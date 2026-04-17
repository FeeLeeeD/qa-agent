# QA Agent

Experimental QA agent that drives a browser via Playwright MCP and an LLM served through Portkey (OpenRouter → Claude).

The repo is in an early stage: right now it's a playground for probing MCP tool latency and LLM behavior inside an agentic loop. Functionality will grow step by step.

## Stack

- **Runtime**: Node.js 22+, TypeScript (strict), ESM, [tsx](https://github.com/privatenumber/tsx) for build-free execution
- **Agent loop**: [Vercel AI SDK v6](https://ai-sdk.dev) (`ai`) + `@ai-sdk/openai-compatible` + `@ai-sdk/mcp`
- **Browser**: [@playwright/mcp](https://github.com/microsoft/playwright-mcp) as a stdio subprocess
- **LLM**: Claude Sonnet 4.6 via Portkey AI → OpenRouter
- **Package manager**: pnpm
- **Lint/format**: [Ultracite](https://ultracite.ai) (Biome)

## Layout

```
src/
├── index.ts     — entrypoint: env → MCP → agent → report
├── env.ts       — zod schema for environment variables
├── agent.ts     — Portkey provider, generateText + onStepFinish
├── mcp.ts       — Playwright MCP launcher + per-tool-call timing
├── metrics.ts   — shared metrics state
├── report.ts    — Markdown report writer
└── logger.ts    — structured JSON logger
```

Every run writes its artifacts (screenshots, page snapshots, console logs, `report.md`) into `reports/<ISO-timestamp>/`.

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
pnpm start
```

After the run finishes, `reports/<timestamp>/report.md` contains a timeline of LLM steps, tool calls, and links to artifacts.

## Checks

```sh
pnpm check   # Ultracite / Biome — lint
pnpm fix     # auto-fix
```

## Current scenario

The code currently hard-codes a simple "hello world" run: the agent opens `DEV_APP_URL`, logs in with the provided credentials, confirms a post-login screen, and takes a final screenshot. It's a throwaway scenario for latency measurements — the prompt and flow will change as the project evolves.
