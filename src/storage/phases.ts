import {
  getOpenDatabase,
  listOpenRunIds,
  nowIso,
  rememberPhaseOwner,
  resolvePhaseOwner,
} from "./db.ts";
import {
  JsonValueSchema,
  type PhaseRow,
  PhaseRowSchema,
  type PhaseStatus,
  PhaseStatusSchema,
  parseNullableJsonColumn,
} from "./schema.ts";

export interface StartPhaseInput {
  phaseName: string;
  runId: string;
}

export interface StartPhaseResult {
  phaseId: number;
}

export type FinishPhaseStatus = Extract<PhaseStatus, "done" | "failed">;

export interface FinishPhaseInput {
  error?: string;
  output?: unknown;
  phaseId: number;
  status: FinishPhaseStatus;
}

interface PhaseDbRow {
  error: string | null;
  finished_at: string | null;
  id: number;
  output_json: string | null;
  phase_name: string;
  run_id: string;
  started_at: string;
  status: string;
}

interface PhaseRunIdRow {
  run_id: string;
}

const toPhaseRow = (raw: PhaseDbRow): PhaseRow =>
  PhaseRowSchema.parse({
    id: raw.id,
    runId: raw.run_id,
    phaseName: raw.phase_name,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    status: raw.status,
    output: parseNullableJsonColumn(
      "phase_executions.output_json",
      raw.output_json,
      JsonValueSchema
    ),
    error: raw.error,
  });

export const startPhase = (input: StartPhaseInput): StartPhaseResult => {
  const db = getOpenDatabase(input.runId);
  const result = db
    .prepare(
      `INSERT INTO phase_executions
        (run_id, phase_name, started_at, status)
       VALUES (?, ?, ?, 'running')`
    )
    .run(input.runId, input.phaseName, nowIso());
  const phaseId = Number(result.lastInsertRowid);
  rememberPhaseOwner(phaseId, input.runId);
  return { phaseId };
};

/**
 * Resolves which open run DB owns `phaseId`. Checks the in-memory map first
 * (populated by `startPhase`), then probes all currently open DBs as a
 * fallback. Throws if no open connection owns the row.
 */
const findRunIdForPhase = (phaseId: number): string => {
  const known = resolvePhaseOwner(phaseId);
  if (known) {
    return known;
  }
  for (const runId of listOpenRunIds()) {
    const db = getOpenDatabase(runId);
    const row = db
      .prepare<[number], PhaseRunIdRow>(
        "SELECT run_id FROM phase_executions WHERE id = ?"
      )
      .get(phaseId);
    if (row) {
      rememberPhaseOwner(phaseId, row.run_id);
      return row.run_id;
    }
  }
  throw new Error(
    `storage: cannot resolve runId for phaseId ${phaseId}; finishPhase requires the run DB to already be open`
  );
};

export const finishPhase = (input: FinishPhaseInput): void => {
  const validated = PhaseStatusSchema.parse(input.status);
  const runId = findRunIdForPhase(input.phaseId);
  const db = getOpenDatabase(runId);
  const outputJson =
    input.output === undefined ? null : JSON.stringify(input.output);
  const result = db
    .prepare(
      `UPDATE phase_executions
       SET status = ?, finished_at = ?, output_json = ?, error = ?
       WHERE id = ?`
    )
    .run(validated, nowIso(), outputJson, input.error ?? null, input.phaseId);
  if (result.changes === 0) {
    throw new Error(
      `storage: finishPhase called for unknown phaseId ${input.phaseId}`
    );
  }
};

export const listPhases = (runId: string): PhaseRow[] => {
  const db = getOpenDatabase(runId);
  const rows = db
    .prepare<[string], PhaseDbRow>(
      `SELECT * FROM phase_executions
       WHERE run_id = ?
       ORDER BY started_at ASC, id ASC`
    )
    .all(runId);
  return rows.map(toPhaseRow);
};
