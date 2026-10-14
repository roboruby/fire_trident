import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { FileVersion, Landing, MergeConflict, Path, Proposal, Sha } from "@fire_trident/core";
import { planCycle, resultsFor, type Outcome, type PlanProposal, type TextMergeInput } from "../../src/trunk/plan.ts";
import { settleLane } from "../../src/trunk/outcome.ts";

/**
 * The conflict resolver's trigger travels with a return (FT_RESOLVER): the cycle plan sends a change back with the files
 * whose text merge conflicted (paths, blobs, lines), the trunk writer's results carry them to the lane, and the lane
 * hands them on to the colony. Nothing else changes about any return.
 */

const F = "src/values.ts";

function lines(changes: Record<number, string> = {}): string {
  return Array.from({ length: 8 }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join("");
}

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
  const fv: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: base[w.path] ?? null }));
  return { p, base: fv };
}

describe("a return carries its text merge conflict", () => {
  it("names the file, its three blobs and the hunks, against a change landing ahead in the same cycle", () => {
    const t = loaded();
    const base = t.blob(lines());
    const a = t.blob(lines({ 6: "a six" }));
    const b = t.blob(lines({ 6: "b six", 8: "b eight" }));
    const pa = prop("a", { [F]: a });
    const pb = prop("b", { [F]: b });
    const plan = planCycle([[entry(pa, { [F]: base })], [entry(pb, { [F]: base })]], (path) => (path === F ? base : null), undefined, undefined, t.input);
    expect(plan.accepted.map((x) => x.map((p) => p.id))).toEqual([["a"], []]);
    const back = plan.returned[1]![0]!;
    expect(back.reason).toBe(`stale: ${F} (expected ${base}, trunk has ${a}, landing ahead in this cycle from a); text merge of ${F}: 1 conflicting hunk, at line 6 of its base`);
    expect(back.conflicts).toEqual([{ path: F, base, trunk: a, theirs: b, lines: [6] }]);
  });

  it("carries nothing for any other return: stale without text merge, or a merge that could not be tried", () => {
    const t = loaded();
    const base = t.blob(lines());
    const onTrunk = t.blob(lines({ 6: "trunk six" }));
    const mine = t.blob(lines({ 6: "mine six" }));
    const p = prop("p", { [F]: mine });
    const off = planCycle([[entry(p, { [F]: base })]], () => onTrunk);
    expect(off.returned[0]![0]!).not.toHaveProperty("conflicts");
    // The trunk writer did not load the texts (past its budget): no merge, no conflict named.
    const unread = planCycle([[entry(p, { [F]: base })]], () => onTrunk, undefined, undefined, { text: () => null, blobOf: blobId });
    expect(unread.returned[0]![0]!).not.toHaveProperty("conflicts");
    // A clean merge lands; nothing goes back.
    const clean = planCycle([[entry(prop("q", { [F]: t.blob(lines({ 2: "mine two" })) }), { [F]: base })]], () => onTrunk, undefined, undefined, t.input);
    expect(clean.returned).toEqual([[]]);
  });

  it("is in the trunk writer's result for the lane, and only where the outcome has it", () => {
    const conflict: MergeConflict = { path: F, base: "1".repeat(40), trunk: "2".repeat(40), theirs: "3".repeat(40), lines: [6] };
    const outcome = new Map<string, Outcome>([
      ["p", { kind: "returned", reason: "stale: conflict", conflicts: [conflict] }],
      ["q", { kind: "returned", reason: "stale: other" }],
    ]);
    const [r] = resultsFor([[prop("p", {}), prop("q", {})]], outcome, [undefined]);
    expect(r!.returned).toEqual([
      { proposalId: "p", reason: "stale: conflict", conflicts: [conflict] },
      { proposalId: "q", reason: "stale: other" },
    ]);
  });

  it("reaches the lane's returns (and so its patch to the colony), and nothing else changes for them", () => {
    const conflict: MergeConflict = { path: F, base: "1".repeat(40), trunk: "2".repeat(40), theirs: "3".repeat(40), lines: [6] };
    const p = prop("p", { [F]: "3".repeat(40) });
    const q = prop("q", { "src/other.ts": "4".repeat(40) });
    const landing: Landing = { id: "lnd_1", colonyId: "c", trunkSha: "5".repeat(40), parentSha: "6".repeat(40), proposalIds: [], intentIds: [], paths: [], regions: [], at: 0 };
    const s = settleLane({
      batch: [p, q],
      stale: [],
      result: { landing, returned: [{ proposalId: "p", reason: "stale: conflict", conflicts: [conflict] }, { proposalId: "q", reason: "stale: other", conflicts: [] }] },
      known: {},
      trunk: () => null,
    });
    expect(s.returned).toEqual([
      { p, id: "p", reason: "stale: conflict", conflicts: [conflict] },
      { p: q, id: "q", reason: "stale: other" },
    ]);
  });
});
