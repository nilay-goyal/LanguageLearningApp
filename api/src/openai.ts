// One batch of subtitle lines through OpenAI, for models that win the eval.

import { z } from 'zod';
import type { Language, RequestLine } from '../../shared/protocol';
import { systemPrompt, userPrompt } from './prompt';
import type { BatchResult } from './translate';
import { OutputSchema } from './translate';
import { validateLines } from './validate';

/** $ per million tokens, from OpenAI's pricing page (read 2026-11-06). */
export const OPENAI_PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, output: 5 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
};

const MAX_OUTPUT_TOKENS = 16000;

function outputSchema(): Record<string, unknown> {
  const { $schema: _unused, ...schema } = z.toJSONSchema(OutputSchema) as Record<string, unknown>;
  return schema;
}

interface OpenAIResponse {
  status?: string;
  output?: { content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

export class OpenAIError extends Error {
  constructor(public status: number) {
    super(`OpenAI error ${status}`);
  }
}

export function costOfOpenAI(model: string, usage: OpenAIResponse['usage']): number {
  const price = OPENAI_PRICES[model];
  if (!price) throw new Error(`no price for ${model}`);
  const input = usage?.input_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  return ((input - cached) * price.input + cached * price.cachedInput + (usage?.output_tokens ?? 0) * price.output) / 1_000_000;
}

export async function translateBatchOpenAI(
  apiKey: string,
  model: string,
  lang: Language,
  lines: RequestLine[],
  glossary: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<BatchResult> {
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      instructions: systemPrompt(lang),
      input: userPrompt(lines, glossary),
      max_output_tokens: MAX_OUTPUT_TOKENS,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'subtitle_units', strict: true, schema: outputSchema() } },
    }),
  });
  if (!response.ok) throw new OpenAIError(response.status);

  const body = (await response.json()) as OpenAIResponse;
  const parts = (body.output ?? []).flatMap((item) => item.content ?? []);
  const refused = parts.some((part) => part.type === 'refusal');
  const text = parts.flatMap((part) => (part.type === 'output_text' && part.text ? [part.text] : [])).join('');
  const costUsd = costOfOpenAI(model, body.usage);
  const usage = { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 };
  const stopReason = refused ? 'refusal' : (body.status ?? null);
  const empty = validateLines([], lines).results;

  let parsed: z.infer<typeof OutputSchema> | null = null;
  try {
    parsed = OutputSchema.parse(JSON.parse(text));
  } catch {
    // Handled below: nothing is cached, and the lines stay English.
  }
  if (!parsed || body.status !== 'completed') {
    return { results: empty, dropped: 0, refused, costUsd, usage, stopReason, unreadable: !refused };
  }
  return { ...validateLines(parsed.lines, lines), refused: false, costUsd, usage, stopReason, unreadable: false };
}
