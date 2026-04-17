import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Metrics, StepMetric, ToolCallMetric } from "./metrics.ts";

const SCREENSHOT_TOOL_NAME = "browser_take_screenshot";
const DEFAULT_SCREENSHOT_EXT = "png";
const JSON_INDENT = 2;

interface TimelineRow {
  at: number;
  durationMs: number;
  index: number;
  kind: "llm-step" | "tool";
  name: string;
  notes: string;
}

export const writeReport = async (params: {
  metrics: Metrics;
  reportDir: string;
  modelLabel: string;
}): Promise<string> => {
  const { metrics, reportDir, modelLabel } = params;

  const endedAt = metrics.endedAt ?? performance.now();
  const wallMs = endedAt - metrics.startedAt;

  const rows = buildTimeline(metrics);
  const body = renderMarkdown({ metrics, modelLabel, wallMs, rows });

  const reportPath = path.join(reportDir, "report.md");
  await writeFile(reportPath, body, "utf8");
  return reportPath;
};

const buildTimeline = (metrics: Metrics): TimelineRow[] => {
  const stepRows: TimelineRow[] = metrics.steps.map((step, idx) => ({
    index: idx,
    kind: "llm-step",
    name: `step ${step.stepNumber}`,
    durationMs: step.durationMs,
    notes: formatStepNotes(step),
    at: metrics.startedAtAbsolute + Math.round(step.durationMs * (idx + 1)),
  }));
  const toolRows: TimelineRow[] = metrics.toolCalls.map((call, idx) => ({
    index: idx,
    kind: "tool",
    name: call.name,
    durationMs: call.durationMs,
    notes: formatToolNotes(call),
    at: call.at,
  }));
  const combined = [...stepRows, ...toolRows].sort((a, b) => a.at - b.at);
  return combined.map((row, i) => ({ ...row, index: i + 1 }));
};

const formatStepNotes = (step: StepMetric): string => {
  const parts: string[] = [];
  parts.push(
    `${step.toolCallCount} tool call${step.toolCallCount === 1 ? "" : "s"}`
  );
  if (step.inputTokens !== undefined && step.outputTokens !== undefined) {
    parts.push(`${step.inputTokens}→${step.outputTokens} tokens`);
  }
  parts.push(`finish: ${step.finishReason}`);
  return parts.join(", ");
};

const formatToolNotes = (call: ToolCallMetric): string => {
  if (!call.ok) {
    return `error: ${call.error ?? "unknown"}`;
  }
  return "ok";
};

const renderMarkdown = (params: {
  metrics: Metrics;
  modelLabel: string;
  wallMs: number;
  rows: TimelineRow[];
}): string => {
  const { metrics, modelLabel, wallMs, rows } = params;
  const isoStart = new Date(metrics.startedAtAbsolute).toISOString();

  const header = [
    `# QA Agent Run — ${isoStart}`,
    "",
    `**Model**: ${modelLabel}  `,
    `**Wall time**: ${formatMs(wallMs)}  `,
    `**Steps**: ${metrics.steps.length}  **Tool calls**: ${metrics.toolCalls.length}  **Finish**: ${metrics.finishReason ?? "n/a"}`,
    "",
  ].join("\n");

  const task = ["## Task", "", "```", metrics.prompt, "```", ""].join("\n");

  const timelineHeader =
    "| # | Kind | Name | Duration (ms) | Notes |\n|---|------|------|---------------|-------|";
  const timelineRows = rows
    .map(
      (row) =>
        `| ${row.index} | ${row.kind} | ${row.name} | ${formatMs(row.durationMs)} | ${escapePipes(row.notes)} |`
    )
    .join("\n");
  const timeline = ["## Timeline", "", timelineHeader, timelineRows, ""].join(
    "\n"
  );

  const screenshotFilenames = collectScreenshotFilenames(metrics.toolCalls);
  const screenshot =
    screenshotFilenames.length === 0
      ? ""
      : [
          "## Screenshots",
          "",
          ...screenshotFilenames.map((name) => `![${name}](./${name})`),
          "",
        ].join("\n");

  const finalText = metrics.finalText
    ? [
        "## Final agent message",
        "",
        "```",
        metrics.finalText.trim(),
        "```",
        "",
      ].join("\n")
    : "";

  const raw = [
    "## Raw metrics",
    "",
    "<details><summary>JSON</summary>",
    "",
    "```json",
    JSON.stringify(metrics, null, JSON_INDENT),
    "```",
    "",
    "</details>",
    "",
  ].join("\n");

  return [header, task, timeline, screenshot, finalText, raw]
    .filter(Boolean)
    .join("\n");
};

const formatMs = (ms: number): string => Math.round(ms).toLocaleString("en-US");

const escapePipes = (value: string): string => value.replace(/\|/g, "\\|");

const collectScreenshotFilenames = (toolCalls: ToolCallMetric[]): string[] => {
  const filenames: string[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (call.name !== SCREENSHOT_TOOL_NAME || !call.ok) {
      continue;
    }
    const filename = extractScreenshotFilename(call);
    if (!filename || seen.has(filename)) {
      continue;
    }
    seen.add(filename);
    filenames.push(filename);
  }
  return filenames;
};

const extractScreenshotFilename = (
  call: ToolCallMetric
): string | undefined => {
  if (!call.args || typeof call.args !== "object") {
    return;
  }
  const args = call.args as { filename?: unknown; type?: unknown };
  if (typeof args.filename === "string" && args.filename.length > 0) {
    return path.basename(args.filename);
  }
  // browser_take_screenshot defaults to `page-{timestamp}.{png|jpeg}` when no
  // filename is provided; we can't reconstruct the exact timestamp, so skip.
  const ext =
    typeof args.type === "string" ? args.type : DEFAULT_SCREENSHOT_EXT;
  return `page-*.${ext}`;
};
