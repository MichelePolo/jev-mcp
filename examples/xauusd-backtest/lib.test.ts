import { barAtOrAfter, parseCsv, parseHeadlines, parsePrices, parseTimestamp, summarize, wallTimeToUtc, wilson, type Bar } from './lib.js';

const utc = (s: string) => Date.parse(`${s}Z`);

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes, CRLF and a BOM', () => {
    const text = '﻿timestamp,headline\r\n2026-01-02 10:00,"Fed holds, signals ""patience"""\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['timestamp', 'headline'],
      ['2026-01-02 10:00', 'Fed holds, signals "patience"'],
    ]);
  });

  it('detects tab and semicolon delimiters', () => {
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a;b\n1,5;2')).toEqual([['a', 'b'], ['1,5', '2']]);
  });
});

describe('time zones', () => {
  it('reads explicit offsets as absolute', () => {
    expect(parseTimestamp('2026-07-01T12:00:00+03:00', 'Europe/Athens')).toBe(utc('2026-07-01T09:00:00'));
    expect(parseTimestamp('2026-07-01T12:00:00Z', '+05:00')).toBe(utc('2026-07-01T12:00:00'));
  });

  it('applies fixed offsets to naive times', () => {
    expect(wallTimeToUtc(utc('2026-07-01T12:00:00'), '+02:00')).toBe(utc('2026-07-01T10:00:00'));
    expect(wallTimeToUtc(utc('2026-07-01T12:00:00'), 'UTC-5')).toBe(utc('2026-07-01T17:00:00'));
  });

  it('follows DST for IANA zones (MT5 server time)', () => {
    expect(parseTimestamp('2026.07.01 12:00', 'Europe/Athens')).toBe(utc('2026-07-01T09:00:00')); // EEST, UTC+3
    expect(parseTimestamp('2026.01.15 12:00', 'Europe/Athens')).toBe(utc('2026-01-15T10:00:00')); // EET, UTC+2
  });

  it('rejects garbage', () => {
    expect(() => parseTimestamp('yesterday', 'UTC')).toThrow(/Unrecognised/);
  });
});

describe('parseHeadlines / parsePrices', () => {
  it('reads headlines sorted by time and drops empty ones', () => {
    const text = 'timestamp,headline\n2026-01-02 11:00,Second\n2026-01-02 10:00,First\n2026-01-02 12:00,';
    expect(parseHeadlines(text, 'UTC').map((h) => h.text)).toEqual(['First', 'Second']);
  });

  it('reads an MT5 export (tabs, <DATE>/<TIME>, server time)', () => {
    const text = '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\n' + '2026.07.01\t12:05:00\t2410.5\t2412\t2409\t2411.2\t812\n' + '2026.07.01\t12:00:00\t2409.0\t2411\t2408\t2410.5\t790\n';
    expect(parsePrices(text, 'Europe/Athens')).toEqual([
      { t: utc('2026-07-01T09:00:00'), open: 2409, close: 2410.5 },
      { t: utc('2026-07-01T09:05:00'), open: 2410.5, close: 2411.2 },
    ]);
  });

  it('reads the "Enhanced Minutes" export: Date+Time win over a server-time epoch, Candle* columns', () => {
    const text =
      'Timestamp,Date,Time,TotalTicks,FirstPrice,LastPrice,CandleOpen,CandleClose,ATR\n' +
      '1763600400,2025.11.20,01:00:00,37,4079.80,4080.53,4079.55,4080.50,1.36\n';
    // Nov = EET (UTC+2): 01:00 server time is 23:00 UTC the day before.
    expect(parsePrices(text, 'Europe/Athens')).toEqual([{ t: utc('2025-11-19T23:00:00'), open: 4079.55, close: 4080.5 }]);
  });

  it('treats a lone epoch column as UTC', () => {
    expect(parsePrices('timestamp,open,close\n1763600400,1,2', 'Europe/Athens')[0].t).toBe(1763600400_000);
    expect(parseTimestamp('1763600400000', 'UTC')).toBe(1763600400_000);
  });

  it('explains a missing column', () => {
    expect(() => parsePrices('time,price\n2026-01-01 10:00,1', 'UTC')).toThrow(/"open" and "close"/);
    expect(() => parseHeadlines('when,headline\nx,y', 'UTC')).toThrow(/timestamp/);
  });
});

describe('barAtOrAfter', () => {
  const bars: Bar[] = [0, 5, 10].map((m) => ({ t: m * 60_000, open: 100 + m, close: 100 + m }));

  it('returns the first bar opening at or after t, never an earlier one', () => {
    expect(barAtOrAfter(bars, 5 * 60_000, 60 * 60_000)?.open).toBe(105);
    expect(barAtOrAfter(bars, 6 * 60_000, 60 * 60_000)?.open).toBe(110);
  });

  it('skips when the next bar is too far away or missing', () => {
    expect(barAtOrAfter(bars, 6 * 60_000, 2 * 60_000)).toBeUndefined();
    expect(barAtOrAfter(bars, 11 * 60_000, 60 * 60_000)).toBeUndefined();
  });
});

describe('wilson', () => {
  it('matches known values', () => {
    const [lo, hi] = wilson(60, 100);
    expect(lo).toBeCloseTo(0.502, 3);
    expect(hi).toBeCloseTo(0.691, 3);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });
});

describe('summarize', () => {
  it('separates hits, misses, flats, neutrals and skips', () => {
    const s = summarize(
      [
        { direction: 'bullish', probability: 0.95, ret: 0.002 }, // hit
        { direction: 'bearish', probability: 0.8, ret: 0.003 }, // miss
        { direction: 'bearish', probability: 0.6, ret: -0.001 }, // hit
        { direction: 'bullish', probability: 0.99, ret: 0.0001 }, // flat
        { direction: 'neutral', probability: 0.7, ret: 0.0002 }, // neutral, flat
        { direction: 'bullish', probability: 0.9, ret: undefined }, // skipped
      ],
      0.05,
    );
    expect(s).toMatchObject({ signals: 4, flat: 1, decided: 3, hits: 2, skipped: 1, neutral: { count: 1, flat: 1 } });
    expect(s.hitRate).toBeCloseTo(2 / 3);
    expect(s.alwaysLong).toBeCloseTo(2 / 3); // 2 of the 3 decided moves were up
    expect(s.edgeBps).toBeCloseTo(((0.002 - 0.003 + 0.001 + 0.0001) / 4) * 10_000);
    expect(s.buckets.map((b) => [b.decided, b.hits])).toEqual([[1, 1], [1, 0], [1, 1]]);
  });
});
