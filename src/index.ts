import { mkdir } from "node:fs/promises";
import path from "node:path";
import { APICallError } from "ai";
import {
  buildUserPrompt,
  MODEL_LABEL,
  runAgent,
  SYSTEM_PROMPT,
} from "./agent.ts";
import { loadEnv } from "./env.ts";
import { logger } from "./logger.ts";
import { launchPlaywrightMcp } from "./mcp.ts";
import { createMetrics } from "./metrics.ts";
import { writeReport } from "./report.ts";

const EXIT_FAILURE = 1;

const main = async (): Promise<void> => {
  const env = loadEnv();

  const reportDir = path.resolve(
    process.cwd(),
    "reports",
    new Date().toISOString().replace(/[:.]/g, "-")
  );
  await mkdir(reportDir, { recursive: true });
  logger.info("report directory ready", { reportDir });

  const metrics = createMetrics({
    systemPrompt: SYSTEM_PROMPT,
    prompt: buildUserPrompt(env),
    model: MODEL_LABEL,
  });

  const mcp = await launchPlaywrightMcp({
    headless: env.HEADLESS,
    outputDir: reportDir,
    metrics,
  });

  try {
    await runAgent({ env, tools: mcp.tools, metrics });
  } finally {
    metrics.endedAt = performance.now();
    try {
      await mcp.close();
    } catch (err) {
      logger.warn("mcp close failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const reportPath = await writeReport({
      metrics,
      reportDir,
      modelLabel: MODEL_LABEL,
    });
    logger.info("report written", {
      reportPath,
      wallMs: Math.round(
        (metrics.endedAt ?? performance.now()) - metrics.startedAt
      ),
      steps: metrics.steps.length,
      toolCalls: metrics.toolCalls.length,
    });
  }
};

main().catch((err) => {
  if (APICallError.isInstance(err)) {
    logger.error("run failed (API call)", {
      message: err.message,
      statusCode: err.statusCode,
      url: err.url,
      responseBody: err.responseBody,
      requestBody: err.requestBodyValues,
    });
  } else {
    logger.error("run failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(EXIT_FAILURE);
});
