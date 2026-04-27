import type { z } from "zod";
import type { Phase } from "../types.ts";

interface FakePhaseArgs<TInput, TOutput> {
  name: string;
  produce: (input: TInput) => TOutput;
  schema: z.ZodType<TOutput>;
}

/**
 * Build a deterministic Phase that the runner short-circuits without an
 * LLM call. The returned object satisfies the full `Phase` interface, but
 * the LLM-only fields (system/user prompts, tool whitelist, step/timeout
 * caps) are placeholders — they are never consulted because
 * `kind: "fake"` is set.
 *
 * Use this for stubs and unit-testing the orchestrator. Real, LLM-driven
 * phases must NOT use this helper.
 */
export const fakePhase = <TInput, TOutput>(
  args: FakePhaseArgs<TInput, TOutput>
): Phase<TInput, TOutput> => ({
  name: args.name,
  kind: "fake",
  produce: args.produce,
  outputSchema: args.schema,
  allowedTools: [],
  buildUserPrompt: () => "",
  systemPrompt: "",
  maxSteps: 0,
  timeoutMs: 0,
});
