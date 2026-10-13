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

/**
 * Does a parsed answer have the shape of a report: the three lists later steps read, each entry an
 * object naming its file? Code from the repository runs beside the harness, so the answer is checked
 * before anything counts it.
 */
export function isReport(x: unknown): x is RunReport {
  if (x === null || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  const named = (list: unknown, key: string): boolean =>
    Array.isArray(list) && list.every((e: unknown) => e !== null && typeof e === "object" && typeof (e as Record<string, unknown>)[key] === "string");
  return named(r.tests, "file") && named(r.suites, "file") && named(r.files, "path");
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
 * its body threw), red otherwise; a run with no tests at all judges nothing. A test file that did
 * not load counts as one failing test (named after the file, with its load error) unless a failing
 * or cancelled test of its own names it already, so no file drops out of a run unnoticed.
 */
export function summarize(r: RunReport): Summary {
  const counts: TestCounts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  const failing: FailingTest[] = [];
  const clip = (s: string | undefined): string | undefined => (s === undefined ? undefined : s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR - 1)}…` : s);
  /** Test files that a failing or cancelled test of their own names. */
  const named = new Set<Path>();
  for (const t of Array.isArray(r.tests) ? r.tests : []) {
    counts.tests++;
    if (t.status === "pass" || t.status === "fail" || t.status === "cancelled" || t.status === "skipped" || t.status === "todo") counts[t.status]++;
    else counts.fail++;
    const bad = t.status === "fail" || t.status === "cancelled" || !["pass", "skipped", "todo"].includes(t.status);
    if (bad) named.add(t.file);
    if (bad && failing.length < MAX_FAILING) {
      const f: FailingTest = { name: testName(t.name), file: t.file };
      const error = clip(t.status === "cancelled" && t.error ? `cancelled: ${t.error}` : t.error);
      if (error) f.error = error;
      failing.push(f);
    }
  }
  for (const file of Array.isArray(r.files) ? r.files : []) {
    if (!file || !file.loadError || named.has(file.path)) continue;
    named.add(file.path);
    counts.tests++;
    counts.fail++;
    if (failing.length < MAX_FAILING) {
      const f: FailingTest = { name: testName(file.path), file: file.path };
      const error = clip(String(file.loadError));
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

/** A body read within a size and a time bound: the text, and the bound it ran past (null when it ended within both). */
export interface BoundedText {
  text: string;
  over: "size" | "time" | null;
}

/**
 * Read a body as UTF-8 text, at most `maxBytes` bytes and only until `deadline` (epoch ms). The test
 * Worker's answer is written by code that runs beside the repository's tests, so its body may never
 * end or may trickle: past either bound the stream is cancelled and the read stops (`text` is then
 * what came before, cut to `maxBytes`). Bytes are copied into one buffer as they come, so many small
 * chunks cost no more memory than one large one.
 */
export async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number, deadline: number): Promise<BoundedText> {
  if (!body) return { text: "", over: null };
  const reader = body.getReader();
  let buf = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  let size = 0;
  let over: BoundedText["over"] = null;
  let ended = false;
  try {
    for (;;) {
      const next = await beforeDeadline(reader.read(), deadline);
      if (next === LATE) {
        over = "time";
        break;
      }
      if (next.done) {
        ended = true;
        break;
      }
      if (!ArrayBuffer.isView(next.value)) throw new TypeError("the body holds something other than bytes");
      const chunk = new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      const take = Math.min(chunk.byteLength, maxBytes - size);
      if (size + take > buf.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(buf.length * 2, size + take)));
        grown.set(buf.subarray(0, size));
        buf = grown;
      }
      buf.set(chunk.subarray(0, take), size);
      size += take;
      if (take < chunk.byteLength) {
        over = "size";
        break;
      }
    }
  } finally {
    // Stop the stream without waiting on it: its source may never answer the cancellation either.
    if (!ended) reader.cancel().catch(() => undefined);
  }
  return { text: new TextDecoder().decode(buf.subarray(0, size)), over };
}

const LATE = Symbol("late");

/** `p`, or LATE when the deadline passes first (one timer per call, cleared when `p` settles, so nothing builds up across many calls). */
function beforeDeadline<T>(p: Promise<T>, deadline: number): Promise<T | typeof LATE> {
  return new Promise<T | typeof LATE>((resolve, reject) => {
    const timer = setTimeout(() => resolve(LATE), Math.max(0, deadline - Date.now()));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
