// One batch of subtitle lines through Claude.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Language, LineResult, RequestLine } from '../../shared/protocol';
import { systemPrompt, userPrompt } from './prompt';
import { validateLines } from './validate';

export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';

const VERDICT = z.enum(['NATURAL', 'ACCEPTABLE', 'FAIL']);

const OutputSchema = z.object({
  lines: z.array(
    z.object({
      i: z.number().int(),
      units: z.array(
        z.object({
          start: z.number().int(),
          end: z.number().int(),
          text: z.string(),
          lemmas: z.array(z.string()),
          verdict: VERDICT,
        }),
      ),
      full: z.object({ text: z.string(), lemmas: z.array(z.string()), verdict: VERDICT }).nullable(),
    }),
  ),
});

/** $ per million tokens: input, output, cache read. Cache writes cost 1.25 × input. */
const PRICES: Record<ModelId, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** Roughly 100 output tokens a line, with room for thinking. */
const MAX_TOKENS = 16000;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costOf(model: ModelId, usage: Usage): number {
  const price = PRICES[model];
  const cost =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    (usage.cache_creation_input_tokens ?? 0) * price.input * 1.25;
  return cost / 1_000_000;
}

export interface BatchResult {
  results: Record<string, LineResult>;
  dropped: number;
  refused: boolean;
  costUsd: number;
  usage: Usage;
}

export async function translateBatch(
  client: Anthropic,
  model: ModelId,
  lang: Language,
  lines: RequestLine[],
  glossary: Record<string, string>,
): Promise<BatchResult> {
  const response = await client.beta.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    // On a safety decline, the API retries on another model when one can help.
    ...(model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    output_config: { effort: 'low', format: zodOutputFormat(OutputSchema) },
    system: [{ type: 'text', text: systemPrompt(lang), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt(lines, glossary) }],
  });

  const costUsd = costOf(model, response.usage);
  const empty = validateLines([], lines).results;
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    return { results: empty, dropped: 0, refused: response.stop_reason === 'refusal', costUsd, usage: response.usage };
  }

  const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  const parsed = OutputSchema.safeParse(safeJson(text));
  if (!parsed.success) return { results: empty, dropped: lines.length, refused: false, costUsd, usage: response.usage };
  return { ...validateLines(parsed.data.lines, lines), refused: false, costUsd, usage: response.usage };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
