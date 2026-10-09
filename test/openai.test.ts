import { describe, expect, it, vi } from 'vitest';
import { nativeSearch, nativeRequestBody, nativeHeaders, responsesUrl, type NativeConfig } from '../src/openai.js';
import { search } from '../src/core.js';
import { responseFixture } from './fixtures.js';

const input = { query: 'current news', search_context_size: 'high' as const };
const oauth = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url')}.signature`;
const config = (extra: Partial<NativeConfig> = {}): NativeConfig => ({
  backend: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-secret', model: 'search-model', ...extra,
});
function sse(events: unknown[], separator = '\n'): Response {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}${separator}${separator}`).join(''));
  // One byte per chunk exercises JSON, CRLF, and UTF-8 boundary handling.
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const codex = (extra: Partial<NativeConfig> = {}) => config({ backend: 'chatgpt-codex', baseUrl: 'https://chatgpt.com/backend-api', apiKey: oauth, ...extra });

describe('native request construction', () => {
  it.each([
    ['https://api.openai.com/v1/', false, 'https://api.openai.com/v1/responses'],
    ['https://api.openai.com/v1/responses/', false, 'https://api.openai.com/v1/responses'],
    ['https://chatgpt.com/backend-api/', true, 'https://chatgpt.com/backend-api/codex/responses'],
    ['https://chatgpt.com/backend-api/codex/', true, 'https://chatgpt.com/backend-api/codex/responses'],
    ['https://chatgpt.com/backend-api/codex/responses/', true, 'https://chatgpt.com/backend-api/codex/responses'],
  ])('normalizes %s', (url, isCodex, expected) => expect(responsesUrl(url as string, isCodex as boolean)).toBe(expected));
  it('rejects non-HTTP and embedded credentials', () => {
    expect(() => responsesUrl('file:///tmp/search')).toThrow('endpoint');
    expect(() => responsesUrl('https://secret:password@example.test')).toThrow('endpoint');
  });
  it('forces hosted search and requests sources without storing conversation data', () => {
    expect(nativeRequestBody(input, config())).toEqual({
      model: 'search-model', input: [{ role: 'user', content: [{ type: 'input_text', text: input.query }] }],
      tools: [{ type: 'web_search', search_context_size: 'high' }], tool_choice: 'required',
      include: ['web_search_call.action.sources'], store: false, stream: false,
    });
    expect(nativeRequestBody(input, codex({ reasoningEffort: 'high' }))).toMatchObject({ stream: true, instructions: expect.any(String), reasoning: { effort: 'high' } });
  });
  it('builds account-scoped Codex headers and respects resolved headers', () => {
    const headers = nativeHeaders(codex({ headers: { 'X-Test': 'value' } }));
    expect(headers.get('Authorization')).toBe(`Bearer ${oauth}`);
    expect(headers.get('chatgpt-account-id')).toBe('account-test');
    expect(headers.get('OpenAI-Beta')).toBe('responses=experimental');
    expect(headers.get('originator')).toBe('pi');
    expect(headers.get('Accept')).toBe('text/event-stream');
    expect(headers.get('X-Test')).toBe('value');
    expect(() => nativeHeaders(codex({ apiKey: 'invalid' }))).toThrow('account ID');
    expect(nativeHeaders(codex({ apiKey: '', headers: { Authorization: 'Bearer opaque', 'chatgpt-account-id': 'resolved' } })).get('chatgpt-account-id')).toBe('resolved');
  });
});

describe('Responses transport', () => {
  it.each(['sk-test-secret', 'chatgpt-access-secret'])('uses JSON Responses with credential %s', async apiKey => {
    const fetch = vi.fn(async () => Response.json(responseFixture()));
    const result = await search(input, config({ apiKey, fetch }));
    expect(result.text).toBe('Answer with citation.');
    expect(result.details).toMatchObject({ backend: 'openai-responses', response_id: 'resp_test', model: 'search-model' });
    expect(result.details.sources).toHaveLength(2);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(new Headers(options.headers).get('Authorization')).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(options.body as string)).toEqual(nativeRequestBody(input, config()));
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
  it.each([401, 403, 429, 400])('reports HTTP %s without leaking OAuth credentials', async status => {
    await expect(nativeSearch(input, config({ apiKey: oauth, fetch: async () => Response.json({ error: { message: `Unsupported tool/model: ${oauth}` } }, { status }) }))).rejects.toThrow(`HTTP ${status}`);
    await expect(nativeSearch(input, config({ apiKey: oauth, fetch: async () => Response.json({ error: { message: oauth } }, { status }) }))).rejects.not.toThrow(oauth);
  });
  it('does not expose arbitrary HTML error bodies', async () => {
    await expect(nativeSearch(input, config({ fetch: async () => new Response('sensitive arbitrary html', { status: 502 }) }))).rejects.not.toThrow('sensitive');
  });
  it('rejects malformed JSON and incomplete responses', async () => {
    await expect(nativeSearch(input, config({ fetch: async () => new Response('not json') }))).rejects.toThrow();
    await expect(nativeSearch(input, config({ fetch: async () => Response.json({ ...responseFixture(), status: 'incomplete' }) }))).rejects.toThrow('incomplete');
  });
  it('redacts credentials even when upstream echoes them in result text', async () => {
    const result = await nativeSearch(input, config({ apiKey: oauth, fetch: async () => Response.json(responseFixture(oauth)) }));
    expect(result.text).toBe('[REDACTED]');
  });
});

describe('Codex SSE transport', () => {
  it.each(['\n', '\r\n'])('handles split UTF-8 and line boundaries using %j', async separator => {
    const fetch = vi.fn(async () => sse([
      { type: 'response.output_text.delta', delta: 'Café ☀️' },
      { type: 'response.output_text.done', text: 'Café ☀️' },
      { type: 'response.completed', response: responseFixture('Café ☀️') }, '[DONE]',
    ], separator));
    const result = await nativeSearch(input, codex({ fetch }));
    expect(result.text).toBe('Café ☀️');
    expect(result.details.backend).toBe('chatgpt-codex');
    expect(result.details.sources).toHaveLength(2);
  });
  it('falls back to terminal snapshot text without deltas', async () => {
    expect((await nativeSearch(input, codex({ fetch: async () => sse([{ type: 'response.completed', response: responseFixture() }]) }))).text).toBe('Answer with citation.');
  });
  it.each([
    [], ['[DONE]'], [{ type: 'response.output_text.delta', delta: 'partial' }],
    [{ type: 'response.incomplete' }], [{ type: 'response.failed', response: { error: { message: 'failed search' } } }],
    ['malformed json'], [{ type: 'response.completed', response: null }],
  ].map(events => ({ events })))('rejects malformed or unfinished streams $events', async ({ events }) => {
    await expect(nativeSearch(input, codex({ fetch: async () => sse(events) }))).rejects.toThrow();
  });
  it('cancels and releases the reader after completion', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.completed', response: responseFixture() })}\n\n`));
    }, cancel });
    await nativeSearch(input, codex({ fetch: async () => new Response(stream) }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });
});

describe('cancellation, timeout, and validation', () => {
  it('does not connect with a pre-aborted signal or missing auth/model', async () => {
    const fetch = vi.fn();
    const controller = new AbortController(); controller.abort();
    await expect(nativeSearch(input, config({ fetch }), controller.signal)).rejects.toThrow('cancelled');
    await expect(nativeSearch(input, config({ apiKey: '', fetch }))).rejects.toThrow('credentials');
    await expect(nativeSearch(input, config({ model: '', fetch }))).rejects.toThrow('model');
    await expect(nativeSearch(input, config({ timeoutMs: 0, fetch }))).rejects.toThrow('timeout');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels an in-flight fetch and removes its abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fetch: typeof globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      controller.abort();
    });
    await expect(nativeSearch(input, config({ fetch }), controller.signal)).rejects.toThrow('cancelled');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it.each(['cancel', 'timeout'])('interrupts blocked SSE reading on %s and releases resources', async action => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const promise = nativeSearch(input, codex({ timeoutMs: action === 'timeout' ? 10 : 1000, fetch: async () => new Response(stream) }), controller.signal);
    if (action === 'cancel') setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toThrow(action === 'timeout' ? 'timed out' : 'cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });
  it('scrubs network errors containing opaque tokens', async () => {
    await expect(nativeSearch(input, config({ apiKey: oauth, fetch: async () => { throw new Error(`network error ${oauth}`); } }))).rejects.toThrow('network error [REDACTED]');
  });
});
