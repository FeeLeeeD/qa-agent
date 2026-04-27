# QA Agent

Automated QA agent that drives a browser via Playwright MCP and an LLM served through Portkey (OpenRouter → Claude). A test-case-driven orchestrator runs a pipeline of phases — each phase is an isolated LLM call with a narrow tool whitelist and a structured output contract — then generates a Markdown report with an LLM-written interpretation.

## Stack

- **Runtime**: Node.js 22+, TypeScript (strict), ESM, [tsx](https://github.com/privatenumber/tsx) for build-free execution
- **Agent loop**: [Vercel AI SDK v6](https://ai-sdk.dev) (`ai`) + `@ai-sdk/openai-compatible` + `@ai-sdk/mcp`
- **Browser**: [@playwright/mcp](https://github.com/microsoft/playwright-mcp) as a stdio subprocess
- **LLM**: Claude Sonnet 4.6 via Portkey AI → OpenRouter
- **Run state**: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — one SQLite file per run, validated with [zod](https://zod.dev)
- **Test cases**: Markdown files with YAML frontmatter, parsed with [gray-matter](https://github.com/jonschlinkert/gray-matter)
- **Package manager**: pnpm
- **Lint/format**: [Ultracite](https://ultracite.ai) (Biome)

## Layout

```
src/
├── index.ts          — entrypoint: env → MCP → pipeline → report
├── env.ts            — zod schema for environment variables
├── logger.ts         — structured JSON logger (newline-delimited JSON to stdout)
├── mcp.ts            — Playwright MCP launcher + per-tool-call logging
├── agent.ts          — (legacy) standalone Portkey provider + generateText
├── metrics.ts        — (legacy) shared metrics state
├── report.ts         — (legacy) Markdown report writer
│
├── llm/              — LLM client construction & structured output
│   ├── model.ts              — Portkey provider factory (single source of truth)
│   ├── structured.ts         — generateStructuredObject via tool-calling
│   └── index.ts              — public surface re-exports
│
├── orchestrator/     — session lifecycle & pipeline execution
│   ├── session.ts            — runSession: test case → run row → phase loop → result
│   ├── types.ts              — PhaseSpec, SessionContext, SessionResult, definePhaseSpec
│   ├── index.ts              — public surface re-exports
│   └── __smoke__.ts          — happy-path + negative-path smoke (run via tsx)
│
├── phases/           — phase runner & phase definitions
│   ├── runner.ts             — universal runPhase: LLM call, tool filtering, artifact capture
│   ├── types.ts              — Phase, PhaseError, PhaseResult, RunPhaseArgs
│   ├── artifacts.ts          — writeStepArtifact: per-step JSON with password redaction
│   ├── index.ts              — public surface re-exports
│   ├── __smoke__.ts          — phase runner smoke (real LLM call, run via tsx)
│   └── stubs/                — deterministic fake phases for testing the orchestrator
│       ├── fake-phase.ts             — fakePhase() helper (kind: "fake", no LLM)
│       ├── login-stub.ts             — login_stub phase
│       ├── create-job-stub.ts        — create_job_stub phase
│       └── observe-job-stub.ts       — observe_job_stub phase
│
├── test-cases/       — Markdown test case loader & schema
│   ├── schema.ts             — TestCaseFrontmatterSchema (zod, strict mode)
│   ├── loader.ts             — loadTestCase / listTestCases from test-cases/*.md
│   ├── index.ts              — public surface re-exports
│   └── __smoke__.ts          — loader + validation smoke (run via tsx)
│
├── reporting/        — post-run report generation
│   └── generate-report.ts    — Facts section (deterministic) + Interpretation (LLM)
│
└── storage/          — SQLite-backed run state (runs, phases, observations)
    ├── db.ts                 — connection cache, migrations, runId generator
    ├── schema.ts             — zod schemas for rows and JSON columns
    ├── runs.ts               — runs table operations
    ├── phases.ts             — phase_executions table operations
    ├── observations.ts       — observations table operations
    ├── index.ts              — public surface re-exports
    └── __smoke__.ts          — standalone lifecycle script (run via tsx)

test-cases/
└── baseline.md       — default test case (even-distribution scheduling sanity check)

reports/
└── <runId>/          — per-run artifacts directory
    ├── state.db              — SQLite database for this run
    ├── report.md             — generated Markdown report
    └── phases/
        └── <phase_name>/
            └── step-NNN.json — per-step artifact (tool calls, results, usage)
```

## Setup

1. Install dependencies:
   ```sh
   pnpm install
   ```
2. Copy `.env.example` to `.env` and fill in the variables:

   | Variable | Required | Description |
   |---|---|---|
   | `PORTKEY_API_KEY` | yes | Portkey API key |
   | `PORTKEY_VIRTUAL_KEY` | one of two | Portkey virtual key for the provider |
   | `PORTKEY_CONFIG` | one of two | Portkey config ID |
   | `DEV_APP_URL` | yes | URL of the app under test |
   | `DEV_APP_EMAIL` | yes | Login email |
   | `DEV_APP_PASSWORD` | yes | Login password |
   | `HEADLESS` | no | `true` to hide the browser window, defaults to `false` |

## Run

```sh
pnpm start              # runs the "baseline" test case
pnpm start <test-case>  # runs a specific test case by name
```

The entrypoint loads the named test case from `test-cases/<name>.md`, launches the Playwright MCP subprocess, assembles the phase pipeline, and hands everything to the orchestrator. After the run finishes, `reports/<runId>/report.md` contains the full report.

## Checks

```sh
pnpm check   # Ultracite / Biome — lint
pnpm fix     # auto-fix
```

## Architecture

### Orchestrator

`runSession` is the top-level execution loop. It loads a test case, creates a storage run, and iterates over a `PhaseSpec[]` pipeline in order. Each spec provides a `buildInput` function that reads prior phase outputs from `SessionContext`, an optional `buildKnowledge` function for injecting context into the system prompt, and an optional `onSuccess` callback for side-effects like recording observations. The pipeline halts on the first phase failure.

### Phases

A `Phase<TInput, TOutput>` is a self-contained unit of work: a system prompt, a user prompt builder, a tool whitelist, an output schema (zod), and step/timeout limits. The runner (`runPhase`) injects a synthetic `__final_answer` tool whose input schema matches the phase's output schema — the model calls it to return structured data. Per-step artifacts are written synchronously via `writeStepArtifact` (with automatic password redaction).

Phases can be `kind: "fake"` — the runner skips the LLM and evaluates a deterministic `produce(input)` function instead. This powers the stub phases used for orchestrator testing.

**Error handling**: the runner never throws on AI SDK errors, schema mismatches, timeouts, step-limit exhaustion, or tool failures. All are returned as `{ status: "failed", error: PhaseError }`.

### Test cases

Test cases are Markdown files under `test-cases/` with YAML frontmatter validated by a strict zod schema:

```yaml
---
name: baseline
description: Single job with conservative parameters; sanity check.
target_type: job
parameters:
  list_id: "smoke-list-100"
  throttling_algorithm: even_distribution
expectations:
  expected_status_after_scheduling: scheduled
---

# Baseline test case

Human-readable description of what the test does and what to verify.
```

Fields: `name` (slug, `^[a-z0-9_-]+$`), `description`, `target_type`, `parameters` (open record), `expectations` (open record, optional). Extra keys are rejected (strict mode).

### Report generation

After all phases complete, `generateReport` reads the SQLite state and produces a Markdown file with two sections:

1. **Facts** — deterministic rendering of run metadata, test case parameters, phase table (status, duration, errors), and observations with metrics.
2. **Interpretation** — an LLM pass (via `generateStructuredObject`) that reviews the facts and returns a structured verdict (`ok | suspicious | buggy | inconclusive`), confidence level, findings with severity, and free-form notes. If the LLM call fails, a fallback message is written and the report is still produced.

### LLM module

`createModel()` is the single source of truth for constructing the Portkey-routed OpenAI-compatible client. It reads validated env on every call. `generateStructuredObject` is a tool-calling wrapper that forces the model to invoke a synthetic `__final_answer` tool — this is used instead of `generateObject` / `Output.object` because tool-calling is more reliable for Anthropic models routed through Portkey/OpenRouter.

### Run state (SQLite)

- One DB per run at `reports/<runId>/state.db`. `runId` is a sortable id like `20260427T143012-a1b2`.
- Three tables: `runs`, `phase_executions`, `observations` (intentionally generic — `observations` is keyed by `target_type`/`target_id` so it can grow beyond jobs).
- Append-only migrations tracked via a `schema_version` table; one open connection cached per `runId`, closed on `finishRun` or process exit.
- All `*_json` columns are validated through zod on read; writes go through the typed functions in `src/storage/`.

## Smoke tests

Each module has a standalone smoke script that exercises the happy path and key negative paths:

```sh
pnpm smoke:storage       # storage lifecycle (creates run, phases, observations, re-opens DB)
pnpm smoke:test-cases    # loader + frontmatter validation (baseline + synthetic negative cases)
pnpm smoke:phases        # phase runner with a real LLM call (requires env)
pnpm smoke:orchestrator  # full pipeline: happy path + broken-phase negative path (requires env)
```

## Current pipeline

The default pipeline (`pnpm start`) runs three stub phases against the `baseline` test case:

1. **login_stub** — deterministic, echoes back the login email
2. **create_job_stub** — deterministic, produces a synthetic job ID
3. **observe_job_stub** — deterministic, produces a "scheduled" observation with synthetic metrics; the `onSuccess` callback records the observation in SQLite

All three are `kind: "fake"` (no LLM calls for the phases themselves). The report's Interpretation section does make a real LLM call. This setup validates the orchestrator → runner → storage → report pipeline end-to-end while real, browser-driving phases are built out.
