import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";

const REPORTS_ROOT = path.resolve(process.cwd(), "reports");
const DB_FILE_NAME = "state.db";
const RUN_ID_RANDOM_SUFFIX_LENGTH = 4;
const RUN_ID_RANDOM_BASE = 36;

/**
 * Migrations are applied in order on first open of a fresh DB. Each entry is a
 * SQL string. To add a new migration later: append to the array; the runner
 * tracks `schema_version` and only applies entries whose index is >= that
 * version. Never edit existing entries — append only.
 */
const MIGRATIONS: readonly string[] = [
  // 0: initial schema
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    test_case_name TEXT NOT NULL
  );

  CREATE TABLE phase_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    phase_name TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    output_json TEXT,
    error TEXT
  );

  CREATE INDEX idx_phase_executions_run_started
    ON phase_executions (run_id, started_at);

  CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    screenshot_paths_json TEXT NOT NULL
  );

  CREATE INDEX idx_observations_run_target_observed
    ON observations (run_id, target_type, target_id, observed_at);
  `,
];

const connections = new Map<string, Database>();
const phaseOwners = new Map<number, string>();
let exitHooksInstalled = false;

const closeAllConnections = (): void => {
  for (const [, db] of connections) {
    try {
      db.close();
    } catch {
      // best-effort close on shutdown
    }
  }
  connections.clear();
  phaseOwners.clear();
};

export const listOpenRunIds = (): Iterable<string> => connections.keys();

export const rememberPhaseOwner = (phaseId: number, runId: string): void => {
  phaseOwners.set(phaseId, runId);
};

export const resolvePhaseOwner = (phaseId: number): string | undefined =>
  phaseOwners.get(phaseId);

const installExitHooksOnce = (): void => {
  if (exitHooksInstalled) {
    return;
  }
  exitHooksInstalled = true;
  process.once("exit", closeAllConnections);
  process.once("SIGINT", () => {
    closeAllConnections();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    closeAllConnections();
    process.exit(143);
  });
};

const getCurrentSchemaVersion = (db: Database): number => {
  const row = db
    .prepare<[], { version: number }>(
      "SELECT MAX(version) AS version FROM schema_version"
    )
    .get();
  return row?.version ?? -1;
};

const runMigrations = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const current = getCurrentSchemaVersion(db);
  const insertVersion = db.prepare(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
  );

  const applyAll = db.transaction(() => {
    for (let version = current + 1; version < MIGRATIONS.length; version += 1) {
      const sql = MIGRATIONS[version];
      if (!sql) {
        continue;
      }
      db.exec(sql);
      insertVersion.run(version, new Date().toISOString());
    }
  });
  applyAll();
};

const configureConnection = (db: Database): void => {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
};

export interface OpenedDatabase {
  db: Database;
  dbPath: string;
  runDir: string;
}

export const ensureReportsRoot = (): string => {
  mkdirSync(REPORTS_ROOT, { recursive: true });
  return REPORTS_ROOT;
};

export const getRunDir = (runId: string): string =>
  path.join(REPORTS_ROOT, runId);

const SORTABLE_TIMESTAMP_REGEX = /[-:.]/g;

export const generateRunId = (now: Date = new Date()): string => {
  const ts = now
    .toISOString()
    .replace(SORTABLE_TIMESTAMP_REGEX, "")
    .slice(0, "YYYYMMDDTHHMMSS".length);
  const suffix = Math.random()
    .toString(RUN_ID_RANDOM_BASE)
    .slice(2, 2 + RUN_ID_RANDOM_SUFFIX_LENGTH)
    .padEnd(RUN_ID_RANDOM_SUFFIX_LENGTH, "0");
  return `${ts}-${suffix}`;
};

const openConnection = (runId: string): OpenedDatabase => {
  installExitHooksOnce();
  const runDir = getRunDir(runId);
  mkdirSync(runDir, { recursive: true });
  const dbPath = path.join(runDir, DB_FILE_NAME);
  const db = new BetterSqlite3(dbPath);
  configureConnection(db);
  runMigrations(db);
  connections.set(runId, db);
  return { db, runDir, dbPath };
};

/**
 * Returns a connection for `runId`, creating the run directory and DB file if
 * they don't exist yet. Connections are cached per-runId.
 */
export const openRunDatabase = (runId: string): OpenedDatabase => {
  const cached = connections.get(runId);
  if (cached) {
    return {
      db: cached,
      runDir: getRunDir(runId),
      dbPath: path.join(getRunDir(runId), DB_FILE_NAME),
    };
  }
  return openConnection(runId);
};

export const getOpenDatabase = (runId: string): Database => {
  const cached = connections.get(runId);
  if (cached) {
    return cached;
  }
  return openRunDatabase(runId).db;
};

export const closeRunDatabase = (runId: string): void => {
  const db = connections.get(runId);
  if (!db) {
    return;
  }
  try {
    db.close();
  } finally {
    connections.delete(runId);
    for (const [phaseId, ownerRunId] of phaseOwners) {
      if (ownerRunId === runId) {
        phaseOwners.delete(phaseId);
      }
    }
  }
};

export const nowIso = (): string => new Date().toISOString();
