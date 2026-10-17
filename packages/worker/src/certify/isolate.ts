import type { FileVersion, FirstRedIsolation, Id, IsolationRun, Path, Sha, Suspect } from "@fire_trident/core";
import type { ProbeOutcome, Target } from "./bisect.ts";
import type { RangeLanding } from "./range.ts";
import { testName, type RunReport } from "./report.ts";

/**
 * Proposal isolation inside the first red landing (FT_BISECT, with the first red search). The trunk writer lands a lane
 * batch of proposals as one commit (group commit takes up to 200 proposals a cycle), and the first red search stops at
 * that commit. A batch's proposals write disjoint files and none reads what another writes (trunk/plan.ts), so each can
 * be taken out of the commit by putting its files back as the commit's parent had them. Only proposals whose write sets
 * meet what the failing test files load (the search's closure) can change what those tests run; the others are not run.
 *
 * Once the search named a landing with more than one proposal (and its landing-level answer is recorded), the tests that
 * failed there run in the same sealed Dynamic Worker as the search (bisect.ts probeAt):
 *
 * 1. Halving, before anyone is excluded: the landing with only the first half of those proposals (the rest put back),
 *    then only the second half. Both pass: the proposals break the tests only together (an interaction), and no single
 *    proposal is named. Both fail: more than one proposal breaks them. One fails: the culprit is in it, and when that half
 *    is still larger than leave-one-out can try, one more run halves it again (at most HALF_RUNS runs).
 * 2. Leave one out: the landing without one candidate at a time (at most WITHOUT_MAX). A candidate is accepted only when
 *    the failing tests pass without it AND every other test in their files keeps its outcome and no file fails to load.
 *    Exactly one accepted is the culprit; several accepted break the tests together; none is no single proposal.
 * 3. Revert probe: the red commit's failing test files with the culprit's files put back as the landing's parent had
 *    them, which is what `ft revert <prp>` writes (and only when trunk still holds what the landing wrote there, as it
 *    requires). Every test in those files passing means causal; anything else says it was not shown causal, and the
 *    revert suggestion is shown as proven only when causal.
 *
 * Bounded: ISOLATE_RUNS runs in all per red result, RUN_MS each and ISOLATE_MS in all. It fails open: a run that fails or
 * times out, a commit or note that cannot be read, or the bounds running out leave the landing-level answer as it was,
 * with the isolation `inconclusive` (or `none` with what was not tried) and the reason.
 */

/** Runs per red result at most: three halvings, six without one proposal, one revert probe. */
export const ISOLATE_RUNS = 10;
/** Halving runs at most, and proposals tried one at a time at most. */
export const HALF_RUNS = 3;
export const WITHOUT_MAX = 6;
/** Wall time of the whole isolation, and of one run (as the first red search's tries). */
export const ISOLATE_MS = 60_000;
export const RUN_MS = 20_000;
/** Below this much time left, no further run starts. */
const MIN_RUN_MS = 1_000;
/** Files of the candidate proposals read at most (the landing, its parent and the red commit each once). */
const ISOLATE_PATHS = 2_000;
/** Paths read on both the landing and its parent to check the parent was read (closure files no proposal wrote). */
const PARENT_CHECKS = 8;
/** Proposal ids a half or a run lists, and paths a culprit lists. */
const LISTED_IDS = 20;
const LISTED_PATHS = 10;

/** A proposal of the landing as its lineage note names it. */
interface NoteProposal {
  id: Id;
  intentId?: Id;
  title?: string;
  agentId?: Id;
  paths: Path[];
}

/** A lineage note's proposals (written by the trunk writer; checked, as stored data from older code may differ), or null when it lists none. */
function proposalsOf(note: unknown): NoteProposal[] | null {
  const list = note && typeof note === "object" ? (note as { proposals?: unknown }).proposals : null;
  if (!Array.isArray(list)) return null;
  return list.flatMap((raw) => {
    const p = (raw ?? {}) as { id?: unknown; agentId?: unknown; intent?: { id?: unknown; title?: unknown }; writeSet?: unknown };
    if (typeof p.id !== "string" || p.id === "") return [];
    const out: NoteProposal = { id: p.id, paths: [] };
    if (typeof p.intent?.id === "string" && p.intent.id) out.intentId = p.intent.id;
    if (typeof p.intent?.title === "string" && p.intent.title) out.title = oneLine(p.intent.title, 200);
    if (typeof p.agentId === "string" && p.agentId) out.agentId = p.agentId;
    const paths = Array.isArray(p.writeSet) ? p.writeSet.flatMap((w: unknown) => (w && typeof (w as { path?: unknown }).path === "string" ? [(w as { path: Path }).path] : [])) : [];
    out.paths = [...new Set(paths)];
    return [out];
  });
}

/** How many proposals the landing carries: its lineage note's, else its record's (isolation is for more than one). */
export function proposalCount(note: unknown, proposalIds: readonly unknown[] | undefined): number {
  const props = proposalsOf(note);
  if (props !== null) return props.length;
  return Array.isArray(proposalIds) ? proposalIds.filter((id) => typeof id === "string" && id !== "").length : 0;
}

// ---------------------------------------------------------------------------
// Outcomes of one run

/**
 * Every test of `files` in a report by "file NUL name" (as the red result names tests), with its status; a file that did
 * not load is named after itself with "load-error", and a suite that failed on its own carries " (suite)" and "fail".
 * Tests that share a name keep their statuses together ("pass,fail").
 */
export function outcomesOf(report: RunReport, files: ReadonlySet<Path>): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, status: string): void => {
    out[key] = out[key] === undefined ? status : `${out[key]},${status}`;
  };
  for (const t of Array.isArray(report.tests) ? report.tests : []) if (t && files.has(t.file)) add(`${t.file}\u0000${testName(t.name)}`, String(t.status));
  for (const f of Array.isArray(report.files) ? report.files : []) if (f && files.has(f.path) && f.loadError) add(`${f.path}\u0000${testName(f.path)}`, "load-error");
  for (const s of Array.isArray(report.suites) ? report.suites : []) if (s && files.has(s.file) && s.status === "fail" && s.error) add(`${s.file}\u0000${testName(s.name)} (suite)`, "fail");
  return out;
}

/** Does a status (or several, joined) count as failing: anything but pass, skipped and todo. */
function failing(status: string | undefined): boolean {
  return status !== undefined && status.split(",").some((s) => s !== "pass" && s !== "skipped" && s !== "todo");
}

function passed(status: string | undefined): boolean {
  return status !== undefined && status.split(",").every((s) => s === "pass");
}

const fileOf = (key: string): Path => key.slice(0, key.indexOf("\u0000"));
const keyOf = (t: Target): string => `${t.file}\u0000${t.name}`;

/**
 * A run without one proposal against the landing's own run: `red` while a failing test still fails, `changed` when they
 * pass but another test of their files changed its outcome or a file did not load, `green` otherwise. A test missing
 * from the run is fine only in a file the left-out proposal wrote (it added the test) or for a file that did not load
 * before (it loads now).
 */
export function judgeWithout(baseline: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>, targets: ReadonlySet<string>, wrote: ReadonlySet<Path>): Pick<IsolationRun, "outcome" | "detail"> {
  let still = 0;
  let changed = 0;
  for (const k of targets) {
    const v = after[k];
    if (v === undefined) {
      if (baseline[k] !== "load-error" && !wrote.has(fileOf(k))) changed++;
    } else if (failing(v)) still++;
    else if (!passed(v)) changed++;
  }
  for (const [k, was] of Object.entries(baseline)) {
    if (targets.has(k)) continue;
    const v = after[k];
    if (v === undefined ? !wrote.has(fileOf(k)) : v !== was) changed++;
  }
  for (const [k, v] of Object.entries(after)) if (!targets.has(k) && (v.split(",").includes("load-error") || (baseline[k] === undefined && failing(v)))) changed++;
  if (still > 0) return { outcome: "red", detail: `${plural(still, "failing test")} still ${still === 1 ? "fails" : "fail"}` };
  if (changed > 0) return { outcome: "changed", detail: `the failing tests passed, but ${plural(changed, "other test")} changed ${changed === 1 ? "its" : "their"} outcome or a file did not load` };
  return { outcome: "green", detail: "the failing tests passed and every other test in their files kept its outcome" };
}

/** The revert probe's run: green only when every test of the failing files passed (at least one ran), and nothing failed or failed to load. */
export function judgeRevert(after: Readonly<Record<string, string>>): Pick<IsolationRun, "outcome" | "detail"> {
  const values = Object.values(after);
  const bad = values.filter((v) => failing(v)).length;
  if (bad > 0) return { outcome: "red", detail: `${plural(bad, "test")} of the failing files still ${bad === 1 ? "fails" : "fail"} with it reverted` };
  if (!values.some((v) => v.split(",").includes("pass"))) return { outcome: "changed", detail: "no test of the failing files ran with it reverted" };
  return { outcome: "green", detail: "every test of the failing files passed with it reverted" };
}

// ---------------------------------------------------------------------------
// The isolation

/** What isolateLanding needs: the search's commits and answer, two trunk reads and one sealed run. */
export interface IsolateInput {
  /** The first red commit (its landing), its parent commit (with its witness when it is a landing of the range), and the red result's commit. */
  landing: RangeLanding;
  parent: Pick<RangeLanding, "trunkSha" | "witness">;
  red: RangeLanding;
  /** The landing's lineage note (each proposal's write set, intent and agent). */
  note: unknown;
  /** What the failing test files load (the search's closure, the test files included). */
  closure: ReadonlySet<Path>;
  /** The red result's failing tests the search followed. */
  targets: readonly Target[];
  /** The search's run on the landing, with every outcome of the target files (`tests`). */
  first: ProbeOutcome;
  /** Blobs of paths at a commit (TrunkDO.baseBlobs). */
  read(sha: Sha, paths: Path[]): Promise<FileVersion[]>;
  /** Run `targets`' files at `commit` with `over` laid on its files (null: absent) within `timeoutMs` (bisect.ts probeAt). */
  probe(commit: RangeLanding, over: ReadonlyMap<Path, Sha | null>, targets: readonly Target[], timeoutMs: number): Promise<ProbeOutcome>;
  maxRuns?: number;
  budgetMs?: number;
  runMs?: number;
  now?: () => number;
}

/** Blobs read at a commit by path, after its witness (a file its landing wrote), when it has one, was read back as written. */
async function blobsAt(s: IsolateInput, commit: Pick<RangeLanding, "trunkSha" | "witness">, paths: readonly Path[]): Promise<Map<Path, Sha | null>> {
  const witness = commit.witness;
  const ask = [...new Set([...(witness ? [witness.path] : []), ...paths])];
  const answer = await s.read(commit.trunkSha, ask);
  const at = new Map<Path, Sha | null>();
  for (const v of Array.isArray(answer) ? answer : []) if (v && typeof v.path === "string") at.set(v.path, typeof v.blob === "string" && v.blob !== "" ? v.blob : null);
  if (witness && at.get(witness.path) !== witness.blob) throw new Error(`could not read the commit ${commit.trunkSha.slice(0, 7)}`);
  return at;
}

/**
 * Isolate the proposal inside the first red landing that the failing tests fail with (see the module comment). Never
 * throws: anything that goes wrong is an `inconclusive` answer with the reason, and the landing-level answer stands.
 */
export async function isolateLanding(s: IsolateInput): Promise<FirstRedIsolation> {
  const now = s.now ?? Date.now;
  const start = now();
  const maxRuns = Math.max(0, Math.floor(s.maxRuns ?? ISOLATE_RUNS));
  const budgetMs = s.budgetMs ?? ISOLATE_MS;
  const runMs = s.runMs ?? RUN_MS;
  const runs: IsolationRun[] = [];
  let probes = 0;
  let candidates = 0;
  const answer = (status: FirstRedIsolation["status"], reason: string, extra: Partial<FirstRedIsolation> = {}): FirstRedIsolation => ({
    status,
    reason,
    ...extra,
    runs,
    candidates,
    probes,
    ms: Math.max(0, now() - start),
  });
  const stopped = (why: string, extra: Partial<FirstRedIsolation> = {}): FirstRedIsolation => answer("inconclusive", `Isolating a proposal stopped: ${why.replace(/[.\s]+$/, "")}. The landing-level answer stands.`, extra);
  try {
    const props = proposalsOf(s.note);
    if (props === null) return stopped(`the lineage note of landing ${s.landing.landingId} could not be read, so which files each of its proposals wrote is unknown`);
    const meets = props.filter((p) => p.paths.some((path) => s.closure.has(path)));
    candidates = meets.length;
    if (meets.length === 0) return answer("none", `None of its ${plural(props.length, "proposal")} changed a file the failing tests load, so leaving one out changes nothing they run.`);

    // The tests that failed at the landing, and every outcome of their files there (the search's own run).
    const before = s.first.tests;
    if (!before) return stopped("the run on the first failing commit kept no outcome per test");
    const failed = s.targets.filter((t) => failing(before[keyOf(t)]));
    if (failed.length === 0) return stopped("no failing test failed in the run on the first failing commit");
    const files = new Set(failed.map((t) => t.file));
    const baseline = Object.fromEntries(Object.entries(before).filter(([k]) => files.has(fileOf(k))));
    const targetKeys = new Set(failed.map(keyOf));

    // What each candidate wrote, on the landing and on its parent; closure files no proposal wrote check the parent was read.
    const written = [...new Set(meets.flatMap((p) => p.paths))];
    if (written.length > ISOLATE_PATHS) return stopped(`its proposals wrote ${written.length} files, more than the ${ISOLATE_PATHS} it reads`);
    const anyWrote = new Set(props.flatMap((p) => p.paths));
    const checks = [...s.closure].filter((p) => !anyWrote.has(p)).slice(0, PARENT_CHECKS);
    const onLanding = await blobsAt(s, s.landing, [...written, ...checks]);
    const onParent = await blobsAt(s, s.parent, [...written, ...checks]);
    if (checks.some((p) => (onLanding.get(p) ?? null) !== null && onParent.get(p) !== onLanding.get(p))) return stopped(`the landing's parent commit ${s.parent.trunkSha.slice(0, 7)} could not be read`);
    /** The landing's files with these proposals' files put back as the parent had them. */
    const without = (out: readonly NoteProposal[]): Map<Path, Sha | null> => new Map(out.flatMap((p) => p.paths.map((path): [Path, Sha | null] => [path, onParent.get(path) ?? null])));

    // One run within the bounds: its outcome, or why it said nothing.
    const late = new Error("late");
    const run = async (commit: RangeLanding, over: ReadonlyMap<Path, Sha | null>, targets: readonly Target[]): Promise<ProbeOutcome | string> => {
      if (probes >= maxRuns) return `its ${plural(maxRuns, "run")} were used`;
      const left = budgetMs - (now() - start);
      if (left < MIN_RUN_MS) return `its ${Math.round(budgetMs / 1000)} s ran out after ${plural(probes, "run")}`;
      const ms = Math.min(runMs, left);
      probes++;
      try {
        return await withTimeout(Promise.resolve().then(() => s.probe(commit, over, targets, ms)), ms, late);
      } catch (err) {
        if (err === late) return `a run took longer than ${Math.round(ms / 100) / 10} s`;
        return `a run failed: ${clip(errorText(err), 200).replace(/[.\s]+$/, "")}`;
      }
    };
    const ids = (list: readonly NoteProposal[]): Id[] => list.slice(0, LISTED_IDS).map((p) => p.id);

    // 1. Halving, before anyone is excluded.
    let pool: NoteProposal[] = meets;
    let halves: Id[][] | undefined;
    let narrowed = "";
    if (meets.length >= 2) {
      const a = meets.slice(0, Math.ceil(meets.length / 2));
      const b = meets.slice(a.length);
      const ra = await run(s.landing, without(b), failed);
      if (typeof ra === "string") return stopped(ra);
      runs.push({ kind: "half", proposals: ids(a), outcome: ra.red ? "red" : "pass" });
      const rb = await run(s.landing, without(a), failed);
      if (typeof rb === "string") return stopped(rb);
      runs.push({ kind: "half", proposals: ids(b), outcome: rb.red ? "red" : "pass" });
      halves = [ids(a), ids(b)];
      if (!ra.red && !rb.red) {
        return answer("interaction", `Each half of the ${plural(meets.length, "proposal")} that changed what the failing tests load passed on its own (${listed(a)}; ${listed(b)}): they break the tests only together, so no single proposal is the cause.`, { halves });
      }
      if (ra.red && rb.red) {
        return answer("none", `Each half of the ${plural(meets.length, "proposal")} that changed what the failing tests load fails them on its own (${listed(a)}; ${listed(b)}): more than one proposal breaks them, so no single proposal is the cause.`, { halves });
      }
      pool = ra.red ? a : b;
      // Still more than leave-one-out can try: halve the failing half once more.
      if (pool.length > WITHOUT_MAX && runs.filter((r) => r.kind === "half").length < HALF_RUNS) {
        const a2 = pool.slice(0, Math.ceil(pool.length / 2));
        const r2 = await run(s.landing, without(meets.filter((p) => !a2.includes(p))), failed);
        if (typeof r2 === "string") return stopped(r2, { halves });
        runs.push({ kind: "half", proposals: ids(a2), outcome: r2.red ? "red" : "pass" });
        if (!r2.red) narrowed = ` The first part of the failing half passed alone, so the rest was tried (an interaction across them would look the same).`;
        pool = r2.red ? a2 : pool.slice(a2.length);
      }
    }

    // 2. Leave one out: the landing without one candidate at a time; one run stays for the revert probe.
    const accepted: NoteProposal[] = [];
    const tried: NoteProposal[] = [];
    let cut = "";
    for (const p of pool.slice(0, WITHOUT_MAX)) {
      if (maxRuns - probes <= 1) {
        cut = `its ${plural(maxRuns, "run")} allow no more`;
        break;
      }
      const r = await run(s.landing, without([p]), failed);
      if (typeof r === "string") return stopped(r, halves ? { halves } : {});
      tried.push(p);
      const verdict = judgeWithout(baseline, r.tests ?? {}, targetKeys, new Set(p.paths));
      runs.push({ kind: "without", proposals: [p.id], ...verdict });
      if (verdict.outcome === "green") accepted.push(p);
      // Two accepted already make it no single proposal: stop spending runs.
      if (accepted.length >= 2) break;
    }
    const untried = pool.filter((p) => !tried.includes(p)).map((p) => p.id);
    const rest = untried.length > 0 ? { untried: untried.slice(0, LISTED_IDS) } : {};
    const extra = { ...(halves ? { halves } : {}), ...rest };
    const notTried = untried.length > 0 ? ` ${listed(untried.map((id) => ({ id })))} ${untried.length === 1 ? "was" : "were"} not tried (${cut || `at most ${WITHOUT_MAX} are tried one at a time`}).` : "";
    if (accepted.length >= 2) {
      return answer("interaction", `Without any one of ${listed(accepted)} the failing tests pass: those proposals break them together, so no single proposal is the cause.${narrowed}`, { ...extra, together: accepted.map((p) => p.id) });
    }
    if (accepted.length === 0) {
      if (tried.length === 0) return stopped(cut || "no proposal could be tried", extra);
      return answer("none", `No single proposal: without each of ${listed(tried)} the failing tests still failed or another test changed its outcome.${notTried}${narrowed}`, extra);
    }

    // 3. The revert probe on the red commit, only where trunk still holds what the landing wrote (as ft revert requires).
    const culprit = accepted[0]!;
    const named: NonNullable<FirstRedIsolation["culprit"]> = { id: culprit.id, paths: culprit.paths.filter((p) => s.closure.has(p)).sort().slice(0, LISTED_PATHS) };
    if (culprit.intentId) named.intentId = culprit.intentId;
    if (culprit.title) named.title = culprit.title;
    if (culprit.agentId) named.agentId = culprit.agentId;
    const at = runs.findIndex((r) => r.kind === "without" && r.proposals[0] === culprit.id) + 1;
    const others = tried.length > 1 ? `, and without each of the other ${plural(tried.length - 1, "candidate")} they did not` : "";
    const evidence = `without it the failing tests pass and every other test in their files keeps its outcome (run ${at}${others})`;
    const isolated = (revert: NonNullable<FirstRedIsolation["revert"]>): FirstRedIsolation =>
      answer("isolated", `Proposal ${culprit.id} is the one inside the landing: ${evidence}; ${revert.reason}${notTried}${narrowed}`, { ...extra, culprit: named, revert });
    const red = s.red;
    const short = red.trunkSha.slice(0, 7);
    let onRed: Map<Path, Sha | null>;
    try {
      onRed = red.trunkSha === s.landing.trunkSha ? onLanding : await blobsAt(s, red, culprit.paths);
    } catch (err) {
      return isolated({ causal: false, reason: `not shown causal: the red commit ${short} could not be read (${clip(errorText(err), 120)}), so reverting it alone was not tried.`, trunkSha: red.trunkSha });
    }
    const moved = culprit.paths.filter((p) => (onRed.get(p) ?? null) !== (onLanding.get(p) ?? null));
    if (moved.length > 0) {
      return isolated({ causal: false, reason: `not shown causal: ${moved.slice(0, 3).join(", ")}${moved.length > 3 ? ` and ${moved.length - 3} more` : ""} changed again after the landing, so reverting it alone was not tried (ft revert would refuse it).`, trunkSha: red.trunkSha });
    }
    const r = await run(red, without([culprit]), s.targets);
    if (typeof r === "string") return isolated({ causal: false, reason: `not shown causal: ${r}, so reverting it alone was not tried.`, trunkSha: red.trunkSha });
    const verdict = judgeRevert(r.tests ?? {});
    runs.push({ kind: "revert", proposals: [culprit.id], ...verdict });
    if (verdict.outcome === "green") return isolated({ causal: true, reason: `causal: reverting it alone turns these tests green (on the red commit ${short}).`, trunkSha: red.trunkSha });
    return isolated({ causal: false, reason: `not shown causal: on the red commit ${short}, ${verdict.detail ?? "the failing files did not pass"}.`, trunkSha: red.trunkSha });
  } catch (err) {
    return stopped(clip(errorText(err), 200));
  }
}

// ---------------------------------------------------------------------------
// Where the answer shows

/** Is the isolated proposal's revert proven (the revert probe turned the failing tests green)? */
export function revertProven(iso: FirstRedIsolation | undefined | null): boolean {
  return !!iso && iso.status === "isolated" && !!iso.culprit && iso.revert?.causal === true;
}

/** One run as the evidence lists it: "half prp_a, prp_b: pass", "without prp_c: green", with its detail when `detail`. */
export function runText(r: IsolationRun, detail = true): string {
  const ids = Array.isArray(r.proposals) ? r.proposals.join(", ") : "";
  const who = r.kind === "half" ? `half ${ids}` : r.kind === "without" ? `without ${ids}` : `revert ${ids}`;
  return `${who}: ${r.outcome}${detail && r.detail ? ` (${r.detail})` : ""}`;
}

/**
 * The isolation's lines for the repair intent's first red block (fenced there: titles and paths are agents' and the
 * repository's text): the isolated proposal with its intent and agent, whether reverting it alone is proven, the runs.
 * A revert is suggested only when proven.
 */
export function isolationLines(iso: FirstRedIsolation | undefined, max = 400): string[] {
  if (!iso || typeof iso !== "object" || typeof iso.status !== "string") return [];
  const out: string[] = [];
  const c = iso.culprit;
  if (iso.status === "isolated" && c && typeof c.id === "string") {
    const intent = c.intentId ? ` for intent ${c.intentId}${c.title ? ` "${c.title}"` : ""}` : c.title ? ` "${c.title}"` : "";
    out.push(`- isolated: proposal ${c.id}${intent}${c.agentId ? ` by agent ${c.agentId}` : ""} changed ${(c.paths ?? []).join(", ")}; the failing tests pass without it and every other test in their files keeps its outcome`);
    if (revertProven(iso)) out.push(`- causal: reverting it alone turns these tests green; a person can undo it alone with ft revert <colony> ${c.id} (proven)`);
    else out.push(`- ${iso.revert?.reason ?? "not shown causal: reverting it alone was not tried"}`);
  } else if (iso.status === "inconclusive") out.push(`- isolating a proposal inside it was inconclusive: ${iso.reason}`);
  else out.push(`- no single proposal inside it: ${iso.reason}`);
  const runs = Array.isArray(iso.runs) ? iso.runs : [];
  if (runs.length > 0) out.push(`- runs: ${runs.map((r) => runText(r, false)).join("; ")}`);
  return out.map((l) => oneLine(l, max));
}

/**
 * A red result's suspects with the isolated proposal marked `isolated`: its own suspect when culprit finding listed it,
 * else a new one beside the landing's (culprit finding names a landing's proposals only when the colony knew one for the
 * paths). Suspects without the landing, or without isolation, are returned as they were.
 */
export function markIsolated<T extends Suspect>(suspects: readonly T[], landingId: Id, iso: FirstRedIsolation | undefined): T[] {
  const c = iso?.status === "isolated" ? iso.culprit : undefined;
  if (!c || typeof c.id !== "string") return [...suspects];
  const mark = (s: T): T => ({ ...s, labels: [...(Array.isArray(s.labels) ? s.labels : []).filter((l) => l !== "isolated"), ...(s.labels?.includes("first-red") ? [] : ["first-red" as const]), "isolated"] });
  if (suspects.some((s) => s && s.landingId === landingId && s.proposalId === c.id)) return suspects.map((s) => (s && s.landingId === landingId && s.proposalId === c.id ? mark(s) : s));
  const same = suspects.find((s) => s && s.landingId === landingId);
  if (!same) return [...suspects];
  const added = { landingId, at: same.at, paths: [...c.paths], files: [...same.files], proposalId: c.id, labels: ["first-red", "isolated"] } as Suspect as T;
  if (same.trunkSha) added.trunkSha = same.trunkSha;
  if (c.intentId) added.intentId = c.intentId;
  if (c.title) added.title = c.title;
  const at = suspects.indexOf(same);
  return [...suspects.slice(0, at), added, ...suspects.slice(at)];
}

// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Proposal ids joined ("prp_a, prp_b +3"). */
function listed(list: ReadonlyArray<{ id: Id }>, max = 4): string {
  const ids = list.map((p) => p.id);
  return ids.length > max ? `${ids.slice(0, max).join(", ")} +${ids.length - max}` : ids.join(", ");
}

function oneLine(s: string, n: number): string {
  const flat = String(s).replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

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
