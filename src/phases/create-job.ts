import { z } from "zod";
import type { Phase } from "./types.ts";

export type JobMode = "regular" | "preview";

export interface CreateJobInput {
  deliveryWindowHours: number;
  jobName: string;
  listName: string;
  mode: JobMode;
  recyclePeople: boolean;
  recyclePercentage: number | null;
  throttlingOption: string;
}

const outputSchema = z.object({
  createdAt: z.string(),
  jobId: z.string(),
  parametersConfirmed: z.object({
    deliveryWindowHours: z.number().nullable(),
    jobName: z.string().nullable(),
    listName: z.string().nullable(),
    mode: z.enum(["regular", "preview"]).nullable(),
    recyclePeople: z.boolean().nullable(),
    recyclePercentage: z.number().nullable(),
    throttlingOption: z.string().nullable(),
  }),
  unexpectedObservations: z.array(z.string()),
});

export type CreateJobOutput = z.infer<typeof outputSchema>;

const SYSTEM_PROMPT = `You are a QA agent creating a new job in the dev app. You assume the user is already logged in.

Domain knowledge:
{{knowledge}}

Operating rules:
- Always call browser_snapshot before deciding the next action. Act only on elements present in the accessibility tree.
- Use browser_fill_form for grouped fields when possible; browser_type for single inputs and search fields; browser_select_option for dropdowns; browser_click for toggles/buttons.
- Read jobId only after you have clicked into the new row on the Jobs table and reached the job detail page (URL or labelled identifier).
- parametersConfirmed must reflect what the UI actually shows on the job detail page, not the input that was passed in. If a value is not visible there, set the corresponding field to null and add a string to unexpectedObservations.
- Do not navigate away from the dev app. Do not execute arbitrary scripts.
- Keep reasoning short. Stop as soon as you can return a complete structured result.`;

export const createJobPhase: Phase<CreateJobInput, CreateJobOutput> = {
  name: "create_job",
  allowedTools: [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_fill_form",
    "browser_select_option",
    "browser_wait_for",
    "browser_take_screenshot",
  ] as const,
  maxSteps: 50,
  timeoutMs: 300_000,
  outputSchema,
  systemPrompt: SYSTEM_PROMPT,
  buildUserPrompt: (input) =>
    [
      "Task: create a new job with the parameters below.",
      "",
      "Steps:",
      '1. From the Jobs table, click "Schedule job".',
      `2. In the dropdown that opens, pick "${input.mode}".`,
      `3. Enter the job name "${input.jobName}".`,
      `4. Search the list field for "${input.listName}", click the matching list, click Next.`,
      `5. Pick throttling option "${input.throttlingOption}".`,
      `6. Set the delivery window: start = a few minutes from now, end = start + ${input.deliveryWindowHours} hours. Do not keep defaults.`,
      `7. Recycle people: ${input.recyclePeople ? `enable and set percentage to ${input.recyclePercentage ? `${input.recyclePercentage}%` : "a valid value (see domain knowledge)"}` : "leave disabled"}, click Next.`,
      '8. On the "Verify information" screen, confirm the mode and values, then click "Apply".',
      "9. You will land on the Jobs table. Find the new row and click into it to reach the job detail page.",
      "10. Read the resulting jobId and the parameters as displayed on the detail page.",
      "",
      "Return the structured result. Anything unexpected (missing fields, validation warnings, pre-filled state, surprising redirects, charts you could not read) goes into unexpectedObservations as short strings.",
    ].join("\n"),
};
