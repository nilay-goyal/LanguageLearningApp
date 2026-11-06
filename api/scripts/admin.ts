// Runs the study from your computer. Nothing here is reachable over the internet.
//
//   npx tsx scripts/admin.ts invite 10 --prefix T        make 10 invite codes (T01 to T10)
//   npx tsx scripts/admin.ts revoke T03                  switch one off
//   npx tsx scripts/admin.ts status                      who is using it, spending, open reports
//   npx tsx scripts/admin.ts reports                     write open reports to eval/data/reports.csv
//   npx tsx scripts/admin.ts confirm 12                  hide report 12's unit for everyone
//   npx tsx scripts/admin.ts dismiss 12                  close report 12 without hiding it
//   npx tsx scripts/admin.ts analyze                     the study's numbers and gates
//
// Add --local to use a local test database instead of the live one.
import { spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineGrowth, bySpeed, engagement, gates, recall, type StoredEvent, summarise } from '../analysis/analysis';

const DATABASE = 'subtitle-learning';
const local = process.argv.includes('--local');
const args = process.argv.slice(2).filter((a) => a !== '--local');
const [command = '', ...rest] = args;

/** Letters and digits that can't be mistaken for each other. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SAFE = /^[A-Za-z0-9_-]{1,16}$/;

/** The SQL goes in a file, because a command line can't carry it safely on every system. */
function run<T = Record<string, unknown>>(sql: string): T[] {
  const dir = mkdtempSync(join(tmpdir(), 'study-'));
  const file = join(dir, 'query.sql');
  writeFileSync(file, sql);
  try {
    const result = spawnSync('npx', ['wrangler', 'd1', 'execute', DATABASE, local ? '--local' : '--remote', '--yes', '--json', '--file', `"${file}"`], {
      encoding: 'utf8',
      shell: true,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`database command failed: ${(result.stderr || result.stdout).slice(0, 400)}`);
    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('['))) as { results: T[] }[];
    // A file can hold several statements, so the answer is the last one's.
    return parsed.at(-1)?.results ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const code = () => {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `FR-${group()}-${group()}-${group()}`;
};
const hashOf = (value: string) => createHash('sha256').update(value.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

function invite() {
  const count = Number(rest[0]);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('say how many codes, from 1 to 50');
  const prefixFlag = rest.indexOf('--prefix');
  const prefix = prefixFlag >= 0 ? rest[prefixFlag + 1]! : 'T';
  const capFlag = rest.indexOf('--cap');
  const cap = capFlag >= 0 ? Number(rest[capFlag + 1]) : 2;
  if (!SAFE.test(prefix) || !(cap > 0 && cap <= 50)) throw new Error('bad --prefix or --cap');

  const existing = run<{ n: number }>("SELECT COUNT(*) AS n FROM testers WHERE label LIKE '" + prefix + "%'")[0]?.n ?? 0;
  const lines: string[] = [];
  const values: string[] = [];
  for (let i = 1; i <= count; i++) {
    const label = `${prefix}${String(existing + i).padStart(2, '0')}`;
    const c = code();
    values.push(`('${hashOf(c)}', '${label}', ${cap}, '${new Date().toISOString()}')`);
    lines.push(`${label}   ${c}`);
  }
  run(`INSERT INTO testers (code_hash, label, daily_cap_usd, created_at) VALUES ${values.join(', ')}`);
  console.log('Give each tester their own code. The codes are not stored anywhere else, so keep this list:\n');
  console.log(lines.join('\n'));
}

function revoke() {
  const label = rest[0];
  if (!label || !SAFE.test(label)) throw new Error('give a label such as T03');
  run(`UPDATE testers SET revoked = 1 WHERE label = '${label}'`);
  console.log(`${label} switched off.`);
}

function status() {
  const testers = run<{ label: string; revoked: number; deleted_at: string | null; spent: number | null; events: number }>(
    "SELECT t.label, t.revoked, t.deleted_at, (SELECT COALESCE(SUM(usd), 0) FROM tester_spend s WHERE s.tester = substr(t.code_hash, 1, 16)) AS spent, (SELECT COUNT(*) FROM events e WHERE e.tester = substr(t.code_hash, 1, 16)) AS events FROM testers t ORDER BY t.label",
  );
  console.table(testers.map((t) => ({ label: t.label, state: t.deleted_at ? 'deleted data' : t.revoked ? 'off' : 'on', events: t.events, spent: `$${(t.spent ?? 0).toFixed(2)}` })));
  const today = run<{ usd: number }>(`SELECT usd FROM spend WHERE day = '${new Date().toISOString().slice(0, 10)}'`)[0]?.usd ?? 0;
  const total = run<{ usd: number }>('SELECT COALESCE(SUM(usd), 0) AS usd FROM spend')[0]?.usd ?? 0;
  const open = run<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'")[0]?.n ?? 0;
  console.log(`Spent today $${today.toFixed(2)}, in total $${total.toFixed(2)}. Open reports: ${open}.`);
}

function reports() {
  const rows = run<Record<string, string | number>>("SELECT id, at, video, hash, unit_start, unit_end, tier, french, english, hour FROM reports WHERE status = 'open' ORDER BY id");
  const quote = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['id', 'tier', 'French shown', 'English line', 'hour', 'verdict', 'comment'];
  const lines = rows.map((r) => [r.id, r.tier, r.french, r.english, r.hour, '', ''].map(quote).join(','));
  mkdirSync('eval/data', { recursive: true });
  writeFileSync('eval/data/reports.csv', '﻿' + [header.map(quote).join(','), ...lines].join('\n'));
  console.log(`${rows.length} open reports written to eval/data/reports.csv (git ignores it: it holds subtitle lines).`);
}

function settle(action: 'confirm' | 'dismiss') {
  const id = Number(rest[0]);
  if (!Number.isInteger(id)) throw new Error('give a report number');
  if (action === 'confirm') {
    run(`INSERT OR IGNORE INTO suppressed (version, lang, video, hash, unit_start, unit_end) SELECT version, lang, video, hash, unit_start, unit_end FROM reports WHERE id = ${id}`);
    run(`UPDATE reports SET status = 'confirmed' WHERE id = ${id}`);
    console.log(`Report ${id} confirmed: that unit is now hidden for everyone.`);
  } else {
    run(`UPDATE reports SET status = 'dismissed' WHERE id = ${id}`);
    console.log(`Report ${id} dismissed.`);
  }
}

function analyze() {
  const events = run<{ tester: string; at: number; kind: string; data: string }>('SELECT tester, at, kind, data FROM events ORDER BY at').map(
    (e): StoredEvent => ({ tester: e.tester, at: e.at, kind: e.kind, data: JSON.parse(e.data) }),
  );
  const reportCount = run<{ n: number }>('SELECT COUNT(*) AS n FROM reports')[0]?.n ?? 0;
  const spend = run<{ usd: number }>('SELECT COALESCE(SUM(usd), 0) AS usd FROM spend')[0]?.usd ?? 0;
  const per = engagement(events);
  const summary = summarise(events, reportCount);
  const recalled = recall(events);
  const pct = (r: { rate: number; low: number; high: number } | null) => (r ? `${Math.round(r.rate * 100)}% (${Math.round(r.low * 100)} to ${Math.round(r.high * 100)})` : '-');

  console.log(`\n${events.length} events from ${summary.testers} testers, ${Math.round(summary.minutes)} minutes watched. Spent $${spend.toFixed(2)}.\n`);
  console.log('Use per tester');
  console.table(per.map((p) => ({ tester: p.tester, from: p.firstDay, to: p.lastDay, minutes: Math.round(p.minutes), 'hours advanced': p.hoursAdvanced.toFixed(1), 'days with 20+ min': p.activeDays })));
  console.log('Hold E and pausing, by how fast the line is spoken (the fast-show question)');
  console.table(bySpeed(events).map((r) => ({ speed: r.bin, 'French shown': r.unitsShown, presses: r.reveals, 'per 100': r.revealsPer100?.toFixed(1) ?? '-', 'pauses and rewinds': r.struggles, 'per 100 ': r.strugglesPer100?.toFixed(1) ?? '-' })));
  console.log('Recall, with a 95% range (all checks, then only words tested 3+ days after last shown)');
  console.table(recalled.map((r) => ({ group: r.group, items: r.items, correct: pct(r.correct), 'correct or close': pct(r.correctOrClose) })));
  console.table(recall(events, 3).map((r) => ({ group: `${r.group} (3+ days)`, items: r.items, correct: pct(r.correct) })));
  console.log('20-word baseline, day 0 and day 14');
  console.table(baselineGrowth(events));
  console.log('Gates (reviewer quality is scored separately, with review-results.ts)');
  console.table(gates(summary, per, recalled).map((g) => ({ gate: g.gate, result: g.result, met: g.pass ? 'yes' : 'no' })));
}

const commands: Record<string, () => void> = {
  invite,
  revoke,
  status,
  reports,
  confirm: () => settle('confirm'),
  dismiss: () => settle('dismiss'),
  analyze,
};
const chosen = commands[command];
if (!chosen) {
  console.log('Commands: invite <count> [--prefix T] [--cap 2], revoke <label>, status, reports, confirm <id>, dismiss <id>, analyze  (add --local for a test database)');
  process.exit(1);
}
chosen();
