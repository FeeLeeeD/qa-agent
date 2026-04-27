import { generateText, type LanguageModel, tool } from "ai";
import type { z } from "zod";

const FINAL_ANSWER_TOOL = "__final_answer";

export interface GenerateStructuredArgs<T> {
  abortSignal?: AbortSignal;
  model: LanguageModel;
  prompt: string;
  schema: z.ZodType<T>;
  system: string;
  temperature?: number;
}

export type StructuredResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "no_tool_call" | "schema_validation" | "model_error";
      details: string;
    };

/**
 * Get a typed object out of an LLM via tool-calling. The model is given a single
 * synthetic tool whose `inputSchema` matches the requested Zod schema; we force it
 * to call this tool, then read the validated `input` as the structured output.
 *
 * This pattern is used because `generateObject` / `Output.object` rely on the
 * `responseFormat` mechanism, which is unreliable for Anthropic models routed via
 * Portkey/OpenRouter. Tool-calling is Anthropic's native structured-output mechanism
 * and works reliably through that provider stack.
 *
 * On any failure (model error, missing tool call, schema mismatch), returns a
 * `{ ok: false, kind, details }` value. Never throws on model-side problems.
 */
export const generateStructuredObject = async <T>(
  args: GenerateStructuredArgs<T>
): Promise<StructuredResult<T>> => {
  try {
    const result = await generateText({
      model: args.model,
      system: args.system,
      prompt: args.prompt,
      temperature: args.temperature ?? 0,
      abortSignal: args.abortSignal,
      tools: {
        [FINAL_ANSWER_TOOL]: tool({
          description:
            "Return your final structured answer by calling this tool exactly once. Do not produce any other output.",
          inputSchema: args.schema,
        }),
      },
      toolChoice: { type: "tool", toolName: FINAL_ANSWER_TOOL },
    });

    const call = result.steps
      .flatMap((s) => s.toolCalls)
      .find((c) => c.toolName === FINAL_ANSWER_TOOL);

    if (!call) {
      return {
        ok: false,
        kind: "no_tool_call",
        details: "Model did not invoke the final-answer tool.",
      };
    }

    const parsed = args.schema.safeParse(call.input);
    if (!parsed.success) {
      return {
        ok: false,
        kind: "schema_validation",
        details: parsed.error.message,
      };
    }
    return { ok: true, value: parsed.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "model_error", details: message };
  }
};
