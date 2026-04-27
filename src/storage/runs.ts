import {
  closeRunDatabase,
  ensureReportsRoot,
  getOpenDatabase,
  nowIso,
  openRunDatabase,
} from "./db.ts";
import {
  type RunRow,
  RunRowSchema,
  type RunStatus,
  RunStatusSchema,
} from "./schema.ts";

export interface CreateRunInput {
  testCaseName: string;
}

export interface CreateRunResult {
  runDir: string;
  runId: string;
}

interface RunDbRow {
  finished_at: string | null;
  id: string;
  started_at: string;
  status: string;
  test_case_name: string;
}

const toRunRow = (raw: RunDbRow): RunRow =>
  RunRowSchema.parse({
    id: raw.id,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    status: raw.status,
    testCaseName: raw.test_case_name,
  });

export const createRun = (
  runId: string,
  input: CreateRunInput
): CreateRunResult => {
  ensureReportsRoot();
  const { db, runDir } = openRunDatabase(runId);
  db.prepare(
    `INSERT INTO runs (id, started_at, finished_at, status, test_case_name)
     VALUES (?, ?, NULL, 'running', ?)`
  ).run(runId, nowIso(), input.testCaseName);
  return { runId, runDir };
};

export type FinishRunStatus = Extract<RunStatus, "done" | "failed">;

export const finishRun = (runId: string, status: FinishRunStatus): void => {
  const validated = RunStatusSchema.parse(status);
  const db = getOpenDatabase(runId);
  const result = db
    .prepare(
      `UPDATE runs
       SET status = ?, finished_at = ?
       WHERE id = ?`
    )
    .run(validated, nowIso(), runId);
  if (result.changes === 0) {
    throw new Error(`storage: finishRun called for unknown runId ${runId}`);
  }
  closeRunDatabase(runId);
};

export const getRun = (runId: string): RunRow | null => {
  const db = getOpenDatabase(runId);
  const row = db
    .prepare<[string], RunDbRow>("SELECT * FROM runs WHERE id = ?")
    .get(runId);
  if (!row) {
    return null;
  }
  return toRunRow(row);
};
