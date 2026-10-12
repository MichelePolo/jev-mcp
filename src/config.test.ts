import { loadConfig, normalizeBaseUrl } from './config.js';

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
