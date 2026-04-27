import {
  AISDKError,
  APICallError,
  generateText,
  type StepResult,
  stepCountIs,
  type ToolSet,
  tool,
} from "ai";
import { logger } from "../logger.ts";
import { finishPhase, startPhase } from "../storage/index.ts";
import { writeStepArtifact } from "./artifacts.ts";
import type { Phase, PhaseError, PhaseResult, RunPhaseArgs } from "./types.ts";

const KNOWLEDGE_PLACEHOLDER = "{{knowledge}}";

const FINAL_ANSWER_TOOL = "__final_answer";

const FINAL_ANSWER_INSTRUCTION = [
  `When you have completed the task, call the \`${FINAL_ANSWER_TOOL}\` tool exactly once`,
  "with the structured result that conforms to its input schema.",
  `Do not output text after calling it. Do not call \`${FINAL_ANSWER_TOOL}\` more than once.`,
].join(" ");

interface ToolErrorRecord {
  details: string;
  toolName: string;
}

/**
 * Build the tool subset the model is allowed to call. Throws (caught by the
 * runner and returned as `unknown`) when an allowed tool name has no
 * corresponding entry in `allTools`.
 */
const filterTools = (
  allTools: Record<string, unknown>,
  allowedTools: readonly string[]
): ToolSet => {
  const filtered: Record<string, unknown> = {};
  for (const name of allowedTools) {
    if (!Object.hasOwn(allTools, name)) {
      throw new Error(
        `phase runner: allowed tool "${name}" is not present in allTools`
      );
    }
    filtered[name] = allTools[name];
  }
  return filtered as ToolSet;
};

const buildSystemPrompt = (template: string, knowledge: string): string =>
  template.split(KNOWLEDGE_PLACEHOLDER).join(knowledge);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Inspect a step's content for `tool-error` parts. AI SDK v6 surfaces tool
 * execute() rejections as `tool-error` content parts; they do not appear in
 * `step.toolResults`.
 */
const collectToolErrors = (
  step: StepResult<ToolSet>
): readonly ToolErrorRecord[] => {
  const errors: ToolErrorRecord[] = [];
  for (const part of step.content) {
    if (part.type === "tool-error") {
      errors.push({
        toolName: part.toolName,
        details: errorMessage(part.error),
      });
    }
  }
  return errors;
};

interface FinalizeArgs {
  phaseId: number;
  phaseName: string;
  runId: string;
  startedAt: number;
  steps: number;
}

const finalizeOk = <TOutput>(
  args: FinalizeArgs & { output: TOutput }
): PhaseResult<TOutput> => {
  const durationMs = performance.now() - args.startedAt;
  finishPhase({
    phaseId: args.phaseId,
    status: "done",
    output: args.output,
  });
  logger.info("phase_finished", {
    runId: args.runId,
    phaseId: args.phaseId,
    phase: args.phaseName,
    status: "ok",
    steps: args.steps,
    durationMs: Math.round(durationMs),
  });
  return {
    status: "ok",
    output: args.output,
    phaseId: args.phaseId,
    steps: args.steps,
    durationMs,
  };
};

const finalizeFailed = <TOutput>(
  args: FinalizeArgs & { error: PhaseError }
): PhaseResult<TOutput> => {
  const durationMs = performance.now() - args.startedAt;
  const details =
    "details" in args.error ? args.error.details : JSON.stringify(args.error);
  finishPhase({
    phaseId: args.phaseId,
    status: "failed",
    error: `${args.error.kind}: ${details}`,
  });
  logger.warn("phase_failed", {
    runId: args.runId,
    phaseId: args.phaseId,
    phase: args.phaseName,
    kind: args.error.kind,
    details,
  });
  logger.info("phase_finished", {
    runId: args.runId,
    phaseId: args.phaseId,
    phase: args.phaseName,
    status: "failed",
    steps: args.steps,
    durationMs: Math.round(durationMs),
  });
  return {
    status: "failed",
    error: args.error,
    phaseId: args.phaseId,
    steps: args.steps,
    durationMs,
  };
};

/**
 * Build a one-line, human-actionable detail string from an `APICallError`.
 * The default `.message` from Portkey/OpenRouter is often just "Bad Request";
 * the useful information lives in `statusCode`, `url`, and `responseBody`.
 */
const formatApiCallError = (err: APICallError): string => {
  const parts: string[] = [];
  if (err.statusCode !== undefined) {
    parts.push(`status=${err.statusCode}`);
  }
  parts.push(`message=${err.message}`);
  if (err.url) {
    parts.push(`url=${err.url}`);
  }
  if (err.responseBody && err.responseBody.length > 0) {
    parts.push(`body=${err.responseBody}`);
  }
  return parts.join(" ");
};

/**
 * Map a thrown value from `generateText` to a `PhaseError`. The runner is
 * the boundary that converts SDK exceptions into structured outcomes.
 */
const classifyThrown = (
  err: unknown,
  abortedByTimer: boolean,
  timeoutMs: number
): PhaseError => {
  if (abortedByTimer) {
    return { kind: "timeout", afterMs: timeoutMs };
  }
  if (APICallError.isInstance(err)) {
    return { kind: "model_error", details: formatApiCallError(err) };
  }
  if (AISDKError.isInstance(err)) {
    return { kind: "model_error", details: err.message };
  }
  return { kind: "unknown", details: errorMessage(err) };
};

interface FakePhaseRunArgs<TInput, TOutput> {
  input: TInput;
  phase: Phase<TInput, TOutput>;
  phaseId: number;
  runDir: string;
  runId: string;
  startedAt: number;
}

/**
 * Short-circuit path for `kind: "fake"` phases used by stubs and tests.
 * Skips the LLM, validates `phase.produce(input)` against `outputSchema`,
 * writes a single `step-001.json` artifact, and persists the row exactly
 * like a real phase would. Returns `PhaseResult` errors via the same
 * `PhaseError` shape so callers can't tell the difference.
 */
const runFakePhase = <TInput, TOutput>(
  args: FakePhaseRunArgs<TInput, TOutput>
): PhaseResult<TOutput> => {
  const { phase, input, runId, runDir, phaseId, startedAt } = args;
  if (!phase.produce) {
    return finalizeFailed<TOutput>({
      phaseId,
      phaseName: phase.name,
      runId,
      steps: 0,
      startedAt,
      error: {
        kind: "unknown",
        details: `fake phase "${phase.name}" is missing produce()`,
      },
    });
  }

  let produced: TOutput;
  try {
    produced = phase.produce(input);
  } catch (err) {
    return finalizeFailed<TOutput>({
      phaseId,
      phaseName: phase.name,
      runId,
      steps: 0,
      startedAt,
      error: { kind: "unknown", details: errorMessage(err) },
    });
  }

  const parsed = phase.outputSchema.safeParse(produced);
  if (!parsed.success) {
    return finalizeFailed<TOutput>({
      phaseId,
      phaseName: phase.name,
      runId,
      steps: 0,
      startedAt,
      error: {
        kind: "schema_validation",
        details: parsed.error.message,
      },
    });
  }

  try {
    writeStepArtifact({
      runDir,
      phaseName: phase.name,
      stepIndex: 1,
      payload: { kind: "fake", input, output: parsed.data },
    });
  } catch (err) {
    return finalizeFailed<TOutput>({
      phaseId,
      phaseName: phase.name,
      runId,
      steps: 0,
      startedAt,
      error: { kind: "unknown", details: errorMessage(err) },
    });
  }

  return finalizeOk<TOutput>({
    phaseId,
    phaseName: phase.name,
    runId,
    steps: 1,
    startedAt,
    output: parsed.data,
  });
};

/**
 * Universal Phase runner. Persists a `phase_executions` row, runs the LLM
 * with a filtered tool set and structured output, captures per-step
 * artifacts, and returns a typed result. Never throws on AI SDK errors,
 * schema mismatches, timeouts, or tool failures — all are returned as
 * `{ status: "failed", error }`.
 */
export const runPhase = async <TInput, TOutput>(
  args: RunPhaseArgs<TInput, TOutput>
): Promise<PhaseResult<TOutput>> => {
  const { phase, input, runId, runDir, allTools, model } = args;
  const knowledge = args.knowledge ?? "";

  const { phaseId } = startPhase({ runId, phaseName: phase.name });
  const startedAt = performance.now();
  let stepsCount = 0;
  let firstToolError: ToolErrorRecord | undefined;

  logger.info("phase_started", {
    runId,
    phaseId,
    phase: phase.name,
    allowedTools: phase.allowedTools.length,
    kind: phase.kind ?? "real",
  });

  // Fake-phase short-circuit: deterministic, no LLM, no tools.
  if (phase.kind === "fake") {
    return runFakePhase<TInput, TOutput>({
      phase,
      input,
      runId,
      runDir,
      phaseId,
      startedAt,
    });
  }

  let filteredTools: ToolSet;
  try {
    filteredTools = filterTools(allTools, phase.allowedTools);
  } catch (err) {
    return finalizeFailed<TOutput>({
      phaseId,
      phaseName: phase.name,
      runId,
      steps: 0,
      startedAt,
      error: { kind: "unknown", details: errorMessage(err) },
    });
  }

  // __final_answer is injected by the runner — phases do NOT list it in
  // allowedTools. It sits alongside the phase's whitelisted MCP tools.
  const llmTools: ToolSet = {
    ...filteredTools,
    [FINAL_ANSWER_TOOL]: tool({
      description:
        "Return your final structured result by calling this tool exactly once. " +
        "Do not respond with plain text after calling it.",
      inputSchema: phase.outputSchema,
    }),
  };

  const builtSystem = buildSystemPrompt(phase.systemPrompt, knowledge);
  const systemPrompt = `${builtSystem}\n\n${FINAL_ANSWER_INSTRUCTION}`;
  const userPrompt = phase.buildUserPrompt(input, knowledge);

  const abortController = new AbortController();
  let abortedByTimer = false;
  const timeoutHandle = setTimeout(() => {
    abortedByTimer = true;
    abortController.abort();
  }, phase.timeoutMs);

  try {
    const result = await generateText({
      model,
      tools: llmTools,
      toolChoice: "auto",
      system: systemPrompt,
      prompt: userPrompt,
      stopWhen: stepCountIs(phase.maxSteps),
      temperature: 0,
      abortSignal: abortController.signal,
      onStepFinish: (step) => {
        stepsCount += 1;
        const hasFinalAnswer = step.toolCalls.some(
          (c) => c.toolName === FINAL_ANSWER_TOOL
        );
        writeStepArtifact({
          runDir,
          phaseName: phase.name,
          stepIndex: stepsCount,
          payload: {
            stepIndex: stepsCount,
            timestamp: new Date(Date.now()).toISOString(),
            text: step.text,
            toolCalls: step.toolCalls,
            toolResults: step.toolResults,
            finishReason: step.finishReason,
            usage: step.usage,
            hasFinalAnswer,
          },
        });
        if (firstToolError === undefined) {
          const errs = collectToolErrors(step);
          if (errs.length > 0) {
            firstToolError = errs[0];
          }
        }
      },
    });

    if (firstToolError !== undefined) {
      return finalizeFailed<TOutput>({
        phaseId,
        phaseName: phase.name,
        runId,
        steps: stepsCount,
        startedAt,
        error: {
          kind: "tool_call_failed",
          toolName: firstToolError.toolName,
          details: firstToolError.details,
        },
      });
    }

    const finalAnswerCalls = result.steps
      .flatMap((s) => s.toolCalls)
      .filter((c) => c.toolName === FINAL_ANSWER_TOOL);

    if (finalAnswerCalls.length === 0) {
      return finalizeFailed<TOutput>({
        phaseId,
        phaseName: phase.name,
        runId,
        steps: stepsCount,
        startedAt,
        error: { kind: "step_limit_exceeded", steps: stepsCount },
      });
    }

    if (finalAnswerCalls.length > 1) {
      logger.warn("phase_multiple_final_answers", {
        runId,
        phaseId,
        phase: phase.name,
        count: finalAnswerCalls.length,
      });
    }

    const lastFinalCall = finalAnswerCalls.at(-1);
    const parsed = phase.outputSchema.safeParse(lastFinalCall?.input);
    if (!parsed.success) {
      return finalizeFailed<TOutput>({
        phaseId,
        phaseName: phase.name,
        runId,
        steps: stepsCount,
        startedAt,
        error: {
          kind: "schema_validation",
          details: parsed.error.message,
        },
      });
    }

    return finalizeOk<TOutput>({
      phaseId,
      phaseName: phase.name,
      runId,
      steps: stepsCount,
      startedAt,
      output: parsed.data,
    });
  } catch (err) {
    if (firstToolError !== undefined) {
      return finalizeFailed<TOutput>({
        phaseId,
        phaseName: phase.name,
        runId,
        steps: stepsCount,
        startedAt,
        error: {
          kind: "tool_call_failed",
          toolName: firstToolError.toolName,
          details: firstToolError.details,
        },
      });
    }
    const error = classifyThrown(err, abortedByTimer, phase.timeoutMs);
    return finalizeFailed<TOutput>({
      phaseId,
      phaseName: phase.name,
      runId,
      steps: stepsCount,
      startedAt,
      error,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
};
