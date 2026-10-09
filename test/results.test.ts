import { describe, expect, it } from 'vitest';
import { parseSearchEvent, parseSearchResponse, type SearchState } from '../src/results.js';

import { responseFixture } from './fixtures.js';
const state = (): SearchState => ({ text: '', sources: [], events: [] });

describe('native result extraction', () => {
  it('extracts nested message text, sources and citations, deduplicating by URL', () => {
    const result = state();
    parseSearchResponse(responseFixture(), result);
    expect(result.text).toBe('Answer with citation.');
    expect(result.responseId).toBe('resp_test');
    expect(result.sources.map(source => source.url)).toEqual(['https://example.test/a', 'https://example.test/b']);
  });
  it('handles annotations and output items before completion without duplicating snapshots', () => {
    const result = state();
    parseSearchEvent({ type: 'response.output_text.delta', delta: 'Answer' }, result);
    parseSearchEvent({ type: 'response.output_text.annotation.added', annotation: { url: 'https://example.test/a' } }, result);
    parseSearchEvent({ type: 'response.output_item.done', item: responseFixture().output[0] }, result);
    parseSearchResponse(responseFixture('Answer'), result);
    expect(result.text).toBe('Answer');
    expect(result.sources).toHaveLength(2);
  });
  it('uses done text when deltas are absent and keeps multiple text parts', () => {
    const result = state();
    parseSearchEvent({ type: 'response.output_text.done', text: 'First', output_index: 1 }, result);
    parseSearchEvent({ type: 'response.output_text.delta', delta: 'Second', output_index: 2 }, result);
    parseSearchEvent({ type: 'response.output_text.done', text: 'Second', output_index: 2 }, result);
    parseSearchEvent({ type: 'response.reasoning_text.delta', delta: 'Not answer text' }, result);
    expect(result.text).toBe('FirstSecond');
  });
  it.each([
    null, [], {}, { status: 'in_progress', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [] }] },
  ].map(value => ({ value })))('rejects invalid or unsearched responses: $value', ({ value }) => {
    expect(() => parseSearchResponse(value, state())).toThrow();
  });
  it.each(['failed', 'incomplete', 'cancelled'])('rejects terminal status %s', status => {
    expect(() => parseSearchResponse({ ...responseFixture(), status }, state())).toThrow();
  });
  it('extracts output item text even when completion has no output snapshot', () => {
    const result = state();
    parseSearchEvent({ type: 'response.output_item.done', output_index: 1, item: responseFixture('Item answer').output[1] }, result);
    parseSearchEvent({ type: 'response.completed', response: { id: 'resp_item' } }, result);
    expect(result.text).toBe('Item answer');
  });
  it('still handles flat CPA result sources', () => {
    const result = state();
    parseSearchEvent({ type: 'web_search_call', title: 'CPA source', link: 'https://example.test/cpa', snippet: 'Snippet' }, result);
    expect(result.sources[0]).toMatchObject({ title: 'CPA source', url: 'https://example.test/cpa', snippet: 'Snippet' });
  });
});
