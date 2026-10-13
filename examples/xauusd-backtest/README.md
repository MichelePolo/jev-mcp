# XAUUSD headline backtest

Measures how often the direction a decision model assigns to a news headline (bullish / bearish / neutral for gold) anticipated the actual XAUUSD move 1, 4 and 24 hours later.

> This is a research tool, not a trading system and not financial advice. A good hit rate on past headlines is no guarantee of anything going forward.

```bash
npm install
npx tsx examples/xauusd-backtest/backtest.ts \
  --headlines headlines.csv \
  --prices XAUUSD_M5.csv --prices-tz Europe/Athens \
  --out results.csv
```

It talks to `/v1/systemone` directly, using the same `JEV_BASE_URL` / `OLLAMA_HOST` / `JEV_MODEL` variables as the MCP server. Run `--help` for every option.

## Inputs

**Headlines**: a CSV with a timestamp column (`timestamp`, or `date` + `time`) and a `headline` column (`title` also works). Quote headlines that contain commas.

```csv
timestamp,headline
2026-10-05T12:30:00Z,"Fed Chair signals rate cuts could begin as soon as next meeting"
2026-10-06 14:45,US CPI comes in hotter than expected
```

The timestamp must be the **publication time to the minute**. Date-only or rounded timestamps make the 1h horizon meaningless. Naive timestamps are read in `--headlines-tz` (default UTC).

**Prices**: intraday bars, ideally M1 or M5. With H1 bars, the entry can come up to an hour after the news, when the move has already happened. Two formats are accepted:

- **MT5 export** (History Center → XAUUSD → M5 → Export): tab-separated `<DATE> <TIME> <OPEN> …`. MT5 writes **broker server time**, so pass `--prices-tz`. Most brokers run on UTC+2 in winter and UTC+3 in summer, which `Europe/Athens` matches including DST. Check yours: compare a bar's time in MT5 with the UTC time of the same moment. Use a fixed offset like `+02:00` if your broker has no DST.
- **Generic CSV** with `timestamp` (or `date` + `time`), `open` and `close` columns. `CandleOpen` / `CandleClose` are accepted too. When both `date` + `time` and a `timestamp` column exist, `date` + `time` win: MT5-based exporters often write server wall time into the epoch, so it isn't real UTC. A lone 10- or 13-digit epoch column is read as UTC.

Getting the time zone wrong silently ruins the result. On test data with known outcomes, a 3-hour misalignment dropped the hit rate from 100% to 20%.

## Method

- **Entry**: the open of the first bar at or after the headline. This is the first price you could have traded at, so there is no look-ahead.
- **Exit**: the open of the first bar at or after entry + horizon.
- **Skipped**: samples where the next bar is more than `--max-gap-min` away (default 30). This covers weekends, holidays and data gaps: a Monday open is not "1 hour after" a Friday-night headline.
- **Flat**: moves within `±--flat-pct` (default 0.05%) count as neither hit nor miss. Set it at or above your round-trip trading costs.
- **Classification** asks the model: *"What is the most likely short-term effect of this news on the price of gold in US dollars (XAUUSD)?"* with options bullish / bearish / neutral. Answers are cached in `--cache` (JSONL, keyed by model + prompt + headline), so reruns with other horizons or thresholds are instant.

## Reading the report

| Line | Meaning |
| --- | --- |
| `Jev hit rate` | Share of decided (non-flat) bullish/bearish calls that matched the move, with a 95% Wilson interval |
| `always-long hit rate` | What "always bullish" scored on the same events. Gold trended up for long stretches, so this baseline can be high. **Beating 50% is not enough; beat this.** |
| `mean edge` | Average of sign(call) × return, in basis points, before spread and commissions. A high hit rate with negative edge means the misses were bigger than the hits. |
| `by Jev confidence` | Hit rate by the probability the model gave its call. If `p ≥ 0.9` isn't better than `p < 0.7`, the confidence is not useful as a filter. |
| `neutral calls` | How often a "neutral" headline was indeed followed by a flat market |

The `← CI lower bound above always-long` marker appears only when even the pessimistic end of the interval beats the baseline, and never below 30 decided samples, which get an "anecdotal" warning instead.

## Caveats

- **Clustered headlines are not independent.** Five headlines about the same CPI print are one event, not five samples, so the intervals are optimistic. Deduplicate per event if you can.
- **Hit rate ignores size.** Look at `mean edge` and at `results.csv`.
- **Markets move before headlines.** Prices often react before the news hits your feed. A low 1h hit rate does not necessarily mean the model misread the headline.
- **Prompt overfitting.** If you tweak the classification wording until the numbers look good, test it on a period you didn't tune on.
