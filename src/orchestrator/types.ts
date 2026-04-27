import type { Phase } from "../phases/types.ts";
import type { TestCase } from "../test-cases/index.ts";

/**
 * Per-phase configuration the orchestrator consumes. Each spec is
 * self-consistent: its `phase`, `buildInput`, and `onSuccess` all share
 * the same `TInput`/`TOutput` types. The orchestrator stores them in a
 * heterogeneous array and erases the type parameters at the array
 * boundary — see `definePhaseSpec` for safe construction.
 */
export interface PhaseSpec<TInput = unknown, TOutput = unknown> {
  /**
   * Build typed input for this phase from the session context.
   */
  buildInput: (ctx: SessionContext) => TInput;
  /**
   * Optional knowledge text to inject into the phase's system prompt.
   * Defaults to "". Knowledge-base loading lands in a later step.
   */
  buildKnowledge?: (ctx: SessionContext) => string;
  /**
   * Optional side-effect after a successful phase, e.g. recording an
   * observation. Errors here mark the phase as failed post-hoc — the
   * orchestrator wraps and logs them.
   */
  onSuccess?: (output: TOutput, ctx: SessionContext) => void | Promise<void>;
  /** The Phase definition (from src/phases). */
  phase: Phase<TInput, TOutput>;
}

/**
 * Captures the cumulative state shared between phase specs in a single
 * orchestrator run. Mutated by the orchestrator as phases complete.
 */
export interface SessionContext {
  /**
   * Outputs of phases that have completed successfully, keyed by
   * `phase.name`. Subsequent specs read prior outputs through this map.
   */
  outputs: Record<string, unknown>;
  runDir: string;
  runId: string;
  testCase: TestCase;
}

export interface SessionResult {
  durationMs: number;
  failedPhase: string | null;
  runId: string;
  status: "done" | "failed";
}

/**
 * Type-safe constructor for `PhaseSpec` array entries. Phase types are
 * contravariant in `TInput` (the runner calls `phase.buildUserPrompt`),
 * so `PhaseSpec<I, O>` is not directly assignable to
 * `PhaseSpec<unknown, unknown>` even when the spec is internally
 * consistent. This helper performs a single supervised cast so
 * call-sites remain strongly typed.
 */
export const definePhaseSpec = <TInput, TOutput>(
  spec: PhaseSpec<TInput, TOutput>
): PhaseSpec => spec as unknown as PhaseSpec;
