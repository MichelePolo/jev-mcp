import { SystemOneClient, SystemOneError, type SystemOneRequest } from './systemone.js';

const req: SystemOneRequest = {
  model: 'nimble',
  state: 'Checkout returns 500',
  questions: { q: { type: 'noul', instructions: 'Is this a bug?' } },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(fetchImpl: typeof fetch, extra: { apiKey?: string; timeoutMs?: number } = {}) {
  return new SystemOneClient({ baseUrl: 'http://ollama:11434', timeoutMs: extra.timeoutMs ?? 1000, apiKey: extra.apiKey, fetch: fetchImpl });
}

describe('SystemOneClient', () => {
  it('POSTs to /v1/systemone and returns the parsed body', async () => {
    const body = { model: 'nimble', answers: { q: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 10, output_tokens: 1 } };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(200, body));

    await expect(client(fetchImpl).decide(req)).resolves.toEqual(body);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://ollama:11434/v1/systemone');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(req);
    expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('sends a bearer token when configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(200, { answers: {} }));
    await client(fetchImpl, { apiKey: 'sk-test' }).decide(req);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
  });

  it.each([
    [{ error: 'model "nimble" not found' }, 'model "nimble" not found'],
    [{ error: { message: 'quota exceeded' } }, 'quota exceeded'],
  ])('surfaces the server error message (%j)', async (body, message) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(400, body));
    await expect(client(fetchImpl).decide(req)).rejects.toThrow(message);
  });

  it('hints at the Ollama version on 404', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('404 page not found', { status: 404 }));
    await expect(client(fetchImpl).decide(req)).rejects.toThrow(/Ollama >= 0\.35/);
  });

  it('reports unreachable hosts', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(client(fetchImpl).decide(req)).rejects.toThrow(/Cannot reach http:\/\/ollama:11434: fetch failed/);
  });

  it('times out', async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    await expect(client(fetchImpl, { timeoutMs: 20 }).decide(req)).rejects.toThrow(/timed out after 20 ms/);
  });

  it('rejects a body without answers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(200, { model: 'nimble' }));
    await expect(client(fetchImpl).decide(req)).rejects.toBeInstanceOf(SystemOneError);
  });
});
