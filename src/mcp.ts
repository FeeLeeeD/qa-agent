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
