// "This French is wrong": reports from testers, and hiding units that get reported.

import { z } from 'zod';
import type { LineResult } from '../../shared/protocol';
import type { Tester } from './auth';

const ReportSchema = z.object({
  lang: z.literal('fr'),
  video: z.string().min(1).max(40),
  hash: z.string().min(8).max(128),
  start: z.number().int().min(0).max(200),
  end: z.number().int().min(-1).max(200),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  french: z.string().min(1).max(300),
  english: z.string().min(1).max(700),
  hour: z.number().finite().min(0).max(100_000),
});

/** Different testers who must report a unit before it is hidden for everyone. */
export const SUPPRESS_AFTER_TESTERS = 2;
const MAX_REPORTS_PER_DAY = 200;
const DAY_MS = 24 * 3600 * 1000;

export type ReportResult = { ok: true; suppressed: boolean } | { ok: false; status: 400 | 429 };

export async function storeReport(db: D1Database, tester: Tester, input: unknown, version: number, now = Date.now()): Promise<ReportResult> {
  const parsed = ReportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400 };
  const r = parsed.data;

  const today = await db
    .prepare('SELECT COUNT(*) AS n FROM reports WHERE tester = ? AND at > ?')
    .bind(tester.id, now - DAY_MS)
    .first<number>('n');
  if ((today ?? 0) >= MAX_REPORTS_PER_DAY) return { ok: false, status: 429 };

  await db
    .prepare('INSERT INTO reports (tester, at, lang, video, hash, unit_start, unit_end, tier, french, english, hour, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(tester.id, now, r.lang, r.video, r.hash, r.start, r.end, r.tier, r.french, r.english, r.hour, version)
    .run();

  const testers = await db
    .prepare('SELECT COUNT(DISTINCT tester) AS n FROM reports WHERE lang = ? AND video = ? AND hash = ? AND unit_start = ? AND unit_end = ?')
    .bind(r.lang, r.video, r.hash, r.start, r.end)
    .first<number>('n');
  const suppressed = (testers ?? 0) >= SUPPRESS_AFTER_TESTERS;
  if (suppressed) {
    await db
      .prepare('INSERT OR IGNORE INTO suppressed (version, lang, video, hash, unit_start, unit_end) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(version, r.lang, r.video, r.hash, r.start, r.end)
      .run();
  }
  return { ok: true, suppressed };
}

/** Takes hidden units out of results that are about to be sent. Returns how many were hidden. */
export async function applySuppression(
  db: D1Database,
  version: number,
  lang: string,
  video: string,
  results: Record<string, LineResult>,
): Promise<number> {
  const hashes = Object.keys(results);
  if (hashes.length === 0) return 0;
  const hidden = await db
    .prepare(`SELECT hash, unit_start, unit_end FROM suppressed WHERE version = ? AND lang = ? AND video = ? AND hash IN (${hashes.map(() => '?').join(',')})`)
    .bind(version, lang, video, ...hashes)
    .all<{ hash: string; unit_start: number; unit_end: number }>();

  let count = 0;
  for (const row of hidden.results) {
    const line = results[row.hash];
    if (!line) continue;
    if (row.unit_end === -1) {
      if (line.full) {
        line.full = null;
        count++;
      }
      continue;
    }
    const kept = line.units.filter((u) => !(u.start === row.unit_start && u.end === row.unit_end));
    count += line.units.length - kept.length;
    line.units = kept;
  }
  return count;
}
