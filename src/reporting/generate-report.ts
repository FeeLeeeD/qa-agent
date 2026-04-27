import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createModel, generateStructuredObject } from "../llm/index.ts";
import { logger } from "../logger.ts";
import {
  getRun,
  getRunDir,
  listObservations,
  listPhases,
  type ObservationRow,
  type PhaseRow,
  type RunRow,
} from "../storage/index.ts";
import { loadTestCase, type TestCase } from "../test-cases/index.ts";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const JSON_INDENT = 2;
const REPORT_FILE_NAME = "report.md";

const interpretationSchema = z.object({
  verdict: z.enum(["ok", "suspicious", "buggy", "inconclusive"]),
  confidence: z.enum(["high", "medium", "low"]),
  findings: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      severity: z.enum(["info", "warn", "error"]),
    })
  ),
  notes: z.string(),
});
type Interpretation = z.infer<typeof interpretationSchema>;

const SYSTEM_PROMPT = [
  "You are a senior QA engineer reviewing one automated test run of a",
  "job-scheduling feature. You will receive structured facts about the run:",
  "the test case parameters, the executed phases, and the observations",
  "collected. Your job is to assess whether the run looks healthy. Be",
  "concise and grounded — every finding must point to a specific fact you",
  'saw. Use "inconclusive" if there isn\'t enough data to judge. Do not',
  "invent metrics that aren't in the input.",
].join(" ");

interface GenerateReportArgs {
  runId: string;
}

interface GenerateReportResult {
  reportPath: string;
}

/**
 * Reads the SQLite state for `runId`, renders a deterministic Facts
 * section, asks the LLM for one structured interpretation pass, and
 * writes the combined Markdown to `reports/<runId>/report.md`. The
 * function never throws on LLM failures — those degrade the
 * Interpretation section to a fallback message but the file is still
 * produced.
 */
export const generateReport = async (
  args: GenerateReportArgs
): Promise<GenerateReportResult> => {
  const { runId } = args;
  const run = getRun(runId);
  if (!run) {
    throw new Error(`generateReport: no run row found for runId=${runId}`);
  }
  const phases = listPhases(runId);
  const observations = listObservations({ runId });
  const testCase = loadTestCase(run.testCaseName);

  const factsMarkdown = renderFactsSection({
    run,
    phases,
    observations,
    testCase,
  });

  const interpretationMarkdown = await renderInterpretationSection({
    run,
    phases,
    observations,
    testCase,
  });

  const body = `${factsMarkdown}\n${interpretationMarkdown}`;
  const reportPath = path.join(getRunDir(runId), REPORT_FILE_NAME);
  await writeFile(reportPath, body, "utf8");
  logger.info("report_written", { runId, reportPath });
  return { reportPath };
};

/* ---------- Facts ---------- */

interface FactsArgs {
  observations: readonly ObservationRow[];
  phases: readonly PhaseRow[];
  run: RunRow;
  testCase: TestCase;
}

const renderFactsSection = (args: FactsArgs): string => {
  const { run, phases, observations, testCase } = args;
  const failedPhase = phases.find((p) => p.status === "failed");
  const statusLine =
    run.status === "failed" && failedPhase
      ? `failed (failed phase: ${failedPhase.phaseName})`
      : run.status;
  const finishedAt = run.finishedAt ?? "(not finished)";
  const durationHuman = formatDuration(run.startedAt, run.finishedAt);

  const header = [
    "# QA Run Report",
    "",
    `- **Run ID:** ${run.id}`,
    `- **Test case:** ${testCase.name}`,
    `- **Status:** ${statusLine}`,
    `- **Started:** ${run.startedAt}`,
    `- **Finished:** ${finishedAt}`,
    `- **Duration:** ${durationHuman}`,
    "",
  ].join("\n");

  const parameters = renderKeyValueTable(testCase.parameters);
  const parametersSection = [
    "## Test case parameters",
    "",
    parameters,
    "",
  ].join("\n");

  const phasesSection = renderPhasesSection(phases);
  const observationsSection = renderObservationsSection(observations);

  return [header, parametersSection, phasesSection, observationsSection]
    .filter(Boolean)
    .join("\n");
};

const renderPhasesSection = (phases: readonly PhaseRow[]): string => {
  const head = [
    "## Phases",
    "",
    "| # | Phase | Status | Duration | Error |",
    "| - | ----- | ------ | -------- | ----- |",
  ];
  if (phases.length === 0) {
    head.push("| — | — | — | — | — |", "");
    return head.join("\n");
  }
  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i];
    if (!phase) {
      continue;
    }
    const duration = formatDuration(phase.startedAt, phase.finishedAt);
    const errorText = phase.error ? escapeCell(phase.error) : "—";
    head.push(
      `| ${i + 1} | ${escapeCell(phase.phaseName)} | ${phase.status} | ${duration} | ${errorText} |`
    );
  }
  head.push("");
  return head.join("\n");
};

const renderObservationsSection = (
  observations: readonly ObservationRow[]
): string => {
  const lines: string[] = ["## Observations", ""];
  if (observations.length === 0) {
    lines.push("_No observations recorded._", "");
    return lines.join("\n");
  }

  for (const observation of observations) {
    lines.push(
      `### ${observation.targetType} ${observation.targetId}`,
      "",
      `- **Observed at:** ${observation.observedAt}`
    );

    const status = extractStatusFromMetrics(observation.metrics);
    if (status !== null) {
      lines.push(`- **Status:** ${status}`);
    }

    const innerMetrics = extractInnerMetrics(observation.metrics);
    if (innerMetrics !== null && Object.keys(innerMetrics).length > 0) {
      lines.push("- **Metrics:**", "");
      lines.push(indent(renderKeyValueTable(innerMetrics), "  "));
    }

    if (observation.screenshotPaths.length > 0) {
      const links = observation.screenshotPaths
        .map((p) => `[${p}](${p})`)
        .join(", ");
      lines.push(`- **Screenshots:** ${links}`);
    } else {
      lines.push("- **Screenshots:** none");
    }
    lines.push("");
  }

  return lines.join("\n");
};

const extractStatusFromMetrics = (metrics: unknown): string | null => {
  if (
    metrics &&
    typeof metrics === "object" &&
    !Array.isArray(metrics) &&
    "status" in metrics
  ) {
    const candidate = (metrics as { status: unknown }).status;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
};

const extractInnerMetrics = (
  metrics: unknown
): Record<string, unknown> | null => {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return null;
  }
  const obj = metrics as Record<string, unknown>;
  const inner = obj.metrics;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return null;
};

const renderKeyValueTable = (
  values: Readonly<Record<string, unknown>>
): string => {
  const keys = Object.keys(values).sort();
  const lines = ["| Key | Value |", "| --- | --- |"];
  if (keys.length === 0) {
    lines.push("| — | — |");
    return lines.join("\n");
  }
  for (const key of keys) {
    lines.push(
      `| ${escapeCell(key)} | ${escapeCell(renderValueCell(values[key]))} |`
    );
  }
  return lines.join("\n");
};

const renderValueCell = (raw: unknown): string => {
  if (raw === null || raw === undefined) {
    return "_null_";
  }
  if (typeof raw === "object") {
    return `\`${JSON.stringify(raw)}\``;
  }
  return String(raw);
};

const escapeCell = (value: string): string =>
  value.replace(/\|/g, "\\|").replace(/\n/g, " ");

const indent = (block: string, prefix: string): string =>
  block
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n");

const formatDuration = (
  startedAt: string,
  finishedAt: string | null
): string => {
  if (!finishedAt) {
    return "(in progress)";
  }
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(finishedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return "(unknown)";
  }
  const diff = Math.max(0, endMs - startMs);
  if (diff < MS_PER_SECOND) {
    return `${diff}ms`;
  }
  const totalSeconds = Math.floor(diff / MS_PER_SECOND);
  const remainderMs = diff % MS_PER_SECOND;
  if (totalSeconds < SECONDS_PER_MINUTE) {
    const fractional = remainderMs > 0 ? `.${remainderMs}` : "";
    return `${totalSeconds}${fractional}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  if (totalMinutes < MINUTES_PER_HOUR) {
    return `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return `${hours}h ${minutes}m ${seconds}s`;
};

/* ---------- Interpretation ---------- */

const renderInterpretationSection = async (
  args: FactsArgs
): Promise<string> => {
  const model = createModel();
  const userPrompt = buildInterpretationUserPrompt(args);

  const result = await generateStructuredObject({
    model,
    schema: interpretationSchema,
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  if (result.ok) {
    return renderInterpretation(result.value);
  }

  logger.warn("report_interpretation_failed", {
    kind: result.kind,
    details: result.details,
  });
  return renderInterpretationFallback(`${result.kind}: ${result.details}`);
};

const buildInterpretationUserPrompt = (args: FactsArgs): string => {
  const { run, phases, observations, testCase } = args;
  const failedPhase = phases.find((p) => p.status === "failed");
  const statusLine =
    run.status === "failed" && failedPhase
      ? `${run.status} (failed phase: ${failedPhase.phaseName})`
      : `${run.status} (failed phase: none)`;

  const phaseLines = phases.map((phase, idx) => {
    const duration = formatDuration(phase.startedAt, phase.finishedAt);
    const error = phase.error ? phase.error : "—";
    return `- ${idx + 1}. ${phase.phaseName} — status=${phase.status}, duration=${duration}, error=${error}`;
  });

  const observationLines = observations.map((obs) => {
    const metricsJson = JSON.stringify(obs.metrics);
    return `- target_type=${obs.targetType}, target_id=${obs.targetId}, observed_at=${obs.observedAt}, metrics=${metricsJson}`;
  });

  return [
    `Test case: ${testCase.name} — ${testCase.description}`,
    `Parameters: ${JSON.stringify(testCase.parameters, null, JSON_INDENT)}`,
    `Expectations: ${JSON.stringify(testCase.expectations, null, JSON_INDENT)}`,
    "",
    `Run status: ${statusLine}`,
    "",
    "Phases (in order):",
    ...(phaseLines.length > 0 ? phaseLines : ["- (none)"]),
    "",
    "Observations (in order):",
    ...(observationLines.length > 0 ? observationLines : ["- (none)"]),
    "",
    "Produce your structured assessment.",
  ].join("\n");
};

const renderInterpretation = (data: Interpretation): string => {
  const lines: string[] = [
    "## Interpretation",
    "",
    `- **Verdict:** ${data.verdict}`,
    `- **Confidence:** ${data.confidence}`,
    "",
    "### Findings",
    "",
  ];
  if (data.findings.length === 0) {
    lines.push("_No findings reported._", "");
  } else {
    for (const finding of data.findings) {
      lines.push(
        `- **[${finding.severity}] ${finding.title}**`,
        `  ${finding.detail}`
      );
    }
    lines.push("");
  }
  lines.push(
    "### Notes",
    "",
    data.notes.trim().length > 0 ? data.notes : "_No notes._",
    ""
  );
  return lines.join("\n");
};

const renderInterpretationFallback = (detail: string): string =>
  [
    "## Interpretation",
    "",
    `> Interpretation could not be generated: ${detail}.`,
    "> Facts above are complete; review manually.",
    "",
  ].join("\n");
