import { describe, it, expect } from 'vitest';
import { normalizeBaseUrl, websocketUrl, requestBody, SearchInput, search, parseEvent } from '../src/core.js';
import extension, { WEB_SEARCH_INSTRUCTIONS } from '../src/extension.js';

describe('request construction', () => {
 it('normalizes endpoint and preserves hosted search contract', () => { expect(normalizeBaseUrl('http://proxy.local/')).toBe('http://proxy.local'); expect(websocketUrl('https://proxy.local/')).toBe('wss://proxy.local/v1/responses'); const b=requestBody({query:'cats',search_context_size:'high'},{baseUrl:'https://proxy.local',apiKey:'x',model:'gpt',reasoningEffort:'high'}); expect(b.reasoning).toEqual({effort:'high'}); expect(b.store).toBe(false); expect(b.tools).toEqual([{type:'web_search',search_context_size:'high'}]); });
 it('streams citations and sends auth without leaking it', async () => { let sent=''; let headers:any; const listeners:any={}; const ws:any={send:(x:string)=>sent=x,close:()=>{},addEventListener:(t:string,f:any)=>{listeners[t]=f}}; const r=await search({query:'cats',search_context_size:'medium'},{baseUrl:'https://proxy.local',apiKey:'SECRET',model:'gpt',websocketFactory:(_u,_p,o)=>{headers=o?.headers; setTimeout(()=>listeners.open(),0); setTimeout(()=>listeners.message({data:JSON.stringify({type:'response.output_text.delta',delta:'answer'})}),1); setTimeout(()=>listeners.message({data:JSON.stringify({type:'web_search_call',title:'A',url:'https://a.test',snippet:'s'})}),2); setTimeout(()=>listeners.message({data:JSON.stringify({type:'response.completed',response:{id:'resp_1'}})}),3); return ws}}); expect(headers.Authorization).toBe('Bearer SECRET'); expect(sent).toContain('"store":false'); expect(r.text).toBe('answer'); expect(r.details.sources[0].url).toBe('https://a.test'); expect(JSON.stringify(r)).not.toContain('SECRET'); });
 it('fails clearly on errors and cancellation', async()=>{ const ws:any={send:()=>{},close:()=>{},addEventListener:(t:string,f:any)=>{if(t==='open')setTimeout(f,0); if(t==='message')setTimeout(()=>f({data:JSON.stringify({type:'error',error:{message:'bad'}})}),1)}}; await expect(search({query:'x',search_context_size:'low'},{baseUrl:'https://x',apiKey:'k',model:'m',websocketFactory:()=>ws})).rejects.toThrow('bad'); const ac=new AbortController(); const p=search({query:'x',search_context_size:'low'},{baseUrl:'https://x',apiKey:'k',model:'m',websocketFactory:()=>({send(){},close(){},addEventListener(){}} as any)},ac.signal); ac.abort(); await expect(p).rejects.toThrow('cancelled'); });
});

describe('event parsing', () => {
 it('does not append complete output after streaming deltas', () => {
  const state = { text: '', sources: [], events: [] as string[] };
  parseEvent({ type: 'response.output_text.delta', delta: 'answer' }, state);
  parseEvent({ type: 'response.output_text.done', text: 'answer' }, state);
  expect(state.text).toBe('answer');
 });
});

describe('local_time', () => { it('returns readable local time and structured timestamp', async () => { const { localTime } = await import('../src/core.js'); const result = localTime(new Date('2026-10-07T20:00:00.000Z')); expect(result.details.iso).toBe('2026-10-07T20:00:00.000Z'); expect(result.details.epochMs).toBe( Date.parse('2026-10-07T20:00:00.000Z') ); expect(result.text).toMatch(/2026/); }); });

describe('system prompt guidance', () => {
 it('adds web search instructions only when the tool is selected', () => {
  let beforeAgentStart: any;
  const pi: any = { on: (name: string, handler: any) => { if (name === 'before_agent_start') beforeAgentStart = handler; }, registerTool: () => {} };
  extension(pi);
  const withTool = { systemPromptOptions: { selectedTools: ['web_search'], sections: {} as Record<string, string> } };
  beforeAgentStart(withTool);
  expect(withTool.systemPromptOptions.sections.web_search_guidance).toBe(WEB_SEARCH_INSTRUCTIONS);
  const withoutTool = { systemPromptOptions: { selectedTools: [], sections: { web_search_guidance: 'stale' } } };
  beforeAgentStart(withoutTool);
  expect(withoutTool.systemPromptOptions.sections.web_search_guidance).toBeUndefined();
 });
});
