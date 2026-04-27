import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { loadEnv } from "../env.ts";
import {
  closeRunDatabase,
  createRun,
  finishRun,
  listPhases,
} from "../storage/index.ts";
import type { Phase } from "./index.ts";
import { runPhase } from "./index.ts";

const FAILURE_EXIT_CODE = 1;
const PORTKEY_BASE_URL = "https://api.portkey.ai/v1";
const MODEL_SLUG = "@openrouter/anthropic/claude-sonnet-4.5";
const PHASE_TIMEOUT_MS = 30_000;
const PHASE_MAX_STEPS = 2;

const stdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const buildPortkeyHeaders = (
  apiKey: string,
  virtualKey: string | undefined,
  config: string | undefined
): Record<string, string> => {
  const headers: Record<string, string> = {
    "x-portkey-api-key": apiKey,
  };
  if (virtualKey) {
    headers["x-portkey-virtual-key"] = virtualKey;
  }
  if (config) {
    headers["x-portkey-config"] = config;
  }
  return headers;
};

interface MockEchoInput {
  phrase: string;
}

interface MockEchoOutput {
  echoed: string;
  receivedKnowledge: string;
}

const mockEchoOutputSchema = z.object({
  echoed: z.string(),
  receivedKnowledge: z.string(),
});

const buildMockEchoPhase = (): Phase<MockEchoInput, MockEchoOutput> => ({
  name: "mock_echo",
  allowedTools: [],
  maxSteps: PHASE_MAX_STEPS,
  timeoutMs: PHASE_TIMEOUT_MS,
  outputSchema: mockEchoOutputSchema,
  systemPrompt: "You are a deterministic echo. Knowledge: {{knowledge}}",
  buildUserPrompt: (input, knowledge) =>
    `Echo the phrase '${input.phrase}' and the knowledge '${knowledge}' into the structured result.`,
});

const mismatchedSchema = z.object({
  neverProduced: z.string(),
});

const buildMismatchedPhase = (): Phase<
  MockEchoInput,
  z.infer<typeof mismatchedSchema>
> => ({
  name: "mock_echo_mismatch",
  allowedTools: [],
  maxSteps: PHASE_MAX_STEPS,
  timeoutMs: PHASE_TIMEOUT_MS,
  outputSchema: mismatchedSchema,
  systemPrompt: "You are a deterministic echo. Knowledge: {{knowledge}}",
  buildUserPrompt: (input, knowledge) =>
    `Echo the phrase '${input.phrase}' and the knowledge '${knowledge}' into the structured result.`,
});

const main = async (): Promise<void> => {
  const env = loadEnv();
  const apiKey = env.PORTKEY_API_KEY;
  const virtualKey = env.PORTKEY_VIRTUAL_KEY;
  const config = env.PORTKEY_CONFIG;

  const portkey = createOpenAICompatible({
    name: "portkey",
    baseURL: PORTKEY_BASE_URL,
    apiKey,
    headers: buildPortkeyHeaders(apiKey, virtualKey, config),
  });
  const model = portkey.chatModel(MODEL_SLUG);

  const { runId, runDir } = createRun({
    testCaseName: "phase-runner-smoke",
  });
  stdout(`runId=${runId}`);

  const phase = buildMockEchoPhase();
  const okResult = await runPhase({
    phase,
    input: { phrase: "hello-runner" },
    knowledge: "kb-stub",
    runId,
    runDir,
    allTools: {},
    model,
  });

  assert.equal(okResult.status, "ok", "expected first phase to succeed");
  if (okResult.status === "ok") {
    assert.equal(okResult.output.echoed, "hello-runner");
    assert.equal(okResult.output.receivedKnowledge, "kb-stub");
  }

  const phaseDir = path.join(runDir, "phases", phase.name);
  assert.ok(
    existsSync(phaseDir),
    `expected phase artifact dir to exist: ${phaseDir}`
  );
  const stepFiles = readdirSync(phaseDir).filter(
    (file) => file.startsWith("step-") && file.endsWith(".json")
  );
  assert.ok(
    stepFiles.length >= 1,
    `expected at least one step-NNN.json under ${phaseDir}, found ${stepFiles.length}`
  );

  const phasesAfterOk = listPhases(runId);
  const okRow = phasesAfterOk.find((row) => row.phaseName === phase.name);
  assert.ok(okRow, "expected mock_echo phase row");
  assert.equal(okRow?.status, "done");
  assert.notEqual(
    okRow?.output,
    null,
    "expected output_json to be populated for completed phase"
  );

  const mismatchPhase = buildMismatchedPhase();
  const failedResult = await runPhase({
    phase: mismatchPhase,
    input: { phrase: "hello-runner" },
    knowledge: "kb-stub",
    runId,
    runDir,
    allTools: {},
    model,
  });

  assert.equal(
    failedResult.status,
    "failed",
    "expected mismatched-schema phase to fail"
  );
  if (failedResult.status === "failed") {
    assert.equal(
      failedResult.error.kind,
      "schema_validation",
      `expected schema_validation, got ${failedResult.error.kind}`
    );
  }

  const phasesAfterFail = listPhases(runId);
  const failRow = phasesAfterFail.find(
    (row) => row.phaseName === mismatchPhase.name
  );
  assert.ok(failRow, "expected mock_echo_mismatch phase row");
  assert.equal(failRow?.status, "failed");
  assert.notEqual(
    failRow?.error,
    null,
    "expected error column to be populated for failed phase"
  );

  finishRun(runId, "done");
  closeRunDatabase(runId);
  stdout(`SMOKE OK ${runId}`);
};

main().catch((err) => {
  process.stderr.write(
    `SMOKE FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  );
  process.exit(FAILURE_EXIT_CODE);
});
