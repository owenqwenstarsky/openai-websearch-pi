import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolveProviderConfig } from '../src/core.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.mocked(readFile).mockReset(); });
import { resolveSearchConfig, type SearchContext } from '../src/config.js';
import extension from '../src/extension.js';
import { responseFixture } from './fixtures.js';

const proxy = { baseUrl: 'https://proxy.test', apiKey: 'proxy-secret', model: 'proxy-model' };
const model = { provider: 'openai', api: 'openai-responses', id: 'search-model', baseUrl: 'https://api.openai.com/v1' };
const ctx = (auth: any = { ok: true, apiKey: 'sk-test-secret' }): SearchContext => ({
  model, modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue(auth) },
});

describe('native configuration', () => {
  it.each(['sk-test-secret', 'chatgpt-oauth-secret'])('uses request-time registry auth for %s, not incidental CPA config', async key => {
    const context = ctx({ ok: true, apiKey: key });
    const hook = vi.fn(() => proxy);
    const fallback = vi.fn(async () => proxy);
    const result = await resolveSearchConfig(context, { webSearchConfig: hook }, fallback);
    expect(result).toMatchObject({ backend: 'openai-responses', apiKey: key, model: model.id });
    expect(context.modelRegistry!.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(hook).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
  it('resolves fresh credentials for every invocation and respects endpoint/header overrides', async () => {
    const context = ctx({ ok: true, apiKey: 'first-secret', baseUrl: 'https://override.test/v1', headers: { 'X-Project': 'project', Removed: null } });
    const resolver = vi.mocked(context.modelRegistry!.getApiKeyAndHeaders);
    resolver.mockResolvedValueOnce({ ok: true, apiKey: 'first-secret', baseUrl: 'https://override.test/v1', headers: { 'X-Project': 'project', Removed: null } });
    resolver.mockResolvedValueOnce({ ok: true, apiKey: 'refreshed-secret' });
    expect(await resolveSearchConfig(context)).toMatchObject({ baseUrl: 'https://override.test/v1', headers: { 'X-Project': 'project' } });
    expect((await resolveSearchConfig(context))!.apiKey).toBe('refreshed-secret');
    expect(resolver).toHaveBeenCalledTimes(2);
  });
  it.each([
    { provider: 'openai-codex', api: 'openai-codex-responses' },
    { provider: 'openai', api: 'openai-codex-responses' },
  ])('routes Codex models separately: %j', async identity => {
    const context = ctx();
    context.model = { ...model, ...identity, baseUrl: 'https://chatgpt.com/backend-api' };
    expect(await resolveSearchConfig(context)).toMatchObject({ backend: 'chatgpt-codex', baseUrl: 'https://chatgpt.com/backend-api' });
  });
  it('accepts resolved Authorization headers without a separate apiKey', async () => {
    expect(await resolveSearchConfig(ctx({ ok: true, headers: { Authorization: 'Bearer oauth-secret' } }))).toMatchObject({ apiKey: '', headers: { Authorization: 'Bearer oauth-secret' } });
  });
  it('does not fall back to CPA or echo secret auth resolver errors', async () => {
    const fallback = vi.fn(async () => proxy);
    for (const auth of [{ ok: true }, { ok: false, error: 'oauth-super-secret' }]) {
      await expect(resolveSearchConfig(ctx(auth), {}, fallback)).rejects.toThrow(/credentials/);
    }
    const context = ctx();
    vi.mocked(context.modelRegistry!.getApiKeyAndHeaders).mockRejectedValue(new Error('oauth-super-secret'));
    await expect(resolveSearchConfig(context)).rejects.not.toThrow('oauth-super-secret');
    expect(fallback).not.toHaveBeenCalled();
  });
  it('reports missing registry and model IDs', async () => {
    await expect(resolveSearchConfig({ model })).rejects.toThrow('registry');
    const context = ctx();
    context.model = { provider: 'openai' };
    await expect(resolveSearchConfig(context)).rejects.toThrow('model');
  });
});

describe('CPA compatibility', () => {
  it('preserves CPA config and environment model/reasoning overrides', async () => {
    vi.stubEnv('CLIPROXYAPI_API_KEY', 'proxy-api-secret');
    vi.stubEnv('CLIPROXYAPI_WEB_SEARCH_MODEL', '');
    vi.stubEnv('CLIPROXYAPI_WEB_SEARCH_REASONING_EFFORT', '');
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ baseUrl: 'https://proxy.test', webSearchModel: 'configured-model', webSearchReasoningEffort: 'medium' }));
    expect(await resolveProviderConfig({ id: 'active-model' })).toMatchObject({ model: 'configured-model', reasoningEffort: 'medium' });
    vi.stubEnv('CLIPROXYAPI_WEB_SEARCH_MODEL', 'env-model');
    vi.stubEnv('CLIPROXYAPI_WEB_SEARCH_REASONING_EFFORT', 'high');
    expect(await resolveProviderConfig({ id: 'active-model' })).toMatchObject({ model: 'env-model', reasoningEffort: 'high' });
  });
  it('does not mistake CPA Codex-compatible models for native ChatGPT', async () => {
    const context = { model: { provider: 'cpa', api: 'openai-codex-responses', id: 'proxy-model' } };
    expect(await resolveSearchConfig(context, { webSearchConfig: () => proxy })).toEqual(proxy);
  });
  it('preserves provider hook, global hook, and fallback precedence for other models', async () => {
    const context = { model: { provider: 'anthropic', id: 'claude' } };
    const fallback = vi.fn(async () => proxy);
    const hook = vi.fn(() => ({ ...proxy, model: 'global' }));
    expect(await resolveSearchConfig(context, { getProvider: () => ({ webSearchConfig: () => proxy }), webSearchConfig: hook }, fallback)).toEqual(proxy);
    expect(hook).not.toHaveBeenCalled();
    expect(await resolveSearchConfig(context, { webSearchConfig: hook }, fallback)).toMatchObject({ model: 'global' });
    expect(fallback).not.toHaveBeenCalled();
    expect(await resolveSearchConfig(context, {}, fallback)).toEqual(proxy);
    expect(fallback).toHaveBeenCalledWith(context.model);
  });
});

describe('extension integration', () => {
  it('renders native answers and sources using the selected model on each invocation', async () => {
    const tools: any[] = [];
    const fetch = vi.fn(async () => Response.json(responseFixture()));
    vi.stubGlobal('fetch', fetch);
    extension({ registerTool: (tool: any) => tools.push(tool), webSearchConfig: () => proxy });
    const tool = tools.find(tool => tool.name === 'web_search');
    const context = ctx();
    const result = await tool.execute('id', { query: 'news', search_context_size: 'low' }, undefined, undefined, context);
    expect(result.content[0].text).toContain('Sources:');
    expect(result.content[0].text).toContain('https://example.test/a');
    expect(result.details.backend).toBe('openai-responses');
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('sk-test-secret');
    context.model = { ...model, id: 'another-search-model' };
    await tool.execute('id2', { query: 'news', search_context_size: 'medium' }, undefined, undefined, context);
    expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).model).toBe('another-search-model');
  });
  it('marks missing configuration as an actionable tool failure', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('not configured'));
    const tools: any[] = [];
    extension({ registerTool: (tool: any) => tools.push(tool) });
    const result = await tools.find(tool => tool.name === 'web_search').execute('id', {}, undefined, undefined, {});
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe('missing_config');
    expect(result.content[0].text).toContain('/login');
  });
  it('handles native auth failure inside the tool error boundary', async () => {
    const tools: any[] = [];
    extension({ registerTool: (tool: any) => tools.push(tool) });
    const result = await tools.find(tool => tool.name === 'web_search').execute('id', { query: 'news', search_context_size: 'low' }, undefined, undefined, ctx({ ok: false, error: 'secret' }));
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe('web_search_failed');
    expect(result.content[0].text).toContain('/login');
    expect(result.content[0].text).not.toContain('secret');
  });
});
