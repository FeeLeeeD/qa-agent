import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const REDACTION_PLACEHOLDER = "***REDACTED***";
const STEP_INDEX_PAD_LENGTH = 3;
const JSON_INDENT = 2;

/**
 * Loaded once on first call. We intentionally read directly from `process.env`
 * rather than from `loadEnv()`: this utility runs inside `onStepFinish` for
 * every phase, including phases whose smoke tests do not bootstrap the full
 * env. An unset variable disables redaction (no-op) by design.
 */
let cachedPassword: string | null | undefined;

const getCachedPassword = (): string | null => {
  if (cachedPassword === undefined) {
    const raw = process.env.QA_USER_PASSWORD;
    cachedPassword = raw && raw.length > 0 ? raw : null;
  }
  return cachedPassword;
};

/** Test/internal hook to reset the cached password. */
export const __resetRedactionCache = (): void => {
  cachedPassword = undefined;
};

/**
 * Returns a structurally-equal copy of `value` in which any string equal to
 * `password` is replaced with `***REDACTED***`. Walks plain objects and
 * arrays. Does not mutate the input.
 */
const redactDeep = (value: unknown, password: string): unknown => {
  if (typeof value === "string") {
    return value === password ? REDACTION_PLACEHOLDER : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, password));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = redactDeep((value as Record<string, unknown>)[key], password);
    }
    return out;
  }
  return value;
};

interface WriteStepArtifactArgs {
  /** Serialized as JSON with 2-space indent. Strings matching the cached password are redacted. */
  payload: unknown;
  phaseName: string;
  runDir: string;
  /** 1-based step index, zero-padded to 3 digits in the filename. */
  stepIndex: number;
}

/**
 * Writes a `step-NNN.json` file under `<runDir>/phases/<phaseName>/`.
 * The directory is created lazily on first call. Synchronous I/O is used
 * deliberately so it can run inside the AI SDK `onStepFinish` callback
 * without orphaning writes if the runner is later cancelled.
 */
export const writeStepArtifact = (args: WriteStepArtifactArgs): void => {
  const { runDir, phaseName, stepIndex, payload } = args;
  const phaseDir = path.join(runDir, "phases", phaseName);
  mkdirSync(phaseDir, { recursive: true });

  const password = getCachedPassword();
  const redacted = password === null ? payload : redactDeep(payload, password);

  const padded = String(stepIndex).padStart(STEP_INDEX_PAD_LENGTH, "0");
  const fileName = `step-${padded}.json`;
  const filePath = path.join(phaseDir, fileName);
  writeFileSync(filePath, JSON.stringify(redacted, null, JSON_INDENT));
};
