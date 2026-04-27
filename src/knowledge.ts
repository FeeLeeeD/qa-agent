import { readFileSync } from "node:fs";
import path from "node:path";

const OVERVIEW_RELATIVE_PATH = "knowledge/overview.md";

let cached: string | null = null;

/**
 * Loads the static `knowledge/overview.md` content used as the
 * `{{knowledge}}` text for every real phase. Read once per process and
 * cached — content is checked into the repo, so re-reading on every
 * phase would be pure overhead.
 */
export const loadOverview = (): string => {
  if (cached !== null) {
    return cached;
  }
  const filePath = path.resolve(process.cwd(), OVERVIEW_RELATIVE_PATH);
  cached = readFileSync(filePath, "utf8");
  return cached;
};
