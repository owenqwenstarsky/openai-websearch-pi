import { Type } from '@sinclair/typebox';
import { SearchInput, search, resolveProviderConfig, localTime, type Config } from './core.js';

export default function extension(pi: any) {
  pi.registerTool({
    name: 'web_search', label: 'Web search', description: 'Search the web through CLIProxyAPI hosted search.', parameters: SearchInput,
    async execute(_id: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const config: Config | undefined = pi.getProvider?.('pi-cliproxyapi-provider')?.webSearchConfig?.() ?? pi.webSearchConfig?.() ?? await resolveProviderConfig(ctx?.model);
      if (!config) return { content: [{ type: 'text', text: 'CLIProxyAPI web search is not configured.' }], details: { error: 'missing_config' } };
      try { const result = await search(params, config, _signal); return { content: [{ type: 'text', text: result.text + (result.details.sources.length ? '\n\nSources:\n' + result.details.sources.map(s => `- ${s.title ?? s.url}: ${s.url}`).join('\n') : '') }], details: result.details }; }
      catch (e) { return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], details: { error: 'web_search_failed' }, isError: true }; }
    }
  });
  pi.registerTool({
    name: 'local_time', label: 'Local time', description: 'Return the current local date, time, timezone, and timestamp of the machine running Pi.', parameters: Type.Object({}),
    async execute() { const result = localTime(); return { content: [{ type: 'text', text: result.text }], details: result.details }; }
  });
}
