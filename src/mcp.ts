import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import { logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";

interface McpHandle {
  close: () => Promise<void>;
  tools: ToolSet;
}

interface LaunchOptions {
  headless: boolean;
  metrics: Metrics;
  outputDir: string;
}

export const launchPlaywrightMcp = async (
  options: LaunchOptions
): Promise<McpHandle> => {
  const args = [
    "playwright-mcp",
    "--isolated",
    "--output-dir",
    options.outputDir,
  ];
  if (options.headless) {
    args.push("--headless");
  }

  logger.info("launching Playwright MCP", {
    headless: options.headless,
    outputDir: options.outputDir,
  });

  const client = await createMCPClient({
    transport: new Experimental_StdioMCPTransport({
      command: "pnpm",
      args: ["exec", ...args],
      // Playwright MCP resolves `browser_take_screenshot`'s `filename` via
      // `workspaceFile`, which is anchored on the subprocess `options.cwd`
      // — not on `--output-dir`. So we pin cwd to the report directory to
      // make screenshot artifacts land next to the report.
      cwd: options.outputDir,
      env: {
        ...process.env,
        PLAYWRIGHT_MCP_OUTPUT_DIR: options.outputDir,
      },
    }),
  });

  const rawTools = await client.tools();
  logger.info("MCP tools discovered", {
    count: Object.keys(rawTools).length,
    names: Object.keys(rawTools),
  });

  const tools = instrumentTools(rawTools, options.metrics);

  return {
    tools,
    close: async () => {
      await client.close();
    },
  };
};

const instrumentTools = (rawTools: ToolSet, metrics: Metrics): ToolSet => {
  const entries = Object.entries(rawTools).map(([name, tool]) => {
    const originalExecute = tool.execute;
    if (!originalExecute) {
      return [name, tool] as const;
    }
    const wrapped = {
      ...tool,
      execute: async (
        args: unknown,
        ctx: Parameters<typeof originalExecute>[1]
      ) => {
        const startedAt = performance.now();
        const startedAtAbsolute = Date.now();
        try {
          const result = await originalExecute(args, ctx);
          metrics.toolCalls.push({
            name,
            args,
            durationMs: performance.now() - startedAt,
            ok: true,
            at: startedAtAbsolute,
          });
          logger.info("tool call ok", {
            name,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          metrics.toolCalls.push({
            name,
            args,
            durationMs: performance.now() - startedAt,
            ok: false,
            error: message,
            at: startedAtAbsolute,
          });
          logger.error("tool call failed", { name, error: message });
          throw err;
        }
      },
    };
    return [name, wrapped] as const;
  });
  return Object.fromEntries(entries) as ToolSet;
};

export interface InitMcpOptions {
  headless: boolean;
  /**
   * Directory the Playwright MCP subprocess uses as its cwd / output root
   * for screenshots and traces. Real phases will pass per-run directories
   * once they wire it through; for the orchestrator stub flow this can
   * point at any writable location.
   */
  outputDir: string;
}

export interface McpSession {
  /** Best-effort shutdown of the underlying MCP subprocess. */
  dispose: () => Promise<void>;
  tools: ToolSet;
}

/**
 * Lightweight Playwright MCP launcher used by the orchestrator path. Same
 * subprocess wiring as `launchPlaywrightMcp`, minus the legacy `metrics`
 * dependency. Tool calls are logged via `logger`; per-call durations and
 * args land in `step-NNN.json` artifacts written by the phase runner.
 */
export const initMcp = async (options: InitMcpOptions): Promise<McpSession> => {
  const configPath = path.join(options.outputDir, "config.json");

  const args = [
    "playwright-mcp",
    "--isolated",
    "--ignore-https-errors",
    "--config",
    configPath,
    "--output-dir",
    options.outputDir,
  ];
  if (options.headless) {
    args.push("--headless");
  }

  logger.info("initMcp launching", {
    headless: options.headless,
    outputDir: options.outputDir,
    configPath,
  });

  await writeFile(
    configPath,
    JSON.stringify({
      browser: {
        contextOptions: { locale: "en-US" },
      },
    })
  );
  const client = await createMCPClient({
    transport: new Experimental_StdioMCPTransport({
      command: "pnpm",
      args: ["exec", ...args],
      // Playwright MCP resolves `browser_take_screenshot`'s `filename` via
      // `workspaceFile`, which is anchored on the subprocess `options.cwd`
      // — not on `--output-dir`. So we pin cwd to the report directory to
      // make screenshot artifacts land next to the report.
      cwd: options.outputDir,
      env: {
        ...process.env,
        PLAYWRIGHT_MCP_OUTPUT_DIR: options.outputDir,
      },
    }),
  });

  const rawTools = await client.tools();
  logger.info("initMcp tools discovered", {
    count: Object.keys(rawTools).length,
    names: Object.keys(rawTools),
  });

  const tools = wrapToolsForLogging(rawTools);

  return {
    tools,
    dispose: async () => {
      await client.close();
    },
  };
};

/**
 * Minimal logging wrapper around tool.execute. Mirrors the bookkeeping
 * `instrumentTools` does for the legacy Metrics path, but writes only
 * structured logs — duration and args are already captured per-step by
 * `writeStepArtifact` inside the phase runner.
 */
const wrapToolsForLogging = (rawTools: ToolSet): ToolSet => {
  const entries = Object.entries(rawTools).map(([name, tool]) => {
    const originalExecute = tool.execute;
    if (!originalExecute) {
      return [name, tool] as const;
    }
    const wrapped = {
      ...tool,
      execute: async (
        args: unknown,
        ctx: Parameters<typeof originalExecute>[1]
      ) => {
        const startedAt = performance.now();
        try {
          const result = await originalExecute(args, ctx);
          logger.info("tool call ok", {
            name,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("tool call failed", { name, error: message });
          throw err;
        }
      },
    };
    return [name, wrapped] as const;
  });
  return Object.fromEntries(entries) as ToolSet;
};
