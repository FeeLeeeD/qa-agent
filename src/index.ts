import { mkdir } from "node:fs/promises";
import path from "node:path";
import { APICallError } from "ai";
import { loadEnv } from "./env.ts";
import { loadOverview } from "./knowledge.ts";
import { createModel } from "./llm/index.ts";
import { logger } from "./logger.ts";
import { initMcp } from "./mcp.ts";
import {
  definePhaseSpec,
  type PhaseSpec,
  runSession,
} from "./orchestrator/index.ts";
import {
  type CreateJobOutput,
  createJobPhase,
  type JobMode,
  loginPhase,
  observeJobPhase,
} from "./phases/index.ts";
import { generateReport } from "./reporting/generate-report.ts";
import { generateRunId } from "./storage/db.ts";
import { getRunDir, recordObservation } from "./storage/index.ts";

const DEFAULT_TEST_CASE = "baseline";
const EXIT_FAILURE = 1;

const main = async (): Promise<void> => {
  const env = loadEnv();
  const testCaseName = process.argv[2] ?? DEFAULT_TEST_CASE;
  const runId = generateRunId();

  // Scratch directory the Playwright MCP subprocess can use as cwd. The
  // orchestrator owns per-run dirs (created inside runSession), so MCP
  // artifacts that aren't tied to a specific phase land here.
  const mcpOutputDir = path.resolve(
    process.cwd(),
    "reports",
    getRunDir(runId),
    "mcp"
  );
  await mkdir(mcpOutputDir, { recursive: true });

  const mcp = await initMcp({
    headless: env.HEADLESS,
    outputDir: mcpOutputDir,
  });
  const model = createModel();
  const knowledge = loadOverview();

  const pipeline: PhaseSpec[] = [
    definePhaseSpec({
      phase: loginPhase,
      buildInput: () => ({
        email: env.DEV_APP_EMAIL,
        password: env.DEV_APP_PASSWORD,
        url: env.DEV_APP_URL,
      }),
      buildKnowledge: () => `The dev app URL is ${env.DEV_APP_URL}.`,
    }),
    definePhaseSpec({
      phase: createJobPhase,
      buildInput: (ctx) => {
        const params = ctx.testCase.parameters;
        return {
          jobName: `${params.job_name_prefix}-${Date.now().toString()}`,
          mode: params.mode as JobMode,
          listName: params.list_name as string,
          throttlingOption: params.throttling_option as string,
          deliveryWindowHours: params.delivery_window_hours as number,
          recyclePeople: params.recycle_people as boolean,
          recyclePercentage:
            (params.recycle_percentage as number | null) ?? null,
        };
      },
      buildKnowledge: () =>
        `${knowledge}\nThe dev app URL is ${env.DEV_APP_URL}.`,
    }),
    definePhaseSpec({
      phase: observeJobPhase,
      buildInput: (ctx) => {
        const created = ctx.outputs[createJobPhase.name] as CreateJobOutput;
        return { jobId: created.jobId };
      },
      buildKnowledge: () =>
        `${knowledge}\nThe dev app URL is ${env.DEV_APP_URL}.`,
      onSuccess: (output, ctx) => {
        const created = ctx.outputs[createJobPhase.name] as CreateJobOutput;
        recordObservation({
          runId: ctx.runId,
          targetType: "job",
          targetId: created.jobId,
          metrics: output,
          screenshotPaths: output.screenshotPaths,
          observedAt: output.observedAt,
        });
      },
    }),
  ];

  let exitCode = 0;
  try {
    const result = await runSession({
      runId,
      testCaseName,
      pipeline,
      tools: mcp.tools,
      model,
    });
    const { reportPath } = await generateReport({ runId: result.runId });
    logger.info("run complete", {
      runId: result.runId,
      status: result.status,
      failedPhase: result.failedPhase,
      durationMs: Math.round(result.durationMs),
      reportPath,
    });
    if (result.status !== "done") {
      exitCode = EXIT_FAILURE;
    }
  } finally {
    try {
      await mcp.dispose();
    } catch (err) {
      logger.warn("mcp dispose failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  process.exit(exitCode);
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
