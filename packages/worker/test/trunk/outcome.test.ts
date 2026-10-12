import { describe, expect, it } from "vitest";
import { validateProposal } from "@fire_trident/core";
import type { Landing, OccResult, Path, Proposal, Sha } from "@fire_trident/core";
import { settleLane, suspects, writesOnTrunk } from "../../src/trunk/outcome.ts";
import type { LandResult } from "../../src/trunk/plan.ts";

const sha = (c: string): Sha => c.repeat(40).slice(0, 40);
const OLD = sha("0");
const OWN = sha("a"); // the blob the proposal writes

function prop(id: string, writes: Record<Path, Sha | null>, reads: Record<Path, Sha | null> = {}): Proposal {
  return {
    id,
    colonyId: "c",
    intentId: `int_${id}`,
    agentId: `agt_${id}`,
    workspace: { namespace: "ft-ws-0", name: `c--ws-${id}`, remote: "https://example.invalid/ws.git" },
    baseSha: sha("b"),
    headSha: sha("h"),
    writeSet: Object.entries(writes).map(([path, blob]) => ({ path, blob })),
    readSet: Object.entries(reads).map(([path, blob]) => ({ path, blob })),
    declared: { footprint: Object.keys(writes), summary: id },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 0,
  };
}

function landing(id: string, proposalIds: string[]): Landing {
  return { id, colonyId: "c", trunkSha: sha("t"), parentSha: sha("p"), proposalIds, intentIds: [], paths: [], regions: [], at: 1 };
}

/** The lane's own OCC for `p` against `trunk`, with base blobs `base` (what the lane computes each tick). */
function occ(p: Proposal, trunk: Record<Path, Sha | null>, base: Record<Path, Sha | null>): OccResult {
  return validateProposal(p, (path) => trunk[path] ?? null, p.writeSet.map((w) => ({ path: w.path, blob: base[w.path] ?? null })));
}

describe("settleLane: idempotent per proposal id", () => {
  it("settles a proposal that landed but whose report was lost as LANDED, not stale against its own blob", () => {
    // prp_1 changed src/jsx/a.ts from OLD to OWN and landed in lnd_1, but the lane's land call
    // failed (the trunk object was reset by a deploy mid-call), so the lane still holds it.
    const p = prop("prp_1", { "src/jsx/a.ts": OWN });
    const trunk = { "src/jsx/a.ts": OWN }; // trunk now holds the proposal's own blob
    const o = occ(p, trunk, { "src/jsx/a.ts": OLD });
    expect(o.eligible).toBe(false); // the lane's OCC alone would return it as stale
    expect(writesOnTrunk(p, (path) => trunk[path as keyof typeof trunk])).toBe(true);
    const stale = [{ p, occ: o, reason: "stale: 1 path changed on trunk since read" }];
    expect(suspects(stale, null)).toEqual(["prp_1"]);

    const l1 = landing("lnd_1", ["prp_1"]);
    const s = settleLane({ batch: [], stale, result: null, known: { prp_1: l1 }, trunk: (path) => trunk[path as keyof typeof trunk] });
    expect(s.landings).toEqual([l1]);
    expect([...s.landed]).toEqual(["prp_1"]);
    expect(s.returned).toEqual([]);
    expect(s.keep).toEqual([]);
  });

  it("keeps (never returns) a proposal that holds its own blob on trunk when the trunk writer cannot be asked", () => {
    const p = prop("prp_1", { "src/jsx/a.ts": OWN });
    const trunk = { "src/jsx/a.ts": OWN };
    const stale = [{ p, occ: occ(p, trunk, { "src/jsx/a.ts": OLD }), reason: "stale" }];
    const s = settleLane({ batch: [], stale, result: null, known: null, trunk: (path) => trunk[path as keyof typeof trunk] });
    expect(s.returned).toEqual([]);
    expect(s.keep).toEqual(["prp_1"]);
  });

  it("still returns a genuinely stale proposal, with the lane's reason and stale paths", () => {
    const p = prop("prp_2", { "src/b.ts": OWN }, { "src/c.ts": OLD });
    const trunk = { "src/b.ts": OLD, "src/c.ts": sha("9") }; // someone else changed what it read
    const o = occ(p, trunk, { "src/b.ts": OLD });
    const s = settleLane({ batch: [], stale: [{ p, occ: o, reason: "stale: src/c.ts" }], result: null, known: {}, trunk: (path) => trunk[path as keyof typeof trunk] });
    expect(s.returned).toEqual([{ p, id: "prp_2", reason: "stale: src/c.ts", stale: o.stale }]);
    expect(s.landings).toEqual([]);
  });

  it("never reports an 'already landed' answer as a return; with the landing known it settles as landed", () => {
    const a = prop("prp_a", { "x/a": OWN });
    const b = prop("prp_b", { "x/b": OWN });
    const res: LandResult = { returned: [{ proposalId: "prp_a", reason: "already landed in lnd_9" }] };
    expect(suspects([], res)).toEqual(["prp_a"]);
    const unknown = settleLane({ batch: [a, b], stale: [], result: res, known: null, trunk: () => null });
    expect(unknown.returned).toEqual([]);
    expect(unknown.keep.sort()).toEqual(["prp_a", "prp_b"]);
    const l9 = landing("lnd_9", ["prp_a"]);
    const known = settleLane({ batch: [a, b], stale: [], result: res, known: { prp_a: l9 }, trunk: () => null });
    expect(known.landings).toEqual([l9]);
    expect(known.returned).toEqual([]);
    expect(known.keep).toEqual(["prp_b"]);
  });

  it("reports the new landing and earlier ones (prior) once each, and passes the trunk writer's returns through", () => {
    const a = prop("prp_a", { "x/a": OWN });
    const b = prop("prp_b", { "x/b": OWN });
    const c = prop("prp_c", { "x/c": OWN });
    const d = prop("prp_d", { "x/d": OWN });
    const now = landing("lnd_new", ["prp_a"]);
    const before = landing("lnd_old", ["prp_b", "prp_x"]);
    const res: LandResult = { landing: now, prior: [before, before], returned: [{ proposalId: "prp_c", reason: "stale: x/c (expected a, trunk has b)" }], deferred: [{ proposalId: "prp_d", reason: "blob pull failed" }] };
    const s = settleLane({ batch: [a, b, c, d], stale: [], result: res, known: { prp_b: before }, trunk: () => null });
    expect(s.landings.map((l) => l.id)).toEqual(["lnd_new", "lnd_old"]);
    expect([...s.landed].sort()).toEqual(["prp_a", "prp_b", "prp_x"]);
    expect(s.returned).toEqual([{ p: c, id: "prp_c", reason: "stale: x/c (expected a, trunk has b)" }]);
    expect(s.keep).toEqual(["prp_d"]);
  });

  it("lets a landing win over a return for the same proposal", () => {
    const a = prop("prp_a", { "x/a": OWN });
    const res: LandResult = { landing: landing("lnd_1", ["prp_a"]), returned: [{ proposalId: "prp_a", reason: "conflict" }] };
    const s = settleLane({ batch: [a], stale: [], result: res, known: {}, trunk: () => null });
    expect(s.returned).toEqual([]);
    expect(s.keep).toEqual([]);
  });

  it("counts a deletion as on trunk when the path is gone", () => {
    expect(writesOnTrunk(prop("p", { gone: null }), () => null)).toBe(true);
    expect(writesOnTrunk(prop("p", { gone: null }), () => OLD)).toBe(false);
    expect(writesOnTrunk(prop("p", {}), () => null)).toBe(false);
  });
});
