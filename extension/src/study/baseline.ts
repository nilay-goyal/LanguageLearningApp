// Twenty common French words, asked on day 0 and again on day 14, to measure what each
// tester knew before and what they picked up. A French speaker checks these before use.

export interface BaselineWord {
  french: string;
  /** What a correct answer means. */
  gold: string;
}

export const BASELINE_WORDS: BaselineWord[] = [
  { french: 'maison', gold: 'house, home' },
  { french: 'travail', gold: 'work, job' },
  { french: 'enfant', gold: 'child' },
  { french: 'ville', gold: 'city, town' },
  { french: 'toujours', gold: 'always, still' },
  { french: 'jamais', gold: 'never, ever' },
  { french: 'demain', gold: 'tomorrow' },
  { french: 'hier', gold: 'yesterday' },
  { french: 'beaucoup', gold: 'a lot, many, much' },
  { french: 'chercher', gold: 'to look for, to search' },
  { french: 'parler', gold: 'to speak, to talk' },
  { french: 'manger', gold: 'to eat' },
  { french: 'pourquoi', gold: 'why' },
  { french: 'peut-être', gold: 'maybe, perhaps' },
  { french: 'comprendre', gold: 'to understand' },
  { french: 'petit', gold: 'small, little' },
  { french: 'nuit', gold: 'night' },
  { french: 'argent', gold: 'money, silver' },
  { french: 'vouloir', gold: 'to want' },
  { french: 'semaine', gold: 'week' },
];
