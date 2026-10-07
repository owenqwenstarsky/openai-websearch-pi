import { Type, type Static } from '@sinclair/typebox';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Ws from 'ws';

export const SearchInput = Type.Object({
  query: Type.String({ minLength: 1, description: 'The web search query.' }),
  search_context_size: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], { default: 'medium' })
});
export type SearchInput = Static<typeof SearchInput>;
export type Source = { title?: string; url: string; snippet?: string; content?: string; metadata?: Record<string, unknown> };
export type SearchResult = { text: string; details: { query: string; search_context_size: SearchInput['search_context_size']; model: string; response_id?: string; sources: Source[]; events: string[] } };
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type Config = { baseUrl: string; apiKey: string; model: string; reasoningEffort?: ReasoningEffort; websocketFactory?: (url: string, protocols?: string | string[], options?: { headers: Record<string, string> }) => WebSocketLike };
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
function scrub(value: string): string { return value.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]'); }
function sourceFrom(x: any): Source | undefined { const url = x?.url ?? x?.link ?? x?.source?.url; if (typeof url !== 'string') return undefined; return { title: typeof x.title === 'string' ? x.title : typeof x.name === 'string' ? x.name : undefined, url, snippet: typeof x.snippet === 'string' ? x.snippet : undefined, content: typeof x.content === 'string' ? x.content : undefined, metadata: x.metadata && typeof x.metadata === 'object' ? x.metadata : undefined }; }
export function parseEvent(raw: unknown, state: { text: string; sources: Source[]; events: string[]; responseId?: string }) { const e = typeof raw === 'string' ? JSON.parse(raw) : raw as any; if (!e || typeof e !== 'object') throw new Error('Malformed WebSocket event'); const type = String(e.type ?? 'unknown'); state.events.push(type); if (typeof e.response?.id === 'string') state.responseId = e.response.id; if (typeof e.id === 'string' && type.includes('response')) state.responseId = e.id; /* `response.output_text.done` may contain the complete text already emitted by delta events. Only append deltas to avoid duplicating the answer. */ const text = type.endsWith('.delta') ? e.delta ?? e.output_text?.delta : undefined; if (typeof text === 'string') state.text += text; const candidates = [e, e.item, e.web_search_call, e.result, ...(Array.isArray(e.results) ? e.results : [])]; for (const c of candidates) { const s = sourceFrom(c); if (s && !state.sources.some(x => x.url === s.url)) state.sources.push(s); } if (e.type === 'error' || e.error) throw new Error(scrub(String(e.error?.message ?? e.message ?? 'CLIProxyAPI search failed'))); if (e.type === 'response.failed') throw new Error(scrub(String(e.response?.error?.message ?? 'CLIProxyAPI search failed'))); return e; }
export async function search(input: SearchInput, config: Config, signal?: AbortSignal): Promise<SearchResult> { if (!config.apiKey) throw new Error('CLIProxyAPI credentials are unavailable'); if (!config.model) throw new Error('No CLIProxyAPI ChatGPT/Codex model is selected'); const factory = config.websocketFactory ?? ((url: string, protocols?: string | string[], options?: { headers: Record<string, string> }) => { const socket = new Ws(url, protocols, options); return { send: (data: string) => socket.send(data), close: (code?: number, reason?: string) => socket.close(code, reason), addEventListener: (type: string, listener: (event: any) => void) => { socket.on(type, (data: any) => listener(type === 'message' ? { data: data?.toString?.() ?? data } : data)); } }; }); const ws = factory(websocketUrl(config.baseUrl), undefined, { headers: { Authorization: `Bearer ${config.apiKey}`, 'OpenAI-Beta': 'responses_websockets=2026-02-06' } }); const state = { text: '', sources: [], events: [] as string[], responseId: undefined as string | undefined }; return await new Promise((resolve, reject) => { let settled = false; const finish = (err?: Error) => { if (settled) return; settled = true; try { ws.close(); } catch {} err ? reject(err) : resolve({ text: state.text || 'Search completed.', details: { query: input.query, search_context_size: input.search_context_size, model: config.model, response_id: state.responseId, sources: state.sources, events: state.events } }); }; const onAbort = () => finish(new Error('Web search cancelled')); signal?.addEventListener('abort', onAbort, { once: true }); ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'response.create', ...requestBody(input, config) }))); ws.addEventListener('message', (ev: any) => { try { const parsed = parseEvent(typeof ev.data === 'string' ? ev.data : ev.data?.toString(), state); if (parsed.type === 'response.completed' || parsed.type === 'response.done') finish(); } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); } }); ws.addEventListener('error', (ev: any) => { const message = ev?.message ?? ev?.error?.message ?? ev?.error?.code; finish(new Error(scrub(message ? `CLIProxyAPI WebSocket connection failed: ${message}` : 'CLIProxyAPI WebSocket connection failed'))); }); ws.addEventListener('close', () => { if (!settled) finish(new Error('CLIProxyAPI WebSocket closed before search completed')); }); }); }

export function localTime(now = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });
  return { text: formatter.format(now), details: { iso: now.toISOString(), timeZone, epochMs: now.getTime() } };
}
