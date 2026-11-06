import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { normaliseCode, sha256Hex } from '../src/auth';
import { createD1 } from './d1';

const DEV = 'devtoken';
let env: Env;
let openaiCalls = 0;

async function addTester(code: string, label: string, cap = 2) {
  const hash = await sha256Hex(normaliseCode(code));
  await env.DB.prepare('INSERT INTO testers (code_hash, label, daily_cap_usd, created_at) VALUES (?, ?, ?, ?)')
    .bind(hash, label, cap, new Date().toISOString())
    .run();
  return hash.slice(0, 16);
}

const call = (method: string, path: string, token?: string, body?: unknown) =>
  worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    env,
  );
const post = (path: string, token: string | undefined, body: unknown) => call('POST', path, token, body);
const count = async (sql: string, ...params: (string | number)[]) =>
  (await env.DB.prepare(sql).bind(...params).first<number>('n')) ?? 0;

const WORDS = ['Where', 'are', 'my', 'keys'];
const line = (hash: string, text = 'Where are my keys?') => ({ hash, words: text.replace(/[^\w ]/g, '').split(' '), text });
const translateBody = (hashes: string[], videoId = '100') => ({ videoId, lang: 'fr', glossary: {}, lines: hashes.map((h) => line(h)) });

/** A reply from the mocked OpenAI, shaped like its real one, for however many lines were asked about. */
function openaiTranslation(input: string) {
  const n = [...input.matchAll(/^Line (\d+):/gm)].length;
  const lines = Array.from({ length: n }, (_, i) => ({
    i,
    units: [{ start: 2, end: 4, english: 'my keys', text: 'mes clés', lemmas: ['mon', 'clé'], verdict: 'NATURAL' }],
    full: { text: 'Où sont mes clés ?', lemmas: ['où', 'être'], verdict: 'NATURAL' },
  }));
  return { status: 'completed', usage: { input_tokens: 1000, output_tokens: 500 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ lines }) }] }] };
}

beforeEach(() => {
  env = { DB: createD1(), CLIENT_TOKEN: DEV, OPENAI_API_KEY: 'sk-test', DAILY_BUDGET_USD: '5' };
  openaiCalls = 0;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    openaiCalls++;
    const body = JSON.parse(init.body) as { input: string; instructions: string };
    const reply = body.instructions.includes('mark a language learner') ? { status: 'completed', usage: { input_tokens: 200, output_tokens: 30 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ grades: [...body.input.matchAll(/^Item \d+/gm)].map(() => 'correct') }) }] }] } : openaiTranslation(body.input);
    return new Response(JSON.stringify(reply), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('who can call', () => {
  it('rejects no token and wrong tokens', async () => {
    expect((await call('GET', '/v1/me')).status).toBe(401);
    expect((await call('GET', '/v1/me', 'nope')).status).toBe(401);
  });

  it('accepts the development token and a tester code, whatever its case or dashes', async () => {
    await addTester('FR-AB12-CD34', 'T01');
    expect((await call('GET', '/v1/me', DEV)).status).toBe(200);
    const res = await call('GET', '/v1/me', 'fr ab12 cd34');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, label: 'T01' });
  });

  it('stops working when a code is revoked', async () => {
    const hash = await sha256Hex(normaliseCode('CODE1'));
    await addTester('CODE1', 'T02');
    await env.DB.prepare('UPDATE testers SET revoked = 1 WHERE code_hash = ?').bind(hash).run();
    expect((await call('GET', '/v1/me', 'CODE1')).status).toBe(401);
  });

  it('answers wrong paths and methods with 404, and the privacy page without a token', async () => {
    expect((await call('GET', '/nope', DEV)).status).toBe(404);
    expect((await call('GET', '/v1/translate', DEV)).status).toBe(404);
    const page = await call('GET', '/privacy');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('What we do not collect');
  });

  it('shows a contact address on the privacy page only when one is set', async () => {
    expect(await (await call('GET', '/privacy')).text()).toContain('contact the person who gave you your invite code');
    env.CONTACT_EMAIL = 'study@example.com';
    expect(await (await call('GET', '/privacy')).text()).toContain('mailto:study@example.com');
  });
});

describe('translate', () => {
  it('translates once, then answers from storage without calling the provider', async () => {
    const first = await post('/v1/translate', DEV, translateBody(['aaaaaaaa']));
    expect(first.status).toBe(200);
    const body = (await first.json()) as { results: Record<string, { units: { text: string }[] }>; stats: { translated: number } };
    expect(body.results.aaaaaaaa!.units[0]!.text).toBe('mes clés');
    expect(body.stats.translated).toBe(1);
    expect(openaiCalls).toBe(1);

    const second = (await (await post('/v1/translate', DEV, translateBody(['aaaaaaaa']))).json()) as { stats: { cached: number } };
    expect(second.stats.cached).toBe(1);
    expect(openaiCalls).toBe(1);
  });

  it('stores French and positions but never the English line', async () => {
    await post('/v1/translate', DEV, translateBody(['aaaaaaaa']));
    const rows = await env.DB.prepare('SELECT result FROM translations').all<{ result: string }>();
    expect(JSON.stringify(rows.results)).not.toMatch(/where|keys/i);
  });

  it('counts a tester\'s spending separately, and stops them at their own limit', async () => {
    const id = await addTester('SPENDER', 'T03', 0.003);
    const first = await post('/v1/translate', 'SPENDER', translateBody(['aaaaaaaa']));
    expect(first.status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM tester_spend WHERE tester = ? AND usd > 0', id)).toBe(1);

    const blocked = await post('/v1/translate', 'SPENDER', translateBody(['bbbbbbbb']));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'over_budget' });
    // Lines already stored are still free.
    expect((await post('/v1/translate', 'SPENDER', translateBody(['aaaaaaaa']))).status).toBe(200);
  });

  it('stops everyone at the overall daily limit', async () => {
    env.DAILY_BUDGET_USD = '0.003';
    await addTester('A', 'T04');
    await addTester('B', 'T05');
    expect((await post('/v1/translate', 'A', translateBody(['aaaaaaaa']))).status).toBe(200);
    expect((await post('/v1/translate', 'B', translateBody(['bbbbbbbb']))).status).toBe(429);
  });

  it('rejects a malformed request and one that is too big', async () => {
    expect((await post('/v1/translate', DEV, { videoId: '1' })).status).toBe(400);
    expect((await post('/v1/translate', DEV, 'x'.repeat(250_000))).status).toBe(400);
  });
});

describe('events', () => {
  const tick = { kind: 'tick', secs: 60, words: 150, l2Words: 12, lines: 25, linesFrench: 6, late: 0, tiers: [3, 2, 1, 0], bySpeed: [1, 3, 2, 0], hour: 4.5, pace: '90to120', build: 'v0.4.0' };

  it('stores a valid batch under the tester, without the kind inside the data', async () => {
    const id = await addTester('EVENTS', 'T06');
    const res = await post('/v1/events', 'EVENTS', { events: [{ at: Date.now(), event: tick }, { at: Date.now(), event: { kind: 'reveal', tier: 2, hour: 4.5, wps: 3.1, ms: 900 } }] });
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare('SELECT kind, data FROM events WHERE tester = ? ORDER BY id').bind(id).all<{ kind: string; data: string }>();
    expect(rows.results.map((r) => r.kind)).toEqual(['tick', 'reveal']);
    expect(JSON.parse(rows.results[0]!.data)).toMatchObject({ secs: 60, hour: 4.5 });
    expect(JSON.parse(rows.results[0]!.data).kind).toBeUndefined();
  });

  it('refuses any field that is not listed, so text cannot slip in', async () => {
    await addTester('LEAKY', 'T07');
    const withText = { ...tick, title: 'Some Show', text: 'Where are my keys?' };
    expect((await post('/v1/events', 'LEAKY', { events: [{ at: 1, event: withText }] })).status).toBe(400);
    expect((await post('/v1/events', 'LEAKY', { events: [{ at: 1, event: { kind: 'video', id: '80103686' } }] })).status).toBe(400);
    expect((await post('/v1/events', 'LEAKY', { events: [{ at: 1, event: { kind: 'reveal', tier: 2, hour: 1, wps: 2, ms: 5, line: 'Hello' } }] })).status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM events')).toBe(0);
  });

  it('rejects a batch with one bad event, storing none of it', async () => {
    await addTester('MIXED', 'T08');
    const res = await post('/v1/events', 'MIXED', { events: [{ at: 1, event: tick }, { at: 1, event: { kind: 'rate', enjoy: 9, follow: 'yes' } }] });
    expect(res.status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM events')).toBe(0);
  });

  it('accepts the recall events and keeps their numbers', async () => {
    await addTester('RECALL', 'T09');
    const event = { kind: 'recall', phase: 'check', n: 2, bucket: '25+', count: 31, sinceLastDays: 3.2, sinceFirstDays: 9, grade: 'correct', ms: 4200 };
    expect((await post('/v1/events', 'RECALL', { events: [{ at: Date.now(), event }] })).status).toBe(200);
  });

  it('pulls a tester\'s odd clock back into a sensible range', async () => {
    await addTester('CLOCK', 'T10');
    await post('/v1/events', 'CLOCK', { events: [{ at: Date.now() + 90 * 24 * 3600 * 1000, event: { kind: 'consent', version: '1' } }] });
    const row = await env.DB.prepare('SELECT at FROM events').first<{ at: number }>();
    expect(row!.at).toBeLessThan(Date.now() + 10 * 60 * 1000);
  });

  it('limits how many events a tester can send in a day', async () => {
    const id = await addTester('FLOOD', 'T11');
    const insert = env.DB.prepare('INSERT INTO events (tester, at, kind, data) VALUES (?, ?, ?, ?)');
    for (let chunk = 0; chunk < 20; chunk++) {
      await env.DB.batch(Array.from({ length: 1000 }, () => insert.bind(id, Date.now(), 'tick', '{}')));
    }
    expect((await post('/v1/events', 'FLOOD', { events: [{ at: Date.now(), event: tick }] })).status).toBe(429);
  });
});

describe('reports', () => {
  const report = { lang: 'fr', video: '100', hash: 'aaaaaaaa', start: 2, end: 4, tier: 2, french: 'mes clés', english: 'Where are my keys?', hour: 12, version: 2 };
  const reportBody = (over: object = {}) => ({ ...report, ...over });

  it('stores a report, and one tester alone does not hide the unit', async () => {
    await addTester('R1', 'T12');
    await post('/v1/translate', 'R1', translateBody(['aaaaaaaa']));
    const res = (await (await post('/v1/report', 'R1', reportBody())).json()) as { suppressed: boolean };
    expect(res.suppressed).toBe(false);
    // A second report from the same tester still isn't a second tester.
    expect(((await (await post('/v1/report', 'R1', reportBody())).json()) as { suppressed: boolean }).suppressed).toBe(false);
  });

  it('hides a unit for everyone once two different testers report it, even from storage', async () => {
    await addTester('R2', 'T13');
    await addTester('R3', 'T14');
    await post('/v1/translate', 'R2', translateBody(['aaaaaaaa']));
    await post('/v1/report', 'R2', reportBody());
    expect(((await (await post('/v1/report', 'R3', reportBody())).json()) as { suppressed: boolean }).suppressed).toBe(true);

    const after = (await (await post('/v1/translate', 'R3', translateBody(['aaaaaaaa']))).json()) as { results: Record<string, { units: unknown[]; full: unknown }> };
    expect(after.results.aaaaaaaa!.units).toEqual([]);
    expect(after.results.aaaaaaaa!.full).not.toBeNull();
  });

  it('hides only the reported unit, not other videos', async () => {
    await addTester('R4', 'T15');
    await addTester('R5', 'T16');
    await post('/v1/translate', 'R4', translateBody(['aaaaaaaa'], '100'));
    await post('/v1/translate', 'R4', translateBody(['aaaaaaaa'], '200'));
    await post('/v1/report', 'R4', reportBody());
    await post('/v1/report', 'R5', reportBody());
    const other = (await (await post('/v1/translate', 'R4', translateBody(['aaaaaaaa'], '200'))).json()) as { results: Record<string, { units: unknown[] }> };
    expect(other.results.aaaaaaaa!.units).toHaveLength(1);
  });

  it('can hide a full-sentence line', async () => {
    await addTester('R6', 'T17');
    await addTester('R7', 'T18');
    await post('/v1/translate', 'R6', translateBody(['aaaaaaaa']));
    await post('/v1/report', 'R6', reportBody({ start: 0, end: -1, tier: 4 }));
    await post('/v1/report', 'R7', reportBody({ start: 0, end: -1, tier: 4 }));
    const after = (await (await post('/v1/translate', 'R6', translateBody(['aaaaaaaa']))).json()) as { results: Record<string, { units: unknown[]; full: unknown }> };
    expect(after.results.aaaaaaaa!.full).toBeNull();
    expect(after.results.aaaaaaaa!.units).toHaveLength(1);
  });

  it('rejects malformed reports', async () => {
    await addTester('R8', 'T19');
    expect((await post('/v1/report', 'R8', { video: '1' })).status).toBe(400);
    expect((await post('/v1/report', 'R8', reportBody({ start: -5 }))).status).toBe(400);
  });
});

describe('grading', () => {
  it('grades typed answers, and marks blank ones without asking the model', async () => {
    await addTester('G1', 'T20');
    const res = await post('/v1/grade', 'G1', { items: [{ french: 'mes clés', gold: 'my keys', answer: 'my keys' }, { french: 'la maison', gold: 'the house', answer: '' }, { french: 'merci', gold: 'thanks', answer: 'no idea' }] });
    expect(await res.json()).toEqual({ grades: ['correct', 'noidea', 'noidea'] });
    expect(openaiCalls).toBe(1);
  });

  it('does not call the model at all when nothing was answered', async () => {
    await addTester('G2', 'T21');
    await post('/v1/grade', 'G2', { items: [{ french: 'merci', gold: 'thanks', answer: '' }] });
    expect(openaiCalls).toBe(0);
  });

  it('counts the cost against the tester', async () => {
    const id = await addTester('G3', 'T22');
    await post('/v1/grade', 'G3', { items: [{ french: 'merci', gold: 'thanks', answer: 'thanks' }] });
    expect(await count('SELECT COUNT(*) AS n FROM tester_spend WHERE tester = ? AND usd > 0', id)).toBe(1);
  });

  it('rejects too many items', async () => {
    await addTester('G4', 'T23');
    const items = Array.from({ length: 21 }, () => ({ french: 'a', gold: 'b', answer: 'c' }));
    expect((await post('/v1/grade', 'G4', { items })).status).toBe(400);
  });
});

describe('delete my data', () => {
  it('erases events, reports and spending, and switches the code off', async () => {
    const id = await addTester('GONE', 'T24');
    await addTester('STAYS', 'T25');
    await post('/v1/events', 'GONE', { events: [{ at: Date.now(), event: { kind: 'consent', version: '1' } }] });
    await post('/v1/events', 'STAYS', { events: [{ at: Date.now(), event: { kind: 'consent', version: '1' } }] });
    await post('/v1/report', 'GONE', { lang: 'fr', video: '1', hash: 'aaaaaaaa', start: 0, end: 2, tier: 2, french: 'x', english: 'y', hour: 1, version: 2 });
    await post('/v1/translate', 'GONE', translateBody(['aaaaaaaa']));

    expect((await post('/v1/me/delete', 'GONE', {})).status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM events WHERE tester = ?', id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM reports WHERE tester = ?', id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM tester_spend WHERE tester = ?', id)).toBe(0);
    expect((await call('GET', '/v1/me', 'GONE')).status).toBe(401);
    // Other people's data is untouched.
    expect(await count('SELECT COUNT(*) AS n FROM events')).toBe(1);
    expect((await call('GET', '/v1/me', 'STAYS')).status).toBe(200);
  });

  it('does nothing for the development token', async () => {
    expect((await post('/v1/me/delete', DEV, {})).status).toBe(400);
  });
});
