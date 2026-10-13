import type { Certification, Id, IntentStatus, Path } from "@fire_trident/core";
import { lostOrigin } from "./owed.ts";

/**
 * The repair loop's rules. A red trunk becomes a need like any other: the colony declares one
 * intent ("Make the failing tests pass: ...") whose footprint is the source files the failing
 * tests load, with the test files as read-only context, and agents take it from the field. At most
 * one is open at a time and a few are declared per hour. A green trunk satisfies the open one, and
 * a run is green only when every test each repair was declared for ran and passed (owed.ts).
 */

/** Per-colony certification policy (POST /api/colonies/:id/certify/policy). */
export interface CertifyPolicy {
  /** Run the colony's tests after landings (the deployment's FT_TRUNK_TESTS must be "on" too). */
  enabled: boolean;
  /** Declare a repair intent when trunk turns red. */
  repair: boolean;
  /** Repair intents declared per hour at most. */
  repairsPerHour: number;
  /** Wall-clock limit of one run, start to result. */
  timeoutMs: number;
  /** Limit of one test (Node has none; a runner needs one). */
  testTimeoutMs: number;
  /** Runs start at least this far apart (landings in a burst share one run). */
  minIntervalMs: number;
}

export const DEFAULT_POLICY: CertifyPolicy = { enabled: true, repair: true, repairsPerHour: 3, timeoutMs: 60_000, testTimeoutMs: 10_000, minIntervalMs: 2_000 };

const LIMITS: Record<Exclude<keyof CertifyPolicy, "enabled" | "repair">, [number, number]> = {
  repairsPerHour: [0, 60],
  timeoutMs: [5_000, 300_000],
  testTimeoutMs: [100, 120_000],
  minIntervalMs: [0, 600_000],
};

/** Apply a partial policy change; unknown keys and wrong types are refused with the reason. */
export function mergePolicy(base: CertifyPolicy, patch: unknown): { policy: CertifyPolicy } | { error: string } {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return { error: "policy must be an object" };
  const out: CertifyPolicy = { ...base };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === "enabled" || k === "repair") {
      if (typeof v !== "boolean") return { error: `${k} must be true or false` };
      out[k] = v;
    } else if (k in LIMITS) {
      const [lo, hi] = LIMITS[k as keyof typeof LIMITS];
      if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return { error: `${k} must be a number from ${lo} to ${hi}` };
      out[k as keyof typeof LIMITS] = Math.round(v);
    } else {
      return { error: `unknown policy field ${k}` };
    }
  }
  return { policy: out };
}

/** A repair intent as the rules see it. */
export interface RepairRow {
  id: Id;
  status: IntentStatus;
  createdAt: number;
}

const OPEN: ReadonlySet<string> = new Set(["open", "claimed", "proposed"]);

/** Is a repair intent still open (not landed or withdrawn)? */
export function isOpen(status: string): boolean {
  return OPEN.has(status);
}

const HOUR_MS = 60 * 60_000;

/** What a certification result asks of the repair loop. */
export type RepairAction = { kind: "declare" } | { kind: "satisfy"; ids: Id[] } | { kind: "none"; reason: string };

/**
 * Green satisfies every open repair intent (a run is green only when every test each repair was
 * declared for ran and passed). Red declares one, unless repairs are off, one is still open, no
 * failing or lost test is named, or `repairsPerHour` were declared in the last hour. Anything else
 * (error, skipped, running) changes nothing.
 */
export function repairAction(cert: Pick<Certification, "status" | "failing">, repairs: readonly RepairRow[], policy: Pick<CertifyPolicy, "repair" | "repairsPerHour">, now: number): RepairAction {
  const open = repairs.filter((r) => OPEN.has(r.status));
  if (cert.status === "green") return open.length > 0 ? { kind: "satisfy", ids: open.map((r) => r.id) } : { kind: "none", reason: "green, nothing to repair" };
  if (cert.status !== "red") return { kind: "none", reason: `${cert.status} says nothing about the code` };
  if (!policy.repair) return { kind: "none", reason: "repairs are off for this colony" };
  if (open.length > 0) return { kind: "none", reason: `repair intent ${open[0]!.id} is still open` };
  if (!cert.failing || cert.failing.length === 0) return { kind: "none", reason: "no failing test is named" };
  const recent = repairs.filter((r) => now - r.createdAt < HOUR_MS).length;
  if (recent >= policy.repairsPerHour) return { kind: "none", reason: `${recent} repair intent(s) in the last hour (cap ${policy.repairsPerHour})` };
  return { kind: "declare" };
}

/** What a repair intent is declared with (ColonyDO.addIntent input). */
export interface RepairIntentInput {
  title: string;
  why: string;
  source: "certify";
  footprint: Path[];
  acceptance: string[];
  priority: number;
  createdBy: string;
}

/** Above every spec intent (they use 1 to 5): a red trunk is fixed before more is built on it. */
export const REPAIR_PRIORITY = 10;
/** Files a repair writes at most, and files it reads as context at most (the failing test files first). */
export const REPAIR_FOOTPRINT = 6;
export const REPAIR_CONTEXT = 12;
const TITLE_NAMES = 100;
const WHY_MAX = 16_000;
const LISTED = 20;

/** What repairIntent needs from the run that went red. */
export interface RepairInput {
  /** The red result: `failing` (lost tests included) and `lost`. */
  cert: Certification;
  /** The modules a test file loads, itself first and nearest first (the run's module graph). */
  reach: (file: Path) => Path[];
  isTest: (path: Path) => boolean;
  /**
   * Files a test's fix has to be written in, besides the code its file loads: its own file when the
   * file does not parse or lost tests that must be put back, or the module that keeps the file from
   * running (a package import). Test files are otherwise context only.
   */
  fixIn?: (test: { file: Path; name?: string }) => Path[];
  /** Tests the run lost in all (`cert.lost` lists at most 50). */
  lostTotal?: number;
  /** The spec context of the intents that wrote the failing files, when the colony grew from a spec. */
  spec?: string | null;
  sourceLabel?: string;
}

/** The test's own name: the last part of "suite > test". */
function leafName(name: string): string {
  const parts = name.split(" > ");
  return parts[parts.length - 1] ?? name;
}

/** Repository text (test names, errors) on one line, so it can never read as another line of the intent. */
function flat(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, " ");
}

/**
 * Build the repair intent for a red certification. The tests are the specification: the footprint
 * holds the source files to fix (nearest first, at most 6) and the failing test files are "Builds
 * on" context, read but not rewritten. A test file is in the footprint only when the fix has to be
 * written in it (see `fixIn`), or when the failing tests load no other file. The text says the tests
 * must not be edited, and that an agent finding a test wrong escalates it to a person (kind broken-test).
 */
export function repairIntent(p: RepairInput): RepairIntentInput {
  const lost = p.cert.lost ?? [];
  const lostKeys = new Set(lost.map((l) => `${l.file}\u0000${l.name ?? l.file}`));
  // `failing` lists the lost tests too, with their reason as the error: the rest failed.
  const failing = (p.cert.failing ?? []).filter((f) => !lostKeys.has(`${f.file}\u0000${f.name}`));
  const tests: Array<{ file: Path; name?: string }> = [...failing, ...lost];
  const fixIn = p.fixIn ?? (() => []);
  const footprint: Path[] = [];
  const context: Path[] = [];
  const overflow: Path[] = [];
  for (const t of tests) for (const path of fixIn(t)) if (path && !footprint.includes(path) && footprint.length < REPAIR_FOOTPRINT) footprint.push(path);
  const files = [...new Set(tests.map((t) => t.file).filter((f) => f !== ""))];
  // The code the test files load, nearest first and one level at a time across the files, so each failing test's own module gets in.
  const deps = files.map((file) => p.reach(file).filter((dep) => dep !== file && !p.isTest(dep)));
  for (let level = 0; deps.some((d) => level < d.length); level++) {
    for (const d of deps) {
      const dep = d[level];
      if (dep === undefined || footprint.includes(dep) || overflow.includes(dep)) continue;
      if (footprint.length < REPAIR_FOOTPRINT) footprint.push(dep);
      else overflow.push(dep);
    }
  }
  // Tests that load no other file can only be fixed in themselves.
  if (footprint.length === 0) footprint.push(...files.slice(0, REPAIR_FOOTPRINT));
  for (const path of [...files, ...overflow]) if (!footprint.includes(path) && !context.includes(path) && context.length < REPAIR_CONTEXT) context.push(path);
  const testsToChange = footprint.filter((path) => files.includes(path) || p.isTest(path));

  const named = [...failing.map((f) => f.name), ...lost.map((l) => l.name ?? l.file)].map((n) => flat(leafName(n)));
  const names: string[] = [];
  let used = 0;
  for (const n of named) {
    if (names.includes(n)) continue;
    if (names.length > 0 && used + n.length > TITLE_NAMES) break;
    names.push(n);
    used += n.length + 2;
  }
  const more = new Set(named).size - names.length;
  const title = `${failing.length > 0 ? "Make the failing tests pass" : "Restore the lost tests"}: ${names.join("; ")}${more > 0 ? ` and ${more} more` : ""}`;

  const c = p.cert.counts;
  const short = p.cert.trunkSha.slice(0, 7);
  const bad = c ? c.fail + c.cancelled : 0;
  const lostCount = Math.max(p.lostTotal ?? 0, lost.length);
  const what: string[] = [];
  // Tests that did not run stay visible ("2 skipped, 1 todo").
  const idle = c ? [c.skipped > 0 ? `${c.skipped} skipped` : "", c.todo > 0 ? `${c.todo} todo` : ""].filter((s) => s !== "").join(", ") : "";
  if (failing.length > 0) what.push(`fails ${bad > 0 && c ? `${bad} of its ${c.tests} tests` : `${failing.length} of its tests`}`);
  if (lostCount > 0) what.push(`lost ${lostCount} test${lostCount === 1 ? "" : "s"} that ${lost.every((l) => l.repairIntentId) ? "a repair was declared for" : "passed on certified trunk"}`);
  const lines = [
    `Trunk ${short} ${what.join(" and ")} (node:test, run by trunk certification${idle ? `; ${idle}` : ""}).`,
    `The tests are the specification. Make them pass by fixing the code under test; do not edit, skip, delete or weaken a test to make it pass. The test files under "Builds on" are there to read, not to change.`,
  ];
  if (testsToChange.length > 0) {
    lines.push(flat(`${testsToChange.join(", ")} ${testsToChange.length === 1 ? "is" : "are"} in the footprint only to run again as written: put back the lost tests listed below exactly as they were on the commit named (git show <commit>:<file>), or make a file that does not parse load, without changing what any test checks; otherwise leave it as it is.`));
  }
  lines.push(
    "If a test itself is wrong (it contradicts the spec), do not change it: escalate the intent with kind broken-test, naming the test and the spec line that disagree, and a person decides. Escalating is not a failure.",
  );
  if (failing.length > 0) {
    lines.push("", "Failing tests:");
    for (const f of failing.slice(0, LISTED)) lines.push(flat(`- ${f.file} > ${f.name === f.file ? "(the file fails to load)" : f.name}${f.error ? `: ${f.error}` : ""}`));
    if (failing.length > LISTED) lines.push(`- and ${failing.length - LISTED} more`);
  }
  if (lost.length > 0) {
    lines.push("", "Lost tests (put each back as it was, then make it pass):");
    for (const l of lost.slice(0, LISTED)) lines.push(flat(`- ${l.file}${l.name !== undefined ? ` > ${l.name}` : ""}: ${l.why} (${lostOrigin(l)})`));
    if (lostCount > LISTED) lines.push(`- and ${lostCount - LISTED} more`);
  }
  let why = lines.join("\n");
  if (context.length > 0) why += `\nBuilds on: ${flat(context.join(", "))}`;
  why += "\nModel: default";
  if (p.spec) {
    const room = WHY_MAX - why.length - 40;
    if (room > 500) why += `\n\nSpec context${p.sourceLabel ? ` (${p.sourceLabel})` : ""}:\n${p.spec.length > room ? p.spec.slice(0, room) : p.spec}`;
  }
  return {
    title,
    why,
    source: "certify",
    footprint,
    acceptance: [
      "Every test listed above passes under trunk certification and every other test still passes: node --test passes from a clean clone of trunk",
      testsToChange.length > 0
        ? "Test files change only to run again as written (lost tests put back exactly as they were, a file that does not parse made to load); no test checks less than before"
        : "No test file changes; a test that is wrong is escalated with kind broken-test, not changed",
    ],
    priority: REPAIR_PRIORITY,
    createdBy: "certify",
  };
}
