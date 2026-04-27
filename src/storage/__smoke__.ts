import {
  closeRunDatabase,
  createRun,
  finishPhase,
  finishRun,
  getRun,
  listObservations,
  listPhases,
  openRunDatabase,
  recordObservation,
  startPhase,
} from "./index.ts";

const ONE_SECOND_MS = 1000;
const FAILURE_EXIT_CODE = 1;

const stdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const printJson = (label: string, value: unknown): void => {
  stdout(`${label}:`);
  stdout(JSON.stringify(value, null, 2));
};

const main = (): void => {
  const { runId, runDir } = createRun({ testCaseName: "smoke" });
  stdout(`runId=${runId}`);
  stdout(`runDir=${runDir}`);

  const phaseA = startPhase({ runId, phaseName: "phase-a" });
  finishPhase({
    phaseId: phaseA.phaseId,
    status: "done",
    output: { ok: true, summary: "phase a finished cleanly" },
  });

  const phaseB = startPhase({ runId, phaseName: "phase-b" });
  finishPhase({
    phaseId: phaseB.phaseId,
    status: "failed",
    error: "phase b deliberately failed for smoke test",
  });

  const earlier = new Date(Date.now() - ONE_SECOND_MS).toISOString();
  recordObservation({
    runId,
    targetType: "job",
    targetId: "job-123",
    metrics: { progress: 0.25, queueDepth: 3 },
    screenshotPaths: ["screens/job-123/0.png"],
    observedAt: earlier,
  });
  recordObservation({
    runId,
    targetType: "job",
    targetId: "job-123",
    metrics: { progress: 1, queueDepth: 0 },
    screenshotPaths: ["screens/job-123/1.png", "screens/job-123/1-detail.png"],
  });

  const phasesBeforeFinish = listPhases(runId);
  printJson("phases", phasesBeforeFinish);

  const observationsBeforeFinish = listObservations({
    runId,
    targetType: "job",
    targetId: "job-123",
  });
  printJson("observations", observationsBeforeFinish);

  finishRun(runId, "done");

  // Re-open the same DB by runId and verify reads still work.
  openRunDatabase(runId);
  const reopenedRun = getRun(runId);
  printJson("reopenedRun", reopenedRun);
  const reopenedPhases = listPhases(runId);
  printJson("reopenedPhases", reopenedPhases);
  const reopenedObservations = listObservations({ runId });
  printJson("reopenedObservations", reopenedObservations);

  if (
    reopenedRun?.status !== "done" ||
    reopenedPhases.length !== 2 ||
    reopenedObservations.length !== 2
  ) {
    throw new Error("storage smoke: reopened reads failed sanity checks");
  }

  closeRunDatabase(runId);
  stdout(`SMOKE OK ${runId}`);
};

try {
  main();
} catch (err) {
  process.stderr.write(
    `SMOKE FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  );
  process.exit(FAILURE_EXIT_CODE);
}
