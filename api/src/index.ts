// The translation API. It keeps the provider keys server-side, stores translations
// per line (so batches finishing together can't overwrite each other), and stops
// spending at a daily cap. No subtitle text is logged or stored in English.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { LineResult, OverBudgetResponse, TranslateResponse } from '../../shared/protocol';
import { OpenAIError, translateBatchOpenAI } from './openai';
import { PROMPT_VERSION } from './prompt';
import { type ModelId, translateBatch } from './translate';

export interface Env {
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string;
  CLIENT_TOKEN: string;
  MODEL?: string;
  DAILY_BUDGET_USD?: string;
  DB: D1Database;
}

const MAX_LINES = 60;
const MAX_LINE_CHARS = 500;
const DEFAULT_MODEL = 'gpt-6.1-terra';
const DEFAULT_DAILY_BUDGET = 5;

const RequestSchema = z.object({
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/translate' || request.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (!env.CLIENT_TOKEN || request.headers.get('authorization') !== `Bearer ${env.CLIENT_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }

    let body;
    try {
      body = RequestSchema.parse(await request.json());
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
    if (missing.length === 0) return json({ results, stats } satisfies TranslateResponse);

    const budget = Number(env.DAILY_BUDGET_USD) || DEFAULT_DAILY_BUDGET;
    const spent = (await env.DB.prepare('SELECT usd FROM spend WHERE day = ?').bind(today()).first<number>('usd')) ?? 0;
    if (spent >= budget) return json({ error: 'over_budget' } satisfies OverBudgetResponse, 429);

    const model = env.MODEL || DEFAULT_MODEL;
    let batch;
    try {
      batch = model.startsWith('claude-')
        ? await translateBatch(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), model as ModelId, body.lang, missing, body.glossary)
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

    const writes = [
      env.DB.prepare('INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd').bind(today(), batch.costUsd),
    ];
    // Refused or unreadable batches are not kept, so they can be tried again.
    if (!batch.refused && !batch.unreadable) {
      const insert = env.DB.prepare('INSERT OR REPLACE INTO translations (version, lang, video, hash, result) VALUES (?, ?, ?, ?, ?)');
      for (const [hash, result] of Object.entries(batch.results)) {
        writes.push(insert.bind(PROMPT_VERSION, body.lang, body.videoId, hash, JSON.stringify(result)));
      }
    }
    await env.DB.batch(writes);
    Object.assign(results, batch.results);
    Object.assign(stats, {
      translated: missing.length,
      dropped: batch.dropped,
      refused: batch.refused,
      costUsd: batch.costUsd,
    });

    return json({ results, stats } satisfies TranslateResponse);
  },
};
