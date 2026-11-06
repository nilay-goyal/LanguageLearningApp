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
