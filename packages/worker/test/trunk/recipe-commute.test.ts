import { describe, expect, it } from "vitest";
import { applyRecipe, blobId, parseRecipe } from "@fire_trident/core";
import type { FileVersion, Path, Proposal, Recipe, Sha } from "@fire_trident/core";
import { isMergeHold } from "../../src/trunk/mergelock.ts";
import { planCycle, type PlanProposal, type TextMergeInput } from "../../src/trunk/plan.ts";
import type { LiveRecipe, RecipeInput } from "../../src/trunk/recipes.ts";

function recipe(input: Record<string, unknown>): Recipe {
  const r = parseRecipe(input);
  if (!r.ok) throw new Error(r.error);
  return r.recipe;
}

const RENAME = recipe({ kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope: ["src/**"] });

/** A recipe's output of one text (the test's own reference). */
function through(r: Recipe, path: Path, text: string): string {
  const o = applyRecipe(r, path, text);
  if (!o.ok) throw new Error(`${o.reason}: ${o.detail}`);
  return o.text;
}

/** Every text the tests use, by blob id: what the trunk writer would have loaded. */
const texts = new Map<Sha, string>();
function blob(text: string): Sha {
  const id = blobId(text);
  texts.set(id, text);
  return id;
}

const CORE = "export function compose(f, g) {\n  return (x) => f(g(x));\n}\n";
const USE = 'import { compose } from "./core.ts";\nexport const twice = (f) => compose(f, f);\n';
const USE_EDITED = `${USE}export const thrice = (f) => compose(f, compose(f, f));\n`;

/** Trunk after the rename landed as lnd_r: both files through the recipe. */
function renamedTrunk(): Record<Path, Sha | null> {
  return { "src/core.ts": blob(through(RENAME, "src/core.ts", CORE)), "src/use.ts": blob(through(RENAME, "src/use.ts", USE)) };
}

const LIVE: LiveRecipe = { id: "rcp_1", recipe: RENAME, landingId: "lnd_r", batches: [{ landingId: "lnd_r", from: null, through: "src/use.ts" }], cursor: "src/use.ts", doneSeq: 7 };

function input(live: LiveRecipe[] = [LIVE]): RecipeInput {
  return { later: () => live, text: (b) => texts.get(b) ?? null, blobOf: blob };
}

function proposal(id: string, writes: Record<Path, Sha | null>, reads: Record<Path, Sha | null> = {}, extra: Partial<Proposal> = {}): Proposal {
  return {
    id,
    colonyId: "c",
    intentId: `int_${id}`,
    agentId: `agt_${id}`,
    workspace: { namespace: "ft-ws-0", name: `c--ws-${id}`, remote: "https://example.invalid/ws.git" },
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    writeSet: Object.entries(writes).map(([path, b]) => ({ path, blob: b })),
    readSet: Object.entries(reads).map(([path, b]) => ({ path, blob: b })),
    declared: { footprint: Object.keys(writes), summary: id },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 0,
    ...extra,
  };
}

function entry(p: Proposal, base: Record<Path, Sha | null>, lock?: PlanProposal["lock"]): PlanProposal {
  const fv: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: base[w.path] ?? null }));
  return { p, base: fv, ...(lock ? { lock } : {}) };
}

describe("commutation: changes in flight built before a recipe landed", () => {
  it("lands an agent's change written before the rename with the new name applied, instead of sending it back", () => {
    const trunk = renamedTrunk();
    const at = (path: Path): Sha | null => trunk[path] ?? null;
    const p = proposal("a", { "src/use.ts": blob(USE_EDITED) }, { "src/use.ts": blob(USE), "src/core.ts": blob(CORE) });
    const e = entry(p, { "src/use.ts": blob(USE) });

    // Without the recipe it is stale on both files, and goes back.
    const plain = planCycle([[e]], at);
    expect(plain.accepted).toEqual([[]]);
    expect(plain.returned[0]![0]!.reason).toMatch(/^stale: /);

    const plan = planCycle([[e]], at, undefined, undefined, undefined, undefined, input());
    expect(plan.returned).toEqual([[]]);
    const landed = plan.accepted[0]![0]!;
    const want = through(RENAME, "src/use.ts", USE_EDITED);
    expect(want).not.toMatch(/\bcompose\b/);
    expect(landed.writeSet).toEqual([{ path: "src/use.ts", blob: blobId(want) }]);
    // What it read is recorded as it read it.
    expect(landed.readSet).toEqual(p.readSet);
    expect(plan.mergedTexts.get(blobId(want))).toBe(want);
    expect(plan.recipes?.get("a")).toEqual([{ recipe: "rcp_1", landing: "lnd_r", paths: ["src/use.ts"] }]);
  });

  it("lands a change that only read a file the recipe rewrote: its read is current through the recipe", () => {
    const trunk: Record<Path, Sha | null> = { ...renamedTrunk(), "src/new.ts": null };
    const at = (path: Path): Sha | null => trunk[path] ?? null;
    const NEW = 'import { compose } from "./core.ts";\nexport const id = compose((x) => x, (x) => x);\n';
    const p = proposal("b", { "src/new.ts": blob(NEW) }, { "src/core.ts": blob(CORE) }, { nameAssumptions: [{ path: "src/core.ts", names: ["compose"] }] });
    const plan = planCycle([[entry(p, {})]], at, undefined, undefined, undefined, undefined, input());
    expect(plan.returned).toEqual([[]]);
    expect(plan.accepted[0]![0]!.writeSet).toEqual([{ path: "src/new.ts", blob: blobId(through(RENAME, "src/new.ts", NEW)) }]);
  });

  it("sends back a change whose written file the recipe cannot read, naming the recipe's landing", () => {
    const trunk = renamedTrunk();
    const at = (path: Path): Sha | null => trunk[path] ?? null;
    const BROKEN = `${USE}const s = 'open;\n`;
    const p = proposal("c", { "src/use.ts": blob(BROKEN) }, { "src/use.ts": blob(USE) });
    const plan = planCycle([[entry(p, { "src/use.ts": blob(USE) })]], at, undefined, undefined, undefined, undefined, input());
    expect(plan.accepted).toEqual([[]]);
    const reason = plan.returned[0]![0]!.reason;
    expect(reason).toMatch(/^stale: src\/use\.ts/);
    expect(reason).toMatch(/recipe rcp_1 \(landing lnd_r\) could not rewrite src\/use\.ts \(unparsable: an unterminated string at line 3\), so it went back as stale/);
  });

  it("sends back a change whose written file is binary, naming the recipe", () => {
    const trunk = renamedTrunk();
    const at = (path: Path): Sha | null => trunk[path] ?? null;
    const binaryBlob = "9".repeat(40); // a version the trunk writer could not load as text
    const p = proposal("d", { "src/use.ts": binaryBlob });
    const plan = planCycle([[entry(p, { "src/use.ts": blob(USE) })]], at, undefined, undefined, undefined, undefined, input());
    expect(plan.returned[0]![0]!.reason).toMatch(/recipe rcp_1 \(landing lnd_r\) could not rewrite src\/use\.ts \(unread: its text was not loaded/);
  });

  it("holds a change a person approved for that person when the recipe would rewrite it, and lands it once they approve the rewrite", () => {
    const trunk = renamedTrunk();
    const at = (path: Path): Sha | null => trunk[path] ?? null;
    const p = proposal("e", { "src/use.ts": blob(USE_EDITED) }, { "src/use.ts": blob(USE) });
    const held = planCycle([[entry(p, { "src/use.ts": blob(USE) }, { approvedAt: 5 })]], at, undefined, undefined, undefined, undefined, input());
    expect(held.accepted).toEqual([[]]);
    const back = held.returned[0]![0]!;
    expect(isMergeHold(back.reason)).toBe(true);
    expect(back.reason).toMatch(/The rewrite of src\/use\.ts is recipe rcp_1 \(landing lnd_r\)'s, applied because this change was built before it landed\./);
    const result = blobId(through(RENAME, "src/use.ts", USE_EDITED));
    expect(back.held).toEqual([
      expect.objectContaining({ path: "src/use.ts", base: blob(USE), trunk: trunk["src/use.ts"], theirs: blob(USE_EDITED), result, trunkDiff: expect.objectContaining({ added: 2, removed: 2 }), mergedDiff: expect.objectContaining({ added: 3, removed: 3 }) }),
    ]);
    // The person approves exactly that rewrite: it lands.
    const consented = new Map([["src/use.ts", { trunk: trunk["src/use.ts"]!, result }]]);
    const plan = planCycle([[entry(p, { "src/use.ts": blob(USE) }, { approvedAt: 9, consented })]], at, undefined, undefined, undefined, undefined, input());
    expect(plan.accepted[0]!.map((x) => x.writeSet)).toEqual([[{ path: "src/use.ts", blob: result }]]);
  });

  it("merges line by line on the recipe's version of the base when trunk also changed the file after the recipe", () => {
    const header = "// a header another change added\n";
    const trunk: Record<Path, Sha | null> = { ...renamedTrunk(), "src/use.ts": blob(header + through(RENAME, "src/use.ts", USE)) };
    const at = (path: Path): Sha | null => trunk[path] ?? null;
    const p = proposal("f", { "src/use.ts": blob(USE_EDITED) });
    const merge: TextMergeInput = { text: (b) => texts.get(b) ?? null, blobOf: blob };
    const plan = planCycle([[entry(p, { "src/use.ts": blob(USE) })]], at, undefined, undefined, merge, undefined, input());
    expect(plan.returned).toEqual([[]]);
    const landed = plan.accepted[0]![0]!.writeSet[0]!.blob!;
    expect(plan.mergedTexts.get(landed)).toBe(header + through(RENAME, "src/use.ts", USE_EDITED));
    expect(plan.merged.get("f")?.[0]).toMatchObject({ path: "src/use.ts", base: blobId(through(RENAME, "src/use.ts", USE)) });
  });

  it("never makes a rewrite that adds a danger pattern: the change keeps its own version and the ordinary rules decide", () => {
    const swap = recipe({ kind: "text-replace", args: { find: "./safe-shell", replace: "child_process" }, scope: ["src/**"] });
    const RUN = 'import { run } from "./safe-shell";\nrun("ls");\n';
    const trunk: Record<Path, Sha | null> = { "src/run.ts": blob(through(swap, "src/run.ts", RUN)) };
    const at = (path: Path): Sha | null => trunk[path] ?? null;
    const live: LiveRecipe = { ...LIVE, id: "rcp_x", recipe: swap, landingId: "lnd_x", batches: [{ landingId: "lnd_x", from: null, through: "src/run.ts" }] };
    const p = proposal("g", { "src/run.ts": blob(`${RUN}run("pwd");\n`) });
    const plan = planCycle([[entry(p, { "src/run.ts": blob(RUN) })]], at, undefined, undefined, undefined, undefined, input([live]));
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]![0]!.reason).toMatch(/recipe rcp_x \(landing lnd_x\) could not rewrite src\/run\.ts \(its rewrite would add a danger pattern \(capability/);
  });

  it("already on trunk: reads the change's reads through the recipe, closing one that read trunk's version and sending back a stale read", () => {
    const merge: TextMergeInput = { text: (b) => texts.get(b) ?? null, blobOf: blob };
    // Read before the rename at the version the rename made trunk's: current through the recipe, and its write is there.
    const current: Record<Path, Sha | null> = { "src/use.ts": blob(through(RENAME, "src/use.ts", USE_EDITED)) };
    const p = proposal("i", { "src/use.ts": blob(USE_EDITED) }, { "src/use.ts": blob(USE_EDITED) });
    const closed = planCycle([[entry(p, { "src/use.ts": blob(USE_EDITED) })]], (path) => current[path] ?? null, undefined, undefined, merge, undefined, input(), true);
    expect(closed.onTrunk).toEqual([{ proposalId: "i" }]);
    expect(closed.accepted).toEqual([[]]);
    // Read before trunk also gained thrice(): the same edit, but not one it saw, so it goes back.
    const q = proposal("j", { "src/use.ts": blob(USE_EDITED) }, { "src/use.ts": blob(USE) });
    const back = planCycle([[entry(q, { "src/use.ts": blob(USE) })]], (path) => current[path] ?? null, undefined, undefined, merge, undefined, input(), true);
    expect(back.onTrunk).toBeUndefined();
    expect(back.returned[0]![0]!.reason).toMatch(/^stale: src\/use\.ts .*text merge stopped: this change repeats an edit trunk made after it read the file/);
  });

  it("leaves a change alone when no recipe applies to it", () => {
    const trunk = renamedTrunk();
    const at = (path: Path): Sha | null => trunk[path] ?? null;
    const p = proposal("h", { "src/use.ts": blob(USE_EDITED) });
    const plan = planCycle([[entry(p, { "src/use.ts": blob(USE) })]], at, undefined, undefined, undefined, undefined, input([]));
    expect(plan.returned[0]![0]!.reason).toMatch(/^stale: src\/use\.ts/);
    expect(plan.recipes).toBeUndefined();
  });
});
