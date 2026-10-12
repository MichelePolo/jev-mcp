import { mapWithConcurrency } from './pool.js';

describe('mapWithConcurrency', () => {
  it('preserves order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (ms, i) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
