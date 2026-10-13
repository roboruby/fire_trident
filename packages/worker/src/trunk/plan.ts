/**
 * Group commit, the pure part: what one trunk cycle does with the landing requests that queued
 * while the previous cycle ran (one request per lane batch, in arrival order).
 *
 * Every request becomes its own landing commit, and the commits of a cycle are chained: the
 * second batch's commit has the first's as parent, and only the tip is pushed. Lineage stays
 * per landing (one commit, one lineage note, one `why` entry per lane batch) while the cycle
 * pays for one trunk push and one notes push. Because the commits are chained, the plan is
 * sequential optimistic concurrency over a virtual trunk: each proposal is validated against
 * trunk as it will be once every earlier accepted proposal of the cycle has landed. That is
 * what serving the batches one commit at a time would decide, without a push per batch.
 */
import { validateProposal } from "@fire_trident/core";
import type { FileVersion, Id, Landing, Path, Proposal, Sha } from "@fire_trident/core";

/** A proposal sent back from `land`, with the exact reason. */
export interface Returned {
  proposalId: Id;
  reason: string;
}

/**
 * What `TrunkDO.land` reports for one batch. Idempotent per proposal id: a proposal that landed
 * earlier (a retried batch whose result was lost) comes back in `prior` with its landing and is
 * never returned. `deferred` proposals were neither landed nor returned (a transient failure);
 * the lane keeps them and tries again.
 */
export interface LandResult {
  landing?: Landing;
  prior?: Landing[];
  returned: Returned[];
  deferred?: Returned[];
}

/** One proposal's fate in a cycle. */
export type Outcome =
  | { kind: "landed"; landing: Landing }
  | { kind: "returned"; reason: string }
  | { kind: "deferred"; reason: string };

/** A proposal ready for planning: shape-checked, not landed before, its new blobs local. */
export interface PlanProposal {
  p: Proposal;
  /** Blob of every written path at the proposal's base commit. */
  base: FileVersion[];
}

/** Per batch (same order as the input): the proposals that land in its commit, and the ones that go back. */
export interface PlanResult {
  accepted: Proposal[][];
  returned: Returned[][];
}

/** Same path, or one is a directory prefix of the other. */
export function overlaps(a: Path, b: Path): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Short form of a blob id for reasons. */
function short(blob: Sha | null): string {
  return blob === null ? "absent" : blob.slice(0, 10);
}

/**
 * Plan one cycle. Batches are served in order and proposals in batch order:
 *
 * - Within a batch (one commit) the lane's lateral-inhibition rule holds: a proposal whose writes
 *   overlap an accepted proposal's writes or reads, or whose reads overlap its writes, goes back
 *   ("conflicts with another proposal in this landing").
 * - Across batches the commits are chained, so a proposal is checked against the virtual trunk:
 *   current trunk plus every write accepted earlier in the cycle. A read or written path that an
 *   earlier batch changes makes it stale (write/write and write-then-read overlaps), with the
 *   exact delta and the proposal landing ahead of it. Writing a path that an earlier batch only
 *   read is fine: that batch lands first, on the trunk it read.
 * - A file/directory clash with an earlier batch's write (one path a prefix of the other) goes back.
 * - Assumptions (the files a proposal's imports resolve to) must still exist: a proposal whose assumption
 *   is gone from the virtual trunk goes back, and so does one that would delete a assumption of a
 *   proposal accepted earlier in the cycle. Only existence counts; an edited assumption is fine.
 *
 * Proposal ids must be unique across the cycle (the caller dedupes); a repeated id is skipped.
 */
export function planCycle(batches: PlanProposal[][], trunk: (path: Path) => Sha | null): PlanResult {
  const ahead = new Map<Path, { blob: Sha | null; by: Id }>();
  const aheadPaths: Path[] = [];
  /** Assumptions of the proposals accepted in earlier batches, with the proposal relying on each. */
  const reliedAhead = new Map<Path, Id>();
  const virtual = (path: Path): Sha | null => {
    const w = ahead.get(path);
    return w !== undefined ? w.blob : trunk(path);
  };
  const seen = new Set<Id>();
  const accepted: Proposal[][] = [];
  const returned: Returned[][] = [];
  for (const batch of batches) {
    const ok: Proposal[] = [];
    const back: Returned[] = [];
    const writes = new Set<Path>();
    const reads = new Set<Path>();
    /** Paths this batch's accepted proposals delete, and the assumptions they rely on. */
    const deleted = new Map<Path, Id>();
    const relied = new Map<Path, Id>();
    for (const { p, base } of batch) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const w = p.writeSet.map((f) => f.path);
      const r = p.readSet.map((f) => f.path);
      const assumptions = p.assumptions ?? [];
      const clash = w.find((path) => reads.has(path) || [...writes].some((x) => overlaps(x, path))) ?? r.find((path) => writes.has(path));
      if (clash !== undefined) {
        back.push({ proposalId: p.id, reason: `conflicts with another proposal in this landing on ${clash}` });
        continue;
      }
      const gone = assumptions.find((path) => deleted.has(path));
      if (gone !== undefined) {
        back.push({ proposalId: p.id, reason: `conflicts with ${deleted.get(gone)} in this landing: it deletes ${gone}, which this change's imports resolve to` });
        continue;
      }
      const kill = p.writeSet.find((f) => (f.blob ?? null) === null && (relied.has(f.path) || reliedAhead.has(f.path)));
      if (kill !== undefined) {
        const here = relied.get(kill.path);
        const by = here ?? reliedAhead.get(kill.path)!;
        back.push({ proposalId: p.id, reason: `conflicts with ${by}${here ? " in this landing" : ", landing ahead in this cycle"}: this change deletes ${kill.path}, which ${by}'s imports resolve to` });
        continue;
      }
      const occ = validateProposal(p, virtual, base);
      if (!occ.eligible) {
        const detail = occ.stale
          .map((s) => {
            const by = ahead.get(s.path)?.by;
            return `${s.path} (expected ${s.expected ?? "absent"}, trunk has ${s.actual ?? "absent"}${by ? `, landing ahead in this cycle from ${by}` : ""})`;
          })
          .join(", ");
        back.push({ proposalId: p.id, reason: `stale: ${detail}` });
        continue;
      }
      const missing = assumptions.find((path) => virtual(path) === null);
      if (missing !== undefined) {
        const by = ahead.get(missing)?.by;
        back.push({ proposalId: p.id, reason: `stale: its imports resolve to ${missing}, which ${by ? `${by} deletes, landing ahead in this cycle` : "is no longer on trunk"}` });
        continue;
      }
      const shape = [...w, ...r].find((path) => aheadPaths.some((x) => x !== path && overlaps(x, path)));
      if (shape !== undefined) {
        const x = aheadPaths.find((y) => y !== shape && overlaps(y, shape))!;
        const a = ahead.get(x)!;
        back.push({ proposalId: p.id, reason: `conflicts with ${a.by} on ${shape}: ${a.by} ${a.blob === null ? "deletes" : `writes ${short(a.blob)} at`} ${x}, landing ahead in this cycle` });
        continue;
      }
      ok.push(p);
      for (const path of w) writes.add(path);
      for (const path of r) reads.add(path);
      for (const f of p.writeSet) if ((f.blob ?? null) === null) deleted.set(f.path, p.id);
      for (const path of assumptions) if (!relied.has(path)) relied.set(path, p.id);
    }
    // The batch's writes become the base of every later batch, and its assumptions bind them.
    for (const p of ok) {
      for (const f of p.writeSet) {
        if (!ahead.has(f.path)) aheadPaths.push(f.path);
        ahead.set(f.path, { blob: f.blob ?? null, by: p.id });
      }
    }
    for (const [path, id] of relied) if (!reliedAhead.has(path)) reliedAhead.set(path, id);
    accepted.push(ok);
    returned.push(back);
  }
  return { accepted, returned };
}

/**
 * Split a cycle's requests into the first occurrence of each proposal id (in arrival order) and
 * the repeats. A repeat (the same proposal sent again, say by a lane retrying a call whose answer
 * it never got) is not processed twice; it shares the first occurrence's outcome.
 */
export function uniqueProposals(requests: Proposal[][]): Array<{ request: number; p: Proposal }> {
  const seen = new Set<Id>();
  const out: Array<{ request: number; p: Proposal }> = [];
  requests.forEach((batch, request) => {
    for (const p of batch) {
      const id = typeof p?.id === "string" ? p.id : "";
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      out.push({ request, p });
    }
  });
  return out;
}

/**
 * Each request's result from the per-proposal outcomes, idempotent per proposal id: a landed
 * proposal reports its landing (the request's own new landing in `landing`, any other in
 * `prior`, each once) and is never returned. Proposals without an id or outcome come back with
 * `fallback` reasons from `direct` (malformed input) or as deferred.
 */
export function resultsFor(requests: Proposal[][], outcome: Map<Id, Outcome>, own: Array<Landing | undefined>, direct: Returned[][] = []): LandResult[] {
  return requests.map((batch, i) => {
    const res: LandResult = { returned: [...(direct[i] ?? [])] };
    const mine = own[i];
    const prior = new Map<Id, Landing>();
    const listed = new Set<Id>();
    for (const p of batch) {
      const id = typeof p?.id === "string" ? p.id : "";
      if (id === "" || listed.has(id)) continue;
      listed.add(id);
      const o = outcome.get(id);
      if (!o) {
        (res.deferred ??= []).push({ proposalId: id, reason: "not decided in this trunk cycle" });
      } else if (o.kind === "landed") {
        if (mine && o.landing.id === mine.id) res.landing = mine;
        else prior.set(o.landing.id, o.landing);
      } else if (o.kind === "returned") {
        res.returned.push({ proposalId: id, reason: o.reason });
      } else {
        (res.deferred ??= []).push({ proposalId: id, reason: o.reason });
      }
    }
    if (prior.size > 0) res.prior = [...prior.values()];
    return res;
  });
}
