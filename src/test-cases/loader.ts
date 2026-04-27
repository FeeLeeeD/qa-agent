import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { ZodError } from "zod";
import { type TestCase, TestCaseFrontmatterSchema } from "./schema.ts";

const MARKDOWN_EXTENSION = ".md";

const resolveRootDir = (rootDir: string | undefined): string =>
  rootDir ?? path.resolve(process.cwd(), "test-cases");

const resolveTestCasePath = (rootDir: string, name: string): string =>
  path.resolve(rootDir, `${name}${MARKDOWN_EXTENSION}`);

const formatZodIssues = (error: ZodError): string =>
  error.issues
    .map((issue) => {
      const fieldPath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${fieldPath}: ${issue.message}`;
    })
    .join("\n");

/**
 * Read, parse and validate a single Markdown test case file. All failure
 * modes throw with the file path embedded in the message so callers can
 * trace them back without extra plumbing.
 */
const parseTestCaseFile = (filePath: string): TestCase => {
  if (!existsSync(filePath)) {
    throw new Error(`Test case file does not exist: ${filePath}`);
  }

  const raw = readFileSync(filePath, "utf8");

  if (!matter.test(raw)) {
    throw new Error(
      `Invalid test case ${filePath}: missing frontmatter. Expected the file to start with '---' followed by YAML and a closing '---'.`
    );
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse YAML frontmatter in ${filePath}: ${detail}`
    );
  }

  const result = TestCaseFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    throw new Error(
      `Invalid frontmatter in ${filePath}:\n${formatZodIssues(result.error)}`
    );
  }

  const fm = result.data;
  return {
    name: fm.name,
    description: fm.description,
    targetType: fm.target_type,
    parameters: fm.parameters,
    expectations: fm.expectations,
    body: parsed.content.trim(),
    filePath,
  };
};

/**
 * Load and validate a single test case by name. `name` is the basename of
 * the file without the `.md` extension, e.g. `loadTestCase('baseline')`
 * reads `<rootDir>/baseline.md`. Defaults to `<cwd>/test-cases`.
 */
export const loadTestCase = (
  name: string,
  opts?: { rootDir?: string }
): TestCase => {
  const dir = resolveRootDir(opts?.rootDir);
  const filePath = resolveTestCasePath(dir, name);
  return parseTestCaseFile(filePath);
};

/**
 * Load every `.md` file directly under the test-cases root, validate each,
 * and return the typed array sorted by file name. If any file fails to
 * parse or validate, this function throws — better to fail loud during the
 * PoC than to silently skip broken files.
 */
export const listTestCases = (opts?: { rootDir?: string }): TestCase[] => {
  const dir = resolveRootDir(opts?.rootDir);
  if (!existsSync(dir)) {
    throw new Error(`Test case directory does not exist: ${dir}`);
  }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)
    )
    .map((entry) => path.resolve(dir, entry.name))
    .sort();
  return files.map((filePath) => parseTestCaseFile(filePath));
};
