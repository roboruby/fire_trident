import type { CertificationStatus, FailingTest, Path, TestCounts } from "@fire_trident/core";

/** One test as the harness reports it. */
export interface ReportedTest {
  name: string;
  file: Path;
  status: "pass" | "fail" | "cancelled" | "skipped" | "todo";
  error?: string;
  ms?: number;
}

/** The harness's JSON answer (plan.ts, HARNESS_BODY). */
export interface RunReport {
  runner: string;
  files: Array<{ path: Path; ms: number; tests: number; loadError: string | null }>;
  tests: ReportedTest[];
  suites: Array<{ name: string; file: Path; status: string; error?: string }>;
  diagnostics?: string[];
  unhandled?: string[];
  ms: number;
}

/** Failing tests kept per result, and the length of each error and test name. */
export const MAX_FAILING = 50;
export const MAX_ERROR = 300;
export const MAX_NAME = 200;

/** A test or suite name as results keep it: the repository's text, cut to one readable length. */
export function testName(s: unknown): string {
  const n = typeof s === "string" ? s : String(s);
  return n.length > MAX_NAME ? `${n.slice(0, MAX_NAME - 1)}…` : n;
}

/** The verdict of one run: green, red, or nothing to judge (no tests). */
export interface Summary {
  status: Extract<CertificationStatus, "green" | "red" | "skipped">;
  counts: TestCounts;
  failing: FailingTest[];
  detail?: string;
}

/**
 * Count a report the way `node --test` does (tests = pass + fail + cancelled + skipped + todo) and
 * judge it: green when no test failed or was cancelled and no suite failed on its own (a hook or
 * its body threw), red otherwise; a run with no tests at all judges nothing.
 */
export function summarize(r: RunReport): Summary {
  const counts: TestCounts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  const failing: FailingTest[] = [];
  const clip = (s: string | undefined): string | undefined => (s === undefined ? undefined : s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR - 1)}…` : s);
  for (const t of Array.isArray(r.tests) ? r.tests : []) {
    counts.tests++;
    if (t.status === "pass" || t.status === "fail" || t.status === "cancelled" || t.status === "skipped" || t.status === "todo") counts[t.status]++;
    else counts.fail++;
    if ((t.status === "fail" || t.status === "cancelled" || !["pass", "skipped", "todo"].includes(t.status)) && failing.length < MAX_FAILING) {
      const f: FailingTest = { name: testName(t.name), file: t.file };
      const error = clip(t.status === "cancelled" && t.error ? `cancelled: ${t.error}` : t.error);
      if (error) f.error = error;
      failing.push(f);
    }
  }
  let suiteErrors = 0;
  for (const s of Array.isArray(r.suites) ? r.suites : []) {
    counts.suites++;
    if (s.status === "fail" && s.error) {
      suiteErrors++;
      if (failing.length < MAX_FAILING) {
        const f: FailingTest = { name: `${testName(s.name)} (suite)`, file: s.file };
        const error = clip(s.error);
        if (error) f.error = error;
        failing.push(f);
      }
    }
  }
  if (counts.tests === 0 && suiteErrors === 0) return { status: "skipped", counts, failing, detail: "the test files define no tests" };
  const red = counts.fail > 0 || counts.cancelled > 0 || suiteErrors > 0;
  return { status: red ? "red" : "green", counts, failing };
}

/**
 * The counts in one line: "60/60 tests", "58/60 tests · 2 skipped", "5 failing · 1 todo". Skipped
 * and todo tests stay in the total and are named, so a test that stops running never drops out of
 * the line.
 */
export function countsLine(counts: TestCounts | undefined): string {
  if (!counts) return "";
  const bad = counts.fail + counts.cancelled;
  const parts = [bad === 0 ? `${counts.pass}/${counts.tests} tests` : `${bad} failing`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.todo > 0) parts.push(`${counts.todo} todo`);
  return parts.join(" · ");
}
