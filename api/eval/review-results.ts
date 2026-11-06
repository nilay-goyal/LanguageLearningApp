// Scores the sheets that reviewers send back.
//
//   npx tsx eval/review-results.ts path/to/sheet-A-done.csv path/to/sheet-B-done.csv ...
//
// Reads the "verdict" column, which should be one of OK, GRAMMAR, MEANING, AWKWARD or REGION.
import { readFileSync } from 'node:fs';

interface Key {
  shared: string[];
  items: Record<string, { models: string[]; kind: string }>;
}
const key = JSON.parse(readFileSync('eval/data/review/review-key.json', 'utf8')) as Key;
const VERDICTS = ['OK', 'GRAMMAR', 'MEANING', 'AWKWARD', 'REGION'];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('give the returned CSV files');

const byReviewer: Record<string, string>[] = files.map((file) => {
  const [header, ...rows] = parseCsv(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const id = header!.indexOf('id');
  const verdict = header!.indexOf('verdict');
  const out: Record<string, string> = {};
  for (const row of rows) {
    const v = (row[verdict] ?? '').trim().toUpperCase();
    if (row[id] && VERDICTS.includes(v)) out[row[id]!] = v;
  }
  return out;
});

const unanswered = byReviewer.map((r, i) => `${files[i]}: ${Object.keys(r).length} answered`);
console.log(unanswered.join('\n'));

// "Regional" differences aren't errors: the item is judged correct for the purposes of the gate.
const ok = (v: string) => v === 'OK' || v === 'REGION' || v === 'AWKWARD';
const strictOk = (v: string) => v === 'OK' || v === 'REGION';

interface Tally { n: number; ok: number; strict: number }
const tallies = new Map<string, Tally>();
const add = (label: string, v: string) => {
  const t = tallies.get(label) ?? { n: 0, ok: 0, strict: 0 };
  t.n++;
  if (ok(v)) t.ok++;
  if (strictOk(v)) t.strict++;
  tallies.set(label, t);
};

for (const reviewer of byReviewer) {
  for (const [id, v] of Object.entries(reviewer)) {
    const item = key.items[id];
    if (!item) continue;
    add('all', v);
    add(`type ${item.kind}`, v);
    // An item both models produced identically counts for both.
    for (const model of item.models) {
      add(`model ${model}`, v);
      add(`${model} ${item.kind}`, v);
    }
  }
}

const pct = (a: number, n: number) => `${Math.round((a / Math.max(1, n)) * 100)}%`;
console.log('\n"correct" counts OK, REGION and AWKWARD as passing; "natural" counts only OK and REGION.');
console.table(
  [...tallies.entries()].sort().map(([label, t]) => ({ group: label, items: t.n, correct: pct(t.ok, t.n), natural: pct(t.strict, t.n) })),
);

// Agreement on the items everyone read.
const reviewersWhoRead = (id: string) => byReviewer.filter((r) => r[id]);
const sharedRead = key.shared.filter((id) => reviewersWhoRead(id).length === byReviewer.length);
let agree = 0;
for (const id of sharedRead) {
  const passes = byReviewer.map((r) => ok(r[id]!));
  if (passes.every((p) => p === passes[0])) agree++;
}
console.log(`\nShared items read by every reviewer: ${sharedRead.length}. They agree on pass or fail for ${pct(agree, sharedRead.length)}.`);

const terraOk = tallies.get(`model gpt-6.1-terra`);
const opusOk = tallies.get(`model claude-opus-5-5`);
if (terraOk && opusOk) console.log(`Terra ${pct(terraOk.ok, terraOk.n)} against Opus ${pct(opusOk.ok, opusOk.n)}, on ${terraOk.n} and ${opusOk.n} verdicts.`);

const gate = tallies.get('model gpt-6.1-terra');
if (gate) console.log(`\nGate (90% overall, 85% per type): ${gate.ok / gate.n >= 0.9 ? 'overall passes' : 'overall FAILS'}`);
for (const kind of ['word', 'functional', 'short', 'full']) {
  const t = tallies.get(`gpt-6.1-terra ${kind}`);
  if (t) console.log(`  ${kind}: ${pct(t.ok, t.n)} ${t.ok / t.n >= 0.85 ? 'passes' : 'FAILS'} (${t.n} verdicts)`);
}
