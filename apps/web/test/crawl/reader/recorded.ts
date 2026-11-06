import type Anthropic from '@anthropic-ai/sdk';

// Model output in the shape the Messages API and the Batches API return it,
// for the reader's unit tests. These are written by hand in the API's shape:
// no paid run has recorded real ones yet. Each test that reads one says what
// the model got right or wrong in it, so the code around the model is
// tested both ways.

/** A message the model ended on its own, with the JSON as its text. */
export function message(json: unknown, stop: Anthropic.Messages.StopReason = 'end_turn'): Anthropic.Messages.Message {
  return {
    id: 'msg_recorded',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'recorded' },
      { type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json), citations: null },
    ],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 812,
      output_tokens: 4_120,
      cache_creation_input_tokens: 4_310,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 4_310, ephemeral_5m_input_tokens: 0 },
      server_tool_use: null,
      service_tier: 'batch',
      inference_geo: null,
    },
  } as unknown as Anthropic.Messages.Message;
}

/** A statement as the model writes one. */
export const statement = (
  path: string,
  startLine: number,
  endLine: number,
  quote: string,
  about: string,
  extra: { label?: string | null; value?: string | null; why?: string } = {},
) => ({ path, startLine, endLine, quote, about, label: extra.label ?? null, value: extra.value ?? null, why: extra.why ?? 'Recorded.' });

/** A policy reading as the model writes one. */
export const policyOutput = (statements: unknown[], tier: string, steering: unknown[] = [], summary = 'Recorded summary.') => ({
  statements,
  tier,
  steering,
  summary,
});
