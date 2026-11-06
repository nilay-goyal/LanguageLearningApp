// The API. It keeps the provider keys server-side, stores translations per line (so batches
// finishing together can't overwrite each other), gives each tester their own invite code
// and daily limit, collects the study's usage data, and stops spending at a daily cap.
// No subtitle text is logged, and none is stored except in a report a tester sends.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { LineResult, MeResponse, OverBudgetResponse, TranslateResponse } from '../../shared/protocol';
import { authenticate, type Tester } from './auth';
import { storeEvents } from './events';
import { GradeRequestSchema, gradeAnswers } from './grade';
import { OpenAIError, translateBatchOpenAI } from './openai';
import { PROMPT_VERSION } from './prompt';
import { privacyHtml } from './privacy';
import { applySuppression, storeReport } from './reports';
import { type ModelId, translateBatch } from './translate';

export interface Env {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Development only: one shared token with no per-tester limit. */
  CLIENT_TOKEN?: string;
  MODEL?: string;
  DAILY_BUDGET_USD?: string;
  /** Shown on the privacy page, if set. */
  CONTACT_EMAIL?: string;
  DB: D1Database;
}

const MAX_LINES = 60;
const MAX_LINE_CHARS = 500;
const MAX_BODY_CHARS = 200_000;
const DEFAULT_MODEL = 'gpt-6.1-terra';
const DEFAULT_DAILY_BUDGET = 5;

const TranslateSchema = z.object({
  videoId: z.string().min(1).max(40),
  lang: z.literal('fr'),
  lines: z
    .array(
      z.object({
        hash: z.string().min(8).max(128),
        words: z.array(z.string().max(80)).min(1).max(80),
        text: z.string().min(1).max(MAX_LINE_CHARS),
        prev: z.string().max(MAX_LINE_CHARS).optional(),
        next: z.string().max(MAX_LINE_CHARS).optional(),
      }),
    )
    .min(1)
    .max(MAX_LINES),
  glossary: z.record(z.string().max(80), z.string().max(120)),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const today = () => new Date().toISOString().slice(0, 10);

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new Error('too large');
  return JSON.parse(text);
}

async function spentToday(env: Env, tester: Tester): Promise<{ overall: number; tester: number }> {
  const overall = (await env.DB.prepare('SELECT usd FROM spend WHERE day = ?').bind(today()).first<number>('usd')) ?? 0;
  if (tester.dev) return { overall, tester: 0 };
  const own = (await env.DB.prepare('SELECT usd FROM tester_spend WHERE tester = ? AND day = ?').bind(tester.id, today()).first<number>('usd')) ?? 0;
  return { overall, tester: own };
}

/** The statements that add a cost to the overall and the tester's own totals. */
function spendStatements(env: Env, tester: Tester, usd: number) {
  const add = (table: string, columns: string, values: unknown[], conflict: string) =>
    env.DB.prepare(`INSERT INTO ${table} (${columns}) VALUES (${values.map(() => '?').join(', ')}) ON CONFLICT (${conflict}) DO UPDATE SET usd = usd + excluded.usd`).bind(...values);
  const statements = [add('spend', 'day, usd', [today(), usd], 'day')];
  if (!tester.dev) statements.push(add('tester_spend', 'tester, day, usd', [tester.id, today(), usd], 'tester, day'));
  return statements;
}

async function overLimit(env: Env, tester: Tester): Promise<boolean> {
  const budget = Number(env.DAILY_BUDGET_USD) || DEFAULT_DAILY_BUDGET;
  const spent = await spentToday(env, tester);
  return spent.overall >= budget || (tester.cap !== null && spent.tester >= tester.cap);
}

async function translate(request: Request, env: Env, tester: Tester): Promise<Response> {
  let body;
  try {
    body = TranslateSchema.parse(await readJson(request));
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const hashes = [...new Set(body.lines.map((line) => line.hash))];
  const stored = await env.DB.prepare(
    `SELECT hash, result FROM translations WHERE version = ? AND lang = ? AND video = ? AND hash IN (${hashes.map(() => '?').join(',')})`,
  )
    .bind(PROMPT_VERSION, body.lang, body.videoId, ...hashes)
    .all<{ hash: string; result: string }>();
  const results: Record<string, LineResult> = {};
  for (const row of stored.results) results[row.hash] = JSON.parse(row.result) as LineResult;
  const missing = body.lines.filter((line) => !results[line.hash]);
  const stats: TranslateResponse['stats'] = {
    cached: body.lines.length - missing.length,
    translated: 0,
    dropped: 0,
    refused: false,
    costUsd: 0,
  };

  if (missing.length > 0) {
    if (await overLimit(env, tester)) return json({ error: 'over_budget' } satisfies OverBudgetResponse, 429);

    const model = env.MODEL || DEFAULT_MODEL;
    let batch;
    try {
      batch = model.startsWith('claude-')
        ? await translateBatch(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? '' }), model as ModelId, body.lang, missing, body.glossary)
        : await translateBatchOpenAI(env.OPENAI_API_KEY ?? '', model, body.lang, missing, body.glossary);
    } catch (error) {
      if (error instanceof OpenAIError) {
        console.error('OpenAI API error', error.status);
        return json({ error: error.status === 429 ? 'rate_limited' : 'upstream' }, error.status === 429 ? 429 : 502);
      }
      if (error instanceof Anthropic.RateLimitError) return json({ error: 'rate_limited' }, 429);
      if (error instanceof Anthropic.APIError) {
        console.error('Claude API error', error.status);
        return json({ error: 'upstream' }, 502);
      }
      console.error('Translate failed');
      return json({ error: 'upstream' }, 502);
    }

    const writes = spendStatements(env, tester, batch.costUsd);
    // Refused or unreadable batches are not kept, so they can be tried again.
    if (!batch.refused && !batch.unreadable) {
      const insert = env.DB.prepare('INSERT OR REPLACE INTO translations (version, lang, video, hash, result) VALUES (?, ?, ?, ?, ?)');
      for (const [hash, result] of Object.entries(batch.results)) {
        writes.push(insert.bind(PROMPT_VERSION, body.lang, body.videoId, hash, JSON.stringify(result)));
      }
    }
    await env.DB.batch(writes);
    Object.assign(results, batch.results);
    Object.assign(stats, { translated: missing.length, dropped: batch.dropped, refused: batch.refused, costUsd: batch.costUsd });
  }

  // Units that testers reported are hidden for everyone, even if they were cached earlier.
  await applySuppression(env.DB, PROMPT_VERSION, body.lang, body.videoId, results);
  return json({ results, stats } satisfies TranslateResponse);
}

async function grade(request: Request, env: Env, tester: Tester): Promise<Response> {
  let body;
  try {
    body = GradeRequestSchema.parse(await readJson(request));
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (await overLimit(env, tester)) return json({ error: 'over_budget' } satisfies OverBudgetResponse, 429);
  try {
    const outcome = await gradeAnswers(env.OPENAI_API_KEY ?? '', body.items);
    if (outcome.costUsd > 0) await env.DB.batch(spendStatements(env, tester, outcome.costUsd));
    return json({ grades: outcome.grades });
  } catch (error) {
    console.error('Grading failed', error instanceof OpenAIError ? error.status : '');
    return json({ error: 'upstream' }, 502);
  }
}

async function deleteMyData(env: Env, tester: Tester): Promise<Response> {
  // The development token isn't a person, so there's nothing of theirs to delete.
  if (tester.dev) return json({ error: 'bad_request' }, 400);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM events WHERE tester = ?').bind(tester.id),
    env.DB.prepare('DELETE FROM reports WHERE tester = ?').bind(tester.id),
    env.DB.prepare('DELETE FROM tester_spend WHERE tester = ?').bind(tester.id),
    env.DB.prepare('UPDATE testers SET revoked = 1, deleted_at = ? WHERE substr(code_hash, 1, 16) = ?').bind(new Date().toISOString(), tester.id),
  ]);
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/privacy' && request.method === 'GET') {
      return new Response(privacyHtml(env.CONTACT_EMAIL), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }

    const routes: Record<string, string> = {
      '/v1/me': 'GET',
      '/v1/me/delete': 'POST',
      '/v1/translate': 'POST',
      '/v1/events': 'POST',
      '/v1/report': 'POST',
      '/v1/grade': 'POST',
    };
    if (routes[url.pathname] !== request.method) return json({ error: 'not_found' }, 404);

    const tester = await authenticate(request, env);
    if (!tester) return json({ error: 'unauthorized' }, 401);

    switch (url.pathname) {
      case '/v1/me':
        return json({ ok: true, label: tester.label } satisfies MeResponse);
      case '/v1/me/delete':
        return deleteMyData(env, tester);
      case '/v1/translate':
        return translate(request, env, tester);
      case '/v1/grade':
        return grade(request, env, tester);
      case '/v1/events':
      case '/v1/report': {
        let input: unknown;
        try {
          input = await readJson(request);
        } catch {
          return json({ error: 'bad_request' }, 400);
        }
        const result = url.pathname === '/v1/events' ? await storeEvents(env.DB, tester, input) : await storeReport(env.DB, tester, input);
        return result.ok ? json(result) : json({ error: result.status === 429 ? 'rate_limited' : 'bad_request' }, result.status);
      }
    }
    return json({ error: 'not_found' }, 404);
  },
};
