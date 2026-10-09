import type { SearchInput, SearchResult, ReasoningEffort } from './core.js';
import { parseSearchEvent, parseSearchResponse, scrub, searchResult, redactResult, type SearchState } from './results.js';

export type NativeConfig = {
  backend: 'openai-responses' | 'chatgpt-codex';
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  reasoningEffort?: ReasoningEffort;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};
export const DEFAULT_SEARCH_TIMEOUT_MS = 120_000;

export function responsesUrl(baseUrl: string, codex = false): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid web search endpoint');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (codex) {
    if (!url.pathname.endsWith('/codex/responses')) {
      url.pathname += url.pathname.endsWith('/codex') ? '/responses' : '/codex/responses';
    }
  } else if (!url.pathname.endsWith('/responses')) {
    url.pathname += '/responses';
  }
  return url.toString();
}

export function nativeRequestBody(input: SearchInput, config: NativeConfig) {
  return {
    model: config.model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: input.query }] }],
    tools: [{ type: 'web_search', search_context_size: input.search_context_size }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    store: false,
    stream: config.backend === 'chatgpt-codex',
    ...(config.backend === 'chatgpt-codex' ? { instructions: 'Search the web for the user query. Answer concisely with source citations.' } : {}),
    ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
  };
}

export function nativeHeaders(config: NativeConfig): Headers {
  const headers = new Headers(config.headers);
  if (config.apiKey) headers.set('Authorization', `Bearer ${config.apiKey}`);
  if (!headers.get('Authorization')) throw new Error('OpenAI credentials are unavailable. Use /login');
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', config.backend === 'chatgpt-codex' ? 'text/event-stream' : 'application/json');
  if (config.backend === 'chatgpt-codex') {
    if (!headers.get('chatgpt-account-id')) {
      try {
        const token = headers.get('Authorization')!.replace(/^Bearer\s+/i, '');
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid token');
        const claim = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const accountId = claim['https://api.openai.com/auth']?.chatgpt_account_id;
        if (typeof accountId !== 'string' || !accountId) throw new Error('Missing account ID');
        headers.set('chatgpt-account-id', accountId);
      } catch {
        throw new Error('ChatGPT Codex credentials do not contain an account ID. Reconnect using /login');
      }
    }
    headers.set('OpenAI-Beta', 'responses=experimental');
    headers.set('originator', 'pi');
  }
  return headers;
}

async function consumeSSE(response: Response, state: SearchState, signal: AbortSignal): Promise<void> {
  if (!response.body) throw new Error('Web search returned no response stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let completed = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') return;
    const event = JSON.parse(payload);
    if (event?.type === 'response.completed' || event?.type === 'response.done') {
      parseSearchResponse(event.response, state);
      completed = true;
    } else {
      parseSearchEvent(event, state);
    }
  };
  const line = (value: string) => {
    if (!value) dispatch();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    if (signal.aborted) throw new Error('Web search cancelled');
    while (!completed) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error('Web search cancelled');
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      // Retain a trailing CR until the next chunk, since CRLF can cross chunk boundaries.
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r(?!$)|\n/u.exec(buffer))) {
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (completed) break;
      }
      if (chunk.done) {
        if (!completed) {
          if (buffer) line(buffer.replace(/\r$/, ''));
          dispatch();
        }
        break;
      }
      if (buffer.length > 5_000_000 || data.join('\n').length > 5_000_000) throw new Error('Web search stream event is too large');
    }
    if (!completed) throw new Error('Web search stream closed before completion');
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function nativeSearch(input: SearchInput, config: NativeConfig, signal?: AbortSignal): Promise<SearchResult> {
  if (signal?.aborted) throw new Error('Web search cancelled');
  if (!config.model) throw new Error('No OpenAI search model is selected');
  const timeoutMs = config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid web search timeout');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const secrets = [config.apiKey, ...Object.entries(config.headers ?? {})
    .filter(([key]) => /authorization|api[-_]?key|token/i.test(key)).map(([, value]) => value)];
  let response: Response | undefined;
  try {
    const url = responsesUrl(config.baseUrl, config.backend === 'chatgpt-codex');
    const headers = nativeHeaders(config);
    const bearer = headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (bearer) secrets.push(bearer);
    response = await (config.fetch ?? globalThis.fetch)(url, {
      method: 'POST', headers, body: JSON.stringify(nativeRequestBody(input, config)), signal: controller.signal,
    });
    if (!response.ok) {
      // Only expose a recognized error message, not arbitrary HTML or complete provider payloads.
      let message = response.statusText;
      try {
        const error = await response.json() as any;
        if (typeof error?.error?.message === 'string') message = error.error.message.slice(0, 1000);
      } catch { /* retain status text */ }
      throw new Error(`Web search HTTP ${response.status}: ${message || 'Request failed'}`);
    }
    const state: SearchState = { text: '', sources: [], events: [] };
    if (config.backend === 'chatgpt-codex') await consumeSSE(response, state, controller.signal);
    else parseSearchResponse(await response.json(), state);
    if (controller.signal.aborted) throw new Error('Web search cancelled');
    // Provider results should never contain credentials, even if an upstream echoes them.
    return redactResult(searchResult(input, config.model, state, config.backend), secrets);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timedOut ? 'Web search timed out' : 'Web search cancelled');
    throw new Error(scrub(error instanceof Error ? error.message : 'Web search failed', secrets));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
