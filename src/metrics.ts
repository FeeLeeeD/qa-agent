export interface ToolCallMetric {
  args: unknown;
  at: number;
  durationMs: number;
  error?: string;
  name: string;
  ok: boolean;
}

export interface StepMetric {
  durationMs: number;
  finishReason: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  stepNumber: number;
  text?: string | undefined;
  toolCallCount: number;
}

export interface Metrics {
  endedAt?: number;
  finalText?: string;
  finishReason?: string;
  model: string;
  prompt: string;
  startedAt: number;
  startedAtAbsolute: number;
  steps: StepMetric[];
  systemPrompt: string;
  toolCalls: ToolCallMetric[];
}

export const createMetrics = (init: {
  prompt: string;
  systemPrompt: string;
  model: string;
}): Metrics => ({
  startedAt: performance.now(),
  startedAtAbsolute: Date.now(),
  toolCalls: [],
  steps: [],
  prompt: init.prompt,
  systemPrompt: init.systemPrompt,
  model: init.model,
});
