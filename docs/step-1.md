# Step 1 — First vertical slice

**Scope:** one Innovation Day · 2 developers · ~2 person-days total.

## Goal

Deliver the first end-to-end run of the agent: create one job, observe it once, produce a report. No 24-hour monitoring, no randomization, no Slack, no knowledge base — just the shortest possible path from "agent opens the app" to "report file exists on disk with real data in it."

The value of this step isn't the feature set. It's the **architectural shape**: after Step 1, adding a new phase or a new test case should be a matter of dropping in a file, not rewriting the core. Everything we build after this compounds on top of this scaffolding, so getting the shape right now is worth more than getting more behavior done.

## Non-goals

Explicitly out of scope for this step, to keep it achievable in one day:

- Parameter randomization
- Multiple jobs per run
- Multiple observations over time (just one, right after creation)
- The 24-hour final observation
- Slack delivery
- Anomaly detection logic beyond "does the data look structurally correct"
- A populated knowledge base (a minimal stub is fine)
- Eval harness
- Retries and sophisticated error handling

Anything on this list that sneaks in costs us the fundamentals. If there's time left at the end, use it on stability, not on these.

## Deliverables

At the end of the day, running `pnpm start` should:

1. Log in to the dev app.
2. Create one job via a single test case with fixed parameters.
3. Wait a short interval (~1–2 minutes), then collect one observation of the job.
4. Write a structured report to disk with the parameters used, the observed metrics, screenshots, and a short LLM-generated interpretation.

Running the same command again produces a new run in its own directory, independent of the previous one.

## Architectural moves

These are the shape-defining decisions for this step. Once in place, they define how every future step plugs in.

### Introduce phases as first-class

Split the current monolithic `runAgent` into distinct phases, each a separate module with its own system prompt, its own whitelisted subset of browser tools, and its own structured output schema. For Step 1 we need exactly three phases:

- **login** — authenticate, confirm we're in.
- **create-job** — navigate to job creation, fill the form with the given parameters, submit, confirm creation, return the new `jobId`.
- **observe-job** — open the job page, extract current metrics into a structured object, save screenshots.

Each phase is short (a handful of steps), has a hard step limit, and returns structured data. The orchestrator chains them; phases don't call each other directly.

### Introduce a run state, persisted

Even though Step 1 runs in a single process, the run state should already live in SQLite (or equivalent durable storage), not in memory. This matters now, not later: the moment we add a second observation or the 24h check, we need state that survives process restarts. Building on top of an in-memory `Metrics` object first and migrating later is the kind of rework that eats a whole Innovation Day on its own.

Minimum schema: a `run` (id, started_at, status), a row per `phase` execution (which phase, when, outcome, duration), and a row per `observation` (job_id, observed_at, metrics as JSON, screenshot paths). The current `Metrics` becomes a thin layer on top of this.

### Structured output on every phase

No phase returns free text as its primary result. Each phase declares a Zod schema, the LLM call uses structured generation, and the orchestrator validates. This is what makes the pipeline debuggable and lets us compare observations across runs later.

Free-text commentary from the model is fine, but it belongs in a dedicated field inside the schema, not as the whole output.

### Test cases as data, not code

Create a `test-cases/` directory. The test case for Step 1 is one Markdown file describing in plain language what to do (create a job with these parameters). The orchestrator reads it, the `create-job` phase receives its content in the prompt. No branching logic in code on which test case is running — the difference between test cases lives entirely in the `.md` file.

For Step 1 this is overkill for one test case, but it sets the precedent: adding a second test case later means adding a file, not modifying code.

### Tool whitelisting per phase

Currently every phase would have access to all ~30 MCP tools. That's both more attack surface for the model to wander off and more tokens burned describing unused tools. Each phase should declare exactly which tools it needs (typically 5–8) and the orchestrator constructs the toolset for that phase only.

## Suggested division of work

Two developers, roughly parallel tracks that converge at the end:

**Developer A — orchestration & state**
- Run directory + SQLite state store
- Phase abstraction (interface, runner, per-phase tool whitelist, step limits)
- Test case loader
- Report generator (facts table from structured observations + one short LLM interpretation pass at the end)

**Developer B — phases & prompts**
- Port existing login flow into the new phase format
- Build `create-job` phase: prompt, schema, tool whitelist, tune to pass reliably 5+ times in a row
- Build `observe-job` phase: prompt, schema, tool whitelist, extract the key metrics (status, contact counts, whatever the job page shows structurally)
- A stub knowledge-base file with just enough context for the two phases to work (will grow later)

Integration and end-to-end runs happen jointly in the last few hours. Expect a meaningful chunk of the day to go into making `create-job` reliable — it's the first phase doing real work and will surface a lot of prompt/selector issues.

## Stability bar before calling it done

Step 1 is done when the full run succeeds **five times in a row** without intervention on a stable dev deploy. Not "once, with some help." Not "usually." Five clean runs. If it passes four and fails on the fifth, it's not done — diagnose, fix, re-verify.

This bar exists because stability is our top priority and because flaky agents compound: every future phase we add on top of an unreliable foundation inherits and multiplies that unreliability.

## What we learn from this step

By the end of the day we should know concretely:

- How stable is Sonnet 4.6 at filling out our job creation form? (This informs how much selector hardening we need in the app itself — `data-testid` coverage, etc.)
- How well does the model extract numeric metrics from our job page? (This informs whether we need the API-based observation path sooner rather than later.)
- What's the token/cost profile of a single phase? (Informs budget for the full 24h flow.)
- Where does the agent get stuck or confused? (Informs what the knowledge base actually needs to contain.)

These answers shape Step 2 much more than any plan we could make in advance.