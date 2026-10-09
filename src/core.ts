import { Type, type Static } from '@sinclair/typebox';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Ws from 'ws';
import { parseSearchEvent, scrub, searchResult, redactResult, type SearchState } from './results.js';
import { nativeSearch } from './openai.js';
import type { SearchConfig } from './config.js';

export const SearchInput = Type.Object({
  query: Type.String({ minLength: 1, description: 'The web search query.' }),
  search_context_size: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], { default: 'medium' })
});
export type SearchInput = Static<typeof SearchInput>;
export type Source = { title?: string; url: string; snippet?: string; content?: string; metadata?: Record<string, unknown> };
export type SearchResult = { text: string; details: { query: string; search_context_size: SearchInput['search_context_size']; model: string; response_id?: string; sources: Source[]; events: string[]; backend?: 'cliproxyapi' | 'openai-responses' | 'chatgpt-codex' } };
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type Config = { backend?: 'cliproxyapi'; baseUrl: string; apiKey: string; model: string; timeoutMs?: number; reasoningEffort?: ReasoningEffort; websocketFactory?: (url: string, protocols?: string | string[], options?: { headers: Record<string, string> }) => WebSocketLike };
export interface WebSocketLike { send(data: string): void; close(code?: number, reason?: string): void; addEventListener(type: string, listener: (event: any) => void): void; removeEventListener?(type: string, listener: (event: any) => void): void; }
export function normalizeBaseUrl(input: string): string { const u = new URL(input); return u.toString().replace(/\/$/, ''); }
export function websocketUrl(baseUrl: string): string { const u = new URL(normalizeBaseUrl(baseUrl)); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; u.pathname = u.pathname.replace(/\/+$/u, ''); if (!u.pathname) u.pathname = '/'; if (!/\/v1$/u.test(u.pathname)) u.pathname = u.pathname.replace(/\/$/u, '') + '/v1'; u.pathname += '/responses'; return u.toString(); }

export async function resolveProviderConfig(model?: { id?: string; modelId?: string; baseUrl?: string; provider?: string }): Promise<Config | undefined> {
  const cfgPath = join(homedir(), '.pi', 'agent', 'pi-cliproxyapi-provider', 'config.json');
  try {
    const raw = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : process.env.CLIPROXYAPI_BASE_URL;
    if (!baseUrl) return undefined;
    let apiKey = process.env.CLIPROXYAPI_API_KEY;
    if (!apiKey) {
      try {
        const auth = JSON.parse(await readFile(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8')) as any;
        const credential = auth.cpa ?? auth[typeof raw.providerName === 'string' ? raw.providerName : 'cpa'];
        if (credential?.type === 'api_key' && typeof credential.key === 'string') apiKey = credential.key;
      } catch { /* report missing credentials below */ }
    }
    if (raw.authRequired !== false && !apiKey) return undefined;
    const configuredModel = typeof raw.webSearchModel === 'string' ? raw.webSearchModel.trim() : '';
    const id = process.env.CLIPROXYAPI_WEB_SEARCH_MODEL?.trim() || configuredModel || model?.id || model?.modelId;
    if (!id) return undefined;
    const configuredEffort = typeof raw.webSearchReasoningEffort === 'string' ? raw.webSearchReasoningEffort.trim() : '';
    const effort = (process.env.CLIPROXYAPI_WEB_SEARCH_REASONING_EFFORT?.trim() || configuredEffort) as ReasoningEffort | '';
    return { baseUrl, apiKey: apiKey ?? '', model: id, ...(effort ? { reasoningEffort: effort } : {}) };
  } catch { return undefined; }
}

export function requestBody(input: SearchInput, config: Config) { return { model: config.model, ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}), input: [{ role: 'user', content: [{ type: 'input_text', text: input.query }] }], tools: [{ type: 'web_search', search_context_size: input.search_context_size }], store: false }; }
export function parseEvent(raw: unknown, state: SearchState) {
  return parseSearchEvent(raw, state);
}

export async function search(input: SearchInput, config: SearchConfig, signal?: AbortSignal): Promise<SearchResult> {
  if (config.backend === 'openai-responses' || config.backend === 'chatgpt-codex') {
    return nativeSearch(input, config, signal);
  }
  return proxySearch(input, config as Config, signal);
}

async function proxySearch(input: SearchInput, config: Config, signal?: AbortSignal): Promise<SearchResult> {
  if (signal?.aborted) throw new Error('Web search cancelled');
  if (!config.apiKey) throw new Error('CLIProxyAPI credentials are unavailable');
  if (!config.model) throw new Error('No CLIProxyAPI ChatGPT/Codex model is selected');
  const timeoutMs = config.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid web search timeout');
  const factory = config.websocketFactory ?? ((url: string, protocols?: string | string[], options?: { headers: Record<string, string> }) => {
    const socket = new Ws(url, protocols, options);
    // A terminating handshake can emit an error after the request listeners are
    // removed. Keep a harmless socket-lifetime handler to avoid a Node crash.
    socket.on('error', () => {});
    const listeners = new Map<(event: any) => void, (event: any) => void>();
    return {
      send: (data: string) => socket.send(data),
      close: () => {
        // terminate also works when cancellation occurs during the handshake.
        if (socket.readyState !== Ws.CLOSED) socket.terminate();
      },
      addEventListener: (type: string, listener: (event: any) => void) => {
        const wrapped = (data: any) => listener(type === 'message' ? { data: data?.toString?.() ?? data } : data);
        listeners.set(listener, wrapped);
        socket.on(type, wrapped);
      },
      removeEventListener: (type: string, listener: (event: any) => void) => {
        const wrapped = listeners.get(listener);
        if (wrapped) socket.off(type, wrapped);
        listeners.delete(listener);
      },
    };
  });
  let ws: WebSocketLike;
  try {
    ws = factory(websocketUrl(config.baseUrl), undefined, {
      headers: { Authorization: `Bearer ${config.apiKey}`, 'OpenAI-Beta': 'responses_websockets=2026-02-06' },
    });
  } catch (error) {
    throw new Error(scrub(error instanceof Error ? error.message : 'CLIProxyAPI connection failed', [config.apiKey]));
  }
  const state: SearchState = { text: '', sources: [], events: [] };
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners = new Map<string, (event: any) => void>();
    const listen = (type: string, handler: (event: any) => void) => {
      listeners.set(type, handler);
      ws.addEventListener(type, handler);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const [type, handler] of listeners) ws.removeEventListener?.(type, handler);
      listeners.clear();
      try { ws.close(); } catch { /* already closed */ }
      if (error) reject(new Error(scrub(error.message, [config.apiKey])));
      else resolve(redactResult(searchResult(input, config.model, state, 'cliproxyapi'), [config.apiKey]));
    };
    const onAbort = () => finish(new Error('Web search cancelled'));
    const timer = setTimeout(() => finish(new Error('Web search timed out')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    listen('open', () => {
      if (settled) return;
      try { ws.send(JSON.stringify({ type: 'response.create', ...requestBody(input, config) })); }
      catch (error) { finish(error instanceof Error ? error : new Error('CLIProxyAPI send failed')); }
    });
    listen('message', (event: any) => {
      if (settled) return;
      try {
        const parsed = parseEvent(typeof event.data === 'string' ? event.data : event.data?.toString(), state);
        if (parsed.type === 'response.completed' || parsed.type === 'response.done') finish();
      } catch (error) { finish(error instanceof Error ? error : new Error('Malformed search event')); }
    });
    listen('error', (event: any) => {
      const message = event?.message ?? event?.error?.message ?? event?.error?.code;
      finish(new Error(message ? `CLIProxyAPI WebSocket connection failed: ${message}` : 'CLIProxyAPI WebSocket connection failed'));
    });
    listen('close', () => {
      if (!settled) finish(new Error('CLIProxyAPI WebSocket closed before search completed'));
    });
    if (signal?.aborted) onAbort();
  });
}

export function localTime(now = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });
  return { text: formatter.format(now), details: { iso: now.toISOString(), timeZone, epochMs: now.getTime() } };
}
