import type { LanguageModel } from "ai";
import { logger } from "../logger.ts";
import { runPhase } from "../phases/index.ts";
import { createRun, finishRun } from "../storage/index.ts";
import { loadTestCase } from "../test-cases/index.ts";
import type { PhaseSpec, SessionContext, SessionResult } from "./types.ts";

export interface RunSessionArgs {
  model: LanguageModel;
  pipeline: readonly PhaseSpec[];
  testCaseName: string;
  /** Tools object returned by `initMcp`. */
  tools: Record<string, unknown>;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Executes `args.pipeline` in order against a freshly-created run. Never
 * throws on phase failures — those are reported via the returned
 * `SessionResult`. Programmer errors (bad pipeline, broken env, missing
 * test case file) DO throw, before any phase has run.
 */
export const runSession = async (
  args: RunSessionArgs
): Promise<SessionResult> => {
  const { testCaseName, pipeline, tools, model } = args;

  // 1. Resolve the test case up-front so a typo fails before we open a DB.
  const testCase = loadTestCase(testCaseName);
  logger.info("session_test_case_loaded", {
    testCase: testCase.name,
    targetType: testCase.targetType,
    parameterKeys: Object.keys(testCase.parameters),
  });

  // 2. Open a run row + per-run directory.
  const { runId, runDir } = createRun({ testCaseName: testCase.name });
  logger.info("session_started", {
    runId,
    runDir,
    testCase: testCase.name,
    pipelineLength: pipeline.length,
  });

  const ctx: SessionContext = {
    runId,
    runDir,
    testCase,
    outputs: {},
  };

  const startedAt = performance.now();
  let failedPhase: string | null = null;

  for (let i = 0; i < pipeline.length; i += 1) {
    const spec = pipeline[i];
    if (!spec) {
      continue;
    }
    const phaseName = spec.phase.name;
    const phaseIndex = i + 1;

    logger.info("session_phase_dispatching", {
      runId,
      phaseIndex,
      phase: phaseName,
    });

    let input: unknown;
    try {
      input = spec.buildInput(ctx);
    } catch (err) {
      logger.error("session_build_input_failed", {
        runId,
        phase: phaseName,
        error: errorMessage(err),
      });
      failedPhase = phaseName;
      break;
    }

    const knowledge = spec.buildKnowledge ? spec.buildKnowledge(ctx) : "";

    const result = await runPhase({
      phase: spec.phase,
      input,
      knowledge,
      runId,
      runDir,
      allTools: tools,
      model,
    });

    if (result.status === "failed") {
      failedPhase = phaseName;
      break;
    }

    ctx.outputs[phaseName] = result.output;

    if (spec.onSuccess) {
      try {
        await spec.onSuccess(result.output, ctx);
      } catch (err) {
        logger.error("session_on_success_failed", {
          runId,
          phase: phaseName,
          error: errorMessage(err),
        });
        failedPhase = phaseName;
        break;
      }
    }
  }

  const status: SessionResult["status"] =
    failedPhase === null ? "done" : "failed";
  finishRun(runId, status);

  const durationMs = performance.now() - startedAt;
  logger.info("session_finished", {
    runId,
    status,
    failedPhase,
    durationMs: Math.round(durationMs),
  });

  return { runId, status, failedPhase, durationMs };
};
