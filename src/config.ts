import { resolveProviderConfig, type Config } from './core.js';
import type { NativeConfig } from './openai.js';

export type SearchConfig = Config | NativeConfig;
export type SearchModel = { id?: string; modelId?: string; provider?: string; api?: string; baseUrl?: string; headers?: Record<string, string> };
export interface SearchContext {
  model?: SearchModel;
  modelRegistry?: {
    getApiKeyAndHeaders(model: SearchModel): Promise<
      { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string } |
      { ok: false; error: string }
    >;
  };
}
export interface ProxyHooks {
  getProvider?(name: string): { webSearchConfig?(): Config | undefined } | undefined;
  webSearchConfig?(): Config | undefined;
}

/** Uses Pi's request-time auth resolution, including OAuth refresh and runtime overrides. */
export async function resolveSearchConfig(
  ctx: SearchContext,
  pi: ProxyHooks = {},
  proxyResolver = resolveProviderConfig,
): Promise<SearchConfig | undefined> {
  const model = ctx.model;
  // A proxy can also advertise the Codex API; only native OpenAI providers
  // should bypass CPA's own configuration and credential hooks.
  const codex = model?.provider === 'openai-codex' || (model?.provider === 'openai' && model.api === 'openai-codex-responses');
  if (model && (model.provider === 'openai' || codex)) {
    if (!ctx.modelRegistry) throw new Error('Pi model registry is unavailable; reload Pi to use native OpenAI web search');
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model).catch(() => {
      throw new Error('Unable to resolve OpenAI credentials. Reconnect the selected provider using /login');
    });
    // Auth resolver errors may contain command output or secrets; do not echo them.
    if (!auth.ok) throw new Error('Unable to resolve OpenAI credentials. Reconnect the selected provider using /login');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...model.headers, ...auth.headers })) {
      if (typeof value === 'string') headers[key] = value;
    }
    if (!auth.apiKey && !Object.keys(headers).some(key => key.toLowerCase() === 'authorization' && headers[key])) {
      throw new Error('OpenAI credentials are unavailable. Use /login for the selected provider or configure OPENAI_API_KEY');
    }
    const id = model.id ?? model.modelId;
    if (!id) throw new Error('No OpenAI search model is selected');
    return {
      backend: codex ? 'chatgpt-codex' : 'openai-responses',
      baseUrl: auth.baseUrl ?? model.baseUrl ?? (codex ? 'https://chatgpt.com/backend-api' : 'https://api.openai.com/v1'),
      apiKey: auth.apiKey ?? '', model: id, headers,
    };
  }
  return pi.getProvider?.('pi-cliproxyapi-provider')?.webSearchConfig?.()
    ?? pi.webSearchConfig?.()
    ?? await proxyResolver(model);
}
