import type { LandingTests, LineageNote, Path, ProofPath, ProofRung, TestAuthorGroup, TestAuthors, TestReach } from "./types.ts";
import { gateOf, modelOf, personName } from "./answerable.ts";
import { usdText } from "./pricing.ts";

/**
 * A landing's test row, as every landing card shows it (the Why tab, the landing page's note card, `ft why`, both MCP
 * `why` tools): the colony's own tests at the commit the landing was applied on against the first green certification
 * that includes it, the tests lost on the way, whose tests they are, whether a test from before the landing reaches the
 * files it wrote, what landed it, and what the model calls this platform made for it cost. The worker computes the
 * numbers (certify/landingtests.ts); this module holds the parts that are pure: what landed a change (from its lineage
 * note), the per-test delta between two commits, and the words. Pure: no I/O.
 */

/** Lost tests a row names at most (`lost` counts them all). */
export const MAX_LOST_NAMED = 20;

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const whole = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const num = (n: number): string => whole(n).toLocaleString("en-US");
const short = (sha: string): string => sha.slice(0, 7);
const plural = (n: number, word: string): string => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

/** A model id as a card shows it: its last path segment ("@cf/google/gemma-4-26b-a4b-it" reads "gemma-4-26b-a4b-it"). */
export function shortModel(model: string): string {
  const parts = model.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? model;
}

// ---------------------------------------------------------------------------
// What landed it

/**
 * The rung that landed one change of a note: a person's approval first (a human `approve` decision), else what the gate
 * check says: the deterministic proof, a model's approval (the second opinion), the reflex on earned autonomy (`autonomy`
 * among the confirmations), a person; no gate check means it landed with no review recorded (review off).
 */
export function changeRung(entry: unknown): { rung: ProofRung; by?: string } {
  const p = isObj(entry) ? entry : {};
  const decisions = list(p.decisions);
  const checks = list(isObj(p.evidence) ? p.evidence.checks : undefined);
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (!isObj(d) || d.layer !== "human" || d.action !== "approve") continue;
    const name = personName(d.by);
    return name ? { rung: "person", by: name } : { rung: "person" };
  }
  const gate = gateOf(checks);
  if (!gate) return { rung: "unreviewed" };
  if (gate.layer === "deterministic") return { rung: "deterministic" };
  if (gate.layer === "llm" || gate.layer === "reflex") {
    const rung: ProofRung = gate.layer === "reflex" && gate.confirmations.includes("autonomy") ? "autonomy" : "model";
    const model = modelOf(gate.layer, decisions, checks);
    return model ? { rung, by: model } : { rung };
  }
  if (gate.layer === "human") return { rung: "person" };
  return { rung: "unknown" };
}

/** The phrase for one rung ("deterministic", "model approval (gemma-4-26b-a4b-it)", "a person (Lee)", ...). */
function rungText(rung: ProofRung, by: string | undefined, revert = false): string {
  switch (rung) {
    case "deterministic":
      return "deterministic";
    case "model":
      return by ? `model approval (${shortModel(by)})` : "model approval";
    case "autonomy":
      return by ? `earned autonomy (${shortModel(by)})` : "earned autonomy";
    case "person":
      return revert ? (by ? `a person's revert (${by})` : "a person's revert") : by ? `a person (${by})` : "a person";
    case "unreviewed":
      return "no review recorded";
    case "system":
      return "FireTrident's own commit";
    default:
      return "unknown";
  }
}

/**
 * What landed each change of a landing, from its lineage note: each change's rung (changeRung), grouped by rung and by
 * the model or person it names, in the order first seen. A person's revert names the person; FireTrident's own commit
 * (an antibody, a protection record) says so.
 */
export function proofPath(note: LineageNote | Json | null | undefined): ProofPath {
  const n: Json = isObj(note) ? (note as Json) : {};
  if (isObj(n.revert)) {
    const name = personName(n.revert.by);
    return { rungs: [{ rung: "person", count: 1, ...(name ? { by: name } : {}) }], text: rungText("person", name ?? undefined, true) };
  }
  if (isObj(n.system)) return { rungs: [{ rung: "system", count: 1 }], text: rungText("system", undefined) };
  const proposals = list(n.proposals).filter(isObj);
  if (proposals.length === 0) return { rungs: [{ rung: "unknown", count: 1 }], text: "unknown: the note lists no change" };
  const groups: ProofPath["rungs"] = [];
  for (const p of proposals) {
    const r = changeRung(p);
    const g = groups.find((x) => x.rung === r.rung && x.by === r.by);
    if (g) g.count++;
    else groups.push({ rung: r.rung, count: 1, ...(r.by ? { by: r.by } : {}) });
  }
  const text = groups.length === 1 ? rungText(groups[0]!.rung, groups[0]!.by) : groups.map((g) => `${rungText(g.rung, g.by)}${g.count > 1 ? ` ×${g.count}` : ""}`).join(", ");
  return { rungs: groups, text };
}

// ---------------------------------------------------------------------------
// The delta

/** One test file's outcomes at one commit, as certification keeps them: the key of what it reaches, and its tests (null when no longer kept). */
export interface FileOutcomes {
  key: string;
  tests: ReadonlyArray<{ name: string; status: string }> | null;
}

/** Lost and new tests between two commits (testDelta). */
export interface TestDelta {
  /** Tests that passed at the base and do not pass after (missing, failing, skipped), duplicates of one name counted. */
  lost: number;
  /** The first of them by name (at most `maxNamed`), in file order. */
  lostTests: Array<{ file: Path; name: string }>;
  /** Tests that pass after and did not pass at the base. */
  added: number;
  /** Test files left out of both counts because their results at one of the commits are no longer kept. */
  unknownFiles: number;
}

/** How many times each name passed in a file's results. */
function passes(tests: ReadonlyArray<{ name: string; status: string }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tests) if (t && t.status === "pass" && typeof t.name === "string") out.set(t.name, (out.get(t.name) ?? 0) + 1);
  return out;
}

/**
 * The tests lost and gained between two commits' test files (each map holds the files that ran there). A file with the
 * same key at both commits reached the same code with the same runner: its results are the same, so it adds nothing.
 * Otherwise each name counts as many times as it passed: a name that passed twice at the base and once after lost one.
 * A file that ran at the base and not after lost every test that passed in it. A file whose results at one of the commits
 * are no longer kept (null) is counted in `unknownFiles` and in neither count.
 */
export function testDelta(base: ReadonlyMap<Path, FileOutcomes>, after: ReadonlyMap<Path, FileOutcomes>, maxNamed = MAX_LOST_NAMED): TestDelta {
  const out: TestDelta = { lost: 0, lostTests: [], added: 0, unknownFiles: 0 };
  const files = [...new Set([...base.keys(), ...after.keys()])].sort();
  for (const file of files) {
    const b = base.get(file);
    const a = after.get(file);
    if (b && a && b.key === a.key) continue;
    if ((b && b.tests === null) || (a && a.tests === null)) {
      out.unknownFiles++;
      continue;
    }
    const was = b?.tests ? passes(b.tests) : new Map<string, number>();
    const now = a?.tests ? passes(a.tests) : new Map<string, number>();
    for (const [name, n] of was) {
      const gone = n - (now.get(name) ?? 0);
      if (gone <= 0) continue;
      out.lost += gone;
      for (let i = 0; i < gone && out.lostTests.length < maxNamed; i++) out.lostTests.push({ file, name });
    }
    for (const [name, n] of now) out.added += Math.max(0, n - (was.get(name) ?? 0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The words

/** The row's parts a card needs (a LandingTests, or one from an older server that lacks some fields). */
export type TestsRowInput = Pick<LandingTests, "status" | "proof"> & Partial<Pick<LandingTests, "reason" | "base" | "certified" | "lost" | "added" | "unknownFiles" | "spend">>;

/** "433/434": tests passing of tests run. */
function counted(at: { pass: number; tests: number }): string {
  return `${num(at.pass)}/${num(at.tests)}`;
}

/** The tests part of the row: base against certified, lost and new; or why there is no certified commit yet. */
function testsPart(t: TestsRowInput): string {
  if (t.status === "no-tests") return "no tests this platform can run";
  if (t.status !== "certified" || !t.certified) return `not certified yet${t.reason ? `: ${t.reason}` : ""}`;
  const certified = `${counted(t.certified)} certified`;
  if (!t.base) return `no result at or before base, ${certified}`;
  const where = t.base.exact ? "at base" : `at ${short(t.base.sha)}, before base`;
  const skipped = whole(t.unknownFiles) > 0 ? ` (${plural(whole(t.unknownFiles), "test file")} not compared)` : "";
  const lost = typeof t.lost === "number" ? `${num(t.lost)} lost${skipped}` : "lost not known";
  const added = whole(t.added) > 0 ? `, ${num(whole(t.added))} new` : "";
  return `${counted(t.base)} ${where}, ${certified}, ${lost}${added}`;
}

/**
 * The row a landing card shows: "433/434 at base, 434/434 certified, 0 lost · proof: deterministic · $0.0003 (model calls
 * this platform made)". A base that was not certified itself reads "at <sha>, before base"; with no certified commit
 * yet, "not certified yet" and why; with no test this platform can run, it says so. The spend is left out when no model
 * call was counted for the landing's intents.
 */
export function testsRow(t: TestsRowInput): string {
  const parts = [testsPart(t), `proof: ${t.proof?.text || "unknown"}`];
  if (t.spend && typeof t.spend.usd === "number") parts.push(`${usdText(t.spend.usd)} (model calls this platform made)`);
  return parts.join(" · ");
}

/** One line under the row: what it says, and whether it warns (amber). */
export interface TestsLine {
  k: "lost" | "red" | "whose" | "reach" | "note";
  text: string;
  warn: boolean;
}

/** "N of one origin (M files: by, by)". */
function group(g: TestAuthorGroup | undefined, what: string): string | null {
  if (!g || whole(g.files) === 0) return null;
  const by = Array.isArray(g.by) && g.by.length > 0 ? `: ${g.by.map(shortModel).join(", ")}` : "";
  return `${num(g.tests)} ${what} (${plural(g.files, "file")}${by})`;
}

/** Whose tests ran at the certified commit, in one line: inherited, written by agents, edits a person approved. */
export function authorsText(a: TestAuthors): string {
  const parts = [
    group(a.inherited, "inherited from the repository"),
    group(a.agents, "written or edited by agents"),
    group(a.person, "in edits a person approved"),
    group(a.unknown, "of unknown origin"),
  ].filter((p): p is string => p !== null);
  const uncounted = whole(a.uncounted) > 0 ? ` (${plural(whole(a.uncounted), "file")} whose test count is no longer kept)` : "";
  return parts.length > 0 ? `${parts.join(" · ")}${uncounted}` : `no test file ran${uncounted}`;
}

/** Does the closure check warn: it wrote code a test can load, and no test from before it reaches that code? */
export function reachWarns(r: TestReach | null | undefined): boolean {
  return !!r && r.none === undefined && whole(r.earlier) === 0;
}

/** The closure check in one line: the earlier test files that reach the change, or "No earlier test reaches this change" and what does. */
export function reachText(r: TestReach): string {
  if (r.none === "no-code") return "It changed no file a test can load.";
  const bounded = r.bounded ? ` (${r.bounded.replace(/[.\s]+$/, "")})` : "";
  const own = whole(r.own);
  const later = whole(r.later);
  if (reachWarns(r)) {
    const what = own > 0 ? `only ${plural(own, "test file")} it wrote ${own === 1 ? "reaches" : "reach"} its files` : later > 0 ? `only ${plural(later, "later test file")} ${later === 1 ? "reaches" : "reach"} its files` : "no test file reaches its files";
    return `No earlier test reaches this change: ${what}${bounded}.`;
  }
  const earlier = whole(r.earlier);
  const named = (r.earlierFiles ?? []).slice(0, 5);
  const more = earlier > named.length ? ` and ${num(earlier - named.length)} more` : "";
  const wrote = own > 0 ? `, and ${plural(own, "test file")} it wrote` : "";
  return `${plural(earlier, "earlier test file")} ${earlier === 1 ? "reaches" : "reach"} its files (${named.join(", ")}${more})${wrote}${bounded}.`;
}

/** The lines under the row: the lost tests by name, a red result before it was certified, whose tests, the closure check, and what could not be read. */
export function testsLines(t: Partial<LandingTests>): TestsLine[] {
  const out: TestsLine[] = [];
  const lost = Array.isArray(t.lostTests) ? t.lostTests : [];
  if (lost.length > 0) {
    const shown = lost.slice(0, 5).map((l) => `${l.name} (${l.file})`);
    const more = whole(t.lost) > shown.length ? `; and ${num(whole(t.lost) - shown.length)} more` : "";
    out.push({ k: "lost", text: `Passed at base, not at the certified commit: ${shown.join("; ")}${more}.`, warn: true });
  }
  if (t.status === "no-tests" && typeof t.reason === "string" && t.reason.trim() !== "") {
    const r = t.reason.trim().replace(/[.\s]+$/, "");
    out.push({ k: "note", text: `${r.charAt(0).toUpperCase()}${r.slice(1)}.`, warn: false });
  }
  if (t.status === "certified" && t.red) out.push({ k: "red", text: `Trunk was red at ${short(t.red.sha)} after it landed (${num(t.red.failing)} of ${num(t.red.tests)} failing) before a green certification included it.`, warn: false });
  if (t.authors) out.push({ k: "whose", text: `${authorsText(t.authors)}.`, warn: false });
  if (t.reach) out.push({ k: "reach", text: reachText(t.reach), warn: reachWarns(t.reach) });
  if (typeof t.detail === "string" && t.detail.trim() !== "") out.push({ k: "note", text: t.detail.trim(), warn: false });
  return out;
}
