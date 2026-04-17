import { z } from "zod";

const EnvSchema = z
  .object({
    PORTKEY_API_KEY: z.string().min(1, "PORTKEY_API_KEY is required"),
    PORTKEY_VIRTUAL_KEY: z.string().optional(),
    PORTKEY_CONFIG: z.string().optional(),

    DEV_APP_URL: z.string().url("DEV_APP_URL must be a valid URL"),
    DEV_APP_EMAIL: z.string().min(1, "DEV_APP_EMAIL is required"),
    DEV_APP_PASSWORD: z.string().min(1, "DEV_APP_PASSWORD is required"),

    HEADLESS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .refine(
    (value) => Boolean(value.PORTKEY_VIRTUAL_KEY ?? value.PORTKEY_CONFIG),
    {
      message: "Provide either PORTKEY_VIRTUAL_KEY or PORTKEY_CONFIG",
      path: ["PORTKEY_VIRTUAL_KEY"],
    }
  );

export type Env = z.infer<typeof EnvSchema>;

export const loadEnv = (): Env => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`
      )
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
};
