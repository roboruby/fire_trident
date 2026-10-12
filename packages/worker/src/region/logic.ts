import { inhibitionFactor, laneIntervalMs, markValue } from "@fire_trident/core";
import type { Mark, MarkKind, OccResult, Path, Proposal, Sha } from "@fire_trident/core";

/** Valid mark kinds (used to reject bad deposits). */
export const KINDS: ReadonlySet<string> = new Set<MarkKind>(["claim", "need", "trail", "failure", "danger"]);

/**
 * Storage key that decides which deposits merge into one row:
 * - claim: one per (agent, intent, path); a re-deposit refreshes it (heartbeat).
 * - need: one per (intent, path); a re-deposit replaces it.
 * - trail, failure, danger: one per path; deposits accumulate.
 * Merging is exact for exponential decay, so the table stays small without
 * changing any field value.
 */
export function mergeKey(m: Pick<Mark, "kind" | "path" | "agentId" | "intentId">): string {
  switch (m.kind) {
    case "claim":
      return `claim|${m.agentId ?? ""}|${m.intentId ?? ""}|${m.path}`;
    case "need":
      return `need|${m.intentId ?? ""}|${m.path}`;
    default:
      return `${m.kind}|${m.path}`;
  }
}

/** Do deposits of this kind add up (true) or replace the previous value (false)? */
export function accumulates(kind: MarkKind): boolean {
  return kind === "trail" || kind === "failure" || kind === "danger";
}

/**
 * Fold an incoming deposit into the stored row with the same merge key.
 * Replacing kinds keep the incoming strength and time; accumulating kinds
 * store the sum of both values decayed to `now`.
 */
export function foldDeposit(
  existing: { strength: number; at: number } | undefined,
  incoming: Omit<Mark, "id">,
  now: number,
): { strength: number; at: number } {
  if (!accumulates(incoming.kind)) return { strength: incoming.strength, at: incoming.at };
  const fresh = markValue({ ...incoming, id: "" }, now);
  if (!existing) return { strength: fresh, at: now };
  const old = markValue({ id: "", kind: incoming.kind, path: incoming.path, strength: existing.strength, at: existing.at }, now);
  return { strength: old + fresh, at: now };
}

/** Is this a deposit the field can store (known kind, path, finite non-negative strength)? */
export function validDeposit(m: Partial<Omit<Mark, "id">>): m is Omit<Mark, "id"> {
  return (
    typeof m.kind === "string" &&
    KINDS.has(m.kind) &&
    typeof m.path === "string" &&
    m.path.length > 0 &&
    typeof m.strength === "number" &&
    Number.isFinite(m.strength) &&
    m.strength >= 0
  );
}

/** Short form of a blob id for reasons ("absent" for null). */
export function shortSha(sha: Sha | null): string {
  return sha === null ? "absent" : sha.slice(0, 10);
}

/** Human and agent readable reason listing the exact stale paths. */
export function staleReason(stale: OccResult["stale"], max = 25): string {
  const paths = [...new Set(stale.map((s) => s.path))];
  const shown = stale.slice(0, max).map((s) => `${s.path} (expected ${shortSha(s.expected)}, trunk ${shortSha(s.actual)})`);
  const more = stale.length > max ? `; and ${stale.length - max} more` : "";
  return `stale: ${paths.length} path${paths.length === 1 ? "" : "s"} changed on trunk since read: ${shown.join("; ")}${more}`;
}

/** The paths a proposal read or wrote (each once). */
export function proposalPaths(p: Pick<Proposal, "readSet" | "writeSet">): Path[] {
  const out = new Set<Path>();
  for (const f of p.readSet) out.add(f.path);
  for (const f of p.writeSet) out.add(f.path);
  return [...out];
}

/** Union of write paths per base commit, so baseBlobs is called once per distinct base. */
export function writePathsByBase(ps: Array<Pick<Proposal, "baseSha" | "writeSet">>): Map<Sha, Path[]> {
  const sets = new Map<Sha, Set<Path>>();
  for (const p of ps) {
    let set = sets.get(p.baseSha);
    if (!set) {
      set = new Set();
      sets.set(p.baseSha, set);
    }
    for (const w of p.writeSet) set.add(w.path);
  }
  return new Map([...sets].map(([sha, set]) => [sha, [...set]]));
}

/** Lane cadence: Physarum interval for the current flux, slowed by the criticality governor. */
export function laneDelayMs(fluxPerMin: number, sigma: number): number {
  return Math.round(laneIntervalMs(fluxPerMin) * inhibitionFactor(sigma));
}

/**
 * When the next lane tick should run: one interval after the previous tick, but
 * never in the past, so an idle lane serves its first proposal right away.
 */
export function nextTickAt(now: number, lastTickAt: number, delayMs: number): number {
  return Math.max(now, lastTickAt + delayMs);
}

/**
 * The smallest claim value that keeps an agent inside a region for admission: the bar lateral
 * inhibition uses (FT_LATERAL_INHIBITION as a fraction of a fresh claim, else half a fresh claim).
 * "off", 0 or anything unparsable falls back to the default: admission must never count a claim
 * that is mostly gone. Heartbeats keep a working agent's claims above it; a silent agent's claims
 * (tau 5 minutes) fall below it after about 3.5 minutes, where counting every claim until it
 * decays to 0.01 kept a stopped run in the count for 23 minutes.
 */
export function admissionBar(raw: string | undefined, fallback = 0.5): number {
  const s = (raw ?? "").trim();
  const f = s === "" || s === "off" ? Number.NaN : Number(s);
  return Number.isFinite(f) && f > 0 && f <= 1 ? f : fallback;
}

/** Split a list into chunks of at most `size` items. */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
