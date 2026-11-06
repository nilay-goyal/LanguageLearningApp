// Usage events from testers. Every shape is listed here and nothing else is accepted, so
// subtitle text, titles and video IDs can't end up in the data, even by mistake.

import { z } from 'zod';
import type { EventsRequest } from '../../shared/protocol';
import type { Tester } from './auth';

const num = (max = 1_000_000) => z.number().finite().min(-1).max(max);
const tier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const pace = z.enum(['under90', '90to120', '120to150', 'over150']);
const build = z.string().max(24);
/** Error messages are cut short and checked against letters-only subtitle-like text by the client. */
const message = z.string().max(160);

const EventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tick'),
      secs: num(3600),
      words: num(),
      l2Words: num(),
      lines: num(),
      linesFrench: num(),
      late: num(),
      tiers: z.tuple([num(), num(), num(), num()]),
      bySpeed: z.tuple([num(), num(), num(), num()]),
      hour: num(),
      pace,
      build,
    })
    .strict(),
  z.object({ kind: z.literal('reveal'), tier, hour: num(), wps: num(100), ms: num(600_000) }).strict(),
  z.object({ kind: z.literal('struggle'), type: z.enum(['pause', 'rewind']), tier, hour: num(), wps: num(100) }).strict(),
  z
    .object({
      kind: z.literal('rate'),
      enjoy: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      follow: z.enum(['yes', 'mostly', 'no']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('episode'),
      firstFrenchSecs: num(100_000).nullable(),
      lines: num(),
      lateLines: num(),
      restarts: num(),
      refetches: num(),
      minutes: num(10_000),
      length: z.enum(['short', 'mid', 'long']),
      pace,
    })
    .strict(),
  z.object({ kind: z.literal('error'), message, build }).strict(),
  z.object({ kind: z.literal('problem'), message, build }).strict(),
  z.object({ kind: z.literal('consent'), version: z.string().max(24) }).strict(),
  z
    .object({
      kind: z.literal('recall'),
      phase: z.enum(['baseline0', 'baseline14', 'check', 'followup']),
      n: num(100),
      bucket: z.enum(['25+', '10-24', '3-9', '1-2', 'control', 'baseline']),
      count: num(),
      sinceLastDays: num(10_000).nullable(),
      sinceFirstDays: num(10_000).nullable(),
      grade: z.enum(['correct', 'close', 'wrong', 'noidea']),
      ms: num(3_600_000),
    })
    .strict(),
]);

const RequestSchema = z.object({
  events: z.array(z.object({ at: z.number().finite(), event: EventSchema })).min(1).max(100),
});

/** More than this in a day is a bug or abuse. */
export const MAX_EVENTS_PER_DAY = 20_000;
const DAY_MS = 24 * 3600 * 1000;

export type EventsResult = { ok: true; stored: number } | { ok: false; status: 400 | 429 };

export async function storeEvents(db: D1Database, tester: Tester, input: unknown, now = Date.now()): Promise<EventsResult> {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400 };

  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE tester = ? AND at > ?')
    .bind(tester.id, now - DAY_MS)
    .first<number>('n');
  if ((recent ?? 0) >= MAX_EVENTS_PER_DAY) return { ok: false, status: 429 };

  const insert = db.prepare('INSERT INTO events (tester, at, kind, data) VALUES (?, ?, ?, ?)');
  await db.batch(parsed.data.events.map(({ at, event }) => {
    const { kind, ...data } = event;
    // Times from a tester's clock are kept, but pulled into a sensible range.
    const when = Math.min(Math.max(at, now - 7 * DAY_MS), now + 5 * 60 * 1000);
    return insert.bind(tester.id, Math.round(when), kind, JSON.stringify(data));
  }));
  return { ok: true, stored: parsed.data.events.length };
}

export type { EventsRequest };
