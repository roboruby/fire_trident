import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { FileVersion, Path, Proposal, Sha } from "@fire_trident/core";
import { mergeInsertionsEnabled, planCycle, type PlanProposal, type TextMergeInput } from "../../src/trunk/plan.ts";

/**
 * Text merge's insertion rule in the cycle plan (FT_MERGE_INSERTIONS): a change whose only conflicts with the version it
 * lands on are lines both inserted at one place lands as the union of the two insertions, and its merge says so.
 */

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

function prop(id: string, writes: Record<Path, Sha | null>): Proposal {
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
  };
}

function entry(p: Proposal, base: Record<Path, Sha | null>): PlanProposal {
  const fv: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: w.path in base ? base[w.path]! : null }));
  return { p, base: fv };
}

const F = "src/values.ts";
const SEED = "export const v1 = 1;\nexport const v2 = 2;\n";

describe("FT_MERGE_INSERTIONS", () => {
  it("is off when absent or off, on for every colony or for the listed ones", () => {
    for (const setting of [undefined, "", "off", " OFF "]) expect(mergeInsertionsEnabled(setting, "c1")).toBe(false);
    expect(mergeInsertionsEnabled("on", "c1")).toBe(true);
    expect(mergeInsertionsEnabled("c0, c1", "c1")).toBe(true);
    expect(mergeInsertionsEnabled("c0,c2", "c1")).toBe(false);
  });
});

describe("planCycle: the insertion rule", () => {
  it("lands a change that appended a line where trunk appended another, trunk's line first, recording the rule", () => {
    const t = loaded();
    const base = t.blob(SEED);
    const onTrunk = t.blob(`${SEED}export const a = 1;\n`);
    const mine = t.blob(`${SEED}export const b = 2;\n`);
    const p = prop("p", { [F]: mine });
    const plan = planCycle([[entry(p, { [F]: base })]], (path) => (path === F ? onTrunk : null), undefined, undefined, { ...t.input, insertions: true });
    const text = `${SEED}export const a = 1;\nexport const b = 2;\n`;
    const result = blobId(text);
    expect(plan.returned).toEqual([[]]);
    expect(plan.accepted[0]!.map((x) => x.writeSet)).toEqual([[{ path: F, blob: result }]]);
    expect(plan.merged.get("p")).toEqual([{ path: F, base, trunk: onTrunk, theirs: mine, result, rule: "insertions" }]);
    expect(plan.mergedTexts).toEqual(new Map([[result, text]]));
  });

  it("without the rule, the same change goes back naming the hunk, as before", () => {
    const t = loaded();
    const base = t.blob(SEED);
    const onTrunk = t.blob(`${SEED}export const a = 1;\n`);
    const mine = t.blob(`${SEED}export const b = 2;\n`);
    const plan = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base })]], () => onTrunk, undefined, undefined, t.input);
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]![0]).toEqual({
      proposalId: "p",
      reason: `stale: ${F} (expected ${base}, trunk has ${onTrunk}); text merge of ${F}: 1 conflicting hunk, at line 3 of its base`,
      conflicts: [{ path: F, base, trunk: onTrunk, theirs: mine, lines: [3] }],
    });
  });

  it("with the rule, a change whose other hunk edits a line trunk edited still goes back, naming every hunk", () => {
    const t = loaded();
    const base = t.blob(SEED);
    const onTrunk = t.blob("export const v1 = 10;\nexport const v2 = 2;\nexport const a = 1;\n");
    const mine = t.blob("export const v1 = 11;\nexport const v2 = 2;\nexport const b = 2;\n");
    const plan = planCycle([[entry(prop("p", { [F]: mine }), { [F]: base })]], () => onTrunk, undefined, undefined, { ...t.input, insertions: true });
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]![0]!.reason).toMatch(/; text merge of src\/values\.ts: 2 conflicting hunks, at lines 1 and 3 of its base$/);
    expect(plan.merged.size).toBe(0);
  });

  it("merges a change against an append accepted earlier in the same cycle, and a clean merge names no rule", () => {
    const t = loaded();
    const base = t.blob(SEED);
    const a = t.blob(`${SEED}export const a = 1;\n`);
    const b = t.blob(`${SEED}export const b = 2;\n`);
    const c = t.blob(`export const v0 = 0;\n${SEED}`);
    const plan = planCycle(
      [[entry(prop("a", { [F]: a }), { [F]: base })], [entry(prop("b", { [F]: b }), { [F]: base })], [entry(prop("c", { [F]: c }), { [F]: base })]],
      () => base,
      undefined,
      undefined,
      { ...t.input, insertions: true },
    );
    expect(plan.returned).toEqual([[], [], []]);
    const both = blobId(`${SEED}export const a = 1;\nexport const b = 2;\n`);
    expect(plan.merged.get("b")).toEqual([{ path: F, base, trunk: a, theirs: b, result: both, rule: "insertions" }]);
    // The third change inserted at the top: git's rules merge it with the others' appends, so no rule is named.
    const all = blobId(`export const v0 = 0;\n${SEED}export const a = 1;\nexport const b = 2;\n`);
    expect(plan.merged.get("c")).toEqual([{ path: F, base, trunk: both, theirs: c, result: all }]);
  });
});
