import type { Path, Sha } from "@fire_trident/core";
import type { ReportedTest, RunReport } from "./report.ts";

/**
 * Per-file results. `node --test` runs each test file in its own process, and certification gives
 * each file its own module copies, so a file's results depend only on what it reaches: the paths
 * and blob ids of the modules in its import closure (plus the runner and the per-test limit). A run
 * re-executes only the test files whose key changed and reuses the stored results of the rest.
 */

/** One test file's results, as stored and reused. */
export interface FileResult {
  path: Path;
  loadError: string | null;
  tests: ReportedTest[];
  suites: RunReport["suites"];
}

/** The text a file's cache key is the digest of (closure paths sorted, each with its blob id). */
export function fileKeyText(path: Path, closure: readonly Path[], blobs: ReadonlyMap<Path, Sha>, runner: string, testTimeoutMs: number): string {
  return [runner, `test-timeout ${testTimeoutMs}`, `file ${path}`, ...[...closure].sort().map((p) => `${p} ${blobs.get(p) ?? "?"}`)].join("\n");
}

/** A test's outcome depended on the run, not on the code (the run's budget, an unfinished file): never reuse it. */
export const RUN_DEPENDENT = /ran out of time|not finished when the file ended|did not finish loading/;

/**
 * Split a run's report into per-file results. Files whose results depended on the run itself (the
 * run's time budget) are left out, so they run again next time, unless `all` (this run's verdict).
 */
export function splitReport(report: RunReport, files: readonly Path[], all = false): Map<Path, FileResult> {
  const out = new Map<Path, FileResult>();
  for (const path of files) {
    const meta = report.files.find((f) => f.path === path);
    if (!meta) continue;
    const tests = report.tests.filter((t) => t.file === path);
    const suites = report.suites.filter((s) => s.file === path);
    if (!all && (tests.some((t) => RUN_DEPENDENT.test(t.error ?? "")) || RUN_DEPENDENT.test(meta.loadError ?? ""))) continue;
    out.set(path, { path, loadError: meta.loadError ?? null, tests, suites });
  }
  return out;
}

/** One report from per-file results, in `order` (files without a result are left out). */
export function mergeResults(order: readonly Path[], results: ReadonlyMap<Path, FileResult>, runner: string, ms: number): RunReport {
  const report: RunReport = { runner, files: [], tests: [], suites: [], ms };
  for (const path of order) {
    const r = results.get(path);
    if (!r) continue;
    report.files.push({ path, ms: 0, tests: r.tests.length, loadError: r.loadError });
    report.tests.push(...r.tests);
    report.suites.push(...r.suites);
  }
  return report;
}
