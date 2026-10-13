// Backtest: did Jev's direction call on a headline anticipate the XAUUSD move
// 1, 4 and 24 hours later? See README.md in this folder.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../src/config.js';
import { mapWithConcurrency } from '../../src/pool.js';
import { SystemOneClient } from '../../src/systemone.js';
import {
  assertTimeZone,
  barAtOrAfter,
  parseHeadlines,
  parsePrices,
  summarize,
  type Direction,
  type HorizonStats,
  type Observation,
} from './lib.js';

const INSTRUCTIONS = 'What is the most likely short-term effect of this news on the price of gold in US dollars (XAUUSD)?';
const OPTIONS: Record<Direction, string> = {
  bullish: 'Gold likely rises (weaker USD, lower real yields, safe-haven demand)',
  bearish: 'Gold likely falls (stronger USD, higher real yields, risk-on)',
  neutral: 'No meaningful effect on gold',
};

const USAGE = `Usage: npx tsx examples/xauusd-backtest/backtest.ts --headlines FILE --prices FILE [options]

  --headlines FILE     CSV with a timestamp and a headline column
  --prices FILE        Intraday XAUUSD bars (MT5 export or CSV with time/open/close)
  --headlines-tz TZ    Zone of naive headline timestamps        (default UTC)
  --prices-tz TZ       Zone of naive price timestamps; MT5 exports use broker
                       server time, e.g. Europe/Athens or +02:00 (default UTC)
  --horizons LIST      Hours after the headline                  (default 1,4,24)
  --flat-pct N         Moves within ±N% count as flat            (default 0.05)
  --max-gap-min N      Max minutes to the next bar before a
                       sample is skipped (weekends, gaps)        (default 30)
  --model NAME         Decision model                            (default $JEV_MODEL or nimble)
  --cache FILE         Classification cache (JSONL)              (default .jev-cache.jsonl)
  --out FILE           Per-headline results CSV                  (optional)
`;

interface Classified {
  direction: Direction;
  probabilities: Record<Direction, number>;
}

function cacheKey(model: string, headline: string): string {
  return createHash('sha256').update(JSON.stringify([model, INSTRUCTIONS, OPTIONS, headline])).digest('hex');
}

function loadCache(file: string): Map<string, Classified> {
  const cache = new Map<string, Classified>();
  if (!existsSync(file)) return cache;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { key, ...value } = JSON.parse(line) as { key: string } & Classified;
    cache.set(key, value);
  }
  return cache;
}

/** Below this many decided samples, results are reported but never flagged as beating the baseline. */
const MIN_SAMPLES = 30;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function report(hours: number, s: HorizonStats): string {
  const lines = [
    `\n── +${hours}h ${'─'.repeat(60)}`,
    `  calls bullish/bearish : ${s.signals}  (flat: ${s.flat}, decided: ${s.decided}, skipped for missing prices: ${s.skipped})`,
  ];
  if (s.decided === 0) return [...lines, '  not enough decided samples'].join('\n');
  const tooFew = s.decided < MIN_SAMPLES;
  const beat = !tooFew && s.ci95[0] > s.alwaysLong ? '  ← CI lower bound above always-long' : '';
  if (tooFew) lines.push(`  ⚠ only ${s.decided} decided samples (< ${MIN_SAMPLES}): anecdotal, not evidence`);
  lines.push(
    `  Jev hit rate          : ${pct(s.hitRate)}  (95% CI ${pct(s.ci95[0])}–${pct(s.ci95[1])})${beat}`,
    `  always-long hit rate  : ${pct(s.alwaysLong)}   coin flip: 50.0%`,
    `  mean edge             : ${s.edgeBps.toFixed(1)} bps per call, before spread and commissions`,
    '  by Jev confidence     :',
  );
  for (const b of s.buckets) {
    lines.push(`    ${b.label.padEnd(15)} ${b.decided ? `${pct(b.hits / b.decided).padStart(6)}  (n=${b.decided})` : '     –  (n=0)'}`);
  }
  if (s.neutral.count) lines.push(`  neutral calls         : ${s.neutral.count}, of which stayed flat: ${pct(s.neutral.flat / s.neutral.count)}`);
  return lines.join('\n');
}

function csvField(value: unknown): string {
  const s = value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      headlines: { type: 'string' },
      prices: { type: 'string' },
      'headlines-tz': { type: 'string', default: 'UTC' },
      'prices-tz': { type: 'string', default: 'UTC' },
      horizons: { type: 'string', default: '1,4,24' },
      'flat-pct': { type: 'string', default: '0.05' },
      'max-gap-min': { type: 'string', default: '30' },
      model: { type: 'string' },
      cache: { type: 'string', default: '.jev-cache.jsonl' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.headlines || !values.prices) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const horizons = values.horizons.split(',').map(Number);
  const flatPct = Number(values['flat-pct']);
  const maxGapMs = Number(values['max-gap-min']) * 60_000;
  if (horizons.some((h) => !(h > 0)) || !(flatPct >= 0) || !(maxGapMs > 0)) {
    throw new Error('--horizons, --flat-pct and --max-gap-min must be positive numbers');
  }
  assertTimeZone(values['headlines-tz']);
  assertTimeZone(values['prices-tz']);

  const read = (file: string, what: string) => {
    if (!existsSync(file)) throw new Error(`${what} file not found: ${resolve(file)}`);
    return readFileSync(file, 'utf8');
  };
  const headlines = parseHeadlines(read(values.headlines, 'Headlines'), values['headlines-tz']);
  const bars = parsePrices(read(values.prices, 'Prices'), values['prices-tz']);
  if (!headlines.length || !bars.length) throw new Error('No headlines or no price bars found');
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  console.error(`${headlines.length} headlines ${iso(headlines[0].t)} → ${iso(headlines.at(-1)!.t)} UTC`);
  console.error(`${bars.length} bars ${iso(bars[0].t)} → ${iso(bars.at(-1)!.t)} UTC`);

  // Classify, reusing cached answers so threshold/horizon tweaks rerun instantly.
  const config = loadConfig();
  const model = values.model ?? config.model;
  const client = new SystemOneClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
  const cache = loadCache(values.cache);
  const todo = [...new Set(headlines.map((h) => h.text))].filter((text) => !cache.has(cacheKey(model, text)));
  console.error(`Classifying ${todo.length} new headlines with ${model} (${cache.size} cached)…`);
  let done = 0;
  await mapWithConcurrency(todo, config.concurrency, async (text) => {
    const res = await client.decide({
      model,
      state: text,
      questions: { direction: { type: 'choice', instructions: INSTRUCTIONS, criteria: OPTIONS } },
    });
    const answer = res.answers.direction;
    if (answer?.type !== 'choice') throw new Error(`Unexpected answer for "${text}"`);
    const value: Classified = { direction: answer.choice as Direction, probabilities: answer.probabilities as Record<Direction, number> };
    const key = cacheKey(model, text);
    cache.set(key, value);
    appendFileSync(values.cache, `${JSON.stringify({ key, ...value })}\n`);
    if (++done % 25 === 0 || done === todo.length) console.error(`  ${done}/${todo.length}`);
  });

  // Measure what the price did after each headline.
  const rows = headlines.map((h) => {
    const c = cache.get(cacheKey(model, h.text))!;
    const entry = barAtOrAfter(bars, h.t, maxGapMs);
    const rets = horizons.map((hours) => {
      if (!entry) return undefined;
      const exit = barAtOrAfter(bars, entry.t + hours * 3_600_000, maxGapMs);
      return exit ? exit.open / entry.open - 1 : undefined;
    });
    return { h, c, entry, rets };
  });

  console.log(`\nXAUUSD headline backtest · model ${model} · flat band ±${flatPct}% · ${headlines.length} headlines`);
  horizons.forEach((hours, i) => {
    const observations: Observation[] = rows.map((r) => ({
      direction: r.c.direction,
      probability: r.c.probabilities[r.c.direction] ?? 0,
      ret: r.rets[i],
    }));
    console.log(report(hours, summarize(observations, flatPct)));
  });
  console.log(
    '\nCaveats: headlines close in time are not independent samples (CIs are optimistic);' +
      ' the hit rate ignores how big the moves were; past results say nothing certain about the future.',
  );

  if (values.out) {
    const header = ['time_utc', 'headline', 'call', 'p_bullish', 'p_bearish', 'p_neutral', 'entry_time_utc', 'entry_price', ...horizons.map((h) => `ret_${h}h_pct`)];
    const lines = rows.map((r) =>
      [
        iso(r.h.t),
        r.h.text,
        r.c.direction,
        r.c.probabilities.bullish,
        r.c.probabilities.bearish,
        r.c.probabilities.neutral,
        r.entry ? iso(r.entry.t) : '',
        r.entry?.open,
        ...r.rets.map((ret) => (ret === undefined ? '' : (ret * 100).toFixed(4))),
      ]
        .map(csvField)
        .join(','),
    );
    writeFileSync(values.out, `${[header.join(','), ...lines].join('\n')}\n`);
    console.error(`\nPer-headline results written to ${values.out}`);
  }
}

main().catch((err: unknown) => {
  console.error(`backtest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
