import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { loadEnv } from "../env.ts";
import { createModel } from "../llm/model.ts";
import {
  type CreateJobStubOutput,
  createJobStubPhase,
} from "../phases/stubs/create-job-stub.ts";
import { fakePhase } from "../phases/stubs/fake-phase.ts";
import { loginStubPhase } from "../phases/stubs/login-stub.ts";
import { observeJobStubPhase } from "../phases/stubs/observe-job-stub.ts";
import { generateReport } from "../reporting/generate-report.ts";
import {
  closeRunDatabase,
  listObservations,
  listPhases,
  recordObservation,
} from "../storage/index.ts";
import { definePhaseSpec, type PhaseSpec, runSession } from "./index.ts";

const FAILURE_EXIT_CODE = 1;
const SMOKE_TEST_CASE = "baseline";
const SMOKE_EMAIL = "smoke@example.com";
const FAILED_STATUS_ROW_REGEX = /\|\s+failed\s+\|/;

const stdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

/* ---------- happy path ---------- */

const buildHappyPipeline = (): PhaseSpec[] => [
  definePhaseSpec({
    phase: loginStubPhase,
    buildInput: () => ({ email: SMOKE_EMAIL }),
  }),
  definePhaseSpec({
    phase: createJobStubPhase,
    buildInput: (ctx) => ({
      listId: ctx.testCase.parameters.list_id as string,
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

const runHappyPath = async (): Promise<string> => {
  const model = createModel();
  const result = await runSession({
    testCaseName: SMOKE_TEST_CASE,
    pipeline: buildHappyPipeline(),
    tools: {},
    model,
  });

  assert.equal(result.status, "done", "expected status to be 'done'");
  assert.equal(result.failedPhase, null, "expected failedPhase to be null");

  const phases = listPhases(result.runId);
  assert.equal(phases.length, 3, "expected three phase rows");
  for (const row of phases) {
    assert.equal(
      row.status,
      "done",
      `expected phase ${row.phaseName} to be 'done', got ${row.status}`
    );
  }

  const observations = listObservations({ runId: result.runId });
  assert.equal(observations.length, 1, "expected exactly one observation row");
  const obs = observations[0];
  assert.ok(obs, "expected observation row to be present");
  assert.equal(obs?.targetType, "job", "expected observation target_type=job");
  const created = phases.find((p) => p.phaseName === createJobStubPhase.name);
  const createdOutput = created?.output as { jobId?: string } | null;
  assert.ok(
    createdOutput?.jobId,
    "expected create_job_stub output to expose jobId"
  );
  assert.equal(
    obs?.targetId,
    createdOutput?.jobId,
    "expected observation target_id to match stubbed jobId"
  );

  const { reportPath } = await generateReport({ runId: result.runId });
  assert.ok(
    reportPath.endsWith("report.md"),
    `expected reportPath to end with report.md, got ${reportPath}`
  );
  assert.ok(
    existsSync(reportPath),
    `expected report file to exist: ${reportPath}`
  );

  const reportBody = readFileSync(reportPath, "utf8");
  for (const needle of [
    "# QA Run Report",
    "## Phases",
    "## Observations",
    "## Interpretation",
  ]) {
    assert.ok(
      reportBody.includes(needle),
      `expected report to contain "${needle}"`
    );
  }
  assert.ok(
    typeof obs?.targetId === "string" && reportBody.includes(obs.targetId),
    `expected report to contain stubbed jobId "${obs?.targetId}"`
  );

  closeRunDatabase(result.runId);
  return result.runId;
};

/* ---------- negative path ---------- */

const brokenSchema = z.object({
  jobId: z.string(),
  createdAt: z.string(),
});

// Returns an object that does NOT match brokenSchema — runner must surface
// this as schema_validation and abort the pipeline.
const brokenCreateJobPhase = fakePhase<
  { listId: string },
  z.infer<typeof brokenSchema>
>({
  name: "broken_create_job_stub",
  schema: brokenSchema,
  produce: (_input) =>
    ({ wrong: "shape" }) as unknown as z.infer<typeof brokenSchema>,
});

const buildBrokenPipeline = (): PhaseSpec[] => [
  definePhaseSpec({
    phase: loginStubPhase,
    buildInput: () => ({ email: SMOKE_EMAIL }),
  }),
  definePhaseSpec({
    phase: brokenCreateJobPhase,
    buildInput: () => ({ listId: "any" }),
  }),
  definePhaseSpec({
    phase: observeJobStubPhase,
    buildInput: () => ({ jobId: "never-runs" }),
  }),
];

const runNegativePath = async (): Promise<void> => {
  const model = createModel();
  const result = await runSession({
    testCaseName: SMOKE_TEST_CASE,
    pipeline: buildBrokenPipeline(),
    tools: {},
    model,
  });

  assert.equal(result.status, "failed", "expected status to be 'failed'");
  assert.equal(
    result.failedPhase,
    brokenCreateJobPhase.name,
    `expected failedPhase to be ${brokenCreateJobPhase.name}, got ${result.failedPhase}`
  );

  const phases = listPhases(result.runId);
  const phaseNames = phases.map((p) => p.phaseName);
  assert.ok(
    phaseNames.includes(loginStubPhase.name),
    "expected login_stub row to exist"
  );
  assert.ok(
    phaseNames.includes(brokenCreateJobPhase.name),
    "expected broken_create_job_stub row to exist"
  );
  assert.ok(
    !phaseNames.includes(observeJobStubPhase.name),
    "expected observe_job_stub to NOT have run after the failure"
  );
  const brokenRow = phases.find(
    (p) => p.phaseName === brokenCreateJobPhase.name
  );
  assert.equal(
    brokenRow?.status,
    "failed",
    "expected broken row status=failed"
  );

  const { reportPath } = await generateReport({ runId: result.runId });
  assert.ok(
    existsSync(reportPath),
    `expected report file to exist for failed run: ${reportPath}`
  );
  const reportBody = readFileSync(reportPath, "utf8");
  assert.ok(
    reportBody.includes(brokenCreateJobPhase.name),
    "expected facts table to mention the failed phase"
  );
  assert.ok(
    FAILED_STATUS_ROW_REGEX.test(reportBody),
    "expected facts table to render a 'failed' status row"
  );

  closeRunDatabase(result.runId);
};

const main = async (): Promise<void> => {
  // Match the smoke convention used by phases/storage smokes: missing env
  // → skip rather than fail. Orchestrator construction calls loadEnv()
  // (via createModel) which throws on missing keys; we pre-flight.
  try {
    loadEnv();
  } catch (err) {
    stdout(`SMOKE SKIPPED missing env: ${errorMessage(err)}`);
    return;
  }

  const runId = await runHappyPath();
  await runNegativePath();
  stdout(`SMOKE OK ${runId}`);
};

main().catch((err) => {
  process.stderr.write(`SMOKE FAIL: ${errorMessage(err)}\n`);
  process.exit(FAILURE_EXIT_CODE);
});
