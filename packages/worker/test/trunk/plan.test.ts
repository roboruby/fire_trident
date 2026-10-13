import { describe, expect, it } from "vitest";
import type { ExportSurface, ExportedNames, FileVersion, Landing, NameAssumption, Path, Proposal, Sha } from "@fire_trident/core";
import { SURFACE_FILE_BYTES, deletionGuardEnabled, exportSurface, overlaps, planCycle, resultsFor, surfaceBlobs, uniqueProposals, type DeletionImports, type Outcome, type PlanProposal } from "../../src/trunk/plan.ts";

const sha = (c: string): Sha => c.repeat(40).slice(0, 40);
const OLD = sha("0");

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

/** A plan entry whose base holds `base` for its written paths (default: what trunk holds now). */
function entry(p: Proposal, trunk: Record<Path, Sha | null>, base: Record<Path, Sha | null> = {}): PlanProposal {
  const fv: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: w.path in base ? base[w.path]! : (trunk[w.path] ?? null) }));
  return { p, base: fv };
}

function landing(id: string, proposalIds: string[]): Landing {
  return { id, colonyId: "c", trunkSha: sha("t"), parentSha: sha("p"), proposalIds, intentIds: [], paths: [], regions: [], at: 1 };
}

describe("planCycle: one cycle, chained commits", () => {
  const trunk: Record<Path, Sha | null> = { "src/a.ts": OLD, "src/b.ts": OLD, "docs/x.md": OLD, lib: OLD };
  const at = (path: Path): Sha | null => trunk[path] ?? null;

  it("lands independent batches from different lanes in the same cycle", () => {
    const a = prop("a", { "src/a.ts": sha("1") });
    const b = prop("b", { "docs/x.md": sha("2") }, { "src/b.ts": OLD });
    const plan = planCycle([[entry(a, trunk)], [entry(b, trunk)]], at);
    expect(plan.accepted.map((x) => x.map((p) => p.id))).toEqual([["a"], ["b"]]);
    expect(plan.returned).toEqual([[], []]);
  });

  it("returns a later batch's write to a path an earlier batch writes (write/write), naming the proposal ahead", () => {
    const a = prop("a", { "src/a.ts": sha("1") });
    const b = prop("b", { "src/a.ts": sha("2") });
    const plan = planCycle([[entry(a, trunk)], [entry(b, trunk)]], at);
    expect(plan.accepted).toEqual([[a], []]);
    expect(plan.returned[1]).toEqual([
      { proposalId: "b", reason: `stale: src/a.ts (expected ${OLD}, trunk has ${sha("1")}, landing ahead in this cycle from a)` },
    ]);
  });

  it("returns a later batch that read a path an earlier batch writes (write/read)", () => {
    const a = prop("a", { "src/a.ts": sha("1") });
    const b = prop("b", { "docs/x.md": sha("2") }, { "src/a.ts": OLD });
    const plan = planCycle([[entry(a, trunk)], [entry(b, trunk)]], at);
    expect(plan.accepted).toEqual([[a], []]);
    expect(plan.returned[1]![0]!.reason).toMatch(/^stale: src\/a\.ts \(expected 0{40}, trunk has 1{40}, landing ahead in this cycle from a\)$/);
  });

  it("lets a later batch write a path an earlier batch only read: the earlier commit lands first, on the trunk it read", () => {
    const a = prop("a", { "docs/x.md": sha("1") }, { "src/a.ts": OLD });
    const b = prop("b", { "src/a.ts": sha("2") });
    const plan = planCycle([[entry(a, trunk)], [entry(b, trunk)]], at);
    expect(plan.accepted).toEqual([[a], [b]]);
  });

  it("keeps the lane's rule inside one batch (one commit): overlapping writes and reads conflict", () => {
    const a = prop("a", { "src/a.ts": sha("1") }, { "src/b.ts": OLD });
    const b = prop("b", { "docs/x.md": sha("2") }, { "src/a.ts": OLD }); // reads what a writes
    const c = prop("c", { "src/b.ts": sha("3") }); // writes what a reads
    const plan = planCycle([[entry(a, trunk), entry(b, trunk), entry(c, trunk)]], at);
    expect(plan.accepted).toEqual([[a]]);
    expect(plan.returned[0]).toEqual([
      { proposalId: "b", reason: "conflicts with another proposal in this landing on src/a.ts" },
      { proposalId: "c", reason: "conflicts with another proposal in this landing on src/b.ts" },
    ]);
  });

  it("returns a file/directory clash with an earlier batch (one path a prefix of the other)", () => {
    const n = prop("n", { "gen/out": sha("1") }); // creates a file gen/out
    const d = prop("d", { "gen/out/part.ts": sha("2") }); // would need gen/out to be a directory
    const z = prop("z", { "src/a.ts": null }); // deletes src/a.ts
    const c = prop("c", { "src/a.ts": sha("3") }); // writes it on the base z deletes
    const plan = planCycle([[entry(n, trunk)], [entry(d, trunk)], [entry(z, trunk)], [entry(c, trunk)]], at);
    expect(plan.accepted.map((x) => x.map((p) => p.id))).toEqual([["n"], [], ["z"], []]);
    expect(plan.returned[1]).toEqual([{ proposalId: "d", reason: `conflicts with n on gen/out/part.ts: n writes ${sha("1").slice(0, 10)} at gen/out, landing ahead in this cycle` }]);
    expect(plan.returned[3]![0]!.reason).toMatch(/^stale: src\/a\.ts \(expected 0{40}, trunk has absent, landing ahead in this cycle from z\)$/);
  });

  it("returns a proposal stale against trunk itself with the exact delta (no attribution)", () => {
    const a = prop("a", { "src/a.ts": sha("1") });
    const plan = planCycle([[entry(a, trunk, { "src/a.ts": sha("9") })]], at);
    expect(plan.returned[0]).toEqual([{ proposalId: "a", reason: `stale: src/a.ts (expected ${sha("9")}, trunk has ${OLD})` }]);
  });

  it("does not let a returned proposal shadow later batches", () => {
    const a = prop("a", { "src/a.ts": sha("1") }, { "src/b.ts": sha("7") }); // stale read: goes back
    const b = prop("b", { "src/a.ts": sha("2") });
    const plan = planCycle([[entry(a, trunk)], [entry(b, trunk)]], at);
    expect(plan.accepted).toEqual([[], [b]]);
  });

  it("serves batches in order and skips a repeated id", () => {
    const a = prop("a", { "src/a.ts": sha("1") });
    const plan = planCycle([[entry(a, trunk)], [entry(a, trunk)]], at);
    expect(plan.accepted).toEqual([[a], []]);
    expect(plan.returned).toEqual([[], []]);
  });

  it("treats directory prefixes as overlapping", () => {
    expect(overlaps("a/b", "a/b")).toBe(true);
    expect(overlaps("a", "a/b")).toBe(true);
    expect(overlaps("a/b/c", "a/b")).toBe(true);
    expect(overlaps("a/bc", "a/b")).toBe(false);
  });
});

describe("idempotent results per proposal id", () => {
  it("keeps the first occurrence of each proposal across a cycle's batches", () => {
    const a = prop("a", { x: sha("1") });
    const b = prop("b", { y: sha("1") });
    expect(uniqueProposals([[a, b], [a], [b, prop("c", { z: sha("1") })]]).map((e) => `${e.request}:${e.p.id}`)).toEqual(["0:a", "0:b", "2:c"]);
  });

  it("reports an already-landed proposal with its landing (prior), never as returned", () => {
    const earlier = landing("lnd_old", ["p1", "p9"]);
    const mine = landing("lnd_new", ["p2"]);
    const outcome = new Map<string, Outcome>([
      ["p1", { kind: "landed", landing: earlier }],
      ["p2", { kind: "landed", landing: mine }],
      ["p3", { kind: "returned", reason: "stale: x" }],
    ]);
    const [r] = resultsFor([[prop("p1", {}), prop("p2", {}), prop("p3", {})]], outcome, [mine]);
    expect(r).toEqual({ landing: mine, prior: [earlier], returned: [{ proposalId: "p3", reason: "stale: x" }] });
    expect(r!.returned.some((x) => /already landed/.test(x.reason))).toBe(false);
  });

  it("gives a repeated proposal in a later batch the first one's landing as prior, and lists each landing once", () => {
    const mine = landing("lnd_1", ["p1", "p2"]);
    const outcome = new Map<string, Outcome>([
      ["p1", { kind: "landed", landing: mine }],
      ["p2", { kind: "landed", landing: mine }],
    ]);
    const res = resultsFor([[prop("p1", {}), prop("p2", {})], [prop("p1", {}), prop("p2", {}), prop("p2", {})]], outcome, [mine, undefined]);
    expect(res[0]).toEqual({ landing: mine, returned: [] });
    expect(res[1]).toEqual({ prior: [mine], returned: [] });
  });

  it("passes deferred proposals and malformed input through", () => {
    const outcome = new Map<string, Outcome>([["p1", { kind: "deferred", reason: "blob pull failed: busy" }]]);
    const res = resultsFor([[prop("p1", {}), prop("p2", {})]], outcome, [undefined], [[{ proposalId: "", reason: "proposal has no id" }]]);
    expect(res[0]).toEqual({
      returned: [{ proposalId: "", reason: "proposal has no id" }],
      deferred: [
        { proposalId: "p1", reason: "blob pull failed: busy" },
        { proposalId: "p2", reason: "not decided in this trunk cycle" },
      ],
    });
  });
});

describe("planCycle: assumptions (the files a change's imports resolve to)", () => {
  const trunk: Record<Path, Sha | null> = { "src/a.ts": OLD, "src/b.ts": OLD, "src/util.ts": OLD };
  const at = (path: Path): Sha | null => trunk[path] ?? null;
  const relying = (id: string, writes: Record<Path, Sha | null>, assumptions: Path[]): Proposal => ({ ...prop(id, writes), assumptions });

  it("returns a change whose assumption is no longer on trunk", () => {
    const b = relying("b", { "src/b.ts": sha("2") }, ["src/gone.ts"]);
    const plan = planCycle([[entry(b, trunk)]], at);
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "b", reason: "stale: its imports resolve to src/gone.ts, which is no longer on trunk" }]);
  });

  it("returns a later batch's change whose assumption an earlier batch deletes, naming it", () => {
    const d = prop("d", { "src/util.ts": null });
    const b = relying("b", { "src/b.ts": sha("2") }, ["src/util.ts"]);
    const plan = planCycle([[entry(d, trunk)], [entry(b, trunk)]], at);
    expect(plan.accepted).toEqual([[d], []]);
    expect(plan.returned[1]).toEqual([{ proposalId: "b", reason: "stale: its imports resolve to src/util.ts, which d deletes, landing ahead in this cycle" }]);
  });

  it("returns a later batch's deletion of a file an accepted change's imports resolve to", () => {
    const b = relying("b", { "src/b.ts": sha("2") }, ["src/util.ts"]);
    const d = prop("d", { "src/util.ts": null });
    const plan = planCycle([[entry(b, trunk)], [entry(d, trunk)]], at);
    expect(plan.accepted).toEqual([[b], []]);
    expect(plan.returned[1]).toEqual([
      { proposalId: "d", reason: "conflicts with b, landing ahead in this cycle: this change deletes src/util.ts, which b's imports resolve to" },
    ]);
  });

  it("never puts a deletion and an import of the same file in one commit, whichever comes first", () => {
    const d = prop("d", { "src/util.ts": null });
    const b = relying("b", { "src/b.ts": sha("2") }, ["src/util.ts"]);
    const first = planCycle([[entry(d, trunk), entry(b, trunk)]], at);
    expect(first.accepted).toEqual([[d]]);
    expect(first.returned[0]).toEqual([{ proposalId: "b", reason: "conflicts with d in this landing: it deletes src/util.ts, which this change's imports resolve to" }]);
    const second = planCycle([[entry(b, trunk), entry(d, trunk)]], at);
    expect(second.accepted).toEqual([[b]]);
    expect(second.returned[0]).toEqual([{ proposalId: "d", reason: "conflicts with b in this landing: this change deletes src/util.ts, which b's imports resolve to" }]);
  });

  it("only existence counts: an edited assumption still lands, and two changes may rely on one file", () => {
    const e = prop("e", { "src/util.ts": sha("3") });
    const b = relying("b", { "src/b.ts": sha("2") }, ["src/util.ts"]);
    const c = relying("c", { "src/a.ts": sha("4") }, ["src/util.ts"]);
    const plan = planCycle([[entry(e, trunk)], [entry(b, trunk), entry(c, trunk)]], at);
    expect(plan.accepted).toEqual([[e], [b, c]]);
    expect(plan.returned).toEqual([[], []]);
  });
});

describe("planCycle: assumption revalidation (decision conflicts, not version conflicts)", () => {
  const S = "src/core/config.ts";
  const NEW = sha("1");
  const trunk: Record<Path, Sha | null> = { [S]: NEW, "src/core/other.ts": OLD, "src/a.ts": OLD };
  const at = (path: Path): Sha | null => trunk[path] ?? null;
  /** A reader that read S at OLD, writes its own new file, and imports `names` from S. */
  const reader = (id: string, names: NameAssumption[] | null, extra: { reads?: Record<Path, Sha | null>; writes?: Record<Path, Sha | null> } = {}): Proposal => ({
    ...prop(id, { [`src/core/${id}.ts`]: sha("9"), ...(extra.writes ?? {}) }, { [S]: OLD, ...(extra.reads ?? {}) }),
    ...(names ? { nameAssumptions: names } : {}),
  });
  const exportsOf = (by: Record<Sha, string[] | ExportSurface>): ExportedNames => (_path, blob) => {
    const e = by[blob];
    return e === undefined ? null : Array.isArray(e) ? { names: new Set(e), open: false } : e;
  };
  const staleReason = `stale: ${S} (expected ${OLD}, trunk has ${NEW})`;

  it("lands a change whose read file changed when every name it imports is still exported, and records it", () => {
    const r = reader("r", [{ path: S, names: ["config", "default"] }]);
    const plan = planCycle([[entry(r, trunk)]], at, exportsOf({ [NEW]: ["config", "default", "added"] }));
    expect(plan.accepted).toEqual([[r]]);
    expect(plan.returned).toEqual([[]]);
    expect(plan.revalidated.get("r")).toEqual([{ path: S, read: OLD, landedOn: NEW, names: ["config", "default"] }]);
  });

  it("returns it as today when revalidation is off (no exported names given)", () => {
    const r = reader("r", [{ path: S, names: ["config"] }]);
    const plan = planCycle([[entry(r, trunk)]], at);
    expect(plan.returned[0]).toEqual([{ proposalId: "r", reason: staleReason }]);
    expect(plan.revalidated.size).toBe(0);
  });

  it("returns a change whose imported name was removed, naming it", () => {
    const r = reader("r", [{ path: S, names: ["config", "load"] }]);
    const plan = planCycle([[entry(r, trunk)]], at, exportsOf({ [NEW]: ["config"] }));
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "r", reason: `${staleReason}; ${S} no longer exports load, which this change imports` }]);
  });

  it("returns a change whose imported name was renamed (the old name is gone, a new one appeared)", () => {
    const r = reader("r", [{ path: S, names: ["load"] }]);
    const plan = planCycle([[entry(r, trunk)]], at, exportsOf({ [NEW]: ["loadConfig"] }));
    expect(plan.returned[0]![0]!.reason).toContain(`${S} no longer exports load`);
  });

  it("still returns a write/write conflict as today, whatever the assumptions say", () => {
    const w = reader("w", [{ path: S, names: ["config"] }], { writes: { [S]: sha("2") } });
    const plan = planCycle([[entry(w, trunk, { [S]: OLD })]], at, exportsOf({ [NEW]: ["config"] }));
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "w", reason: staleReason }]);
  });

  it("returns a change whose import of the file gives no checkable names (a namespace import records no assumption)", () => {
    const r = reader("r", []);
    const plan = planCycle([[entry(r, trunk)]], at, exportsOf({ [NEW]: ["config"] }));
    expect(plan.returned[0]).toEqual([{ proposalId: "r", reason: staleReason }]);
  });

  it("returns as today when another stale read file has no assumption, or the exports cannot be read", () => {
    const r = reader("r", [{ path: S, names: ["config"] }], { reads: { "src/core/other.ts": sha("5") } });
    expect(planCycle([[entry(r, trunk)]], at, exportsOf({ [NEW]: ["config"] })).accepted).toEqual([[]]);
    const unread = reader("u", [{ path: S, names: ["config"] }]);
    expect(planCycle([[entry(unread, trunk)]], at, exportsOf({})).returned[0]).toEqual([{ proposalId: "u", reason: staleReason }]);
  });

  it("does not blame a name a file may re-export wholesale (export * is not followed)", () => {
    const r = reader("r", [{ path: S, names: ["load"] }]);
    const plan = planCycle([[entry(r, trunk)]], at, exportsOf({ [NEW]: { names: new Set(["config"]), open: true } }));
    expect(plan.returned[0]).toEqual([{ proposalId: "r", reason: staleReason }]);
  });

  it("checks against the virtual trunk: an earlier batch's new blob of the file", () => {
    const fresh: Record<Path, Sha | null> = { [S]: OLD };
    const freshAt = (path: Path): Sha | null => fresh[path] ?? null;
    const w = prop("w", { [S]: sha("2") });
    const keeps = reader("r", [{ path: S, names: ["config"] }]);
    const kept = planCycle([[entry(w, fresh)], [entry(keeps, fresh)]], freshAt, exportsOf({ [sha("2")]: ["config", "added"] }));
    expect(kept.accepted).toEqual([[w], [keeps]]);
    expect(kept.revalidated.get("r")).toEqual([{ path: S, read: OLD, landedOn: sha("2"), names: ["config"] }]);
    const drops = planCycle([[entry(w, fresh)], [entry(keeps, fresh)]], freshAt, exportsOf({ [sha("2")]: ["added"] }));
    expect(drops.accepted).toEqual([[w], []]);
    expect(drops.returned[1]![0]!.reason).toBe(`stale: ${S} (expected ${OLD}, trunk has ${sha("2")}, landing ahead in this cycle from w); ${S} no longer exports config, which this change imports`);
  });

  it("keeps the lane's rule inside one batch: a reader beside the writer of its file still conflicts", () => {
    const fresh: Record<Path, Sha | null> = { [S]: OLD };
    const w = prop("w", { [S]: sha("2") });
    const r = reader("r", [{ path: S, names: ["config"] }]);
    const plan = planCycle([[entry(w, fresh), entry(r, fresh)]], (path) => fresh[path] ?? null, exportsOf({ [sha("2")]: ["config"] }));
    expect(plan.accepted).toEqual([[w]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "r", reason: `conflicts with another proposal in this landing on ${S}` }]);
  });

  it("still applies the existence assumptions to a revalidated change", () => {
    const gone = { ...reader("r", [{ path: S, names: ["config"] }]), assumptions: ["src/core/deleted.ts"] };
    const plan = planCycle([[entry(gone, trunk)]], at, exportsOf({ [NEW]: ["config"] }));
    expect(plan.returned[0]).toEqual([{ proposalId: "r", reason: "stale: its imports resolve to src/core/deleted.ts, which is no longer on trunk" }]);
    expect(plan.revalidated.size).toBe(0);
  });
});

describe("assumption revalidation: what the trunk writer reads", () => {
  const S = "src/core/config.ts";
  it("asks for trunk's blob of each read file with a name assumption and every new blob the cycle writes there", () => {
    const reader = { ...prop("r", { "src/core/r.ts": sha("9") }, { [S]: OLD, "src/core/plain.ts": OLD }), nameAssumptions: [{ path: S, names: ["a"] }, { path: "src/core/unread.ts", names: ["b"] }] };
    const writer = prop("w", { [S]: sha("2") });
    const deleter = prop("d", { [S]: null });
    const trunk: Record<Path, Sha | null> = { [S]: sha("1"), "src/core/unread.ts": sha("3") };
    expect(surfaceBlobs([reader, writer, deleter], (path) => trunk[path] ?? null)).toEqual([sha("1"), sha("2")]);
    expect(surfaceBlobs([writer, { ...reader, nameAssumptions: "junk" as unknown as NameAssumption[] }], (path) => trunk[path] ?? null)).toEqual([]);
  });

  it("skips the version a proposal read: nothing changed under it there", () => {
    const reader = { ...prop("r", { "src/core/r.ts": sha("9") }, { [S]: OLD }), nameAssumptions: [{ path: S, names: ["a"] }] };
    expect(surfaceBlobs([reader], () => OLD)).toEqual([]);
    expect(surfaceBlobs([reader, prop("w", { [S]: sha("2") })], () => OLD)).toEqual([sha("2")]);
  });

  it("reads a version's exports from its bytes, and refuses binary, oversized or unreadable sources", () => {
    const enc = new TextEncoder();
    expect(exportSurface(enc.encode("export const a = 1;\nexport * from './b';\n"))).toEqual({ names: new Set(["a"]), open: true });
    expect(exportSurface(enc.encode("export function f() {}\n"))).toEqual({ names: new Set(["f"]), open: false });
    expect(exportSurface(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(exportSurface(enc.encode("export = thing;\n"))).toBeNull();
    expect(exportSurface(new Uint8Array(SURFACE_FILE_BYTES + 1))).toBeNull();
  });
});

describe("planCycle: deletion guard (FT_DELETION_GUARD)", () => {
  const X = "src/lib/x.ts";
  const trunk: Record<Path, Sha | null> = { [X]: OLD, "src/a.ts": OLD, "src/b.ts": OLD, "src/c.ts": OLD, "src/lib/y.js": OLD, "docs/x.md": OLD };
  const at = (path: Path): Sha | null => trunk[path] ?? null;
  /** What the import index answers: for each deleted path, its trunk importers with the targets of their imports. */
  const guard = (importers: Record<Path, Record<Path, string[]>>, targets: Record<Sha, string[]> = {}): DeletionImports => ({
    importers: new Map(Object.entries(importers).map(([path, by]) => [path, new Map(Object.entries(by))])),
    targets: new Map(Object.entries(targets)),
  });
  /** On trunk, src/a.ts and src/b.ts import "./lib/x". */
  const importedByAB = guard({ [X]: { "src/a.ts": ["src/lib/x"], "src/b.ts": ["src/lib/x"] } });
  const reason = (importers: string): string => `deleting ${X} breaks the imports of ${importers}: change them in the same change, or first`;

  it("returns a deletion whose importers landed in earlier cycles, naming them", () => {
    const d = prop("d", { [X]: null });
    const plan = planCycle([[entry(d, trunk)]], at, undefined, importedByAB);
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "d", reason: reason("src/a.ts and src/b.ts") }]);
  });

  it("lands as today when the guard is off (no import input)", () => {
    const d = prop("d", { [X]: null });
    expect(planCycle([[entry(d, trunk)]], at).accepted).toEqual([[d]]);
    expect(planCycle([[entry(d, trunk)]], at, undefined, null).accepted).toEqual([[d]]);
  });

  it("lands a deletion that deletes its importers in the same change", () => {
    const d = prop("d", { [X]: null, "src/a.ts": null, "src/b.ts": null });
    expect(planCycle([[entry(d, trunk)]], at, undefined, importedByAB).accepted).toEqual([[d]]);
    const partly = prop("p", { [X]: null, "src/a.ts": null });
    expect(planCycle([[entry(partly, trunk)]], at, undefined, importedByAB).returned[0]).toEqual([{ proposalId: "p", reason: reason("src/b.ts") }]);
  });

  it("lands a deletion whose importers are rewritten in the same cycle to drop the import, ahead of it or in the same change", () => {
    const fixA = prop("fa", { "src/a.ts": sha("5") });
    const fixB = prop("fb", { "src/b.ts": sha("6") });
    const d = prop("d", { [X]: null });
    const input = guard({ [X]: { "src/a.ts": ["src/lib/x"], "src/b.ts": ["src/lib/x"] } }, { [sha("5")]: ["src/lib/util"], [sha("6")]: [] });
    const plan = planCycle([[entry(fixA, trunk)], [entry(fixB, trunk), entry(d, trunk)]], at, undefined, input);
    expect(plan.accepted).toEqual([[fixA], [fixB, d]]);
    const same = prop("s", { [X]: null, "src/a.ts": sha("5"), "src/b.ts": sha("6") });
    expect(planCycle([[entry(same, trunk)]], at, undefined, input).accepted).toEqual([[same]]);
  });

  it("returns it when the rewrite keeps the import, or comes after it in the cycle", () => {
    const keeps = prop("k", { "src/a.ts": sha("5") });
    const d = prop("d", { [X]: null });
    const input = guard({ [X]: { "src/a.ts": ["src/lib/x"] } }, { [sha("5")]: ["src/lib/x", "src/lib/util"] });
    const kept = planCycle([[entry(keeps, trunk)], [entry(d, trunk)]], at, undefined, input);
    expect(kept.accepted).toEqual([[keeps], []]);
    expect(kept.returned[1]).toEqual([{ proposalId: "d", reason: reason("src/a.ts") }]);
    // A fix later in the cycle does not count: it is not on trunk yet when the deletion lands.
    const fix = prop("f", { "src/a.ts": sha("6") });
    const late = planCycle([[entry(d, trunk)], [entry(fix, trunk)]], at, undefined, guard({ [X]: { "src/a.ts": ["src/lib/x"] } }, { [sha("6")]: [] }));
    expect(late.accepted).toEqual([[], [fix]]);
    expect(late.returned[0]).toEqual([{ proposalId: "d", reason: reason("src/a.ts") }]);
  });

  it("serves one batch in order: a rewrite accepted before the deletion counts, one after it does not", () => {
    const fix = prop("f", { "src/a.ts": sha("5") });
    const d = prop("d", { [X]: null });
    const input = guard({ [X]: { "src/a.ts": ["src/lib/x"] } }, { [sha("5")]: [] });
    expect(planCycle([[entry(fix, trunk), entry(d, trunk)]], at, undefined, input).accepted).toEqual([[fix, d]]);
    const after = planCycle([[entry(d, trunk), entry(fix, trunk)]], at, undefined, input);
    expect(after.accepted).toEqual([[fix]]);
    expect(after.returned[0]).toEqual([{ proposalId: "d", reason: reason("src/a.ts") }]);
  });

  it("lands when the import finds another file once the change lands (moved into a directory, or a .js name's TypeScript twin)", () => {
    const moved = prop("m", { [X]: null, "src/lib/x/index.ts": sha("7") });
    expect(planCycle([[entry(moved, trunk)]], at, undefined, importedByAB).accepted).toEqual([[moved]]);
    const twin = prop("t", { "src/lib/y.js": null, "src/lib/y.ts": sha("8") });
    const input = guard({ "src/lib/y.js": { "src/c.ts": ["src/lib/y.js"] } });
    expect(planCycle([[entry(twin, trunk)]], at, undefined, input).accepted).toEqual([[twin]]);
    const gone = prop("g", { "src/lib/y.js": null });
    expect(planCycle([[entry(gone, trunk)]], at, undefined, input).returned[0]![0]!.reason).toBe(
      "deleting src/lib/y.js breaks the imports of src/c.ts: change them in the same change, or first",
    );
  });

  it("does not blame an import that resolves to another file before the change (a file beside a same-named directory wins)", () => {
    const both: Record<Path, Sha | null> = { [X]: OLD, "src/lib/x/index.ts": OLD, "src/a.ts": OLD };
    const d = prop("d", { "src/lib/x/index.ts": null });
    const input = guard({ "src/lib/x/index.ts": { "src/a.ts": ["src/lib/x"] } });
    expect(planCycle([[entry(d, both)]], (path) => both[path] ?? null, undefined, input).accepted).toEqual([[d]]);
  });

  it("names at most ten importers and three files, sorted", () => {
    const many: Record<Path, string[]> = {};
    for (let i = 11; i >= 0; i--) many[`src/i${String(i).padStart(2, "0")}.ts`] = ["src/lib/x"];
    const files: Record<Path, Sha | null> = { [X]: OLD, "src/lib/x2.ts": OLD, "src/lib/x3.ts": OLD, "src/lib/x4.ts": OLD };
    const d = prop("d", { [X]: null, "src/lib/x2.ts": null, "src/lib/x3.ts": null, "src/lib/x4.ts": null });
    const input = guard({ [X]: many, "src/lib/x2.ts": { "src/z.ts": ["src/lib/x2"] }, "src/lib/x3.ts": { "src/z.ts": ["src/lib/x3"] }, "src/lib/x4.ts": { "src/z.ts": ["src/lib/x4.ts"] } });
    const plan = planCycle([[entry(d, files)]], (path) => files[path] ?? (path.startsWith("src/i") || path === "src/z.ts" ? OLD : null), undefined, input);
    const names = Array.from({ length: 10 }, (_, i) => `src/i${String(i).padStart(2, "0")}.ts`).join(", ");
    expect(plan.returned[0]).toEqual([
      { proposalId: "d", reason: `deleting ${X}, src/lib/x2.ts, src/lib/x3.ts and 1 more breaks the imports of ${names} and 3 more: change them in the same change, or first` },
    ]);
  });

  it("leaves out an importer whose new version was not read, and gives a stale deletion its stale reason", () => {
    const fix = prop("f", { "src/a.ts": sha("5") });
    const d = prop("d", { [X]: null });
    const unread = guard({ [X]: { "src/a.ts": ["src/lib/x"] } });
    expect(planCycle([[entry(fix, trunk)], [entry(d, trunk)]], at, undefined, unread).accepted).toEqual([[fix], [d]]);
    const stale = planCycle([[entry(d, trunk, { [X]: sha("9") })]], at, undefined, importedByAB);
    expect(stale.returned[0]).toEqual([{ proposalId: "d", reason: `stale: ${X} (expected ${sha("9")}, trunk has ${OLD})` }]);
  });

  it("is on per colony, read like FT_REVALIDATE", () => {
    expect(deletionGuardEnabled(undefined, "c1")).toBe(false);
    expect(deletionGuardEnabled(" off ", "c1")).toBe(false);
    expect(deletionGuardEnabled("on", "c1")).toBe(true);
    expect(deletionGuardEnabled("c2, c1", "c1")).toBe(true);
    expect(deletionGuardEnabled("c2", "c1")).toBe(false);
  });
});
