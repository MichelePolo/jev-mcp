// Wire types mirror ollama/ollama decision/types.go (v0.40.3).

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  /** 2–26 named options → description. */
  criteria: Record<string, string>;
};

export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { false: string; true: string };
};

export type ScoreQuestion = {
  type: 'score';
  instructions: string;
  /** 2–26 descriptions, ordered lowest → highest. */
  criteria: string[];
};

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
  images?: string[];
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted average of the zero-based levels, in [0, levels - 1]. */
  score: number;
  legend?: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
}

export class SystemOneError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SystemOneError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Ollama replies `{ error: "..." }`; OpenAI-style gateways reply `{ error: { message } }`. */
function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined;
  const err = (body as { error: unknown }).error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message;
  return undefined;
}

export class SystemOneClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async decide(req: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(req),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (timeout.aborted) throw new SystemOneError(`Request timed out after ${this.opts.timeoutMs} ms`);
      const reason = err instanceof Error ? err.message : String(err);
      throw new SystemOneError(`Cannot reach ${this.opts.baseUrl}: ${reason}`);
    }

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const detail = errorMessage(body) ?? res.statusText;
      const hint = res.status === 404 ? ' (is this Ollama >= 0.35 and is the model pulled?)' : '';
      throw new SystemOneError(`HTTP ${res.status}: ${detail}${hint}`, res.status);
    }
    if (!body || typeof body !== 'object' || !('answers' in body)) {
      throw new SystemOneError('Malformed response: missing "answers"', res.status);
    }
    return body as SystemOneResponse;
  }
}
