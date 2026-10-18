import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { FileVersion, Landing, OccResult, Path, Proposal, Sha } from "@fire_trident/core";
import { planCycle, resultsFor, type Outcome, type PlanProposal, type TextMergeInput } from "../../src/trunk/plan.ts";
import { alreadyOnTrunkEnabled, foundOnTrunk, liftOnTrunk, onTrunkSourceOf, onTrunkSources, onTrunkText, onTrunkUpdates, type OnTrunkLog } from "../../src/trunk/ontrunk.ts";

/**
 * Already on trunk (FT_ALREADY_ON_TRUNK) in the cycle plan, the trunk writer's naming of where content came from, and the
 * lane's two steps. Blob ids are real git blob ids of the texts, as the trunk writer's are.
 */

const F = "src/app/main.ts";
const G = "src/app/other.ts";

/** Six numbered lines, with some of them replaced. */
function lines(changes: Record<number, string> = {}): string {
  return Array.from({ length: 6 }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join("");
}

/** The texts the trunk writer loaded for the cycle, by blob id. */
function loaded(): { blob(text: string): Sha; input: TextMergeInput } {
  const texts = new Map<Sha, string>();
  return {
    blob: (text) => {
      const id = blobId(text);
      texts.set(id, text);
      return id;
    },
    input: { text: (blob) => texts.get(blob) ?? null, blobOf: blobId },
  };
}

function prop(id: string, writes: Record<Path, Sha | null>, reads: Record<Path, Sha | null> = {}): Proposal {
  return {
    id,
    colonyId: "c",
    intentId: `int_${id}`,
    agentId: `agt_${id}`,
    workspace: { namespace: "ft-ws-0", name: `c--ws-${id}`, remote: "https://example.invalid/ws.git" },
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    writeSet: Object.entries(writes).map(([path, blob]) => ({ path, blob })),
    readSet: Object.entries(reads).map(([path, blob]) => ({ path, blob })),
    declared: { footprint: Object.keys(writes), summary: id },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 0,
  };
}

/** A plan entry whose base holds `base` for its written paths. */
function entry(p: Proposal, base: Record<Path, Sha | null>): PlanProposal {
  const fv: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: w.path in base ? base[w.path]! : null }));
  return { p, base: fv };
}

const ids = (batches: Proposal[][]): string[][] => batches.map((b) => b.map((p) => p.id));

describe("planCycle: already on trunk (FT_ALREADY_ON_TRUNK)", () => {
  const t = loaded();
  const base = t.blob(lines());
  const fix = t.blob(lines({ 2: "the same fix" }));
  const trunk: Record<Path, Sha | null> = { [F]: base, [G]: base };
  const at = (path: Path): Sha | null => trunk[path] ?? null;

  it("on: of two changes in one batch with the same content, the second lands nothing, naming the first", () => {
    const a = prop("a", { [F]: fix });
    const b = prop("b", { [F]: fix });
    const plan = planCycle([[entry(a, trunk), entry(b, trunk)]], at, undefined, undefined, undefined, undefined, undefined, true);
    expect(ids(plan.accepted)).toEqual([["a"]]);
    expect(plan.returned).toEqual([[]]);
    expect(plan.onTrunk).toEqual([{ proposalId: "b", by: "a" }]);
  });

  it("off: the second goes back as a conflict in the landing, as before", () => {
    const a = prop("a", { [F]: fix });
    const b = prop("b", { [F]: fix });
    const plan = planCycle([[entry(a, trunk), entry(b, trunk)]], at);
    expect(ids(plan.accepted)).toEqual([["a"]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "b", reason: `conflicts with another proposal in this landing on ${F}` }]);
    expect(plan.onTrunk).toBeUndefined();
  });

  it("on, with text merge: a later batch carrying what an earlier batch writes lands nothing (no empty commit)", () => {
    const a = prop("a", { [F]: fix });
    const b = prop("b", { [F]: fix });
    const plan = planCycle([[entry(a, trunk)], [entry(b, trunk)]], at, undefined, undefined, t.input, undefined, undefined, true);
    expect(ids(plan.accepted)).toEqual([["a"], []]);
    expect(plan.returned).toEqual([[], []]);
    expect(plan.merged.size).toBe(0);
    expect(plan.onTrunk).toEqual([{ proposalId: "b", by: "a" }]);
  });

  it("off, with text merge: it lands merged into a commit that changes nothing, as before", () => {
    const a = prop("a", { [F]: fix });
    const b = prop("b", { [F]: fix });
    const plan = planCycle([[entry(a, trunk)], [entry(b, trunk)]], at, undefined, undefined, t.input);
    expect(ids(plan.accepted)).toEqual([["a"], ["b"]]);
    expect(plan.merged.get("b")).toEqual([{ path: F, base, trunk: fix, theirs: fix, result: fix }]);
    expect(plan.onTrunk).toBeUndefined();
  });

  it("on, text merge off: a change from an older base whose writes trunk already holds lands nothing instead of going back stale", () => {
    const now: Record<Path, Sha | null> = { [F]: fix, [G]: base };
    const b = prop("b", { [F]: fix }, { [F]: base });
    const on = planCycle([[entry(b, { [F]: base })]], (path) => now[path] ?? null, undefined, undefined, undefined, undefined, undefined, true);
    expect(on.accepted).toEqual([[]]);
    expect(on.returned).toEqual([[]]);
    expect(on.onTrunk).toEqual([{ proposalId: "b" }]);
    const off = planCycle([[entry(b, { [F]: base })]], (path) => now[path] ?? null);
    expect(off.returned[0]![0]!.reason).toBe(`stale: ${F} (expected ${base}, trunk has ${fix})`);
  });

  it("on: a merge whose result is the version it merged with lands nothing (trunk already holds that edit and more)", () => {
    const both = t.blob(lines({ 2: "the same fix", 5: "another landing" }));
    const now: Record<Path, Sha | null> = { [F]: both };
    const b = prop("b", { [F]: fix });
    const on = planCycle([[entry(b, { [F]: base })]], (path) => now[path] ?? null, undefined, undefined, t.input, undefined, undefined, true);
    expect(on.accepted).toEqual([[]]);
    expect(on.onTrunk).toEqual([{ proposalId: "b" }]);
    expect(on.merged.size).toBe(0);
    const off = planCycle([[entry(b, { [F]: base })]], (path) => now[path] ?? null, undefined, undefined, t.input);
    expect(off.merged.get("b")).toEqual([{ path: F, base, trunk: both, theirs: fix, result: both }]);
  });

  it("on: a change that writes one file as trunk has it and another anew lands as before", () => {
    const other = t.blob("export const other = 2;\n");
    const now: Record<Path, Sha | null> = { [F]: fix, [G]: base };
    const b = prop("b", { [F]: fix, [G]: other });
    const plan = planCycle([[entry(b, { [F]: fix, [G]: base })]], (path) => now[path] ?? null, undefined, undefined, undefined, undefined, undefined, true);
    expect(ids(plan.accepted)).toEqual([["b"]]);
    expect(plan.onTrunk).toBeUndefined();
  });

  it("on: a deletion of a file trunk no longer has lands nothing; one of a file trunk has lands as before", () => {
    const gone = prop("gone", { "src/app/old.ts": null });
    const plan = planCycle([[entry(gone, { "src/app/old.ts": base })]], at, undefined, undefined, undefined, undefined, undefined, true);
    expect(plan.onTrunk).toEqual([{ proposalId: "gone" }]);
    const real = prop("real", { [G]: null });
    expect(ids(planCycle([[entry(real, trunk)]], at, undefined, undefined, undefined, undefined, undefined, true).accepted)).toEqual([["real"]]);
  });

  it("on: a change that lands nothing holds no place in its batch, so another that reads its file still lands", () => {
    const now: Record<Path, Sha | null> = { [F]: fix, [G]: base };
    // Written on a base that already had the fix (as a REST client may send it): current, and a write of nothing new.
    const same = prop("same", { [F]: fix });
    const reader = prop("reader", { [G]: t.blob("export const g = 1;\n") }, { [F]: fix });
    const input = [[entry(same, { [F]: fix }), entry(reader, { [G]: base })]];
    const on = planCycle(input, (path) => now[path] ?? null, undefined, undefined, undefined, undefined, undefined, true);
    expect(ids(on.accepted)).toEqual([["reader"]]);
    expect(on.onTrunk).toEqual([{ proposalId: "same" }]);
    const off = planCycle(input, (path) => now[path] ?? null);
    expect(ids(off.accepted)).toEqual([["same"]]);
    expect(off.returned[0]).toEqual([{ proposalId: "reader", reason: `conflicts with another proposal in this landing on ${F}` }]);
  });
});

describe("resultsFor: already on trunk", () => {
  it("answers a closed change in its request's onTrunk, never as landed, returned or deferred", () => {
    const a = prop("a", { [F]: "1".repeat(40) });
    const outcome = new Map<string, Outcome>([["a", { kind: "already", onTrunk: { proposalId: "a", source: { trunkSha: "2".repeat(40) }, reason: "r" } }]]);
    expect(resultsFor([[a]], outcome, [undefined])).toEqual([{ returned: [], onTrunk: [{ proposalId: "a", source: { trunkSha: "2".repeat(40) }, reason: "r" }] }]);
  });
});

describe("foundOnTrunk", () => {
  const X = "1".repeat(40);
  it("names the newest change of its own batch that wrote the file, else the earlier batch's writer, else none", () => {
    const p = prop("p", { [F]: X, [G]: X });
    const before = (): Sha | null => X;
    expect(foundOnTrunk(p, before, [prop("q", { [G]: X }), prop("r", { "x.ts": X })], new Map())).toEqual({ proposalId: "p", by: "q" });
    expect(foundOnTrunk(p, before, [], new Map([[G, { by: "s" }]]))).toEqual({ proposalId: "p", by: "s" });
    expect(foundOnTrunk(p, before, [], new Map())).toEqual({ proposalId: "p" });
    expect(foundOnTrunk(p, (path) => (path === F ? X : null), [], new Map())).toBeNull();
  });
});

describe("onTrunkSources: where the content came from", () => {
  const T = "7".repeat(40);
  const HEAD = "9".repeat(40);
  const landing = (id: string, proposalIds: string[], trunkSha = T): Landing => ({ id, colonyId: "c", trunkSha, parentSha: HEAD, proposalIds, intentIds: [], paths: [F], regions: ["src"], at: 1 });
  const none: OnTrunkLog = { lastChange: () => null };

  it("names the landing of this cycle that carries the change ahead of it, with its intent and agent", () => {
    const a = prop("a", { [F]: T });
    const b = prop("b", { [F]: T });
    const [o] = onTrunkSources([{ proposalId: "b", by: "a" }], new Map([["a", a], ["b", b]]), [landing("lnd_1", ["a"])], none, HEAD);
    expect(o).toEqual({
      proposalId: "b",
      source: { trunkSha: T, landingId: "lnd_1", proposalId: "a", intentId: "int_a", agentId: "agt_a", sameCycle: true },
      reason: `Your change is already on trunk: what it writes is there already, landed by agent agt_a in lnd_1 (commit 7777777, intent int_a, proposal a) in the same trunk cycle. Nothing landed for it and it was not sent back, so there is nothing to redo: take your next intent.`,
    });
  });

  it("else the landing that last changed its files, as the landing log and its note say", () => {
    const b = prop("b", { [F]: T, [G]: T });
    const asked: Path[][] = [];
    const log: OnTrunkLog = {
      lastChange: (paths) => {
        asked.push([...paths]);
        return { landing: landing("lnd_0", ["prp_x", "prp_y"]), writer: { proposalId: "prp_y", intentId: "int_y", agentId: "agt_y" } };
      },
    };
    const [o] = onTrunkSources([{ proposalId: "b" }], new Map([["b", b]]), [], log, HEAD);
    expect(asked).toEqual([[F, G]]);
    expect(o!.source).toEqual({ trunkSha: T, landingId: "lnd_0", proposalId: "prp_y", intentId: "int_y", agentId: "agt_y" });
    expect(o!.reason).toContain("landed by agent agt_y in lnd_0 (commit 7777777, intent int_y, proposal prp_y).");
  });

  it("else the trunk head, and the head too when the log cannot be read", () => {
    const b = prop("b", { [F]: T });
    const [o] = onTrunkSources([{ proposalId: "b" }], new Map([["b", b]]), [], none, HEAD);
    expect(o!.source).toEqual({ trunkSha: HEAD });
    expect(o!.reason).toBe("Your change is already on trunk: what it writes is there already at trunk commit 9999999. Nothing landed for it and it was not sent back, so there is nothing to redo: take your next intent.");
    const broken: OnTrunkLog = {
      lastChange: () => {
        throw new Error("no such table");
      },
    };
    expect(onTrunkSources([{ proposalId: "b" }], new Map([["b", b]]), [], broken, HEAD)[0]!.source).toEqual({ trunkSha: HEAD });
  });

  it("falls back to the log when the change ahead is in no landing of the chain", () => {
    const b = prop("b", { [F]: T });
    const log: OnTrunkLog = { lastChange: () => ({ landing: landing("lnd_old", []) }) };
    expect(onTrunkSources([{ proposalId: "b", by: "gone" }], new Map([["b", b]]), [], log, HEAD)[0]!.source).toEqual({ trunkSha: T, landingId: "lnd_old" });
  });
});

describe("onTrunkText and onTrunkSourceOf", () => {
  it("names the landing without an agent when none is known", () => {
    expect(onTrunkText({ trunkSha: "a".repeat(40), landingId: "lnd_5" })).toBe(
      "Your change is already on trunk: what it writes is there already, landed in lnd_5 (commit aaaaaaa). Nothing landed for it and it was not sent back, so there is nothing to redo: take your next intent.",
    );
  });

  it("keeps only well-formed fields, and reads anything else as no source", () => {
    expect(onTrunkSourceOf({ trunkSha: "a", landingId: "l", proposalId: 3, intentId: "", agentId: "g", sameCycle: "yes", extra: 1 })).toEqual({ trunkSha: "a", landingId: "l", agentId: "g" });
    expect(onTrunkSourceOf({ trunkSha: "a", sameCycle: true })).toEqual({ trunkSha: "a", sameCycle: true });
    for (const bad of [null, undefined, "x", {}, { trunkSha: "" }, { trunkSha: 5 }]) expect(onTrunkSourceOf(bad)).toBeNull();
  });
});

describe("the lane's steps", () => {
  const X = "1".repeat(40);
  const Y = "2".repeat(40);
  const stale = (p: Proposal): { p: Proposal; occ: OccResult } => ({ p, occ: { eligible: false, stale: [{ path: p.writeSet[0]!.path, expected: "0".repeat(40), actual: X }] } });

  it("liftOnTrunk moves only stale changes whose every write trunk holds, in order, as candidates", () => {
    const a = prop("a", { [F]: X });
    const b = prop("b", { [F]: Y });
    const c = prop("c", { [F]: X });
    const list = [stale(a), stale(b), stale(c)];
    const valid: Proposal[] = [prop("v", { [G]: Y })];
    const candidates = new Map<string, OccResult["stale"]>();
    expect(liftOnTrunk(list, valid, candidates, (path) => (path === F ? X : undefined))).toBe(2);
    expect(list.map((s) => s.p.id)).toEqual(["b"]);
    expect(valid.map((p) => p.id)).toEqual(["v", "a", "c"]);
    expect([...candidates.keys()]).toEqual(["a", "c"]);
  });

  it("onTrunkUpdates reports each closed change once, never one that landed, and skips malformed entries", () => {
    const source = { trunkSha: X, landingId: "lnd_1" };
    const updates = onTrunkUpdates(
      [{ proposalId: "a", source, reason: "said" }, { proposalId: "a", source, reason: "again" }, { proposalId: "landed", source }, { proposalId: "b", source: { trunkSha: X } }, { proposalId: "c" }, null, "x"],
      new Set(["landed"]),
    );
    expect(updates).toEqual([
      { id: "a", patch: { status: "already_on_trunk", reason: "said", onTrunk: source } },
      { id: "b", patch: { status: "already_on_trunk", reason: onTrunkText({ trunkSha: X }), onTrunk: { trunkSha: X } } },
    ]);
    expect(onTrunkUpdates(undefined, new Set())).toEqual([]);
  });

  it("alreadyOnTrunkEnabled reads the flag like FT_REVALIDATE", () => {
    expect(alreadyOnTrunkEnabled(undefined, "c1")).toBe(false);
    expect(alreadyOnTrunkEnabled("off", "c1")).toBe(false);
    expect(alreadyOnTrunkEnabled("", "c1")).toBe(false);
    expect(alreadyOnTrunkEnabled("on", "c1")).toBe(true);
    expect(alreadyOnTrunkEnabled("c0, c1", "c1")).toBe(true);
    expect(alreadyOnTrunkEnabled("c0", "c1")).toBe(false);
  });
});
