import { describe, expect, it } from 'vitest';
import type { RequestLine } from '../../shared/protocol';
import { costOfOpenAI, translateBatchOpenAI } from './openai';

const lines: RequestLine[] = [{ hash: 'aaaaaaaa', words: ['Where', 'are', 'my', 'keys'], text: 'Where are my keys?' }];
const usage = { input_tokens: 1000, output_tokens: 500, input_tokens_details: { cached_tokens: 200 } };

function mockFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const reply = (text: string, status = 'completed') => ({ status, usage, output: [{ content: [{ type: 'output_text', text }] }] });

const good = JSON.stringify({
  lines: [{ i: 0, units: [{ start: 2, end: 4, english: 'my keys', text: 'mes clés', lemmas: ['mon', 'clé'], verdict: 'NATURAL' }], full: null }],
});

describe('translateBatchOpenAI', () => {
  it('reads units and validates them', async () => {
    const out = await translateBatchOpenAI('k', 'gpt-6.1-terra', 'fr', lines, {}, mockFetch(reply(good)));
    expect(out.results.aaaaaaaa!.units[0]!.text).toBe('mes clés');
    expect(out.unreadable).toBe(false);
  });

  it('counts cached input at its own price', () => {
    expect(costOfOpenAI('gpt-6.1-terra', usage)).toBeCloseTo((800 * 1 + 200 * 0.05 + 500 * 5) / 1_000_000, 9);
  });

  it('marks an incomplete or malformed reply unreadable, so it is not cached', async () => {
    const cut = await translateBatchOpenAI('k', 'gpt-6.1-terra', 'fr', lines, {}, mockFetch(reply(good, 'incomplete')));
    expect(cut.unreadable).toBe(true);
    expect(cut.results.aaaaaaaa).toEqual({ units: [], full: null });
    const broken = await translateBatchOpenAI('k', 'gpt-6.1-terra', 'fr', lines, {}, mockFetch(reply('{not json')));
    expect(broken.unreadable).toBe(true);
  });

  it('reports a refusal', async () => {
    const body = { status: 'completed', usage, output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] };
    const out = await translateBatchOpenAI('k', 'gpt-6.1-terra', 'fr', lines, {}, mockFetch(body));
    expect(out.refused).toBe(true);
    expect(out.unreadable).toBe(false);
  });

  it('throws on an API error', async () => {
    await expect(translateBatchOpenAI('k', 'gpt-6.1-terra', 'fr', lines, {}, mockFetch({}, 500))).rejects.toThrow('500');
  });
});
