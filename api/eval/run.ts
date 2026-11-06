// Runs subtitle lines through each model with the production prompt, and measures
// cost, speed and how many usable units each produces. Real subtitle lines stay in
// eval/data/, which git ignores because they are copyrighted.
//
//   npx tsx eval/run.ts --lines 200 --models claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LineResult, RequestLine } from '../../shared/protocol';
import { tokenize } from '../../extension/src/subtitles/hygiene';
import { type ModelId, translateBatch } from '../src/translate';

const DATA_DIR = 'eval/data';
const BATCH = 40;

interface ExportedLine {
  text: string;
  prev?: string;
  next?: string;
}

export function loadApiKey(): string {
  const match = readFileSync('.dev.vars', 'utf8').match(/ANTHROPIC_API_KEY=(\S+)/);
  if (!match?.[1]) throw new Error('ANTHROPIC_API_KEY missing from .dev.vars');
  return match[1];
}

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

/** Evenly spaced runs of lines from each exported episode, or the made-up sample if none exist. */
function loadLines(count: number): RequestLine[] {
  const files = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => f.startsWith('subtitle-lines')) : [];
  const sources: ExportedLine[][] = files.map((f) => (JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')) as { lines: ExportedLine[] }).lines);
  if (sources.length === 0) sources.push((JSON.parse(readFileSync('eval/sample-lines.json', 'utf8')) as { lines: ExportedLine[] }).lines);
  console.log(`${sources.length} source(s), ${files.length ? 'real exports' : 'made-up sample'}`);

  const perSource = Math.ceil(count / sources.length);
  const picked = sources.flatMap((lines) => {
    const start = Math.max(0, Math.floor((lines.length - perSource) / 2));
    return lines.slice(start, start + perSource);
  });
  return picked.slice(0, count).map((line) => {
    const words = tokenize(line.text).map((t) => line.text.slice(t.start, t.end));
    return {
      hash: createHash('sha256').update(line.text).digest('hex').slice(0, 32),
      words,
      text: line.text,
      ...(line.prev ? { prev: line.prev } : {}),
      ...(line.next ? { next: line.next } : {}),
    };
  });
}

function share(values: boolean[]): string {
  return `${Math.round((values.filter(Boolean).length / Math.max(1, values.length)) * 100)}%`;
}

async function main() {
  const lines = loadLines(Number(arg('lines', '200')));
  const models = arg('models', 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5').split(',') as ModelId[];
  const client = new Anthropic({ apiKey: loadApiKey() });
  mkdirSync(DATA_DIR, { recursive: true });

  for (const model of models) {
    const started = Date.now();
    const results: Record<string, LineResult> = {};
    let costUsd = 0;
    let dropped = 0;
    let refused = 0;
    let cacheRead = 0;
    let slowest = 0;
    const glossary: Record<string, string> = {};
    for (let i = 0; i < lines.length; i += BATCH) {
      const batch = lines.slice(i, i + BATCH);
      const batchStart = Date.now();
      const out = await translateBatch(client, model, 'fr', batch, glossary);
      slowest = Math.max(slowest, Date.now() - batchStart);
      Object.assign(results, out.results);
      costUsd += out.costUsd;
      dropped += out.dropped;
      if (out.refused) refused++;
      cacheRead += out.usage.cache_read_input_tokens ?? 0;
      console.log(`  batch ${i}: stop ${out.stopReason}, unreadable ${out.unreadable}, output tokens ${out.usage.output_tokens}`);
      for (const line of batch) {
        for (const unit of out.results[line.hash]?.units ?? []) {
          if (unit.end - unit.start <= 3) glossary[line.words.slice(unit.start, unit.end).join(' ').toLowerCase()] = unit.text;
        }
      }
    }
    const unitsOf = (l: RequestLine) => results[l.hash]?.units ?? [];
    const lengths = (l: RequestLine) => unitsOf(l).map((u) => u.end - u.start);
    const costPerLine = costUsd / lines.length;
    console.log(`\n${model}`);
    console.log(`  cost $${costUsd.toFixed(4)} (${lines.length} lines), about $${(costPerLine * 564).toFixed(2)} for a 564-line episode`);
    console.log(`  time ${((Date.now() - started) / 1000).toFixed(0)} s, slowest batch of ${BATCH}: ${(slowest / 1000).toFixed(1)} s`);
    console.log(`  lines with a single word ${share(lines.map((l) => lengths(l).includes(1)))}`);
    console.log(`  lines with a functional phrase ${share(lines.map((l) => lengths(l).some((n) => n >= 2 && n <= 3)))} (research: 74%)`);
    console.log(`  lines with a short phrase ${share(lines.map((l) => lengths(l).some((n) => n >= 4 && n <= 5)))} (research: 45%)`);
    console.log(`  lines with a full sentence ${share(lines.map((l) => !!results[l.hash]?.full))}`);
    console.log(`  dropped by validation ${dropped}, refused batches ${refused}, cache read tokens ${cacheRead}`);
    writeFileSync(join(DATA_DIR, `out-${model}.json`), JSON.stringify({ model, lines, results, costUsd }, null, 1));
  }
}

if (process.argv[1]?.endsWith('run.ts')) await main();
