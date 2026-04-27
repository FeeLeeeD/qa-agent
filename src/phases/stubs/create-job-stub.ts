import { z } from "zod";
import { fakePhase } from "./fake-phase.ts";

export interface CreateJobStubInput {
  listId: string;
  throttlingAlgorithm: string;
}

export interface CreateJobStubOutput {
  createdAt: string;
  jobId: string;
}

const schema = z.object({
  jobId: z.string(),
  createdAt: z.string(),
});

/**
 * Deterministic stand-in for the future real "create scheduling job" phase.
 * Returns a synthetic jobId derived from the current timestamp so each
 * smoke run produces a unique-but-stable id.
 */
export const createJobStubPhase = fakePhase<
  CreateJobStubInput,
  CreateJobStubOutput
>({
  name: "create_job_stub",
  schema,
  produce: (_input) => ({
    jobId: `stub-job-${Date.now()}`,
    createdAt: new Date().toISOString(),
  }),
});
