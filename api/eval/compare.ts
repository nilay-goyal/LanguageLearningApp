// Compares models from every provider on the same lines with the production prompt.
// Prices are from each provider's official page, read 2026-11-06.
//
//   npx tsx eval/compare.ts --lines 40
//   npx tsx eval/compare.ts --lines 300 --models claude-sonnet-5-5,gemini-3.8-flash
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { LineResult, RequestLine } from '../../shared/protocol';
import { tokenize } from '../../extension/src/subtitles/hygiene';
import { systemPrompt, userPrompt } from '../src/prompt';
import { type ModelId, OutputSchema, translateBatch } from '../src/translate';
import { validateLines } from '../src/validate';

const DATA_DIR = 'eval/data';
const BATCH = 40;
const MAX_OUTPUT = 16000;
/** Episode size used for cost figures: the two real episodes seen had 564 and 700 lines. */
const EPISODE_LINES = 650;

type Provider = 'anthropic' | 'openai' | 'google';
/** $ per million tokens. */
interface Price { provider: Provider; input: number; output: number; note?: string }

const MODELS: Record<string, Price> = {
  'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20 },
  'claude-sonnet-5-5': { provider: 'anthropic', input: 2, output: 10 },
  'claude-haiku-5-5': { provider: 'anthropic', input: 0.1, output: 0.5 },
  'gpt-6-sol': { provider: 'openai', input: 2, output: 10 },
  'gpt-6.1-sol': { provider: 'openai', input: 2, output: 10 },
  'gpt-6.1-terra': { provider: 'openai', input: 1, output: 5 },
  'gpt-6-luna': { provider: 'openai', input: 0.1, output: 0.5 },
  'gpt-5.6-luna': { provider: 'openai', input: 0.2, output: 1.2 },
  'gpt-5.4-mini': { provider: 'openai', input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { provider: 'openai', input: 0.2, output: 1.25 },
  'gpt-5-mini': { provider: 'openai', input: 0.25, output: 2 },
  'gpt-5-nano': { provider: 'openai', input: 0.05, output: 0.4 },
  'gemini-4-argon': { provider: 'google', input: 2, output: 10, note: 'promo to Nov 30, then $4/$20' },
  'gemini-3.8-flash': { provider: 'google', input: 0.75, output: 3.75, note: 'promo to Dec 31, then $1.50/$7.50' },
  'gemini-3.5-flash-lite': { provider: 'google', input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { provider: 'google', input: 0.25, output: 1.5 },
  'gemini-2.5-flash-lite': { provider: 'google', input: 0.1, output: 0.4 },
};

const vars = readFileSync('.dev.vars', 'utf8');
const secret = (name: string) => {
  const value = vars.match(new RegExp(`${name}=(\\S+)`))?.[1];
  if (!value) throw new Error(`${name} missing from .dev.vars`);
  return value;
};
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

const schema = () => {
  const { $schema: _unused, ...rest } = z.toJSONSchema(OutputSchema) as Record<string, unknown>;
  return rest;
};

interface Reply { text: string; input: number; output: number; finished: boolean }

async function callOpenAI(model: string, system: string, user: string): Promise<Reply> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret('OPENAI_API_KEY')}` },
    body: JSON.stringify({
      model,
      instructions: system,
      input: user,
      max_output_tokens: MAX_OUTPUT,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'subtitle_units', strict: true, schema: schema() } },
    }),
  });
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message ?? ''}`);
  const text = (body.output ?? []).flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
  return { text, input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0, finished: body.status === 'completed' };
}

async function callGoogle(model: string, system: string, user: string): Promise<Reply> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': secret('GOOGLE_API_KEY') },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT, responseMimeType: 'application/json', responseJsonSchema: schema() },
    }),
  });
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message ?? ''}`);
  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const usage = body.usageMetadata ?? {};
  return { text, input: usage.promptTokenCount ?? 0, output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0), finished: candidate?.finishReason === 'STOP' };
}

function loadLines(count: number): RequestLine[] {
  const files = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => f.startsWith('subtitle-lines')) : [];
  type Exported = { text: string; prev?: string; next?: string };
  const sources: Exported[][] = files.map((f) => (JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')) as { lines: Exported[] }).lines);
  if (sources.length === 0) sources.push((JSON.parse(readFileSync('eval/sample-lines.json', 'utf8')) as { lines: Exported[] }).lines);
  console.log(`${sources.length} source(s): ${files.length ? 'real exports' : 'made-up sample'}`);
  const perSource = Math.ceil(count / sources.length);
  return sources
    .flatMap((lines) => {
      const start = Math.max(0, Math.floor((lines.length - perSource) / 2));
      return lines.slice(start, start + perSource);
    })
    .slice(0, count)
    .map((line) => ({
      hash: createHash('sha256').update(line.text).digest('hex').slice(0, 32),
      words: tokenize(line.text).map((t) => line.text.slice(t.start, t.end)),
      text: line.text,
      ...(line.prev ? { prev: line.prev } : {}),
      ...(line.next ? { next: line.next } : {}),
    }));
}

interface Summary {
  model: string;
  error?: string;
  costPerEpisode: number;
  secondsPer40: number;
  unreadable: number;
  dropped: number;
  refused: number;
  word: number;
  functional: number;
  short: number;
  full: number;
}

async function runModel(model: string, price: Price, lines: RequestLine[], claude: Anthropic): Promise<Summary> {
  const results: Record<string, LineResult> = {};
  let cost = 0;
  let dropped = 0;
  let refused = 0;
  let unreadable = 0;
  let spent = 0;
  let batches = 0;
  const glossary: Record<string, string> = {};
  const system = systemPrompt('fr');

  for (let i = 0; i < lines.length; i += BATCH) {
    const batch = lines.slice(i, i + BATCH);
    const started = Date.now();
    if (price.provider === 'anthropic') {
      const out = await translateBatch(claude, model as ModelId, 'fr', batch, glossary);
      Object.assign(results, out.results);
      cost += out.costUsd;
      dropped += out.dropped;
      if (out.refused) refused++;
      if (out.unreadable) unreadable++;
    } else {
      const call = price.provider === 'openai' ? callOpenAI : callGoogle;
      const reply = await call(model, system, userPrompt(batch, glossary));
      cost += (reply.input * price.input + reply.output * price.output) / 1_000_000;
      let parsed: z.infer<typeof OutputSchema> | null = null;
      try {
        parsed = OutputSchema.parse(JSON.parse(reply.text));
      } catch {
        unreadable++;
      }
      const checked = validateLines(parsed?.lines ?? [], batch);
      Object.assign(results, checked.results);
      dropped += checked.dropped;
    }
    spent += Date.now() - started;
    batches++;
    for (const line of batch) {
      for (const unit of results[line.hash]?.units ?? []) {
        if (unit.end - unit.start <= 3) glossary[line.words.slice(unit.start, unit.end).join(' ').toLowerCase()] = unit.text;
      }
    }
  }

  writeFileSync(join(DATA_DIR, `out-${model}.json`), JSON.stringify({ model, lines, results, costUsd: cost }, null, 1));
  const share = (test: (l: RequestLine) => boolean) => Math.round((lines.filter(test).length / lines.length) * 100);
  const lengths = (l: RequestLine) => (results[l.hash]?.units ?? []).map((u) => u.end - u.start);
  return {
    model,
    costPerEpisode: (cost / lines.length) * EPISODE_LINES,
    secondsPer40: spent / batches / 1000,
    unreadable,
    dropped,
    refused,
    word: share((l) => lengths(l).includes(1)),
    functional: share((l) => lengths(l).some((n) => n >= 2 && n <= 3)),
    short: share((l) => lengths(l).some((n) => n >= 4 && n <= 5)),
    full: share((l) => !!results[l.hash]?.full),
  };
}

const lines = loadLines(Number(arg('lines', '40')));
const chosen = arg('models', Object.keys(MODELS).join(',')).split(',');
const claude = new Anthropic({ apiKey: secret('ANTHROPIC_API_KEY') });
mkdirSync(DATA_DIR, { recursive: true });
for (const f of readdirSync(DATA_DIR)) if (f.startsWith('out-')) rmSync(join(DATA_DIR, f));

const summaries = await Promise.all(
  chosen.map((model) =>
    runModel(model, MODELS[model]!, lines, claude).catch(
      (error: Error): Summary => ({ model, error: error.message.slice(0, 120), costPerEpisode: 0, secondsPer40: 0, unreadable: 0, dropped: 0, refused: 0, word: 0, functional: 0, short: 0, full: 0 }),
    ),
  ),
);
writeFileSync(join(DATA_DIR, 'summary.json'), JSON.stringify(summaries, null, 1));
console.table(
  summaries
    .sort((a, b) => a.costPerEpisode - b.costPerEpisode)
    .map((s) => ({
      model: s.model,
      '$/episode': s.error ? 'ERROR' : s.costPerEpisode.toFixed(2),
      's/40 lines': s.secondsPer40.toFixed(0),
      unreadable: s.unreadable,
      dropped: s.dropped,
      refused: s.refused,
      'word%': s.word,
      'func%': s.functional,
      'short%': s.short,
      'full%': s.full,
    })),
);
for (const s of summaries) if (s.error) console.log(s.model, s.error);
