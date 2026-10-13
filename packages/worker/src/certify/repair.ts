import type { Certification, FailingTest, Id, IntentStatus, Path } from "@fire_trident/core";

/**
 * The repair loop's rules. A red trunk becomes a need like any other: the colony declares one
 * intent ("Make the failing tests pass: ...") whose footprint is the failing test files and the
 * source files they load, and agents take it from the field. At most one is open at a time and
 * a few are declared per hour; a green trunk satisfies the open one.
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
const HOUR_MS = 60 * 60_000;

/** What a certification result asks of the repair loop. */
export type RepairAction = { kind: "declare" } | { kind: "satisfy"; ids: Id[] } | { kind: "none"; reason: string };

/**
 * Green satisfies every open repair intent. Red declares one, unless repairs are off, one is
 * still open, no failing test is named, or `repairsPerHour` were declared in the last hour.
 * Anything else (error, skipped, running) changes nothing.
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
/** Files a repair rewrites at most, and files it reads as context at most. */
export const REPAIR_FOOTPRINT = 6;
export const REPAIR_CONTEXT = 8;
const TITLE_NAMES = 100;
const WHY_MAX = 16_000;

/** The test's own name: the last part of "suite > test". */
function leafName(f: FailingTest): string {
  const parts = f.name.split(" > ");
  return parts[parts.length - 1] ?? f.name;
}

/**
 * Build the repair intent for a red certification. `reach(file)` lists the source files a test file
 * loads, nearest first (from the run's module graph); `spec` is the spec context of the intents that
 * wrote the failing files, when the colony grew from a spec.
 */
export function repairIntent(p: { cert: Certification; reach: (file: Path) => Path[]; isTest: (path: Path) => boolean; spec?: string | null; sourceLabel?: string }): RepairIntentInput {
  const failing = p.cert.failing ?? [];
  const files = [...new Set(failing.map((f) => f.file).filter((f) => f !== ""))];
  const footprint: Path[] = [...files];
  const context: Path[] = [];
  for (const file of files) {
    for (const dep of p.reach(file)) {
      if (dep === file || p.isTest(dep) || footprint.includes(dep) || context.includes(dep)) continue;
      if (footprint.length < REPAIR_FOOTPRINT) footprint.push(dep);
      else if (context.length < REPAIR_CONTEXT) context.push(dep);
    }
  }
  const names: string[] = [];
  let used = 0;
  for (const f of failing) {
    const n = leafName(f);
    if (names.includes(n)) continue;
    if (names.length > 0 && used + n.length > TITLE_NAMES) break;
    names.push(n);
    used += n.length + 2;
  }
  const more = new Set(failing.map(leafName)).size - names.length;
  const title = `Make the failing tests pass: ${names.join("; ")}${more > 0 ? ` and ${more} more` : ""}`;
  const c = p.cert.counts;
  const short = p.cert.trunkSha.slice(0, 7);
  const lines = [
    `Trunk ${short} fails ${c ? `${c.fail + c.cancelled} of its ${c.tests} tests` : `${failing.length} of its tests`} (node:test, run by trunk certification). Make them pass: fix the code under test, or a test where it contradicts the spec. Never delete, skip or weaken a test to make it pass.`,
    "",
    "Failing tests:",
    ...failing.slice(0, 20).map((f) => `- ${f.file} > ${f.name === f.file ? "(the file fails to load)" : f.name}${f.error ? `: ${f.error}` : ""}`),
  ];
  if (failing.length > 20) lines.push(`- and ${failing.length - 20} more`);
  let why = lines.join("\n");
  if (context.length > 0) why += `\nBuilds on: ${context.join(", ")}`;
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
      `Every failing test passes, and the rest still pass: node --test passes from a clean clone of trunk`,
      "Fix the code under test; change a test only where it contradicts the spec, and never delete or skip one",
    ],
    priority: REPAIR_PRIORITY,
    createdBy: "certify",
  };
}
