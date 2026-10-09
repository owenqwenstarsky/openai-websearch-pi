import type { SearchInput, SearchResult, Source } from './core.js';

export type SearchState = {
  text: string;
  sources: Source[];
  events: string[];
  responseId?: string;
  textParts?: Map<string, string>;
};

/** Never return raw credentials, including OAuth tokens that do not start with sk-. */
export function scrub(value: string, secrets: string[] = []): string {
  for (const secret of secrets) {
    if (secret) value = value.split(secret).join('[REDACTED]');
  }
  return value.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

export function redactResult(result: SearchResult, secrets: string[]): SearchResult {
  return JSON.parse(JSON.stringify(result, (_key, value) => typeof value === 'string' ? scrub(value, secrets) : value));
}

function collectSources(value: any, state: SearchState): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, state);
    return;
  }
  const url = value.url ?? value.link ?? value.source?.url;
  if (typeof url === 'string' && !state.sources.some(source => source.url === url)) {
    state.sources.push({
      url,
      title: typeof value.title === 'string' ? value.title : typeof value.name === 'string' ? value.name : undefined,
      snippet: typeof value.snippet === 'string' ? value.snippet : undefined,
      content: typeof value.content === 'string' ? value.content : undefined,
      metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : undefined,
    });
  }
  // Only traverse documented result containers, never arbitrary response metadata.
  for (const key of ['response', 'output', 'item', 'content', 'annotations', 'annotation', 'action', 'sources', 'web_search_call', 'result', 'results']) {
    collectSources(value[key], state);
  }
}

function outputText(output: any[]): string {
  return output.flatMap(item => item?.type === 'message' && Array.isArray(item.content)
    ? item.content.filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string').map((part: any) => part.text)
    : []).join('');
}

export function parseSearchEvent(raw: unknown, state: SearchState): any {
  const event = typeof raw === 'string' ? JSON.parse(raw) : raw as any;
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Malformed search event');
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  state.events.push(type);
  if (typeof event.response?.id === 'string') state.responseId = event.response.id;
  if (typeof event.id === 'string' && type.startsWith('response.')) state.responseId = event.id;
  if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
    const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
    state.textParts ??= new Map();
    if (type.endsWith('.delta') && typeof event.delta === 'string') {
      state.textParts.set(key, (state.textParts.get(key) ?? '') + event.delta);
    } else if (typeof event.text === 'string') {
      state.textParts.set(key, event.text);
    }
    state.text = [...state.textParts.values()].join('');
  }
  if (type === 'response.output_item.done' && event.item?.type === 'message' && Array.isArray(event.item.content)) {
    state.textParts ??= new Map();
    event.item.content.forEach((part: any, index: number) => {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        state.textParts!.set(`${event.output_index ?? 0}:${index}`, part.text);
      }
    });
    state.text = [...state.textParts.values()].join('');
  }
  collectSources(event, state);
  if (Array.isArray(event.response?.output)) {
    const text = outputText(event.response.output);
    if (text) state.text = text; // Complete snapshot is authoritative, not another delta.
  }
  if (type === 'error' || event.error || type === 'response.failed' || event.response?.status === 'failed') {
    throw new Error(scrub(String(event.error?.message ?? event.response?.error?.message ?? event.message ?? 'Web search failed')));
  }
  if (type === 'response.incomplete' || ['incomplete', 'cancelled'].includes(event.response?.status)) {
    throw new Error('Web search response was incomplete or cancelled');
  }
  return event;
}

export function parseSearchResponse(response: unknown, state: SearchState): void {
  const value = response as any;
  if (!value || typeof value !== 'object' || !Array.isArray(value.output)) throw new Error('Malformed web search response');
  parseSearchEvent({ type: 'response.completed', response: value }, state);
  if (value.status !== 'completed') throw new Error('Web search response did not complete');
  if (!value.output.some((item: any) => item?.type === 'web_search_call')) {
    throw new Error('The selected model did not perform hosted web search');
  }
}

export function searchResult(input: SearchInput, model: string, state: SearchState, backend?: SearchResult['details']['backend']): SearchResult {
  return {
    text: state.text || 'Search completed.',
    details: { query: input.query, search_context_size: input.search_context_size, model,
      response_id: state.responseId, sources: state.sources, events: state.events, ...(backend ? { backend } : {}) },
  };
}
