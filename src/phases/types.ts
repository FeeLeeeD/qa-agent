import type { LanguageModel } from "ai";
import type { z } from "zod";

/**
 * Per-run context handed to a phase by the runner. Phases that need access
 * to filesystem paths or storage row ids read them from here.
 */
export interface PhaseContext {
  /** Phase row id from storage, used by the runner to write artifacts under the right path. */
  phaseId: number;
  /** Per-run directory absolute path (e.g. .../reports/<runId>). */
  runDir: string;
  /** The runId this phase belongs to. */
  runId: string;
}

/**
 * A self-contained unit of work performed by an LLM with a narrow toolset
 * and a structured output contract. Phase objects are static configuration:
 * the runner is the only place that knows how to execute them.
 */
export interface Phase<TInput, TOutput> {
  /**
   * Whitelist of MCP tool names this phase is allowed to use. Other tools
   * are filtered out before the LLM call.
   */
  allowedTools: readonly string[];

  /**
   * Build the user prompt for this run. Receives the typed input plus the
   * knowledge text loaded by the orchestrator.
   */
  buildUserPrompt(input: TInput, knowledge: string): string;

  /**
   * Optional discriminator. When set to `"fake"`, the runner skips the LLM
   * call entirely and persists the result of `produce(input)` instead.
   * Real (LLM-driven) phases leave this undefined.
   */
  kind?: "fake";

  /** Hard cap on agent steps for this phase. */
  maxSteps: number;
  /** Stable identifier, also used as folder name for artifacts. snake_case. */
  name: string;

  /**
   * Zod schema describing the validated output object. Used both by the
   * underlying LLM call and by storage persistence.
   */
  outputSchema: z.ZodType<TOutput>;

  /**
   * Only consulted when `kind === "fake"`. Returns a deterministic output
   * object that the runner validates against `outputSchema` and persists.
   */
  produce?: (input: TInput) => TOutput;

  /**
   * Static system prompt. May reference `{{knowledge}}` placeholder which
   * the runner substitutes from the `knowledge` argument.
   */
  systemPrompt: string;

  /** Wall-clock timeout in ms for the entire phase execution. */
  timeoutMs: number;
}

/**
 * Discriminated union describing every way a phase can fail. The runner
 * never throws on these; it returns them inside `PhaseResult`.
 */
export type PhaseError =
  | { kind: "schema_validation"; details: string }
  | { kind: "step_limit_exceeded"; steps: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "tool_call_failed"; toolName: string; details: string }
  | { kind: "model_error"; details: string }
  | { kind: "unknown"; details: string };

export interface RunPhaseArgs<TInput, TOutput> {
  /** Tools object returned by `initMcp()` (or any superset of allowedTools). */
  allTools: Record<string, unknown>;
  input: TInput;
  /** Injected into systemPrompt placeholder; defaults to "" when absent. */
  knowledge?: string;
  /** Already-configured Vercel AI SDK model instance. */
  model: LanguageModel;
  phase: Phase<TInput, TOutput>;
  /** From `storage.createRun`. */
  runDir: string;
  /** From `storage.createRun`. */
  runId: string;
}

export type PhaseResult<TOutput> =
  | {
      status: "ok";
      output: TOutput;
      phaseId: number;
      steps: number;
      durationMs: number;
    }
  | {
      status: "failed";
      error: PhaseError;
      phaseId: number;
      steps: number;
      durationMs: number;
    };
