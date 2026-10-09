export function responseFixture(text = 'Answer with citation.') {
  return { id: 'resp_test', status: 'completed', output: [
    { type: 'web_search_call', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.test/a', title: 'Source A' }] } },
    { type: 'message', content: [{ type: 'output_text', text, annotations: [
      { type: 'url_citation', url: 'https://example.test/a', title: 'Source A' },
      { type: 'url_citation', url: 'https://example.test/b', title: 'Source B' },
    ] }] },
  ] };
}
