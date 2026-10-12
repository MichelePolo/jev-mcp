# jev-mcp

An MCP server that exposes **Jev-style "System One" decision models** as tools, so any chat model (Claude, GPT, Gemini, a local Llama…) can delegate fast, calibrated decisions to them.

Decision models don't generate text. They take a piece of state plus a typed question and return **probabilities**: the most likely label, the probability of "yes", or a position on an ordered scale. Ollama serves them locally on `/v1/systemone` (Ollama ≥ 0.35) with open models such as `nimble` (9B), `tev1` (4B) and `tev1:0.8b`. TypeSafe's proprietary Jev is API-only; any server that speaks the same protocol works via `JEV_BASE_URL`.

## When this is worth it

A frontier model can label one item faster than it can call a tool. Reach for jev-mcp when you want:

- **Batches** — label 100 tickets in one tool call instead of spending big-model tokens on each.
- **Numbers you can threshold** — calibrated probabilities instead of a model saying "probably".
- **Help for small models** — a 3B local chat model delegating decisions it would get wrong on its own.

## Tools

All tools are read-only and take `texts` (1–100 strings, each judged independently) plus an optional `model`.

| Tool | Extra input | Result per text |
| --- | --- | --- |
| `classify` | `instructions`, `options` (2–26 `label → description`) | `choice`, `confidence`, `probabilities` |
| `yes_no` | `question`, optional `criteria: { true, false }` | `probability_yes` in [0, 1] |
| `score` | `instructions`, `levels` (2–26, lowest → highest) | see [Score output](#score-output) |

Results come back in input order, as `{ model, results: [{ index, … }], usage }`. A failing text returns `{ index, error }` without failing the batch; the call is flagged `isError` only when every text fails.

## Setup

```bash
# 1. Ollama ≥ 0.35 and a decision model
ollama --version
ollama pull nimble

# 2. Build
npm install
npm run build
```

### Aether

Settings → MCP → add a **stdio** server:

| Field | Value |
| --- | --- |
| Command | `node` |
| Args | `/absolute/path/to/jev-mcp/dist/index.js` |
| Env | `JEV_MODEL=nimble` (optional) |

### Claude Code

```bash
claude mcp add jev -- node /absolute/path/to/jev-mcp/dist/index.js
```

### Any MCP client (JSON config)

```json
{
  "mcpServers": {
    "jev": { "command": "node", "args": ["/absolute/path/to/jev-mcp/dist/index.js"], "env": { "JEV_MODEL": "nimble" } }
  }
}
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_BASE_URL` | — | Server exposing `/v1/systemone`. Takes precedence over `OLLAMA_HOST`. |
| `OLLAMA_HOST` | `127.0.0.1:11434` | Same formats Ollama accepts (`host`, `host:port`, URL). |
| `JEV_MODEL` | `nimble` | Default decision model. |
| `JEV_API_KEY` | — | Sent as `Authorization: Bearer …` (remote endpoints only). |
| `JEV_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `JEV_CONCURRENCY` | `4` | Max in-flight requests per batch. Match Ollama's `OLLAMA_NUM_PARALLEL`. |

> **Privacy:** with a remote `JEV_BASE_URL`, every text you pass leaves the machine. In Aether, give the tools an override with `category: external` so each call needs your approval.

## Score output

`/v1/systemone` returns `score` as the probability-weighted average of the zero-based levels. With levels `["Routine", "Soon", "Immediate"]`, `score` ∈ [0, 2], plus per-level `probabilities` and a `confidence`. jev-mcp returns the nearest `level` (what a caller usually acts on) together with the raw `score`, the scale `max` and the `confidence`, so the uncertainty stays visible: `1.5` on a 0–2 scale is not a confident "Soon". Per-level probabilities are dropped because their keys are the full level descriptions, which would cost tokens on every text.

## Development

```bash
npm run lint      # tsc --noEmit
npm run test:run  # vitest
npm run build     # emits dist/
```
