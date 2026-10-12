import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { mapWithConcurrency } from './pool.js';
import type { Answer, Question, ScoreAnswer, SystemOneClient, Usage } from './systemone.js';

export interface ToolDeps {
  client: SystemOneClient;
  config: Config;
}

const MAX_TEXTS = 100;
const QUESTION_KEY = 'q';

const texts = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_TEXTS)
  .describe(`1–${MAX_TEXTS} texts, each judged independently. Pass many at once to batch.`);

const model = z.string().min(1).optional().describe('Decision model to use. Omit for the server default.');

const optionKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Option names must be short identifiers');

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

type ItemResult = { index: number } & Record<string, unknown>;

/**
 * Sends one request per text and collects results in input order. A failing text
 * yields `{ index, error }` instead of failing the whole call; the call is an error
 * only when every text failed.
 */
async function runBatch<A extends Answer>(
  deps: ToolDeps,
  args: { texts: string[]; model?: string },
  question: Question,
  shape: (answer: A) => Record<string, unknown>,
): Promise<CallToolResult> {
  const modelName = args.model ?? deps.config.model;
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };

  const results = await mapWithConcurrency(args.texts, deps.config.concurrency, async (text, index): Promise<ItemResult> => {
    try {
      const res = await deps.client.decide({ model: modelName, state: text, questions: { [QUESTION_KEY]: question } });
      usage.input_tokens += res.usage?.input_tokens ?? 0;
      usage.output_tokens += res.usage?.output_tokens ?? 0;
      const answer = res.answers[QUESTION_KEY];
      if (!answer || answer.type !== question.type) {
        return { index, error: `Expected a "${question.type}" answer, got ${answer ? `"${answer.type}"` : 'none'}` };
      }
      return { index, ...shape(answer as A) };
    } catch (err) {
      return { index, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const allFailed = results.every((r) => 'error' in r);
  return {
    content: [{ type: 'text', text: JSON.stringify({ model: modelName, results, usage }) }],
    ...(allFailed ? { isError: true } : {}),
  };
}

/**
 * Shapes a `score` answer for the calling LLM.
 *
 * `answer.score` is the probability-weighted average of the zero-based levels, so
 * with 3 levels it lies in [0, 2]. `answer.probabilities` maps each level's
 * description to its probability; `answer.confidence` is in [0, 1].
 */
export function toScoreResult(answer: ScoreAnswer, levels: string[]): Record<string, unknown> {
  const max = levels.length - 1;
  const score = Math.min(Math.max(answer.score, 0), max);
  return {
    // The nearest level is what a caller usually acts on; score/max and confidence
    // keep the uncertainty visible (a 1.5 on a 0–2 scale is not a confident "Soon").
    level: levels[Math.round(score)],
    score: Math.round(score * 1000) / 1000,
    max,
    confidence: answer.confidence,
  };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'classify',
    {
      title: 'Classify text',
      description:
        'Pick the best label for each text from a fixed set, with calibrated per-label probabilities. ' +
        'Fast and cheap: prefer it over reasoning yourself when labelling many items or when you need a numeric confidence.',
      inputSchema: {
        texts,
        instructions: z.string().min(1).describe('What to decide, e.g. "Which team should handle this ticket?"'),
        options: z
          .record(optionKey, z.string().min(1))
          .refine((o) => Object.keys(o).length >= 2 && Object.keys(o).length <= 26, '2–26 options required')
          .describe('Label → short description, 2–26 entries. Example: {"bug": "Software errors", "billing": "Payments"}'),
        model,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runBatch<Extract<Answer, { type: 'choice' }>>(
        deps,
        args,
        { type: 'choice', instructions: args.instructions, criteria: args.options },
        (a) => ({ choice: a.choice, confidence: a.confidence, probabilities: a.probabilities }),
      ),
  );

  server.registerTool(
    'yes_no',
    {
      title: 'Yes/no probability',
      description:
        'Estimate the probability that the answer to a yes/no question is "yes", for each text. ' +
        'Returns a number in [0, 1]; pick your own threshold.',
      inputSchema: {
        texts,
        question: z.string().min(1).describe('A yes/no question, e.g. "Is the customer asking for a refund?"'),
        criteria: z
          .object({ true: z.string().min(1), false: z.string().min(1) })
          .optional()
          .describe('Optional: what "yes" and "no" mean, to sharpen borderline cases.'),
        model,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runBatch<Extract<Answer, { type: 'noul' }>>(
        deps,
        args,
        {
          type: 'noul',
          instructions: args.question,
          ...(args.criteria ? { criteria: { false: args.criteria.false, true: args.criteria.true } } : {}),
        },
        (a) => ({ probability_yes: a.noul }),
      ),
  );

  server.registerTool(
    'score',
    {
      title: 'Score on an ordered scale',
      description:
        'Rate each text on an ordered scale you define (e.g. severity, urgency, quality), lowest level first.',
      inputSchema: {
        texts,
        instructions: z.string().min(1).describe('What to rate, e.g. "How urgent is this ticket?"'),
        levels: z
          .array(z.string().min(1))
          .min(2)
          .max(26)
          .describe('2–26 level descriptions ordered from LOWEST to HIGHEST, e.g. ["Routine", "Soon", "Immediate"]'),
        model,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runBatch<ScoreAnswer>(
        deps,
        args,
        { type: 'score', instructions: args.instructions, criteria: args.levels },
        (a) => toScoreResult(a, args.levels),
      ),
  );
}
