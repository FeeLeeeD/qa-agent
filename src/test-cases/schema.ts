import { z } from "zod";

const NAME_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Validates the YAML frontmatter object parsed from a `test-cases/*.md`
 * file. Top-level keys are snake_case as authored in the file.
 *
 * Strict mode is intentional: typos like `parametres:` should fail loudly
 * rather than silently fall through to phases as missing data.
 *
 * `parameters` and `expectations` are kept as open string-keyed records.
 * Per-target-type validation lives in the phases that consume them, not
 * here.
 */
export const TestCaseFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1, "name must be a non-empty string")
      .regex(
        NAME_PATTERN,
        "name must match ^[a-z0-9_-]+$ (lowercase letters, digits, '_' or '-')"
      ),
    description: z.string().min(1, "description must be a non-empty string"),
    target_type: z.string().min(1, "target_type must be a non-empty string"),
    parameters: z.record(z.string(), z.unknown()),
    expectations: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type TestCaseFrontmatter = z.infer<typeof TestCaseFrontmatterSchema>;

/**
 * Public, normalized shape returned by the loader. Top-level frontmatter
 * keys are converted to camelCase here; keys nested inside `parameters` and
 * `expectations` are passed through verbatim.
 */
export interface TestCase {
  body: string;
  description: string;
  expectations: Record<string, unknown>;
  filePath: string;
  name: string;
  parameters: Record<string, unknown>;
  targetType: string;
}
