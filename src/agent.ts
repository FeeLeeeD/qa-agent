import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, type ToolSet } from "ai";
import type { Env } from "./env.ts";
import { logger } from "./logger.ts";
import type { Metrics, StepMetric } from "./metrics.ts";

const PORTKEY_BASE_URL = "https://api.portkey.ai/v1";
const MODEL_SLUG = "anthropic/claude-sonnet-4.6";
const MAX_STEPS = 30;

export const SYSTEM_PROMPT = `You are a QA agent running against a dev web app. You have Playwright browser tools.
Rules:
- Use browser_snapshot to see the page (prefer over screenshots for decisions).
- Before each tool call emit one line prefixed with "STEP: " describing the action.
- Don't guess selectors — act on elements from the accessibility snapshot.
- Stop as soon as the task is complete. Keep answers short.`;

export const buildUserPrompt = (env: Env): string =>
  `Task: Open ${env.DEV_APP_URL}, log in with email ${env.DEV_APP_EMAIL} and password ${env.DEV_APP_PASSWORD}, ` +
  'confirm a post-login page, then take a final screenshot named "final.png" and stop.';

interface RunAgentOptions {
  env: Env;
  metrics: Metrics;
  tools: ToolSet;
}

export const runAgent = async (options: RunAgentOptions): Promise<void> => {
  const { env, tools, metrics } = options;

  const headers: Record<string, string> = {
    "x-portkey-api-key": env.PORTKEY_API_KEY,
  };
  if (env.PORTKEY_VIRTUAL_KEY) {
    headers["x-portkey-virtual-key"] = env.PORTKEY_VIRTUAL_KEY;
  }
  if (env.PORTKEY_CONFIG) {
    headers["x-portkey-config"] = env.PORTKEY_CONFIG;
  }

  const portkey = createOpenAICompatible({
    name: "portkey",
    baseURL: PORTKEY_BASE_URL,
    apiKey: env.PORTKEY_API_KEY,
    headers,
  });
  const model = portkey.chatModel(MODEL_SLUG);

  let lastStepEndedAt = metrics.startedAt;
  let stepIndex = 0;

  const result = await generateText({
    model,
    tools,
    system: metrics.systemPrompt,
    prompt: metrics.prompt,
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: (step) => {
      const now = performance.now();
      const metric: StepMetric = {
        stepNumber: stepIndex,
        durationMs: now - lastStepEndedAt,
        toolCallCount: step.toolCalls?.length ?? 0,
        finishReason: step.finishReason ?? "unknown",
        inputTokens: step.usage?.inputTokens,
        outputTokens: step.usage?.outputTokens,
        text: step.text,
      };
      metrics.steps.push(metric);
      logger.info("llm step finished", {
        stepNumber: stepIndex,
        durationMs: Math.round(metric.durationMs),
        toolCalls: metric.toolCallCount,
        finishReason: metric.finishReason,
        inputTokens: metric.inputTokens,
        outputTokens: metric.outputTokens,
      });
      lastStepEndedAt = now;
      stepIndex += 1;
    },
  });

  metrics.finalText = result.text;
  metrics.finishReason = result.finishReason;
};

export const MODEL_LABEL = `${MODEL_SLUG} (Portkey → OpenRouter)`;
