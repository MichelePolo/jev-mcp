import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from './config.js';
import { createServer } from './server.js';
import { toScoreResult } from './tools.js';
import type { SystemOneRequest } from './systemone.js';

const config: Config = { baseUrl: 'http://ollama:11434', model: 'nimble', timeoutMs: 1000, concurrency: 2 };

/** Fake Ollama: answers based on the question type; texts containing "FAIL" return HTTP 500. */
function fakeOllama() {
  const requests: SystemOneRequest[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const req = JSON.parse(init?.body as string) as SystemOneRequest;
    requests.push(req);
    if (String(req.state).includes('FAIL')) return Response.json({ error: 'boom' }, { status: 500 });
    const q = req.questions.q;
    const answer =
      q.type === 'choice'
        ? { type: 'choice', choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]]: 0.9 }, confidence: 0.8 }
        : q.type === 'noul'
          ? { type: 'noul', noul: 0.75 }
          : { type: 'score', score: 1.6, probabilities: {}, confidence: 0.5 };
    return Response.json({ model: req.model, answers: { q: answer }, usage: { input_tokens: 100, output_tokens: 1 } });
  };
  return { requests, fetchImpl };
}

async function connect(fetchImpl: typeof fetch) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(config, fetchImpl).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const [first] = res.content as Array<{ type: string; text: string }>;
  return { isError: res.isError ?? false, body: JSON.parse(first.text) };
}

describe('jev-mcp tools', () => {
  it('lists the three read-only tools', async () => {
    const client = await connect(fakeOllama().fetchImpl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['classify', 'score', 'yes_no']);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('classify sends one choice question per text and sums usage', async () => {
    const ollama = fakeOllama();
    const client = await connect(ollama.fetchImpl);
    const { isError, body } = await call(client, 'classify', {
      texts: ['checkout 500s', 'charged twice'],
      instructions: 'Which label?',
      options: { bug: 'Software errors', billing: 'Payments' },
    });

    expect(isError).toBe(false);
    expect(body).toEqual({
      model: 'nimble',
      results: [
        { index: 0, choice: 'bug', confidence: 0.8, probabilities: { bug: 0.9 } },
        { index: 1, choice: 'bug', confidence: 0.8, probabilities: { bug: 0.9 } },
      ],
      usage: { input_tokens: 200, output_tokens: 2 },
    });
    expect(ollama.requests[0]).toEqual({
      model: 'nimble',
      state: 'checkout 500s',
      questions: { q: { type: 'choice', instructions: 'Which label?', criteria: { bug: 'Software errors', billing: 'Payments' } } },
    });
  });

  it('classify rejects fewer than two options', async () => {
    const client = await connect(fakeOllama().fetchImpl);
    const res = await client.callTool({ name: 'classify', arguments: { texts: ['x'], instructions: 'q', options: { only: 'one' } } });
    expect(res.isError).toBe(true);
  });

  it('yes_no honours a per-call model and optional criteria', async () => {
    const ollama = fakeOllama();
    const client = await connect(ollama.fetchImpl);
    const { body } = await call(client, 'yes_no', {
      texts: ['refund please'],
      question: 'Refund requested?',
      criteria: { true: 'Asks for money back', false: 'Does not' },
      model: 'tev1:0.8b',
    });

    expect(body.model).toBe('tev1:0.8b');
    expect(body.results).toEqual([{ index: 0, probability_yes: 0.75 }]);
    expect(ollama.requests[0].questions.q).toEqual({
      type: 'noul',
      instructions: 'Refund requested?',
      criteria: { false: 'Does not', true: 'Asks for money back' },
    });
  });

  it('reports per-text failures without failing the whole batch', async () => {
    const client = await connect(fakeOllama().fetchImpl);
    const { isError, body } = await call(client, 'yes_no', { texts: ['ok', 'FAIL'], question: 'q?' });
    expect(isError).toBe(false);
    expect(body.results[1]).toEqual({ index: 1, error: 'HTTP 500: boom' });
  });

  it('flags the call as an error when every text fails', async () => {
    const client = await connect(fakeOllama().fetchImpl);
    const { isError } = await call(client, 'yes_no', { texts: ['FAIL'], question: 'q?' });
    expect(isError).toBe(true);
  });

  it('score returns the nearest level alongside the raw score', async () => {
    const ollama = fakeOllama();
    const client = await connect(ollama.fetchImpl);
    const levels = ['Routine', 'Soon', 'Immediate'];
    const { body } = await call(client, 'score', { texts: ['site down'], instructions: 'How urgent?', levels });

    expect(body.results).toEqual([{ index: 0, level: 'Immediate', score: 1.6, max: 2, confidence: 0.5 }]);
    expect(ollama.requests[0].questions.q).toEqual({ type: 'score', instructions: 'How urgent?', criteria: levels });
  });
});

describe('toScoreResult', () => {
  const answer = (score: number) => ({ type: 'score' as const, score, probabilities: {}, confidence: 0.4 });

  it('rounds to the nearest level', () => {
    expect(toScoreResult(answer(0.49), ['low', 'mid', 'high'])).toMatchObject({ level: 'low', score: 0.49, max: 2 });
    expect(toScoreResult(answer(0.5), ['low', 'mid', 'high'])).toMatchObject({ level: 'mid' });
  });

  it('clamps out-of-range scores instead of returning an undefined level', () => {
    expect(toScoreResult(answer(2.0004), ['low', 'mid', 'high'])).toMatchObject({ level: 'high', score: 2 });
    expect(toScoreResult(answer(-0.01), ['low', 'high'])).toMatchObject({ level: 'low', score: 0 });
  });
});
