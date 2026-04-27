import { z } from "zod";

export const RUN_STATUS = ["running", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUS)[number];
export const RunStatusSchema = z.enum(RUN_STATUS);

export const PHASE_STATUS = ["running", "done", "failed"] as const;
export type PhaseStatus = (typeof PHASE_STATUS)[number];
export const PhaseStatusSchema = z.enum(PHASE_STATUS);

const IsoDateString = z.string().min(1);

export const RunRowSchema = z.object({
  id: z.string(),
  startedAt: IsoDateString,
  finishedAt: z.string().nullable(),
  status: RunStatusSchema,
  testCaseName: z.string(),
});
export type RunRow = z.infer<typeof RunRowSchema>;

/**
 * Generic JSON value schema for opaque payloads stored in *_json columns.
 * Use a domain-specific schema at the call site when stronger typing is
 * desired.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const PhaseRowSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: z.string(),
  phaseName: z.string(),
  startedAt: IsoDateString,
  finishedAt: z.string().nullable(),
  status: PhaseStatusSchema,
  output: JsonValueSchema.nullable(),
  error: z.string().nullable(),
});
export type PhaseRow = z.infer<typeof PhaseRowSchema>;

export const ScreenshotPathsSchema = z.array(z.string());
export type ScreenshotPaths = z.infer<typeof ScreenshotPathsSchema>;

export const ObservationRowSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  observedAt: IsoDateString,
  metrics: JsonValueSchema,
  screenshotPaths: ScreenshotPathsSchema,
});
export type ObservationRow = z.infer<typeof ObservationRowSchema>;

/**
 * Parse a JSON-encoded column value with a Zod schema. Throws a clear error
 * naming the column when validation fails.
 */
export const parseJsonColumn = <T>(
  columnName: string,
  raw: string,
  schema: z.ZodType<T>
): T => {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `storage: column ${columnName} contains invalid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(
      `storage: column ${columnName} failed schema validation: ${result.error.message}`
    );
  }
  return result.data;
};

export const parseNullableJsonColumn = <T>(
  columnName: string,
  raw: string | null,
  schema: z.ZodType<T>
): T | null => {
  if (raw === null) {
    return null;
  }
  return parseJsonColumn(columnName, raw, schema);
};
