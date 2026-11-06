// Builds the blind review sheets for French speakers from the judged eval items.
// Terra and Opus are mixed together and unlabelled, so reviewers can't tell them apart.
// An item that both models produced identically appears once and counts for both.
//
//   npx tsx eval/review-sheets.ts --reviewers 4
//
// Writes eval/data/review/review-sheet-A.csv ... and review-key.json (which models wrote
// each item, for scoring afterwards). All of it stays in the git-ignored data folder,
// because it contains subtitle lines.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = 'eval/data';
const OUT_DIR = join(DATA_DIR, 'review');
const TERRA = 'gpt-6.1-terra';
const OPUS = 'claude-opus-5-5';
const KINDS = ['word', 'functional', 'short', 'full'] as const;
type Kind = (typeof KINDS)[number];

/** Items per type, from Terra, and from Opus on the same lines. */
const TERRA_TARGET: Record<Kind, number> = { word: 30, functional: 50, short: 20, full: 20 };
const OPUS_TARGET: Record<Kind, number> = { word: 10, functional: 15, short: 5, full: 10 };
const SHARED_ITEMS = 40;

interface Judged {
  model: string;
  kind: Kind;
  english: string;
  hybrid: string;
  before?: string;
  after?: string;
}

interface Item {
  id: string;
  models: Set<string>;
  kind: Kind;
  english: string;
  hybrid: string;
  before?: string;
  after?: string;
}

const reviewers = Number(process.argv[process.argv.indexOf('--reviewers') + 1]) || 4;
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/** One item per distinct (line, shown text), remembering which models made it. */
const merged = new Map<string, Item>();
for (const row of JSON.parse(readFileSync(join(DATA_DIR, 'judged.json'), 'utf8')) as Judged[]) {
  if (row.model !== TERRA && row.model !== OPUS) continue;
  const key = `${row.english}\u0001${row.hybrid}`;
  const existing = merged.get(key);
  if (existing) existing.models.add(row.model);
  else merged.set(key, { id: md5(key).slice(0, 8), models: new Set([row.model]), kind: row.kind, english: row.english, hybrid: row.hybrid, before: row.before, after: row.after });
}
const items = [...merged.values()];

/** A fixed order from hashing, so the sheets are the same every time they are built. */
const order = <T>(values: T[], salt: string, key: (v: T) => string) =>
  [...values].sort((a, b) => md5(salt + key(a)).localeCompare(md5(salt + key(b))));

const chosen = new Set<string>();
const pick = (model: string, kind: Kind, count: number, prefer?: Set<string>) => {
  const pool = order(items.filter((i) => i.models.has(model) && i.kind === kind && !chosen.has(i.id)), 'pick', (i) => i.id);
  const preferred = pool.filter((i) => prefer?.has(i.english));
  const picked = [...preferred, ...pool.filter((i) => !preferred.includes(i))].slice(0, count);
  for (const item of picked) chosen.add(item.id);
  return picked;
};

const terra = KINDS.flatMap((kind) => pick(TERRA, kind, TERRA_TARGET[kind]));
const sameLines = new Set(terra.map((i) => i.english));
const opus = KINDS.flatMap((kind) => pick(OPUS, kind, OPUS_TARGET[kind], sameLines));
const pool = [...terra, ...opus];

const shared = order(pool, 'shared', (i) => i.id).slice(0, SHARED_ITEMS);
const sharedIds = new Set(shared.map((i) => i.id));
const rest = order(pool.filter((i) => !sharedIds.has(i.id)), 'rest', (i) => i.id);
const perReviewer = Math.floor(rest.length / reviewers);

const quote = (value: string | undefined) => `"${(value ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
mkdirSync(OUT_DIR, { recursive: true });

const letters = 'ABCDEFGH';
for (let r = 0; r < reviewers; r++) {
  const own = rest.slice(r * perReviewer, (r + 1) * perReviewer);
  const rows = order([...shared, ...own], `reviewer${r}`, (i) => i.id).map((i) =>
    [i.id, i.kind, i.before, i.english, i.hybrid, i.after, '', ''].map(quote).join(','),
  );
  const header = ['id', 'type', 'line before', 'English line', 'as shown (French in << >>)', 'line after', 'verdict', 'comment'];
  // The byte order mark makes Excel and Google Sheets read the accents correctly.
  writeFileSync(join(OUT_DIR, `review-sheet-${letters[r]}.csv`), '﻿' + [header.map(quote).join(','), ...rows].join('\n'));
}

writeFileSync(
  join(OUT_DIR, 'review-key.json'),
  JSON.stringify({ shared: [...sharedIds], items: Object.fromEntries(pool.map((i) => [i.id, { models: [...i.models], kind: i.kind }])) }, null, 1),
);

const count = (list: Item[]) => KINDS.map((k) => `${k} ${list.filter((i) => i.kind === k).length}`).join(', ');
const both = pool.filter((i) => i.models.size > 1).length;
console.log(`pool ${pool.length} distinct items: from Terra ${terra.length} (${count(terra)}), from Opus ${opus.length} (${count(opus)}); ${both} were identical in both models`);
console.log(`${reviewers} sheets of ${SHARED_ITEMS + perReviewer} items each (${SHARED_ITEMS} shared by everyone), in ${OUT_DIR}`);
