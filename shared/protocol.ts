// The messages between the extension and the translation API.

export type Language = 'fr';

export interface RequestLine {
  /** Hash of the normalised English line. */
  hash: string;
  /** The line's non-punctuation words, in order. Units refer to them by index. */
  words: string[];
  /** The line as written, with punctuation. */
  text: string;
  /** Neighbouring lines, for context. */
  prev?: string;
  next?: string;
}

export interface TranslateRequest {
  videoId: string;
  lang: Language;
  lines: RequestLine[];
  /** Translations already chosen in this episode, so repeats stay consistent. */
  glossary: Record<string, string>;
}

export interface Unit {
  /** First English word replaced, and one past the last. */
  start: number;
  end: number;
  /** The French that replaces them. */
  text: string;
  /** French lemmas shown, lowercased, without names or numbers. */
  lemmas: string[];
  /** Higher is better: 2 natural, 1 acceptable. */
  score: number;
}

export interface LineResult {
  /** Single words and phrases. */
  units: Unit[];
  /** The whole line in French, if it passed. */
  full: { text: string; lemmas: string[] } | null;
}

export interface TranslateResponse {
  results: Record<string, LineResult>;
  /** What this request did, for the development label. */
  stats: { cached: number; translated: number; dropped: number; refused: boolean; costUsd: number };
}

export interface OverBudgetResponse {
  error: 'over_budget';
}

// ---- Tester study ----------------------------------------------------------------

/** How fast the speech in an episode is, in words per minute. */
export type PaceBucket = 'under90' | '90to120' | '120to150' | 'over150';
export type LengthBucket = 'short' | 'mid' | 'long';

/** Which of four groups a line falls in by how fast it is spoken, in words per second. */
export function speedBin(wps: number): 0 | 1 | 2 | 3 {
  return wps < 2 ? 0 : wps < 3 ? 1 : wps < 4 ? 2 : 3;
}

export function paceBucket(wordsPerMinute: number): PaceBucket {
  return wordsPerMinute < 90 ? 'under90' : wordsPerMinute < 120 ? '90to120' : wordsPerMinute < 150 ? '120to150' : 'over150';
}

/** By running time: under 25 minutes, 25 to 60, over 60. */
export function lengthBucket(seconds: number): LengthBucket {
  return seconds < 25 * 60 ? 'short' : seconds <= 60 * 60 ? 'mid' : 'long';
}

/** Which recall items were tested: by how often they had been shown. */
export type ExposureBucket = '25+' | '10-24' | '3-9' | '1-2' | 'control' | 'baseline';
export type Grade = 'correct' | 'close' | 'wrong' | 'noidea';

/**
 * Usage events. None of them carries subtitle text, a title or a video ID. The server
 * accepts only these shapes (api/src/events.ts) and rejects anything else.
 */
export type TelemetryEvent =
  | {
      kind: 'tick';
      /** Seconds of playback this covers. */
      secs: number;
      words: number;
      l2Words: number;
      lines: number;
      linesFrench: number;
      late: number;
      /** Units shown at each tier: single word, functional, short, full sentence. */
      tiers: [number, number, number, number];
      /** French units shown on lines spoken at under 2, 2 to 3, 3 to 4 and over 4 words a second (see speedBin). */
      bySpeed: [number, number, number, number];
      hour: number;
      pace: PaceBucket;
      build: string;
    }
  | { kind: 'reveal'; tier: 1 | 2 | 3 | 4; hour: number; wps: number; ms: number }
  | { kind: 'struggle'; type: 'pause' | 'rewind'; tier: 1 | 2 | 3 | 4; hour: number; wps: number }
  | { kind: 'rate'; enjoy: 1 | 2 | 3 | 4 | 5; follow: 'yes' | 'mostly' | 'no' }
  | {
      kind: 'episode';
      firstFrenchSecs: number | null;
      lines: number;
      lateLines: number;
      restarts: number;
      refetches: number;
      minutes: number;
      length: LengthBucket;
      pace: PaceBucket;
    }
  | { kind: 'error'; message: string; build: string }
  | { kind: 'problem'; message: string; build: string }
  | { kind: 'consent'; version: string }
  | {
      kind: 'recall';
      phase: 'baseline0' | 'baseline14' | 'check' | 'followup';
      n: number;
      bucket: ExposureBucket;
      /** Times shown when tested. Zero for controls and baseline words. */
      count: number;
      sinceLastDays: number | null;
      sinceFirstDays: number | null;
      grade: Grade;
      ms: number;
    };

export type EventKind = TelemetryEvent['kind'];

export interface EventsRequest {
  events: { at: number; event: TelemetryEvent }[];
}

/** A tester pressed R on French they thought was wrong. */
export interface ReportRequest {
  lang: Language;
  video: string;
  hash: string;
  start: number;
  /** One past the last English word, or -1 for a full-sentence line. */
  end: number;
  tier: 1 | 2 | 3 | 4;
  french: string;
  english: string;
  hour: number;
}

export interface GradeRequest {
  items: { french: string; gold: string; answer: string }[];
}

export interface GradeResponse {
  grades: Grade[];
}

export interface MeResponse {
  ok: true;
  label: string | null;
}
