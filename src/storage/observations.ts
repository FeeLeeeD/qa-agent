import { getOpenDatabase, nowIso } from "./db.ts";
import {
  JsonValueSchema,
  type ObservationRow,
  ObservationRowSchema,
  parseJsonColumn,
  ScreenshotPathsSchema,
} from "./schema.ts";

export interface RecordObservationInput {
  metrics: unknown;
  observedAt?: string;
  runId: string;
  screenshotPaths: string[];
  targetId: string;
  targetType: string;
}

export interface RecordObservationResult {
  observationId: number;
}

export interface ListObservationsInput {
  runId: string;
  targetId?: string;
  targetType?: string;
}

interface ObservationDbRow {
  id: number;
  metrics_json: string;
  observed_at: string;
  run_id: string;
  screenshot_paths_json: string;
  target_id: string;
  target_type: string;
}

const toObservationRow = (raw: ObservationDbRow): ObservationRow =>
  ObservationRowSchema.parse({
    id: raw.id,
    runId: raw.run_id,
    targetType: raw.target_type,
    targetId: raw.target_id,
    observedAt: raw.observed_at,
    metrics: parseJsonColumn(
      "observations.metrics_json",
      raw.metrics_json,
      JsonValueSchema
    ),
    screenshotPaths: parseJsonColumn(
      "observations.screenshot_paths_json",
      raw.screenshot_paths_json,
      ScreenshotPathsSchema
    ),
  });

export const recordObservation = (
  input: RecordObservationInput
): RecordObservationResult => {
  const db = getOpenDatabase(input.runId);
  const observedAt = input.observedAt ?? nowIso();
  const metricsJson = JSON.stringify(input.metrics ?? null);
  const screenshotPathsJson = JSON.stringify(
    ScreenshotPathsSchema.parse(input.screenshotPaths)
  );
  const result = db
    .prepare(
      `INSERT INTO observations
        (run_id, target_type, target_id, observed_at, metrics_json, screenshot_paths_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.runId,
      input.targetType,
      input.targetId,
      observedAt,
      metricsJson,
      screenshotPathsJson
    );
  return { observationId: Number(result.lastInsertRowid) };
};

export const listObservations = (
  input: ListObservationsInput
): ObservationRow[] => {
  const db = getOpenDatabase(input.runId);
  const conditions: string[] = ["run_id = ?"];
  const params: (string | number)[] = [input.runId];
  if (input.targetType !== undefined) {
    conditions.push("target_type = ?");
    params.push(input.targetType);
  }
  if (input.targetId !== undefined) {
    conditions.push("target_id = ?");
    params.push(input.targetId);
  }
  const sql = `SELECT * FROM observations
               WHERE ${conditions.join(" AND ")}
               ORDER BY observed_at ASC, id ASC`;
  const rows = db.prepare<typeof params, ObservationDbRow>(sql).all(...params);
  return rows.map(toObservationRow);
};
