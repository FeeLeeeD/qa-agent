import { z } from "zod";
import { fakePhase } from "./fake-phase.ts";

export interface ObserveJobStubInput {
  jobId: string;
}

export interface ObserveJobStubOutput {
  metrics: {
    delivered: number;
    scheduled: number;
    suppressed: number;
  };
  observedAt: string;
  status: string;
}

const schema = z.object({
  observedAt: z.string(),
  status: z.string(),
  metrics: z.object({
    scheduled: z.number(),
    suppressed: z.number(),
    delivered: z.number(),
  }),
});

/**
 * Deterministic stand-in for the future real "observe job" phase. Always
 * reports a fresh "scheduled" snapshot so the orchestrator can persist a
 * realistic-looking observation against the job created upstream.
 */
export const observeJobStubPhase = fakePhase<
  ObserveJobStubInput,
  ObserveJobStubOutput
>({
  name: "observe_job_stub",
  schema,
  produce: (_input) => ({
    observedAt: new Date().toISOString(),
    status: "scheduled",
    metrics: { scheduled: 100, suppressed: 5, delivered: 0 },
  }),
});
