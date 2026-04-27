import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTestCases, loadTestCase } from "./index.ts";

const FAILURE_EXIT_CODE = 1;
const BODY_PREVIEW_LENGTH = 80;

const stdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const expectThrowsContaining = (
  fn: () => unknown,
  needle: string,
  label: string
): Error => {
  let thrown: Error | undefined;
  try {
    fn();
  } catch (err) {
    thrown = err instanceof Error ? err : new Error(String(err));
  }
  if (!thrown) {
    throw new Error(`${label}: expected error, got none`);
  }
  if (!thrown.message.includes(needle)) {
    throw new Error(
      `${label}: expected error message to contain "${needle}", got: ${thrown.message}`
    );
  }
  return thrown;
};

const writeFixture = (dir: string, name: string, contents: string): string => {
  const filePath = path.join(dir, `${name}.md`);
  writeFileSync(filePath, contents, "utf8");
  return filePath;
};

const verifyBaseline = (): void => {
  const baseline = loadTestCase("baseline");
  assert.equal(baseline.name, "baseline", "baseline.name");
  assert.equal(baseline.targetType, "job", "baseline.targetType");
  assert.equal(
    baseline.parameters.throttling_option,
    "Personalize Sending (Default)",
    "baseline.parameters.throttling_option"
  );
  assert.equal(
    baseline.parameters.delivery_window_hours,
    24,
    "baseline.parameters.delivery_window_hours"
  );
  assert.equal(
    baseline.expectations.scheduling_completes_within_minutes,
    5,
    "baseline.expectations.scheduling_completes_within_minutes"
  );
  assert.ok(
    baseline.body.length > 0,
    `expected non-empty body, got: ${baseline.body.slice(0, BODY_PREVIEW_LENGTH)}`
  );
  assert.ok(
    baseline.filePath.endsWith(path.join("test-cases", "baseline.md")),
    `unexpected filePath: ${baseline.filePath}`
  );

  const all = listTestCases();
  assert.ok(all.length >= 1, "expected listTestCases to return >= 1 item");
  assert.ok(
    all.some((tc) => tc.name === "baseline"),
    "expected listTestCases to include baseline"
  );
};

const verifyNegativeCases = (): void => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "qa-agent-test-cases-"));
  try {
    writeFixture(
      tmpRoot,
      "no-frontmatter",
      "# Just markdown\n\nNo YAML here.\n"
    );
    expectThrowsContaining(
      () => loadTestCase("no-frontmatter", { rootDir: tmpRoot }),
      "frontmatter",
      "missing-frontmatter"
    );

    writeFixture(
      tmpRoot,
      "malformed",
      '---\nname: "unterminated\ndescription: x\ntarget_type: job\nparameters: {}\n---\nbody\n'
    );
    const malformedErr = expectThrowsContaining(
      () => loadTestCase("malformed", { rootDir: tmpRoot }),
      "YAML",
      "malformed-yaml-mentions-YAML"
    );
    assert.ok(
      malformedErr.message.includes("parse"),
      `malformed-yaml: expected error to mention 'parse', got: ${malformedErr.message}`
    );

    writeFixture(
      tmpRoot,
      "no-name",
      "---\ndescription: missing name\ntarget_type: job\nparameters: {}\n---\nbody\n"
    );
    const nameErr = expectThrowsContaining(
      () => loadTestCase("no-name", { rootDir: tmpRoot }),
      "name",
      "missing-name"
    );
    stdout(`missing-name error: ${nameErr.message.split("\n").join(" \\n ")}`);

    writeFixture(
      tmpRoot,
      "extra",
      "---\nname: extra\ndescription: extra field\ntarget_type: job\nparameters: {}\nrandom_field: 1\n---\nbody\n"
    );
    expectThrowsContaining(
      () => loadTestCase("extra", { rootDir: tmpRoot }),
      "random_field",
      "extra-field-rejected"
    );

    const missingFilePath = path.join(tmpRoot, "does-not-exist.md");
    expectThrowsContaining(
      () => loadTestCase("does-not-exist", { rootDir: tmpRoot }),
      missingFilePath,
      "missing-file"
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

const main = (): void => {
  verifyBaseline();
  verifyNegativeCases();
  stdout("SMOKE OK");
};

try {
  main();
} catch (err) {
  process.stderr.write(`SMOKE FAIL: ${errorMessage(err)}\n`);
  process.exit(FAILURE_EXIT_CODE);
}
