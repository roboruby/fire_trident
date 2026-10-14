import type { CheckResult, Evidence, FileVersion, Id, Path, PrelandRun, Proposal, Sha } from "@fire_trident/core";
import { globMatch, revalidationEnabled } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { bindingReader, contentsReader, textOf, type InnateFile } from "../colony/innate.ts";
import type { GateVerdict } from "../decide/gate.ts";
import { CallLimiter } from "../decide/limiter.ts";
import { normalizeGlob } from "../decide/policy.ts";
import { sha256Hex } from "../trunk/digest.ts";
import { RUN_DEPENDENT, fileKeyText, type FileResult } from "./cache.ts";
import { MODULE_FILE } from "./compile.ts";
import { DEFAULT_CAPS, load, type CompileMemo, type IndexedFile, type Loaded } from "./load.ts";
import { RUNNER_VERSION, buildPlan, closureOf, type Plan } from "./plan.ts";
import { testName, type RunReport } from "./report.ts";

/**
 * Tests before landing (FT_PRELAND). Trunk certification runs the colony's tests after landing, by choice: no landing
 * waits for a test run. Where a colony asks for it, the decide stage also runs, before the gate and never inside the
 * trunk writer's cycle, the few test files a change reaches: the change's files are laid over the trunk index at its
 * base (an inline change's texts from the colony, any other's from its workspace), the test files whose import closure
 * holds a file the change writes, adds or deletes are chosen (nearest first, at most PRELAND_FILES), and they run in the
 * Dynamic Worker certification uses (no network, no env, CPU and wall-clock limits).
 *
 * Each file is judged against certification's own result for it on trunk without the change: the result stored under
 * the key of what that file reaches at the base (cache.ts), so the only difference between the two runs is the change.
 * A test that passed there and fails with the change sends the change back to its agent, naming the test and its error.
 * A test that did not pass there (it failed too, or it is new) is not held against the change. A test file with no such
 * result (certification has not run it on that tree) is not run.
 *
 * It fails open: a time-out (PRELAND_MS), a runner problem, no trunk result to compare with, or PRELAND_CONCURRENCY
 * checks already running in the colony (after waiting PRELAND_WAIT_MS for one to end) let the change go on as it would
 * without the check, recorded as not checked with the reason. The evidence and the lineage note keep the run. Landing
 * still validates the change's reads: a change tested on its base can still go stale, and certification still runs after
 * it lands.
 */

/** Test files one check runs at most. */
export const PRELAND_FILES = 5;
/** Wall time of one check, from its start to its verdict: past it the change goes on, not checked. */
export const PRELAND_MS = 2_000;
/** Checks running at once in one colony, and how long another waits for one of them to end before it goes on, not checked. */
export const PRELAND_CONCURRENCY = 3;
export const PRELAND_WAIT_MS = 1_000;
/** The check's name in a change's evidence. */
export const PRELAND_CHECK = "tests before landing";
/** The rule a change sent back by its tests is returned under (the gate's verdict and the "gate" check name it). */
export const PRELAND_RULE = "T1 tests before landing";
/** The most globs a colony's prelandPaths keeps, and the longest glob. */
export const MAX_PRELAND_PATHS = 50;
const MAX_GLOB_CHARS = 300;
/** Paths read at the change's base at most, when trunk moved after it. */
const BASE_PATHS = 3_000;
/** Below this much time left, the test Worker is not started. */
const MIN_RUN_MS = 250;
/** Broken tests a run lists, the ones a reason names, and the length of each name and error there. */
const BROKE_LISTED = 5;
const REASON_LISTED = 3;
const NAME_CHARS = 160;
const ERROR_CHARS = 300;
/** As certification: above this many characters of modules, test files share one module copy. */
const ISOLATE_MAX_CHARS = 6 * 1024 * 1024;

/** Is FT_PRELAND on for this colony? Read like FT_REVALIDATE: "on", a comma-separated list of colony ids, or absent / "off". */
export function prelandEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** A certify policy's prelandPaths, trimmed and each once, or why they cannot be set (a sentence). An empty list means every change. */
export function prelandGlobs(v: unknown): string[] | string {
  if (!Array.isArray(v)) return "prelandPaths must be a list of globs";
  if (v.length > MAX_PRELAND_PATHS) return `prelandPaths takes at most ${MAX_PRELAND_PATHS} globs, got ${v.length}`;
  const out: string[] = [];
  for (const g of v) {
    if (typeof g !== "string") return "each entry of prelandPaths must be a glob (a string)";
    const glob = normalizeGlob(g);
    if (glob === "") return "a glob in prelandPaths cannot be empty";
    if (glob.length > MAX_GLOB_CHARS) return `a glob in prelandPaths has at most ${MAX_GLOB_CHARS} characters`;
    if (/[\x00-\x1f\x7f]/.test(glob)) return "a glob in prelandPaths is one line of text";
    if (!out.includes(glob)) out.push(glob);
  }
  return out;
}

/** Does `glob` cover `path`: match it, or match a directory it is under ("src/api" covers src/api/links.ts), as protected paths read globs? */
function covers(glob: string, path: Path): boolean {
  if (globMatch(glob, path)) return true;
  for (let k = path.indexOf("/"); k !== -1; k = path.indexOf("/", k + 1)) if (globMatch(glob, path.slice(0, k))) return true;
  return false;
}

/** Do tests before landing cover a change that writes `paths`: one of them under one of `globs`, or any change when there are none? */
export function prelandMatches(globs: readonly string[] | undefined, paths: readonly Path[]): boolean {
  if (paths.length === 0) return false;
  if (!globs || globs.length === 0) return true;
  return paths.some((path) => globs.some((g) => covers(g, path)));
}

/** Files a test run may load, as the trunk index lists them for certification (TrunkDO.certifySnapshot). */
function loadable(path: Path): boolean {
  return MODULE_FILE.test(path) && !/(^|\/)node_modules\//.test(path) && !/(^|\/)\./.test(path);
}

// ---------------------------------------------------------------------------
// Choosing the test files (pure)

/**
 * The test files that reach a change, nearest first: each runs on trunk at the base and with the change, and its import
 * closure holds a path the change writes (`changed`, deletions included) in either. Nearness is the place of the first
 * changed path in the closure (the file itself first, then what it imports, level by level); ties go by path.
 */
export function reachingTests(base: Pick<Loaded, "tests" | "modules">, after: Pick<Loaded, "tests" | "modules">, changed: ReadonlySet<Path>): Path[] {
  const runs = new Set(after.tests);
  const found: Array<{ path: Path; at: number }> = [];
  for (const test of base.tests) {
    if (!runs.has(test)) continue;
    const at = [closureOf(test, after.modules), closureOf(test, base.modules)].map((c) => c.findIndex((p) => changed.has(p))).filter((i) => i >= 0);
    if (at.length > 0) found.push({ path: test, at: Math.min(...at) });
  }
  return found.sort((a, b) => a.at - b.at || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => f.path);
}

// ---------------------------------------------------------------------------
// Judging a run (pure)

/** A test that passed on trunk and failed with the change; `name` is the file's own path when the file failed to load. */
export interface BrokenTest {
  file: Path;
  name: string;
  error?: string;
}

/** What a run with the change says against trunk's results for the same files. */
export interface Judgment {
  tests: number;
  passed: number;
  failed: number;
  /** Failing tests that did not pass on trunk (they failed there too, or are new): not held against the change. */
  known: number;
  broke: BrokenTest[];
  /** Files whose results depended on the run, not the code (it ran out of time, a runner could not start), or that it did not report. */
  unjudged: Path[];
}

/** Statuses that are not a failure: any other (fail, cancelled, one the runner does not name) is. */
const NOT_FAILING = new Set(["pass", "skipped", "todo"]);

/** Text from the repository on one line, cut to `n` characters. */
function oneLine(s: unknown, n: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/**
 * Judge each file of a run with the change against trunk's result for it. A failing or cancelled test that passed on
 * trunk is broken; any other failing test is known. A file that fails to load with the change is broken when it loaded
 * on trunk and passed a test there, and counts as one failing test either way (as certification counts it). A file
 * whose result depended on the run itself is left unjudged.
 */
export function judgeRun(report: RunReport, files: readonly Path[], trunk: ReadonlyMap<Path, FileResult>): Judgment {
  const out: Judgment = { tests: 0, passed: 0, failed: 0, known: 0, broke: [], unjudged: [] };
  for (const file of files) {
    const meta = (Array.isArray(report.files) ? report.files : []).find((f) => f && f.path === file);
    const tests = (Array.isArray(report.tests) ? report.tests : []).filter((t) => t && t.file === file);
    const suites = (Array.isArray(report.suites) ? report.suites : []).filter((s) => s && s.file === file);
    const dependent =
      tests.some((t) => RUN_DEPENDENT.test(t.error ?? "")) || suites.some((s) => RUN_DEPENDENT.test(s.error ?? "")) || RUN_DEPENDENT.test(meta?.loadError ?? "");
    if (!meta || dependent) {
      out.unjudged.push(file);
      continue;
    }
    const before = trunk.get(file);
    const passedOnTrunk = new Set((before?.tests ?? []).filter((t) => t.status === "pass").map((t) => t.name));
    for (const t of tests) {
      out.tests++;
      if (t.status === "pass") out.passed++;
      if (NOT_FAILING.has(t.status)) continue;
      out.failed++;
      if (passedOnTrunk.has(t.name)) out.broke.push({ file, name: t.name, ...(t.error ? { error: t.error } : {}) });
      else out.known++;
    }
    if (meta.loadError && !tests.some((t) => !NOT_FAILING.has(t.status))) {
      out.tests++;
      out.failed++;
      if (before && before.loadError === null && passedOnTrunk.size > 0) out.broke.push({ file, name: file, error: String(meta.loadError) });
      else out.known++;
    }
  }
  return out;
}

/** How a broken test reads in a sentence: `the test "subtracts" in test/math.test.ts`, or the file that no longer loads. */
function brokenLabel(b: BrokenTest): string {
  return b.name === b.file ? `the test file ${oneLine(b.file, NAME_CHARS)} (it loaded on trunk and fails to load)` : `the test "${oneLine(b.name, NAME_CHARS)}" in ${oneLine(b.file, NAME_CHARS)}`;
}

/** What a change's agent reads when its tests sent it back: the tests that broke, their errors, and what to do next. */
export function prelandReason(broke: readonly BrokenTest[]): string {
  const err = (b: BrokenTest): string => (b.error ? `: ${oneLine(b.error, ERROR_CHARS)}` : "");
  if (broke.length === 1) {
    const b = broke[0]!;
    return `Tests before landing: ${brokenLabel(b)} passed on trunk and fails with this change${err(b)}. Fix the change so it passes again (the test is the specification), then propose again.`;
  }
  const named = broke.slice(0, REASON_LISTED).map((b) => `${brokenLabel(b)}${err(b)}`);
  const more = broke.length > REASON_LISTED ? `; and ${broke.length - REASON_LISTED} more` : "";
  return `Tests before landing: ${broke.length} tests that passed on trunk fail with this change: ${named.join("; ")}${more}. Fix the change so they pass again (the tests are the specification), then propose again.`;
}

/** "1 test file", "3 test files". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The evidence check for a run: its outcome in one line (the Why tab shows it, the review card on hover). */
export function prelandCheck(run: PrelandRun, reason?: string): CheckResult {
  let detail: string;
  if (run.status === "unchecked") detail = `not checked: ${run.reason ?? "no reason recorded"}`;
  else if (run.status === "failed") detail = reason ?? `${plural(run.broke?.length ?? 0, "test")} that passed on trunk failed with the change`;
  else {
    const parts = [`${plural(run.files.length, "test file")} that reach the change ran on its base with it: ${run.passed} of ${plural(run.tests, "test")} passed`];
    if ((run.known ?? 0) > 0) parts.push(`${plural(run.known!, "failing test")} did not pass on trunk either, so not held against it`);
    if ((run.reached ?? 0) > run.files.length) parts.push(`${plural(run.reached! - run.files.length, "more test file")} reach it, left to certification after landing`);
    if (run.reason) parts.push(run.reason);
    detail = parts.join("; ");
  }
  return { name: PRELAND_CHECK, ok: run.status !== "failed", ms: run.ms, detail: detail.slice(0, 1_000) };
}

// ---------------------------------------------------------------------------
// Running a check

/** What the check needs from the trunk writer (TrunkDO; the certifier's trunk). */
export interface PrelandTrunk {
  certifySnapshot(p?: { maxFiles?: number }): Promise<{ trunkSha: Sha; files: IndexedFile[]; truncated: boolean }>;
  readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>>;
  baseBlobs?(baseSha: Sha, paths: Path[]): Promise<FileVersion[]>;
}

/** Reads a change's new blobs as text (its inline contents, or its workspace): null for a blob that cannot be read as text. */
export type PrelandReader = (blobs: Sha[]) => Promise<Map<Sha, string | null>>;

/** What one colony's checks use of its certifier. */
export interface PrelandHost {
  trunk(): PrelandTrunk;
  /** Compiled modules by path and blob, shared with certification (a check then compiles little more than the change). */
  memo: CompileMemo;
  /** Run one plan in certification's test Worker (no network, CPU and wall-clock limits) within `timeoutMs`. */
  run(plan: Plan, timeoutMs: number): Promise<RunReport>;
  /** Certification's stored results for test files, by the key of what each reaches (cache.ts): exact matches only. */
  results(keys: ReadonlyMap<Path, string>): Map<Path, FileResult>;
  /** The colony's per-test limit (its certification policy), part of each file's key. */
  testTimeoutMs(): number;
  now?(): number;
}

/** One check's outcome: the run as recorded, its evidence check, and, when it failed, the sentence the change's agent reads. */
export interface PrelandOutcome {
  run: PrelandRun;
  check: CheckResult;
  reason?: string;
}

/** A check's verdict before its time is known (check() adds it). */
type Verdict = Omit<PrelandRun, "ms">;

const LATE = new Error("late");

/** `p`, or a rejection with `error` once `ms` pass first. */
function withTimeout<T>(p: Promise<T>, ms: number, error: Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error), Math.max(0, ms));
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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function unchecked(reason: string, trunkSha?: Sha): Verdict {
  return { status: "unchecked", ...(trunkSha ? { trunkSha } : {}), files: [], tests: 0, passed: 0, failed: 0, reason };
}

/** One colony's tests before landing (see the module comment): at most PRELAND_CONCURRENCY run at once. */
export class PrelandChecks {
  /** Admission: the same limiter the decide stage puts model calls behind, with no rate cap. */
  private readonly limiter: CallLimiter;

  constructor(private readonly host: PrelandHost) {
    this.limiter = new CallLimiter(PRELAND_CONCURRENCY, Number.MAX_SAFE_INTEGER, () => this.now());
  }

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  /** Checks running now. */
  get running(): number {
    return this.limiter.active;
  }

  /** Check one change (see the module comment). Never throws: every problem lets the change go on, not checked. */
  async check(p: Proposal, readNew: PrelandReader): Promise<PrelandOutcome> {
    const start = this.now();
    const finish = (v: Verdict): PrelandOutcome => {
      const run: PrelandRun = { ...v, ms: Math.max(0, Math.round(this.now() - start)) };
      const reason = run.status === "failed" ? prelandReason(run.broke ?? []) : undefined;
      return { run, check: prelandCheck(run, reason), ...(reason ? { reason } : {}) };
    };
    const release = await this.limiter.acquire("preland", start + PRELAND_WAIT_MS);
    if (!release) return finish(unchecked(`busy: ${PRELAND_CONCURRENCY} test runs before landing were already going in this colony`));
    const work = this.checkNow(p, readNew, this.now() + PRELAND_MS);
    // The slot is held until the work ends, even past the time-out, so no more than PRELAND_CONCURRENCY run at once.
    work.then(release, release);
    try {
      return finish(await withTimeout(work, PRELAND_MS + 250, LATE));
    } catch (err) {
      // The test Worker's own limit (certifier.run) is this check's time too.
      if (err === LATE || /exceeded its \d+ s limit|CPU|ran out of time/i.test(errorText(err))) return finish(unchecked(`the tests took longer than ${PRELAND_MS / 1000} s`));
      return finish(unchecked(`the test run failed: ${oneLine(errorText(err), 200).replace(/[.\s]+$/, "")}`));
    }
  }

  /** The check itself, within `deadline`. Throws on a trunk, read or runner problem (check() records it as not checked). */
  private async checkNow(p: Proposal, readNew: PrelandReader, deadline: number): Promise<Verdict> {
    const host = this.host;
    const writes = (Array.isArray(p.writeSet) ? p.writeSet : []).filter((w) => w && typeof w.path === "string" && loadable(w.path));
    if (writes.length === 0) return unchecked("it changes no file a test can load");
    const trunk = host.trunk();
    const snap = await trunk.certifySnapshot({});
    const at = p.baseSha;
    // The trunk index at the change's base: the current one, or (trunk moved after it) each listed path read there.
    let index: IndexedFile[];
    if (at === snap.trunkSha) {
      index = snap.files;
    } else {
      if (!trunk.baseBlobs) return unchecked("the trunk writer cannot read older commits yet", at);
      const listed = new Map(snap.files.map((f) => [f.path, f]));
      const paths = [...new Set([...listed.keys(), ...writes.map((w) => w.path)])];
      if (paths.length > BASE_PATHS) return unchecked(`trunk moved since its base, and its ${paths.length} files are too many to read there`, at);
      const versions = await trunk.baseBlobs(at, paths);
      index = [];
      for (const v of Array.isArray(versions) ? versions : []) {
        if (!v || typeof v.path !== "string" || typeof v.blob !== "string" || v.blob === "") continue;
        const now = listed.get(v.path);
        index.push({ path: v.path, blob: v.blob, size: now && now.blob === v.blob ? now.size : 0 });
      }
      if (index.length === 0 && snap.files.length > 0) return unchecked(`its base commit ${at.slice(0, 7)} could not be read`, at);
    }

    // The change's own texts, then the index with its files laid over it.
    const wanted = [...new Set(writes.flatMap((w) => (w.blob === null ? [] : [w.blob])))];
    const texts = wanted.length > 0 ? await readNew(wanted) : new Map<Sha, string | null>();
    const own = new Map<Sha, string>();
    const overlay = new Map(index.map((f) => [f.path, f]));
    for (const w of writes) {
      if (w.blob === null) {
        overlay.delete(w.path);
        continue;
      }
      const text = texts.get(w.blob);
      if (typeof text !== "string") return unchecked(`${w.path} could not be read from the change as text`, at);
      own.set(w.blob, text);
      overlay.set(w.path, { path: w.path, blob: w.blob, size: new TextEncoder().encode(text).length });
    }
    const fromTrunk = (blobs: Sha[]): Promise<Record<Sha, string | null>> => trunk.readBlobs(blobs);
    const withChange = async (blobs: Sha[]): Promise<Record<Sha, string | null>> => {
      const rest = blobs.filter((b) => !own.has(b));
      const out: Record<Sha, string | null> = rest.length > 0 ? { ...(await trunk.readBlobs(rest)) } : {};
      for (const b of blobs) if (own.has(b)) out[b] = own.get(b)!;
      return out;
    };
    const before = await load(index, fromTrunk, DEFAULT_CAPS, host.memo);
    const after = await load([...overlay.values()], withChange, DEFAULT_CAPS, host.memo);

    // The test files that reach the change, and trunk's result for each as it is at the base.
    const reached = reachingTests(before, after, new Set(writes.map((w) => w.path)));
    if (reached.length === 0) return unchecked("no test file on trunk reaches the files it changes", at);
    const keys = new Map<Path, string>();
    for (const t of reached) keys.set(t, await sha256Hex(fileKeyText(t, closureOf(t, before.modules), before.blobs, RUNNER_VERSION, host.testTimeoutMs())));
    const onTrunk = host.results(keys);
    const files = reached.filter((t) => onTrunk.has(t)).slice(0, PRELAND_FILES);
    const reach = reached.length > files.length ? { reached: reached.length } : {};
    if (files.length === 0) {
      return unchecked(`no trunk result to compare with: certification has not run the ${plural(reached.length, "test file")} that reach it on its base yet`, at);
    }

    // Run them with the change, in certification's sandbox.
    const left = deadline - this.now();
    if (left < MIN_RUN_MS) throw LATE;
    const config = { testTimeoutMs: host.testTimeoutMs(), budgetMs: Math.max(MIN_RUN_MS, left - 200) };
    let plan = buildPlan({ tests: files, modules: after.modules, config });
    if (plan.bytes > ISOLATE_MAX_CHARS) plan = buildPlan({ tests: files, modules: after.modules, config, isolate: false });
    const report = await host.run(plan, left);
    const j = judgeRun(report, files, onTrunk);
    const counted = { trunkSha: at, files, ...reach, tests: j.tests, passed: j.passed, failed: j.failed, ...(j.known > 0 ? { known: j.known } : {}) };
    if (j.broke.length > 0) {
      const broke = j.broke.slice(0, BROKE_LISTED).map((b) => ({ file: b.file, name: testName(b.name), ...(b.error ? { error: oneLine(b.error, ERROR_CHARS) } : {}) }));
      return { status: "failed", ...counted, broke };
    }
    if (j.unjudged.length === files.length) return unchecked(`the tests ran out of time or the runner could not start them (${plural(files.length, "test file")})`, at);
    const partial = j.unjudged.length > 0 ? { reason: `${plural(j.unjudged.length, "test file")} ran out of time or could not start, so ${j.unjudged.length === 1 ? "it was" : "they were"} not checked` } : {};
    return { status: "passed", ...counted, ...partial };
  }
}

// ---------------------------------------------------------------------------
// The decide stage's side

/** The texts the innate checks already read for a change (its new blob ids to their text), so a check reads none again. */
export function prelandTexts(files: readonly InnateFile[]): Map<Sha, string> {
  const out = new Map<Sha, string>();
  for (const f of files) if (f.afterBlob !== null && typeof f.after === "string") out.set(f.afterBlob, f.after);
  return out;
}

/**
 * Reads a change's new blobs as text: the ones already read (`texts`), then an inline change's from its contents, any
 * other's from its workspace through the binding. Binary and oversized files read as null, as the innate checks read them.
 */
export function prelandReader(env: Env, p: Proposal, texts?: ReadonlyMap<Sha, string>): PrelandReader {
  const inline = p.contents && typeof p.contents === "object" ? p.contents : null;
  const read = inline ? contentsReader(inline) : bindingReader(env);
  return async (blobs) => {
    const out = new Map<Sha, string | null>();
    const missing: Sha[] = [];
    for (const b of blobs) {
      const known = texts?.get(b);
      if (typeof known === "string") out.set(b, known);
      else missing.push(b);
    }
    if (missing.length > 0) {
      const bytes = await read(p.workspace, missing);
      for (const b of missing) out.set(b, textOf(bytes.get(b) ?? null).text);
    }
    return out;
  };
}

/**
 * The gate's verdict for a change its tests sent back: a deterministic return under PRELAND_RULE whose reason is the
 * sentence its agent reads. Damage, confidence and risk stay as the deterministic stage found them.
 */
export function prelandReturn(reason: string, was: GateVerdict): GateVerdict {
  return { action: "return", layer: "deterministic", p: 1, rule: PRELAND_RULE, reasons: [reason], detectors: [], damage: was.damage, confirmations: [], confidence: was.confidence, risk: was.risk };
}

/** Evidence with a check added: its check among the checks, its run as `preland`. */
export function withPreland(evidence: Evidence | undefined, out: PrelandOutcome): Evidence {
  const e: Evidence = evidence ?? { checks: [] };
  return { ...e, checks: [...(Array.isArray(e.checks) ? e.checks : []), out.check], preland: out.run };
}

/** What a change on the decide path with review off needs of its colony (the decide stage's host has all of it). */
export interface PrelandDecideHost {
  proposal(id: Id): Proposal | null;
  updateProposals(items: Array<{ id: Id; patch: Partial<Proposal> }>): Promise<void>;
  preland?(p: Proposal, texts?: ReadonlyMap<Sha, string>): Promise<PrelandOutcome | null>;
}

/**
 * Review off: a change that took the decide path only for its tests runs them, then goes where review off sends every
 * change (its lane), or back to its agent when a test that passed on trunk fails with it. Nothing else is checked, as
 * with review off.
 */
export async function prelandAlone(host: PrelandDecideHost, p: Proposal): Promise<void> {
  const out = host.preland ? await host.preland(p) : null;
  const cur = host.proposal(p.id);
  if (!cur || cur.status !== "checking") return;
  if (cur.headSha !== p.headSha || JSON.stringify(cur.writeSet) !== JSON.stringify(p.writeSet)) {
    await host.updateProposals([{ id: p.id, patch: { status: "returned", reason: "head commit changed while its tests ran before landing; propose again" } }]);
    return;
  }
  const evidence = out ? withPreland(cur.evidence, out) : cur.evidence;
  if (out?.run.status === "failed") await host.updateProposals([{ id: p.id, patch: { status: "returned", reason: out.reason ?? out.check.detail ?? "a test failed before landing", evidence } }]);
  else await host.updateProposals([{ id: p.id, patch: { status: "ready", evidence } }]);
}
