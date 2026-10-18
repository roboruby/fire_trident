import type { Path } from "@fire_trident/core";
import type { Loaded } from "./load.ts";
import type { ReportedTest, RunReport } from "./report.ts";

/**
 * Tests a person excludes from trunk certification (CertifyPolicy.excludeTests): known differences between the test
 * Worker's runtime and the one a project's tests are written for, such as a test that relies on a Fetch API detail the
 * Worker does not implement. An entry is a test file's path, or one test's full name in it ("src/a.test.ts > suite >
 * test", as results name tests). Excluded files are left out before the run; excluded tests run, and their results
 * count as unsupported, never as failing or passing. Only a person sets the policy (the admin token); a test that
 * passed on the certified commit and is excluded afterwards is lost like a skipped one, until the loss is accepted.
 */

/** Why an excluded test or file did not count. */
export const EXCLUDED = "excluded by the colony's certification policy";
/** Entries a policy holds at most, and the length of each. */
export const MAX_EXCLUDES = 200;
export const MAX_EXCLUDE_LENGTH = 400;

/** A policy's excludeTests checked: the entries (trimmed, without duplicates), or why the value is refused. */
export function excludeEntries(v: unknown): string[] | string {
  const shape = `excludeTests must be a list of at most ${MAX_EXCLUDES} test file paths or test names ("path > suite > test"), each at most ${MAX_EXCLUDE_LENGTH} characters`;
  if (!Array.isArray(v) || v.length > MAX_EXCLUDES) return shape;
  const out: string[] = [];
  for (const e of v) {
    if (typeof e !== "string" || e.trim() === "" || e.length > MAX_EXCLUDE_LENGTH) return shape;
    out.push(e.trim());
  }
  return [...new Set(out)];
}

function entryOf(entry: string): { file: Path; name: string | null } {
  const at = entry.indexOf(" > ");
  return at < 0 ? { file: entry, name: null } : { file: entry.slice(0, at), name: entry.slice(at + 3) };
}

/** Leave out the test files the policy excludes whole: they move from `tests` to `unsupported` with the reason. */
export function excludeFiles(loaded: Loaded, entries: readonly string[] | undefined): void {
  const files = new Set((entries ?? []).map(entryOf).filter((e) => e.name === null).map((e) => e.file));
  if (files.size === 0) return;
  for (const t of loaded.tests) {
    if (!files.has(t)) continue;
    loaded.unsupported.push({ path: t, reason: EXCLUDED });
    loaded.via.set(t, t);
  }
  loaded.tests = loaded.tests.filter((t) => !files.has(t));
}

/** The report with the tests the policy excludes by name counted as unsupported, whatever they did (the report itself is not changed). */
export function excludeTests(report: RunReport, entries: readonly string[] | undefined): RunReport {
  const names = new Set((entries ?? []).map(entryOf).filter((e) => e.name !== null).map((e) => `${e.file}\u0000${e.name}`));
  if (names.size === 0) return report;
  const tests = report.tests.map((t): ReportedTest => (names.has(`${t.file}\u0000${t.name}`) ? { ...t, status: "skipped", unsupported: EXCLUDED, error: `not supported by trunk certification: ${EXCLUDED}` } : t));
  return { ...report, tests };
}
