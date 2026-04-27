import { z } from "zod";
import type { Phase } from "./types.ts";

export interface ObserveJobInput {
  jobId: string;
}

export type JobStatus =
  | "queued"
  | "scheduling"
  | "scheduled"
  | "delivering"
  | "completed"
  | "failed";

const outputSchema = z.object({
  metrics: z.object({
    deliveredCount: z.number().nullable(),
    scheduledCount: z.number().nullable(),
    suppressedCount: z.number().nullable(),
    totalContacts: z.number().nullable(),
  }),
  observedAt: z.string(),
  screenshotPaths: z.array(z.string()),
  status: z.enum([
    "queued",
    "scheduling",
    "scheduled",
    "delivering",
    "completed",
    "failed",
  ]),
  unexpectedObservations: z.array(z.string()),
});

export type ObserveJobOutput = z.infer<typeof outputSchema>;

const SYSTEM_PROMPT = `You are a QA agent observing an existing job in the dev app. You assume the user is already logged in.

Domain knowledge:
{{knowledge}}

Operating rules:
- This phase is read-only. You can navigate, take a snapshot, and capture a screenshot — nothing else. Do not attempt to click, type, or change the page state.
- Read status and metrics from the page's text content (via browser_snapshot). Plain text counters like "1,234 scheduled" should be parsed as numbers (strip thousands separators).
- If a metric is rendered inside a canvas or SVG chart, or is otherwise not exposed as plain text, set the corresponding field to null and add a short string to unexpectedObservations describing what you saw.
- status MUST be one of: "queued", "scheduling", "scheduled", "delivering", "completed", "failed". If the page shows something else, pick the closest valid value and record the original phrasing in unexpectedObservations.
- observedAt is the current wall-clock time as ISO-8601.
- screenshotPaths must list the paths of any screenshots you captured during this phase, exactly as they were saved by browser_take_screenshot.
- Do not guess. Prefer null + an unexpectedObservation over a fabricated number.
- Stop as soon as you can return the structured result.`;

export const observeJobPhase: Phase<ObserveJobInput, ObserveJobOutput> = {
  name: "observe_job",
  allowedTools: [
    "browser_navigate",
    "browser_snapshot",
    "browser_take_screenshot",
  ] as const,
  maxSteps: 30,
  timeoutMs: 90_000,
  outputSchema,
  systemPrompt: SYSTEM_PROMPT,
  buildUserPrompt: (input) =>
    [
      `Task: observe the current state of job ${input.jobId}.`,
      "",
      "Steps:",
      `1. Navigate to the detail page for job ${input.jobId} from the Jobs table.`,
      "2. Take a snapshot of the page.",
      "3. Capture one screenshot of the job detail page.",
      "4. Extract the current status and any visible numeric counters (total contacts, scheduled, suppressed, delivered).",
      "5. Return the structured result.",
      "",
      "Be honest about what you cannot see — null + unexpectedObservation is correct, fabrication is not.",
    ].join("\n"),
};
