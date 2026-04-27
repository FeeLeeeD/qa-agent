import { z } from "zod";
import { fakePhase } from "./fake-phase.ts";

export interface LoginStubInput {
  email: string;
}

export interface LoginStubOutput {
  loggedIn: boolean;
  userEmail: string;
}

const schema = z.object({
  loggedIn: z.boolean(),
  userEmail: z.string(),
});

/**
 * Deterministic stand-in for the future real login phase. Always reports
 * success and echoes back the email it was handed.
 */
export const loginStubPhase = fakePhase<LoginStubInput, LoginStubOutput>({
  name: "login_stub",
  schema,
  produce: (input) => ({
    loggedIn: true,
    userEmail: input.email,
  }),
});
