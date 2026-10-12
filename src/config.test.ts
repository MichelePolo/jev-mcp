import { configWarnings, loadConfig, normalizeBaseUrl } from './config.js';

describe('normalizeBaseUrl', () => {
  it.each([
    ['localhost', 'http://localhost:11434'],
    ['0.0.0.0', 'http://127.0.0.1:11434'],
    ['0.0.0.0:9999', 'http://127.0.0.1:9999'],
    ['http://gpu-box:11434/', 'http://gpu-box:11434'],
    ['https://gateway.example.com', 'https://gateway.example.com'],
    ['https://gateway.example.com/jev', 'https://gateway.example.com/jev'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected);
  });
});

describe('credentials in the base URL', () => {
  it.each(['https://user:s3cret@gateway.example.com', 'user:s3cret@gpu-box:11434'])('rejects %s without echoing the secret', (raw) => {
    expect(() => normalizeBaseUrl(raw)).toThrow(/must not contain credentials/);
    expect(() => normalizeBaseUrl(raw)).not.toThrow(/s3cret/);
  });
});

describe('configWarnings', () => {
  const base = loadConfig({});

  it('warns when an API key would travel over cleartext to a remote host', () => {
    expect(configWarnings({ ...base, apiKey: 'k', baseUrl: 'http://gpu-box:11434' })).toEqual([
      expect.stringMatching(/cleartext to gpu-box:11434/),
    ]);
  });

  it.each([
    ['https remote', { apiKey: 'k', baseUrl: 'https://gateway.example.com' }],
    ['http loopback', { apiKey: 'k', baseUrl: 'http://127.0.0.1:11434' }],
    ['no key', { baseUrl: 'http://gpu-box:11434' }],
  ])('stays quiet for %s', (_label, overrides) => {
    expect(configWarnings({ ...base, ...overrides })).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('defaults to local Ollama and nimble', () => {
    expect(loadConfig({})).toEqual({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'nimble',
      apiKey: undefined,
      timeoutMs: 30_000,
      concurrency: 4,
    });
  });

  it('prefers JEV_BASE_URL over OLLAMA_HOST', () => {
    expect(loadConfig({ JEV_BASE_URL: 'https://a.example', OLLAMA_HOST: 'b' }).baseUrl).toBe('https://a.example');
    expect(loadConfig({ OLLAMA_HOST: 'gpu-box' }).baseUrl).toBe('http://gpu-box:11434');
  });

  it('rejects non-positive integers', () => {
    expect(() => loadConfig({ JEV_CONCURRENCY: '0' })).toThrow(/JEV_CONCURRENCY/);
    expect(() => loadConfig({ JEV_TIMEOUT_MS: 'soon' })).toThrow(/JEV_TIMEOUT_MS/);
  });
});
