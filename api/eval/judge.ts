// Scores each model's units with a separate Claude judge against the same rubric, and
// writes a blind sheet for a reader, with model names hidden.
//
//   npx tsx eval/judge.ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { LineResult, RequestLine } from '../../shared/protocol';
import { tokenize } from '../../extension/src/subtitles/hygiene';
import { systemPrompt } from '../src/prompt';
import { costOf } from '../src/translate';
import { loadApiKey } from './run';

const DATA_DIR = 'eval/data';
const JUDGE_MODEL = 'claude-opus-5-5';
const BATCH = 40;
const BLIND_ITEMS = 100;
const PARALLEL = 6;

const Verdicts = z.object({
  verdicts: z.array(z.object({ id: z.string(), verdict: z.enum(['NATURAL', 'ACCEPTABLE', 'GRAMMAR_ERROR', 'MISLEADING', 'INCOMPREHENSIBLE']), reason: z.string() })),
});

const JUDGE_PROMPT = `You judge French units shown inside English subtitles for a language-learning product. Be strict and independent: another system wrote these and may be wrong.

Below is the rubric that system followed. Apply its pass standard and rules. Give each item one verdict:
- NATURAL or ACCEPTABLE: passes.
- GRAMMAR_ERROR: a French form is wrong, or the switch breaks the sentence.
- MISLEADING: correct French, but the learner would learn a wrong meaning. Look hard for wrong word sense in this scene.
- INCOMPREHENSIBLE: the line no longer conveys the message.

Give a short reason in English.

RUBRIC:
`;

interface Item {
  id: string;
  model: string;
  kind: string;
  english: string;
  hybrid: string;
  before?: string;
  after?: string;
}

const itemId = (model: string, line: string, unit: string) => createHash('sha256').update(model + line + unit).digest('hex').slice(0, 8);

function hybridText(text: string, start: number, end: number, french: string): string {
  const tokens = tokenize(text);
  const first = tokens[start];
  const last = tokens[end - 1];
  if (!first || !last) return text;
  return `${text.slice(0, first.start)}<<${french}>>${text.slice(last.end)}`;
}

function collect(file: string): Item[] {
  const { model, lines, results } = JSON.parse(readFileSync(file, 'utf8')) as { model: string; lines: RequestLine[]; results: Record<string, LineResult> };
  const items: Item[] = [];
  for (const line of lines) {
    const context = { ...(line.prev ? { before: line.prev } : {}), ...(line.next ? { after: line.next } : {}) };
    const result = results[line.hash];
    for (const unit of result?.units ?? []) {
      const length = unit.end - unit.start;
      items.push({
        id: itemId(model, line.text, `${unit.start}-${unit.end}-${unit.text}`),
        model,
        kind: length === 1 ? 'word' : length <= 3 ? 'functional' : 'short',
        english: line.text,
        hybrid: hybridText(line.text, unit.start, unit.end, unit.text),
        ...context,
      });
    }
    if (result?.full) {
      items.push({ id: itemId(model, line.text, 'full'), model, kind: 'full', english: line.text, hybrid: `<<${result.full.text}>>`, ...context });
    }
  }
  return items;
}

function shuffled<T>(values: T[], key: (v: T) => string): T[] {
  return [...values].sort((a, b) => createHash('md5').update(key(a)).digest('hex').localeCompare(createHash('md5').update(key(b)).digest('hex')));
}

async function main() {
  const client = new Anthropic({ apiKey: loadApiKey() });
  const files = readdirSync(DATA_DIR).filter((f) => f.startsWith('out-')).map((f) => join(DATA_DIR, f));
  const items = files.flatMap(collect);
  const verdicts = new Map<string, { verdict: string; reason: string }>();
  let cost = 0;

  // Mixed across models, so the judge can't tell whose work it is reading.
  const queue = shuffled(items, (i) => i.id);
  const starts: number[] = [];
  for (let i = 0; i < queue.length; i += BATCH) starts.push(i);
  let done = 0;
  const judgeBatch = async (i: number) => {
    const batch = queue.slice(i, i + BATCH);
    const response = await client.messages.parse({
      model: JUDGE_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: zodOutputFormat(Verdicts) },
      system: [{ type: 'text', text: JUDGE_PROMPT + systemPrompt('fr'), cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: batch
          .map((it) => `Item ${it.id} (${it.kind})\nEnglish: ${it.english}\nShown, French in << >>: ${it.hybrid}${it.before ? `\nBefore: ${it.before}` : ''}${it.after ? `\nAfter: ${it.after}` : ''}`)
          .join('\n\n'),
      }],
    });
    cost += costOf(JUDGE_MODEL, response.usage);
    for (const v of response.parsed_output?.verdicts ?? []) verdicts.set(v.id, v);
    done += batch.length;
    console.log(`judged ${done}/${queue.length}`);
  };
  const worker = async () => {
    for (let next = starts.shift(); next !== undefined; next = starts.shift()) {
      await judgeBatch(next).catch((error: Error) => console.log('judge batch failed', error.message.slice(0, 100)));
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  console.log(`\njudge cost $${cost.toFixed(4)}\n`);
  const passes = (id: string) => ['NATURAL', 'ACCEPTABLE'].includes(verdicts.get(id)?.verdict ?? '');
  const summaries: { model: string; costPerEpisode: number }[] = JSON.parse(readFileSync(join(DATA_DIR, 'summary.json'), 'utf8'));
  const table = [...new Set(items.map((i) => i.model))].map((model) => {
    const mine = items.filter((i) => i.model === model && verdicts.has(i.id));
    const score = (subset: Item[]) => `${subset.filter((i) => passes(i.id)).length}/${subset.length}`;
    const count = (name: string) => mine.filter((i) => verdicts.get(i.id)!.verdict === name).length;
    return {
      model,
      '$/episode': summaries.find((s) => s.model === model)?.costPerEpisode.toFixed(2),
      phrases: score(mine.filter((i) => i.kind !== 'full')),
      full: score(mine.filter((i) => i.kind === 'full')),
      natural: `${Math.round((count('NATURAL') / Math.max(1, mine.length)) * 100)}%`,
      grammar: count('GRAMMAR_ERROR'),
      misleading: count('MISLEADING'),
      lost: count('INCOMPREHENSIBLE'),
    };
  });
  console.table(table);
  writeFileSync(join(DATA_DIR, 'judge-table.json'), JSON.stringify(table, null, 1));
  for (const model of [] as string[]) {
    const mine = items.filter((i) => i.model === model && verdicts.has(i.id));
    const line = (label: string, subset: Item[]) =>
      `${label} ${subset.filter((i) => passes(i.id)).length}/${subset.length} (${Math.round((subset.filter((i) => passes(i.id)).length / Math.max(1, subset.length)) * 100)}%)`;
    const partial = mine.filter((i) => i.kind !== 'full');
    console.log(`${model}: ${line('units', partial)} · ${line('full', mine.filter((i) => i.kind === 'full'))}`);
    for (const kind of ['word', 'functional', 'short']) console.log(`  ${line(kind, mine.filter((i) => i.kind === kind))}`);
    const counts: Record<string, number> = {};
    for (const i of mine) {
      const v = verdicts.get(i.id)!.verdict;
      if (!['NATURAL', 'ACCEPTABLE'].includes(v)) counts[v] = (counts[v] ?? 0) + 1;
    }
    console.log(`  failures ${JSON.stringify(counts)}`);
  }

  writeFileSync(join(DATA_DIR, 'judged.json'), JSON.stringify(items.map((i) => ({ ...i, ...verdicts.get(i.id) })), null, 1));
  const blind = shuffled(items, (i) => `blind${i.id}`).slice(0, BLIND_ITEMS);
  writeFileSync(
    join(DATA_DIR, 'blind-read.md'),
    blind.map((i) => `${i.id} [${i.kind}]\nEN: ${i.english}\nFR: ${i.hybrid}${i.before ? `\nbefore: ${i.before}` : ''}${i.after ? `\nafter: ${i.after}` : ''}\n`).join('\n'),
  );
  console.log(`\nwrote ${DATA_DIR}/judged.json and ${DATA_DIR}/blind-read.md`);
}

await main();
