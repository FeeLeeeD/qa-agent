import { mkdir } from "node:fs/promises";
import path from "node:path";
import { APICallError } from "ai";
import { loadEnv } from "./env.ts";
import { createModel } from "./llm/model.ts";
import { logger } from "./logger.ts";
import { initMcp } from "./mcp.ts";
import {
  definePhaseSpec,
  type PhaseSpec,
  runSession,
} from "./orchestrator/index.ts";
import {
  type CreateJobStubOutput,
  createJobStubPhase,
} from "./phases/stubs/create-job-stub.ts";
import { loginStubPhase } from "./phases/stubs/login-stub.ts";
import { observeJobStubPhase } from "./phases/stubs/observe-job-stub.ts";
import { generateReport } from "./reporting/generate-report.ts";
import { recordObservation } from "./storage/index.ts";

const DEFAULT_TEST_CASE = "baseline";
const EXIT_FAILURE = 1;
const MCP_OUTPUT_DIRNAME = "_mcp-session";

const main = async (): Promise<void> => {
  const env = loadEnv();
  const testCaseName = process.argv[2] ?? DEFAULT_TEST_CASE;

  // Scratch directory the Playwright MCP subprocess can use as cwd. The
  // orchestrator owns per-run dirs (created inside runSession), so MCP
  // artifacts that aren't tied to a specific phase land here. Real phases
  // will eventually thread the runDir into screenshot paths directly.
  const mcpOutputDir = path.resolve(
    process.cwd(),
    "reports",
    MCP_OUTPUT_DIRNAME
  );
  await mkdir(mcpOutputDir, { recursive: true });

  const mcp = await initMcp({
    headless: env.HEADLESS,
    outputDir: mcpOutputDir,
  });
  const model = createModel();

  const pipeline: PhaseSpec[] = [
    definePhaseSpec({
      phase: loginStubPhase,
      buildInput: () => ({ email: env.DEV_APP_EMAIL }),
    }),
    definePhaseSpec({
      phase: createJobStubPhase,
      buildInput: (ctx) => ({
        // TODO: per-phase parameter validation lands when real phases ship.
        listId: ctx.testCase.parameters.list_id as string,
        // TODO: per-phase parameter validation lands when real phases ship.
        throttlingAlgorithm: ctx.testCase.parameters
          .throttling_algorithm as string,
      }),
    }),
    definePhaseSpec({
      phase: observeJobStubPhase,
      buildInput: (ctx) => {
        const created = ctx.outputs[
          createJobStubPhase.name
        ] as CreateJobStubOutput;
        return { jobId: created.jobId };
      },
      onSuccess: (output, ctx) => {
        const created = ctx.outputs[
          createJobStubPhase.name
        ] as CreateJobStubOutput;
        recordObservation({
          runId: ctx.runId,
          targetType: "job",
          targetId: created.jobId,
          metrics: output,
          screenshotPaths: [],
          observedAt: output.observedAt,
        });
      },
    }),
  ];

  let exitCode = 0;
  try {
    const result = await runSession({
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
