// Pure helpers for the XAUUSD headline backtest: CSV parsing, time zones,
// price lookup and hit-rate statistics. No I/O, so everything here is testable.

export type Direction = 'bullish' | 'bearish' | 'neutral';

export interface Headline {
  t: number; // UTC epoch ms
  text: string;
}

export interface Bar {
  t: number; // UTC epoch ms of the bar open
  open: number;
  close: number;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Tab (MT5 exports) wins, then whichever of `;` / `,` appears more in the header. */
function detectDelimiter(headerLine: string): string {
  if (headerLine.includes('\t')) return '\t';
  const semis = headerLine.split(';').length;
  const commas = headerLine.split(',').length;
  return semis > commas ? ';' : ',';
}

/** RFC 4180-ish: quoted fields may contain delimiters, newlines and "" escapes. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(src.slice(0, src.search(/\r?\n|$/)));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

// ── Time zones ───────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of an IANA zone from UTC, in ms, at the given instant. */
function ianaOffsetMs(utcMs: number, timeZone: string): number {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - (utcMs - (utcMs % 1000));
}

/**
 * Converts a wall-clock time in `timeZone` to UTC ms. Accepts `UTC`, fixed offsets
 * (`+03:00`, `UTC+3`, `-0500`) and IANA names (`Europe/Athens`, which follows DST,
 * as most MT5 broker servers do).
 */
export function wallTimeToUtc(wallAsUtcMs: number, timeZone: string): number {
  if (timeZone === 'UTC' || timeZone === 'Z') return wallAsUtcMs;
  const fixed = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(timeZone);
  if (fixed) {
    const sign = fixed[1] === '-' ? -1 : 1;
    return wallAsUtcMs - sign * (Number(fixed[2]) * 60 + Number(fixed[3] ?? 0)) * 60_000;
  }
  // Two passes so times right after a DST switch use the post-switch offset.
  const first = wallAsUtcMs - ianaOffsetMs(wallAsUtcMs, timeZone);
  return wallAsUtcMs - ianaOffsetMs(first, timeZone);
}

/** Validates a time zone argument up front, so a typo fails before any work. */
export function assertTimeZone(timeZone: string): void {
  wallTimeToUtc(0, timeZone);
}

const WALL_TIME = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Timestamps with `Z`, an explicit offset, or Unix epoch digits are absolute. Naive ones
 * (`2026.10.12 14:05`, `2026-10-12T14:05:00`) are read in `timeZone`.
 */
export function parseTimestamp(raw: string, timeZone: string): number {
  const value = raw.trim();
  if (/^\d{10}$/.test(value)) return Number(value) * 1000; // Unix seconds, UTC
  if (/^\d{13}$/.test(value)) return Number(value); // Unix ms, UTC
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && /\d{2}:\d{2}/.test(value)) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  const m = WALL_TIME.exec(value);
  if (!m) throw new Error(`Unrecognised timestamp "${raw}"`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return wallTimeToUtc(wall, timeZone);
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/** `<DATE>` → `date`, so MT5 exports and plain CSVs share one code path. */
function normalizeHeader(h: string): string {
  return h.replace(/[<>]/g, '').trim().toLowerCase();
}

/** Index of the first header present among `names`, or -1. */
function column(headers: string[], ...names: string[]): number {
  return names.map((n) => headers.indexOf(n)).find((i) => i >= 0) ?? -1;
}

/**
 * Returns a function that builds the timestamp string for a row. Readable
 * `date` + `time` columns win over a `timestamp` column: MT5-based exports often
 * put server wall time into the epoch value, so it is not really UTC.
 */
function timeReader(headers: string[], file: string): (row: string[]) => string {
  const date = column(headers, 'date');
  const time = column(headers, 'time');
  if (date >= 0 && time >= 0) return (row) => `${row[date]} ${row[time]}`;
  const single = column(headers, 'timestamp', 'datetime');
  if (single >= 0) return (row) => row[single];
  if (date >= 0) return (row) => row[date];
  if (time >= 0) return (row) => row[time];
  throw new Error(`${file}: needs a "timestamp" column, or "date" (+ "time") columns`);
}

export function parseHeadlines(text: string, timeZone: string): Headline[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const headers = header.map(normalizeHeader);
  const readTime = timeReader(headers, 'headlines');
  const textCol = column(headers, 'headline', 'title', 'text');
  if (textCol < 0) throw new Error('headlines: needs a "headline" (or "title") column');

  return rows
    .map((row, i) => {
      try {
        return { t: parseTimestamp(readTime(row), timeZone), text: (row[textCol] ?? '').trim() };
      } catch (err) {
        throw new Error(`headlines row ${i + 2}: ${(err as Error).message}`);
      }
    })
    .filter((h) => h.text !== '')
    .sort((a, b) => a.t - b.t);
}

export function parsePrices(text: string, timeZone: string): Bar[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const headers = header.map(normalizeHeader);
  const readTime = timeReader(headers, 'prices');
  const open = column(headers, 'open', 'candleopen');
  const close = column(headers, 'close', 'candleclose');
  if (open < 0 || close < 0) throw new Error('prices: needs "open" and "close" columns');

  const bars = rows.map((row, i) => {
    const bar = { t: parseTimestamp(readTime(row), timeZone), open: Number(row[open]), close: Number(row[close]) };
    if (!Number.isFinite(bar.open) || !Number.isFinite(bar.close)) {
      throw new Error(`prices row ${i + 2}: non-numeric open/close`);
    }
    return bar;
  });
  bars.sort((a, b) => a.t - b.t);
  return bars.filter((b, i) => i === 0 || b.t !== bars[i - 1].t);
}

// ── Price lookup ─────────────────────────────────────────────────────────────

/**
 * First bar opening at or after `t`: its open is the first price tradable once
 * the news is out, so there is no look-ahead. Returns undefined when the next bar
 * is more than `maxGapMs` away (weekend, holiday, missing data), because a Monday
 * open is not "1 hour after" a Friday-night headline.
 */
export function barAtOrAfter(bars: Bar[], t: number, maxGapMs: number): Bar | undefined {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const bar = bars[lo];
  return bar && bar.t - t <= maxGapMs ? bar : undefined;
}

// ── Statistics ───────────────────────────────────────────────────────────────

export interface Observation {
  direction: Direction;
  /** Probability Jev assigned to `direction`. */
  probability: number;
  /** Fractional return over the horizon, undefined when prices were unavailable. */
  ret: number | undefined;
}

export interface BucketStats {
  label: string;
  decided: number;
  hits: number;
}

export interface HorizonStats {
  /** Bullish/bearish calls with a measurable return. */
  signals: number;
  /** Of those, how many moved less than the flat band (neither hit nor miss). */
  flat: number;
  /** Signals whose move exceeded the flat band. */
  decided: number;
  hits: number;
  hitRate: number;
  ci95: [number, number];
  /** Hit rate of "always long" on the same decided events. */
  alwaysLong: number;
  /** Mean of sign(call) × return, in basis points, before costs. */
  edgeBps: number;
  buckets: BucketStats[];
  neutral: { count: number; flat: number };
  /** Calls skipped because prices were missing around the headline. */
  skipped: number;
}

/** Wilson score interval: honest for small n and rates near 0 or 1. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const BUCKETS: Array<{ label: string; min: number }> = [
  { label: 'p ≥ 0.9', min: 0.9 },
  { label: '0.7 ≤ p < 0.9', min: 0.7 },
  { label: 'p < 0.7', min: 0 },
];

export function summarize(observations: Observation[], flatPct: number): HorizonStats {
  const flatBand = flatPct / 100;
  const buckets = BUCKETS.map((b) => ({ label: b.label, decided: 0, hits: 0 }));
  let signals = 0;
  let flat = 0;
  let hits = 0;
  let ups = 0;
  let edgeSum = 0;
  let skipped = 0;
  const neutral = { count: 0, flat: 0 };

  for (const o of observations) {
    if (o.ret === undefined) {
      skipped++;
      continue;
    }
    if (o.direction === 'neutral') {
      neutral.count++;
      if (Math.abs(o.ret) <= flatBand) neutral.flat++;
      continue;
    }
    signals++;
    const sign = o.direction === 'bullish' ? 1 : -1;
    edgeSum += sign * o.ret;
    if (Math.abs(o.ret) <= flatBand) {
      flat++;
      continue;
    }
    const hit = Math.sign(o.ret) === sign;
    if (hit) hits++;
    if (o.ret > 0) ups++;
    const bucket = buckets[BUCKETS.findIndex((b) => o.probability >= b.min)];
    bucket.decided++;
    if (hit) bucket.hits++;
  }

  const decided = signals - flat;
  return {
    signals,
    flat,
    decided,
    hits,
    hitRate: decided ? hits / decided : 0,
    ci95: wilson(hits, decided),
    alwaysLong: decided ? ups / decided : 0,
    edgeBps: signals ? (edgeSum / signals) * 10_000 : 0,
    buckets,
    neutral,
    skipped,
  };
}
