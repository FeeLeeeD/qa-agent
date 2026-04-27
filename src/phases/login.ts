import { z } from "zod";
import type { Phase } from "./types.ts";

export interface LoginInput {
  email: string;
  password: string;
}

const outputSchema = z.object({
  loggedIn: z.boolean(),
  postLoginUrl: z.string(),
  userEmail: z.string().nullable(),
});

export type LoginOutput = z.infer<typeof outputSchema>;

const SYSTEM_PROMPT = `You are a QA agent running against a dev web app. You have a small, fixed set of Playwright browser tools.

Domain knowledge:
{{knowledge}}

Operating rules:
- Use browser_snapshot to inspect the page before deciding what to do — prefer the accessibility tree over screenshots for decisions.
- Act on elements from the accessibility snapshot. Do not invent selectors.
- After clicking submit, give the page time to settle: take a fresh browser_snapshot until you see post-login content (a logged-in shell, a dashboard, a user-menu, etc.) before declaring success.
- Stop as soon as you can answer the structured result. Keep reasoning short.`;

export const loginPhase: Phase<LoginInput, LoginOutput> = {
  name: "login",
  allowedTools: [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_take_screenshot",
  ] as const,
  maxSteps: 15,
  timeoutMs: 60_000,
  outputSchema,
  systemPrompt: SYSTEM_PROMPT,
  buildUserPrompt: (input) =>
    [
      "Task: log in to the dev app.",
      `Credentials — email: ${input.email}, password: ${input.password}.`,
      "Steps: navigate to the URL, locate the email and password fields, fill them in, submit, and confirm a post-login page is loaded.",
      "When done, return the structured result with:",
      "- loggedIn: true if the post-login page is visible, false otherwise",
      "- userEmail: the email shown by the app for the logged-in user (null if not surfaced anywhere)",
      "- postLoginUrl: the URL of the page reached after successful login",
    ].join("\n"),
};
