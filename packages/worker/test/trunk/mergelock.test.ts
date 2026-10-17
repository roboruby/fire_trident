import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { FileVersion, Path, Proposal, Sha } from "@fire_trident/core";
import { DANGER_CHECK } from "../../src/decide/danger.ts";
import { heldDiff, holdReason, isMergeHold, mergeHold, mergeLock, type MergeLock } from "../../src/trunk/mergelock.ts";
import { planCycle, type PlanProposal, type TextMergeInput } from "../../src/trunk/plan.ts";

/**
 * Merge locks in the cycle plan (trunk/mergelock.ts): a change a person approved, one with a danger pattern a person
 * must see, or one that writes a protected path never lands merged with a newer trunk on its own. Blob ids are real git
 * blob ids of the texts, as the trunk writer's are.
 */

/** The texts the trunk writer loaded for the cycle, by blob id. */
function loaded(insertions = false): { blob(text: string): Sha; input: TextMergeInput } {
  const texts = new Map<Sha, string>();
  return {
    blob: (text) => {
      const id = blobId(text);
      texts.set(id, text);
      return id;
    },
    input: { text: (blob) => texts.get(blob) ?? null, blobOf: blobId, ...(insertions ? { insertions: true } : {}) },
  };
}

function prop(id: string, writes: Record<Path, Sha | null>, extra: Partial<Proposal> = {}): Proposal {
  return {
    id,
    colonyId: "c",
    intentId: `int_${id}`,
    agentId: `agt_${id}`,
    workspace: { namespace: "ft-ws-0", name: `c--ws-${id}`, remote: "https://example.invalid/ws.git" },
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    writeSet: Object.entries(writes).map(([path, blob]) => ({ path, blob })),
    readSet: [],
    declared: { footprint: Object.keys(writes), summary: id },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 0,
    ...extra,
  };
}

/** A plan entry whose base holds `base` for its written paths, with `lock` when given. */
function entry(p: Proposal, base: Record<Path, Sha | null>, lock?: MergeLock): PlanProposal {
  const fv: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: w.path in base ? base[w.path]! : null }));
  return { p, base: fv, ...(lock ? { lock } : {}) };
}

/** Six numbered lines, with some of them replaced. */
function lines(changes: Record<number, string> = {}): string {
  return Array.from({ length: 6 }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join("");
}

const F = "src/app/main.ts";
const APPROVED: MergeLock = { approvedAt: 1_000 };
const short = (blob: Sha): string => blob.slice(0, 10);

/** A file trunk changed on line 1 since the change's base, and the change's edit of line 5. */
function moved(): { t: ReturnType<typeof loaded>; base: Sha; onTrunk: Sha; mine: Sha; result: Sha } {
  const t = loaded();
  const base = t.blob(lines());
  const onTrunk = t.blob(lines({ 1: "trunk one" }));
  const mine = t.blob(lines({ 5: "mine five" }));
  return { t, base, onTrunk, mine, result: blobId(lines({ 1: "trunk one", 5: "mine five" })) };
}

describe("mergeLock: what locks a change's files", () => {
  const human = (at: number) => [{ layer: "reflex", action: "escalate", at: at - 10 }, { layer: "human", action: "approve", at }];

  it("a person's approval, from the proposal or from the decisions its lane passed, the later of the two", () => {
    expect(mergeLock(prop("p", { [F]: null }), human(500), undefined)).toEqual({ approvedAt: 500 });
    expect(mergeLock(prop("p", { [F]: null }, { approvedAt: 700 }), undefined, undefined)).toEqual({ approvedAt: 700 });
    expect(mergeLock(prop("p", { [F]: null }, { approvedAt: 700 }), human(900), undefined)).toEqual({ approvedAt: 900 });
    // A person's return or rejection is no approval.
    expect(mergeLock(prop("p", { [F]: null }), [{ layer: "human", action: "return", at: 5 }], undefined)).toBeNull();
  });

  it("a danger pattern a person must see, recorded as a failed danger check, and a write the protected globs cover", () => {
    const danger = prop("p", { [F]: null }, { evidence: { checks: [{ name: DANGER_CHECK, ok: false, ms: 0, detail: "needs a human: governance" }] } });
    expect(mergeLock(danger, undefined, undefined)).toEqual({ approvedAt: null, needs: "danger" });
    const quiet = prop("p", { [F]: null }, { evidence: { checks: [{ name: DANGER_CHECK, ok: true, ms: 0 }] } });
    expect(mergeLock(quiet, undefined, undefined)).toBeNull();
    const record = { version: 1, globs: [{ glob: "src/app/**", at: 0 }] };
    expect(mergeLock(prop("p", { [F]: null }), undefined, record)).toEqual({ approvedAt: null, needs: "protected" });
    expect(mergeLock(prop("p", { "docs/x.md": null }), undefined, record)).toBeNull();
    // The decide stage names its check with the same constant; stored proposals carry this name, so it stays.
    expect(DANGER_CHECK).toBe("danger patterns");
  });

  it("an agent's ordinary change, and an old one with no approval field nor decisions, has none", () => {
    expect(mergeLock(prop("p", { [F]: null }), undefined, undefined)).toBeNull();
    expect(mergeLock(prop("p", { [F]: null }), [], { version: 1, globs: [] })).toBeNull();
  });
});

describe("planCycle with merge locks", () => {
  it("does not merge a change a person approved against an older trunk: it goes back to a person with the trunk delta", () => {
    const { t, base, onTrunk, mine, result } = moved();
    const p = prop("p", { [F]: mine });
    const plan = planCycle([[entry(p, { [F]: base }, APPROVED)]], () => onTrunk, undefined, undefined, t.input);
    expect(plan.accepted).toEqual([[]]);
    expect(plan.merged.size).toBe(0);
    expect(plan.mergedTexts.size).toBe(0);
    expect(plan.returned[0]).toEqual([
      {
        proposalId: "p",
        reason:
          `A person approved this change against an older trunk; trunk has since changed ${F} (${short(base)} at its base, ${short(onTrunk)} on trunk, merged as ${short(result)}), ` +
          "so it was not merged automatically. Review the merged result or the trunk change, both shown with it for review: approving it lands exactly this merge, and returning it sends it to its agent to redo on the new trunk.",
        held: [
          {
            path: F,
            base,
            trunk: onTrunk,
            theirs: mine,
            result,
            trunkDiff: heldDiff(F, lines(), lines({ 1: "trunk one" })),
            mergedDiff: heldDiff(F, lines({ 5: "mine five" }), lines({ 1: "trunk one", 5: "mine five" })),
          },
        ],
      },
    ]);
    expect(isMergeHold(plan.returned[0]![0]!.reason)).toBe(true);
    // What the person reads: trunk's change since the base, and the merged result against the approved version.
    const held = plan.returned[0]![0]!.held![0]!;
    expect(held.trunkDiff).toEqual({ hunks: "@@ -1,3 +1,3 @@\n-line 1\n+trunk one\n line 2\n line 3", added: 1, removed: 1, truncated: false });
    expect(held.mergedDiff).toEqual({ hunks: "@@ -1,3 +1,3 @@\n-line 1\n+trunk one\n line 2\n line 3", added: 1, removed: 1, truncated: false });
  });

  it("holds a change with a danger pattern or a protected write the same way, saying why", () => {
    const { t, base, onTrunk, mine } = moved();
    for (const [needs, opener] of [
      ["danger", "This change has a danger pattern a person must see and was decided against an older trunk; "],
      ["protected", "This change writes a protected path and was decided against an older trunk; "],
    ] as const) {
      const plan = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base }, { approvedAt: null, needs })]], () => onTrunk, undefined, undefined, t.input);
      expect(plan.accepted).toEqual([[]]);
      const back = plan.returned[0]![0]!;
      expect(back.reason.startsWith(opener)).toBe(true);
      expect(isMergeHold(back.reason)).toBe(true);
      expect(back.held?.map((h) => h.path)).toEqual([F]);
    }
  });

  it("still merges an agent's ordinary change as before", () => {
    const { t, base, onTrunk, mine, result } = moved();
    const plan = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base })]], () => onTrunk, undefined, undefined, t.input);
    expect(plan.returned).toEqual([[]]);
    expect(plan.accepted[0]!.map((x) => x.writeSet)).toEqual([[{ path: F, blob: result }]]);
  });

  it("lands a person-approved change whose files did not move with the very blobs approved", () => {
    const { t, base, mine } = moved();
    const plan = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base }, APPROVED)]], () => base, undefined, undefined, t.input);
    expect(plan.returned).toEqual([[]]);
    expect(plan.accepted[0]!.map((x) => x.writeSet)).toEqual([[{ path: F, blob: mine }]]);
    expect(plan.merged.size).toBe(0);
  });

  it("lands the merge a person approved after the hold, and holds again once trunk moved since", () => {
    const { t, base, onTrunk, mine, result } = moved();
    const agreed: MergeLock = { approvedAt: 2_000, consented: new Map([[F, { trunk: onTrunk, result }]]) };
    const plan = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base }, agreed)]], () => onTrunk, undefined, undefined, t.input);
    expect(plan.returned).toEqual([[]]);
    expect(plan.accepted[0]!.map((x) => x.writeSet)).toEqual([[{ path: F, blob: result }]]);
    expect(plan.merged.get("p")).toEqual([{ path: F, base, trunk: onTrunk, theirs: mine, result }]);
    // Trunk moved again: the approval was for another merge.
    const again = t.blob(lines({ 1: "trunk one", 2: "trunk two" }));
    const later = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base }, agreed)]], () => again, undefined, undefined, t.input);
    expect(later.accepted).toEqual([[]]);
    expect(later.returned[0]![0]!.held).toMatchObject([{ path: F, base, trunk: again, theirs: mine, result: blobId(lines({ 1: "trunk one", 2: "trunk two", 5: "mine five" })) }]);
  });

  it("needs no hold when the merge lands trunk's version as it is, or the change's own", () => {
    const t = loaded();
    const base = t.blob(lines());
    const same = t.blob(lines({ 2: "the same fix" }));
    // Trunk already has the change's edit: the merge changes nothing.
    const already = planCycle([[entry(prop("p", { [F]: same }), { [F]: base }, APPROVED)]], () => same, undefined, undefined, t.input);
    expect(already.returned).toEqual([[]]);
    expect(already.accepted[0]!.map((x) => x.writeSet)).toEqual([[{ path: F, blob: same }]]);
    // The change already holds trunk's edit: the merge is the change's own version.
    const mine = t.blob(lines({ 2: "the same fix", 4: "mine four" }));
    const contains = planCycle([[entry(prop("q", { [F]: mine }), { [F]: base }, APPROVED)]], () => same, undefined, undefined, t.input);
    expect(contains.returned).toEqual([[]]);
    expect(contains.accepted[0]!.map((x) => x.writeSet)).toEqual([[{ path: F, blob: mine }]]);
  });

  it("returns a locked change whose merge conflicts as before, without the conflicts the resolver would take", () => {
    const t = loaded();
    const base = t.blob(lines());
    const onTrunk = t.blob(lines({ 3: "trunk three" }));
    const mine = t.blob(lines({ 3: "mine three" }));
    const locked = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base }, APPROVED)]], () => onTrunk, undefined, undefined, t.input);
    expect(locked.returned[0]).toEqual([{ proposalId: "p", reason: `stale: ${F} (expected ${base}, trunk has ${onTrunk}); text merge of ${F}: 1 conflicting hunk, at line 3 of its base` }]);
    const open = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base })]], () => onTrunk, undefined, undefined, t.input);
    expect(open.returned[0]![0]!.conflicts).toEqual([{ path: F, base, trunk: onTrunk, theirs: mine, lines: [3] }]);
  });

  it("holds a merge the insertion rule would make", () => {
    const t = loaded(true);
    const base = t.blob("const a = 1;\nconst z = 9;\n");
    const onTrunk = t.blob("const a = 1;\nconst b = 2;\nconst z = 9;\n");
    const mine = t.blob("const a = 1;\nconst c = 3;\nconst z = 9;\n");
    const open = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base })]], () => onTrunk, undefined, undefined, t.input);
    expect(open.merged.get("p")?.[0]?.rule).toBe("insertions");
    const locked = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base }, APPROVED)]], () => onTrunk, undefined, undefined, t.input);
    expect(locked.accepted).toEqual([[]]);
    expect(isMergeHold(locked.returned[0]![0]!.reason)).toBe(true);
  });

  it("names the change landing ahead in the cycle that wrote trunk's version", () => {
    const t = loaded();
    const base = t.blob(lines());
    const a = t.blob(lines({ 1: "a one" }));
    const mine = t.blob(lines({ 5: "mine five" }));
    const plan = planCycle([[entry(prop("a", { [F]: a }), { [F]: base })], [entry(prop("p", { [F]: mine }), { [F]: base }, APPROVED)]], () => base, undefined, undefined, t.input);
    expect(plan.accepted.map((b) => b.map((x) => x.id))).toEqual([["a"], []]);
    expect(plan.returned[1]![0]!.held).toMatchObject([{ path: F, base, trunk: a, theirs: mine, result: blobId(lines({ 1: "a one", 5: "mine five" })), by: "a" }]);
    expect(plan.returned[1]![0]!.reason).toContain(`${short(a)} on trunk from a, landing ahead in this cycle`);
  });
});

describe("holdReason and isMergeHold", () => {
  it("names at most five files, and tells a hold from a stale or protected return", () => {
    const held = Array.from({ length: 7 }, (_, i) => ({ path: `src/f${i}.ts`, base: "a".repeat(40), trunk: "b".repeat(40), theirs: "d".repeat(40), result: "c".repeat(40) }));
    const reason = holdReason({ approvedAt: 1 }, held);
    expect(reason).toContain("src/f4.ts (aaaaaaaaaa at its base, bbbbbbbbbb on trunk, merged as cccccccccc) and 2 more, so it was not merged automatically.");
    expect(reason).not.toContain("src/f5.ts");
    expect(isMergeHold(reason)).toBe(true);
    expect(isMergeHold(`stale: ${F} (expected a, trunk has b)`)).toBe(false);
    expect(isMergeHold("newly protected: src/auth/x.ts (protected by src/auth/**) became protected after this change was cleared to land")).toBe(false);
    expect(isMergeHold(undefined)).toBe(false);
  });

  it("mergeHold leaves alone a change whose every merged file a person agreed to", () => {
    const f = { path: F, base: "a".repeat(40), trunk: "b".repeat(40), theirs: "d".repeat(40), result: "c".repeat(40) };
    expect(mergeHold({ approvedAt: 5, consented: new Map([[F, { trunk: f.trunk, result: f.result }]]) }, "p", [f], () => undefined)).toBeNull();
    expect(mergeHold({ approvedAt: 5, consented: new Map([[F, { trunk: f.trunk, result: "e".repeat(40) }]]) }, "p", [f], () => undefined)?.held).toEqual([
      { path: F, base: f.base, trunk: f.trunk, theirs: f.theirs, result: f.result },
    ]);
  });
});

describe("heldDiff: what a person reads of a held file", () => {
  it("masks a line that may hold a secret, as the review view does", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const d = heldDiff("src/a.ts", "const a = 1;\n", `const a = 1;\nconst t = '${token}';\n`)!;
    expect(d.hunks).toBe("@@ -1,1 +1,2 @@\n const a = 1;\n+… (masked: this line may hold a secret)");
    expect(d.hunks).not.toContain(token);
  });

  it("keeps about 60 lines, marked when cut, with the whole diff's counts; no diff without both texts", () => {
    const before = Array.from({ length: 100 }, (_, i) => `old ${i}\n`).join("");
    const after = Array.from({ length: 100 }, (_, i) => `new ${i}\n`).join("");
    const d = heldDiff("src/a.ts", before, after)!;
    const kept = d.hunks.split("\n");
    expect(kept).toHaveLength(61);
    expect(kept[60]).toBe("… (truncated)");
    expect(d).toMatchObject({ added: 100, removed: 100, truncated: true });
    expect(heldDiff("src/a.ts", null, after)).toBeUndefined();
  });

  it("carries diffs for the first five held files only, and blob ids for every one", () => {
    const t = loaded();
    const writes: Record<Path, Sha> = {};
    const bases: Record<Path, Sha> = {};
    const trunk: Record<Path, Sha> = {};
    for (let i = 0; i < 6; i++) {
      const path = `src/f${i}.ts`;
      bases[path] = t.blob(lines());
      trunk[path] = t.blob(lines({ 1: `trunk ${i}` }));
      writes[path] = t.blob(lines({ 5: `mine ${i}` }));
    }
    const plan = planCycle([[entry(prop("p", writes), bases, APPROVED)]], (path) => trunk[path] ?? null, undefined, undefined, t.input);
    const held = plan.returned[0]![0]!.held!;
    expect(held.map((h) => h.path)).toEqual(Object.keys(writes));
    expect(held.slice(0, 5).every((h) => h.trunkDiff !== undefined && h.mergedDiff !== undefined)).toBe(true);
    expect(held[5]).toEqual({ path: "src/f5.ts", base: bases["src/f5.ts"], trunk: trunk["src/f5.ts"], theirs: writes["src/f5.ts"], result: blobId(lines({ 1: "trunk 5", 5: "mine 5" })) });
  });
});
