# QA Agent — Architecture Overview

## What this is

An automated QA agent that tests our job scheduling feature end-to-end on the real dev environment — with real integrations and no mocks. It replaces the weekly manual QA pass: create a few jobs with varied parameters, watch them schedule and deliver over ~24 hours, and produce a report on whether everything looks sane.

## Why it's not "just a Playwright script"

Job scheduling resists classical testing for three reasons:

1. **Integrations don't work in isolation.** HubSpot and Marketo must be real; mocking them makes the whole test meaningless.
2. **Jobs are dynamic.** A job goes through `creating → scheduling → scheduled → delivering` over minutes to 24+ hours, with live-updating charts and metrics. There's no single moment where "the test result" exists.
3. **Edge cases hide in parameter combinations.** Throttling algorithm × target open rate × delivery window × list size is a large space; a weekly fixed happy-path won't explore it.

The agent addresses all three: it works against real infrastructure, monitors jobs across their full lifecycle, and randomizes parameters within safe ranges each run to surface unexpected behavior.

## How a run works

A **run** is one QA session, triggered manually after each release deploy. During a run the agent:

1. **Creates jobs** with randomized (but reasonable) parameters, based on test cases.
2. **Monitors** each job: short-interval observations during the first ~15 minutes (scheduling phase) and a final observation ~24 hours later (delivering phase).
3. **Reports** its findings to Slack, attaching the raw observations so a human can verify quickly.

The human still decides whether to ship the release. The agent's job is to do the boring, repetitive watching — and to flag anything that deviates from expected behavior.

## The core loop

At each step, the agent (the LLM) receives an **observation** (page snapshot, screenshot, metrics extracted from UI or API), decides on an **action** (click, fill, navigate, or finish), and the browser executes it. This repeats until a phase is complete.

The agent is not one giant prompt that runs the whole test. Instead, the run is split into **phases** — narrow, well-defined tasks like "create a job with these parameters" or "collect metrics from this job page." Each phase has its own focused prompt, its own limited set of tools, and its own structured output. This is the single most important architectural choice: short-horizon agents are dramatically more stable than long-horizon ones.

## Key components

- **Orchestrator** — plain code, no AI. Owns the lifecycle: which phase runs when, how state persists across the 24-hour gap, retries on transient failures, final report assembly. It's the adult in the room.
- **Agent phases** — each phase is an LLM call with a specific system prompt, a subset of browser tools, and a required structured output. Phases don't know about each other; the orchestrator chains them.
- **Knowledge base** — static domain knowledge (how jobs work, what parameters mean, expected behaviors, numerical invariants) injected into phase prompts as needed. This is what makes the agent "domain-aware" instead of a generic clicker.
- **Test cases** — plain-language Markdown files describing what to test. Adding a new test = adding a file, no code changes.
- **Artifact store** — per-run directory with screenshots, page snapshots, extracted metrics, raw LLM exchanges, and the final report. Everything the agent saw and did, preserved for post-mortem.

## State and persistence

A run spans ~24 hours and cannot live in a single long-running process (VM reboots, network hiccups, OOMs would kill it). The orchestrator is designed around short processes triggered on a schedule, communicating through persistent state:

- **Run state** — which phase is next, when it's due, observations collected so far.
- **Observations** — each time the agent looks at a job, it stores a structured snapshot (status, numeric metrics, screenshot references, anomalies noted). The final report is built from these, not regenerated from scratch.

This means any phase can be retried or resumed independently. A failed observation at T+10min doesn't invalidate the T+5min one.

## Observation strategy: UI + API

Numbers extracted from the UI alone are unreliable (charts render as canvas, text can race with backend updates). The agent should get metrics from **two independent sources**:

- **UI** — screenshots and accessibility snapshots, for UX-level checks and as forensic evidence.
- **Backend API** — the same endpoints the frontend queries, hit directly by the agent for exact numbers.

Two independent sources of the same truth lets the orchestrator auto-check consistency and catches a whole class of frontend/backend sync bugs that pure UI testing misses.

## Structured output everywhere

Every agent phase returns data in a well-defined schema, not free text. "Describe what you see" produces unverifiable prose; `{status, scheduled_count, anomalies: []}` produces data the orchestrator can validate, compare across runs, and feed into the next phase. Free text appears only in the final human-readable report, and even there it sits alongside the raw structured facts it's based on.

## Report: facts vs. interpretation

The final report has two clearly separated sections:

- **Facts** — deterministically collected: parameter values, timestamps, numeric metrics per observation, screenshot links. The agent cannot hallucinate these because they come from API/DOM, not from the model.
- **Interpretation** — the model's analysis: does this look normal, are there anomalies, is anything suspicious. Each claim is tagged with a confidence level and references the specific facts it relies on.

This split is deliberate. A human reviewing the report can skim the facts in seconds, and only dig into the interpretation when something looks off. It also contains the blast radius of model hallucinations — the worst case is a misleading interpretation, not fabricated numbers.

## Randomization

Parameters are randomized by the orchestrator, not the agent. LLMs are poor random generators — they bias toward "reasonable" values and underexplore the edges. Deterministic random generation in code, with the agent receiving concrete values to use, gives better coverage and reproducibility (same seed = same run, useful for debugging).

## Stability as the top priority

The agent's value collapses if its reports aren't trustworthy. Several design choices follow from this:

- **Narrow phases** with hard step limits — agents lose coherence over long horizons.
- **Zero temperature** for navigation and data collection; creativity only in the interpretation step.
- **Retry at the phase level**, not the run level — transient failures shouldn't waste a full run.
- **An evaluation harness** — a set of known runs with known expected outputs, used to verify the agent itself before rolling out prompt or model changes. Without this, we can't tell whether a tweak improved or broke things.

## What success looks like

A release deploys to dev. Someone triggers the agent. Over the next day, the agent runs quietly, creates a few jobs, watches them, and drops a Slack message with a report. In the common case, the report says "everything looks normal" with enough detail that we trust it and move on. In the uncommon case, it flags something specific and points to the screenshots and metrics that made it suspicious — and we go look.

The agent doesn't replace the judgment of a QA engineer. It replaces the hours of clicking and watching that precede the judgment.