export interface Config {
  /** Base URL of a server exposing `/v1/systemone` (Ollama >= 0.35, or a remote gateway). */
  baseUrl: string;
  /** Default decision model, overridable per tool call. */
  model: string;
  /** Sent as `Authorization: Bearer` when set (remote endpoints only; local Ollama needs none). */
  apiKey?: string;
  timeoutMs: number;
  /** Max in-flight requests when a tool call carries several texts. */
  concurrency: number;
}

const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';

/**
 * Accepts the same shapes Ollama accepts for OLLAMA_HOST: `host`, `host:port`,
 * or a full URL. A bare host gets Ollama's default port; a full URL is taken as-is.
 * `0.0.0.0` is a bind address, not a destination, so it maps to loopback.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const bare = !/^https?:\/\//i.test(trimmed);
  const url = new URL(bare ? `http://${trimmed}` : trimmed);
  // The URL ends up in error messages that reach the calling model and its history,
  // so credentials must never live in it. Don't echo the value back either.
  if (url.username || url.password) {
    throw new Error('JEV_BASE_URL/OLLAMA_HOST must not contain credentials; use JEV_API_KEY instead');
  }
  if (bare && !url.port) url.port = '11434';
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.toString().replace(/\/$/, '');
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Non-fatal misconfigurations, printed to stderr at startup. */
export function configWarnings(config: Config): string[] {
  const url = new URL(config.baseUrl);
  if (config.apiKey && url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    return [`JEV_API_KEY will be sent in cleartext to ${url.host}; use an https:// JEV_BASE_URL`];
  }
  return [];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.JEV_BASE_URL || env.OLLAMA_HOST || DEFAULT_OLLAMA;
  return {
    baseUrl: normalizeBaseUrl(rawUrl),
    model: env.JEV_MODEL || 'nimble',
    apiKey: env.JEV_API_KEY || undefined,
    timeoutMs: positiveInt(env.JEV_TIMEOUT_MS, 30_000, 'JEV_TIMEOUT_MS'),
    concurrency: positiveInt(env.JEV_CONCURRENCY, 4, 'JEV_CONCURRENCY'),
  };
}
