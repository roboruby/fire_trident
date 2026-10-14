import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { ExportSurface, ExportedNames, FileVersion, NameAssumption, Path, Proposal, Sha } from "@fire_trident/core";
import { exportSurface, mergeBlobs, planCycle, textMergeEnabled, type DeletionImports, type PlanProposal, type TextMergeInput } from "../../src/trunk/plan.ts";

/**
 * Text merge in the cycle plan (FT_TEXT_MERGE): a change stale only on files it writes lands when each of them merges
 * cleanly with the version on the virtual trunk. Blob ids are real git blob ids of the texts, as the trunk writer's are.
 */

/** The texts the trunk writer loaded for the cycle, by blob id. */
function loaded(): { blob(text: string): Sha; input: TextMergeInput; texts: Map<Sha, string> } {
  const texts = new Map<Sha, string>();
  return {
    texts,
    blob: (text) => {
      const id = blobId(text);
      texts.set(id, text);
      return id;
    },
    input: { text: (blob) => texts.get(blob) ?? null, blobOf: blobId },
  };
}

function prop(id: string, writes: Record<Path, Sha | null>, reads: Record<Path, Sha | null> = {}, extra: Partial<Proposal> = {}): Proposal {
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
    ...extra,
  };
}

/** A plan entry whose base holds `base` for its written paths. */
function entry(p: Proposal, base: Record<Path, Sha | null>): PlanProposal {
  const fv: FileVersion[] = p.writeSet.map((w) => ({ path: w.path, blob: w.path in base ? base[w.path]! : null }));
  return { p, base: fv };
}

/** Six numbered lines, with some of them replaced. */
function lines(changes: Record<number, string> = {}): string {
  return Array.from({ length: 6 }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join("");
}

const F = "src/app/main.ts";

describe("planCycle: text merge (FT_TEXT_MERGE)", () => {
  it("lands a change stale only on a file it writes when the file merges cleanly, and records the merge", () => {
    const t = loaded();
    const base = t.blob(lines());
    const onTrunk = t.blob(lines({ 1: "trunk changed line 1" }));
    const mine = t.blob(lines({ 5: "mine changed line 5" }));
    const other = t.blob("export const other = 1;\n");
    const trunk: Record<Path, Sha | null> = { [F]: onTrunk, "src/app/other.ts": base };
    const p = prop("p", { [F]: mine, "src/app/other.ts": other }, { [F]: base });
    const plan = planCycle([[entry(p, { [F]: base, "src/app/other.ts": base })]], (path) => trunk[path] ?? null, undefined, undefined, t.input);
    const text = lines({ 1: "trunk changed line 1", 5: "mine changed line 5" });
    const result = blobId(text);
    expect(plan.returned).toEqual([[]]);
    expect(plan.accepted[0]!.map((x) => x.writeSet)).toEqual([[{ path: F, blob: result }, { path: "src/app/other.ts", blob: other }]]);
    expect(plan.merged.get("p")).toEqual([{ path: F, base, trunk: onTrunk, theirs: mine, result }]);
    expect(plan.mergedTexts).toEqual(new Map([[result, text]]));
    // Nothing else about the change moves: its id, intent, read set.
    expect(plan.accepted[0]![0]!.id).toBe("p");
    expect(plan.accepted[0]![0]!.readSet).toEqual(p.readSet);
  });

  it("returns a change whose merge conflicts, naming the conflicting hunks and where they start in its base", () => {
    const t = loaded();
    const base = t.blob(lines());
    const onTrunk = t.blob(lines({ 2: "trunk two", 5: "trunk five" }));
    const mine = t.blob(lines({ 2: "mine two", 5: "mine five" }));
    const p = prop("p", { [F]: mine });
    const plan = planCycle([[entry(p, { [F]: base })]], (path) => (path === F ? onTrunk : null), undefined, undefined, t.input);
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]).toEqual([
      {
        proposalId: "p",
        reason: `stale: ${F} (expected ${base}, trunk has ${onTrunk}); text merge of ${F}: 2 conflicting hunks, at lines 2 and 5 of its base`,
        // The conflict travels with the return, for the conflict resolver (FT_RESOLVER).
        conflicts: [{ path: F, base, trunk: onTrunk, theirs: mine, lines: [2, 5] }],
      },
    ]);
    expect(plan.merged.size).toBe(0);
    // Edits side by side conflict too.
    const near = t.blob(lines({ 3: "mine three" }));
    const touching = planCycle([[entry(prop("q", { [F]: near }), { [F]: base })]], () => t.blob(lines({ 2: "trunk two" })), undefined, undefined, t.input);
    expect(touching.returned[0]![0]!.reason).toMatch(/; text merge of src\/app\/main\.ts: 1 conflicting hunk, at line 2 of its base$/);
  });

  it("does not merge a change stale on a file it only reads, even when the file it writes would merge", () => {
    const t = loaded();
    const base = t.blob(lines());
    const onTrunk = t.blob(lines({ 1: "trunk one" }));
    const mine = t.blob(lines({ 5: "mine five" }));
    const trunk: Record<Path, Sha | null> = { [F]: onTrunk, "src/app/read.ts": onTrunk };
    const p = prop("p", { [F]: mine }, { "src/app/read.ts": base });
    const plan = planCycle([[entry(p, { [F]: base })]], (path) => trunk[path] ?? null, undefined, undefined, t.input);
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "p", reason: `stale: src/app/read.ts (expected ${base}, trunk has ${onTrunk}), ${F} (expected ${base}, trunk has ${onTrunk})` }]);
  });

  it("merges against a change accepted earlier in the cycle, and the next change against that merge's result", () => {
    const t = loaded();
    const base = t.blob(lines());
    const a = t.blob(lines({ 1: "a one" }));
    const b = t.blob(lines({ 3: "b three" }));
    const c = t.blob(lines({ 5: "c five" }));
    const [pa, pb, pc] = [prop("a", { [F]: a }), prop("b", { [F]: b }), prop("c", { [F]: c })];
    const plan = planCycle([[entry(pa, { [F]: base })], [entry(pb, { [F]: base })], [entry(pc, { [F]: base })]], () => base, undefined, undefined, t.input);
    const ab = blobId(lines({ 1: "a one", 3: "b three" }));
    const abc = blobId(lines({ 1: "a one", 3: "b three", 5: "c five" }));
    expect(plan.returned).toEqual([[], [], []]);
    expect(plan.accepted.map((batch) => batch.map((x) => x.writeSet[0]!.blob))).toEqual([[a], [ab], [abc]]);
    expect(plan.merged.has("a")).toBe(false);
    expect(plan.merged.get("b")).toEqual([{ path: F, base, trunk: a, theirs: b, result: ab }]);
    // c merged with b's result, a text only the plan held.
    expect(plan.merged.get("c")).toEqual([{ path: F, base, trunk: ab, theirs: c, result: abc }]);
    expect([...plan.mergedTexts.keys()]).toEqual([ab, abc]);
  });

  it("lands a change whose edit is already on trunk (the same edit made twice counts once)", () => {
    const t = loaded();
    const base = t.blob(lines());
    const same = t.blob(lines({ 1: "fixed" }));
    const more = t.blob(lines({ 1: "fixed", 6: "and more" }));
    const plan = planCycle([[entry(prop("a", { [F]: same }), { [F]: base })], [entry(prop("b", { [F]: same }), { [F]: base })], [entry(prop("c", { [F]: more }), { [F]: base })]], () => base, undefined, undefined, t.input);
    expect(plan.returned).toEqual([[], [], []]);
    expect(plan.merged.get("b")).toEqual([{ path: F, base, trunk: same, theirs: same, result: same }]);
    expect(plan.merged.get("c")![0]!.result).toBe(more);
  });

  it("keeps the lane's rule inside one batch: two changes to one file in one commit still conflict", () => {
    const t = loaded();
    const base = t.blob(lines());
    const a = prop("a", { [F]: t.blob(lines({ 1: "a" })) });
    const b = prop("b", { [F]: t.blob(lines({ 5: "b" })) });
    const plan = planCycle([[entry(a, { [F]: base }), entry(b, { [F]: base })]], () => base, undefined, undefined, t.input);
    expect(plan.accepted).toEqual([[a]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "b", reason: `conflicts with another proposal in this landing on ${F}` }]);
  });

  it("leaves deletions, files gone from trunk or new in the base, binary files, lockfiles and unloaded texts to the rules as before", () => {
    const t = loaded();
    const base = t.blob(lines());
    const onTrunk = t.blob(lines({ 1: "trunk one" }));
    const mine = t.blob(lines({ 5: "mine five" }));
    const stale = (path: Path, expected: Sha | null, actual: Sha | null): string => `stale: ${path} (expected ${expected ?? "absent"}, trunk has ${actual ?? "absent"})`;
    const run = (p: Proposal, startedOn: Sha | null, now: Sha | null, input: TextMergeInput = t.input) =>
      planCycle([[entry(p, { [p.writeSet[0]!.path]: startedOn })]], () => now, undefined, undefined, input).returned[0];
    // A deletion of a file trunk changed.
    expect(run(prop("d", { [F]: null }), base, onTrunk)).toEqual([{ proposalId: "d", reason: stale(F, base, onTrunk) }]);
    // An edit of a file trunk deleted, and a file new in the change's base that trunk also added.
    expect(run(prop("g", { [F]: mine }), base, null)).toEqual([{ proposalId: "g", reason: stale(F, base, null) }]);
    expect(run(prop("n", { [F]: mine }), null, onTrunk)).toEqual([{ proposalId: "n", reason: stale(F, null, onTrunk) }]);
    // Binary content (a NUL byte) in any version.
    const binBase = t.blob(`${lines()}\0`);
    const binTrunk = t.blob(`${lines({ 1: "trunk one" })}\0`);
    const binMine = t.blob(`${lines({ 5: "mine five" })}\0`);
    expect(run(prop("x", { [F]: binMine }), binBase, binTrunk)).toEqual([{ proposalId: "x", reason: stale(F, binBase, binTrunk) }]);
    // A lockfile.
    expect(run(prop("l", { "package-lock.json": mine }), base, onTrunk)).toEqual([{ proposalId: "l", reason: stale("package-lock.json", base, onTrunk) }]);
    // A text the trunk writer did not load (too large, unreadable, past the cycle's budget).
    const without: TextMergeInput = { text: (blob) => (blob === onTrunk ? null : t.input.text(blob)), blobOf: blobId };
    expect(run(prop("u", { [F]: mine }), base, onTrunk, without)).toEqual([{ proposalId: "u", reason: stale(F, base, onTrunk) }]);
    // The same change with every text there lands.
    expect(planCycle([[entry(prop("ok", { [F]: mine }), { [F]: base })]], () => onTrunk, undefined, undefined, t.input).accepted[0]!.map((x) => x.id)).toEqual(["ok"]);
  });

  it("does not merge a file whose only staleness is what the change read of it (its base is still the version on trunk)", () => {
    const t = loaded();
    const base = t.blob(lines());
    const other = t.blob(lines({ 3: "a version it read" }));
    const p = prop("p", { [F]: t.blob(lines({ 5: "mine five" })) }, { [F]: other });
    const plan = planCycle([[entry(p, { [F]: base })]], () => base, undefined, undefined, t.input);
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "p", reason: `stale: ${F} (expected ${other}, trunk has ${base})` }]);
  });

  it("does not merge a file one side changed in more lines than the edit limit, and names no conflict", () => {
    const t = loaded();
    const many = (changes: (i: number) => string | null): string => Array.from({ length: 1_200 }, (_, i) => `${changes(i) ?? `line ${i}`}\n`).join("");
    const base = t.blob(many(() => null));
    const onTrunk = t.blob(many((i) => (i < 1_100 && i % 2 === 0 ? `trunk ${i}` : null)));
    const p = prop("p", { [F]: t.blob(many((i) => (i === 1_199 ? "mine" : null))) });
    const plan = planCycle([[entry(p, { [F]: base })]], () => onTrunk, undefined, undefined, t.input);
    expect(plan.returned[0]).toEqual([{ proposalId: "p", reason: `stale: ${F} (expected ${base}, trunk has ${onTrunk})` }]);
  });

  it("changes nothing when it is off (no merge input)", () => {
    const t = loaded();
    const base = t.blob(lines());
    const onTrunk = t.blob(lines({ 1: "trunk one" }));
    const p = prop("p", { [F]: t.blob(lines({ 5: "mine five" })) });
    const plan = planCycle([[entry(p, { [F]: base })]], () => onTrunk);
    expect(plan.accepted).toEqual([[]]);
    expect(plan.returned[0]).toEqual([{ proposalId: "p", reason: `stale: ${F} (expected ${base}, trunk has ${onTrunk})` }]);
    expect(plan.merged.size).toBe(0);
    expect(plan.mergedTexts.size).toBe(0);
  });

  /** A later reader of S, and what the trunk writer read: the exports and statements of every version it loaded, never the merged one. */
  function laterReader(t: ReturnType<typeof loaded>, S: string): { reader: Proposal; exported: ExportedNames } {
    const names: NameAssumption[] = [{ path: S, names: ["config"] }];
    const enc = new TextEncoder();
    return {
      reader: prop("r", { "src/core/r.ts": t.blob("r\n") }, { [S]: t.blob(lines()) }, { nameAssumptions: names }),
      exported: (path, blob) => {
        const text = t.texts.get(blob);
        return text === undefined ? null : exportSurface(enc.encode(text), path);
      },
    };
  }

  it("revalidates a later reader against the merged version's exports and statements (import-name revalidation)", () => {
    const t = loaded();
    const S = "src/core/config.ts";
    const text = (changes: Record<number, string>): string =>
      ["export const config = 1;", "export const a = 1;", "export const b = 1;", "export const c = 1;"].map((l, i) => `${changes[i + 1] ?? l}\n`).join("");
    const base = t.blob(text({}));
    // One writer adds a declaration after the first line, the other appends one: the merged version only grew.
    const w1 = t.blob(text({ 1: "export const config = 1;\nexport const z = 1;" }));
    const w2 = t.blob(text({ 4: "export const c = 1;\nexport const d = 1;" }));
    const merged = blobId(text({ 1: "export const config = 1;\nexport const z = 1;", 4: "export const c = 1;\nexport const d = 1;" }));
    const names: NameAssumption[] = [{ path: S, names: ["config"] }];
    const reader = prop("r", { "src/core/r.ts": t.blob("r\n") }, { [S]: base }, { nameAssumptions: names });
    const enc = new TextEncoder();
    // The trunk writer read the exports and statements of trunk's version and of each version a change writes, never the merged one.
    const exported: ExportedNames = (path, blob) => {
      const known = t.texts.get(blob);
      return known === undefined ? null : exportSurface(enc.encode(known), path);
    };
    const plan = planCycle(
      [[entry(prop("w1", { [S]: w1 }), { [S]: base })], [entry(prop("w2", { [S]: w2 }), { [S]: base })], [entry(reader, { "src/core/r.ts": null })]],
      (path) => (path === S ? base : null),
      exported,
      undefined,
      t.input,
    );
    expect(plan.accepted.map((batch) => batch.map((x) => x.id))).toEqual([["w1"], ["w2"], ["r"]]);
    expect(plan.revalidated.get("r")).toEqual([{ path: S, read: base, landedOn: merged, names: ["config"], grew: true }]);

    // The writers edit statements the reader read instead: the merged version did more than grow, and the reader goes back naming the line.
    const u = loaded();
    const ubase = u.blob(text({}));
    const e1 = u.blob(text({ 2: "export const a = 2;" }));
    const e2 = u.blob(text({ 4: "export const c = 2;" }));
    const ureader = prop("r", { "src/core/r.ts": u.blob("r\n") }, { [S]: ubase }, { nameAssumptions: names });
    const uexported: ExportedNames = (path, blob) => {
      const known = u.texts.get(blob);
      return known === undefined ? null : exportSurface(enc.encode(known), path);
    };
    const back = planCycle(
      [[entry(prop("w1", { [S]: e1 }), { [S]: ubase })], [entry(prop("w2", { [S]: e2 }), { [S]: ubase })], [entry(ureader, { "src/core/r.ts": null })]],
      (path) => (path === S ? ubase : null),
      uexported,
      undefined,
      u.input,
    );
    expect(back.accepted.map((batch) => batch.map((x) => x.id))).toEqual([["w1"], ["w2"], []]);
    expect(back.returned[2]![0]!.reason).toContain(`${S} changed after this change read it: the statement at line 2 of the version it read is no longer there as it was`);
    expect(back.revalidated.size).toBe(0);
  });

  it("guards a deletion against a merged importer's imports, read from its merged text (deletion guard)", () => {
    const t = loaded();
    const X = "src/lib/x.ts";
    const I = "src/a.ts";
    const importer = (changes: Record<number, string>): string =>
      ['import { x } from "./lib/x";', "const one = 1;", "const two = 2;", "const three = 3;", "export { x, one, two, three };"].map((l, i) => `${changes[i + 1] ?? l}\n`).join("");
    const base = t.blob(importer({}));
    const edit = t.blob(importer({ 4: "const three = 33;" }));
    const keeps = t.blob(importer({ 2: "const one = 11;" }));
    const drops = t.blob(importer({ 1: "const x = 0;" }));
    const trunk: Record<Path, Sha | null> = { [X]: t.blob("export const x = 1;\n"), [I]: base };
    // What the trunk writer's import index answers: trunk's I imports ./lib/x, and the new versions changes write.
    const guard = (targets: Record<Sha, string[]>): DeletionImports => ({ importers: new Map([[X, new Map([[I, ["src/lib/x"]]])]]), targets: new Map(Object.entries(targets)) });
    const del = prop("d", { [X]: null });
    const cycle = (second: Sha) =>
      planCycle(
        [[entry(prop("e", { [I]: edit }), { [I]: base })], [entry(prop("m", { [I]: second }), { [I]: base })], [entry(del, { [X]: trunk[X]! })]],
        (path) => trunk[path] ?? null,
        undefined,
        guard({ [edit]: ["src/lib/x"], [keeps]: ["src/lib/x"], [drops]: [] }),
        t.input,
      );
    const kept = cycle(keeps);
    expect(kept.merged.has("m")).toBe(true);
    expect(kept.accepted[2]).toEqual([]);
    expect(kept.returned[2]).toEqual([{ proposalId: "d", reason: `deleting ${X} breaks the imports of ${I}: change them in the same change, or first` }]);
    // The merged importer no longer imports the file: the deletion lands.
    const dropped = cycle(drops);
    expect(dropped.merged.has("m")).toBe(true);
    expect(dropped.accepted[2]!.map((x) => x.id)).toEqual(["d"]);
  });
});

describe("text merge: what the trunk writer loads", () => {
  it("lists, for each file a change writes on an older base or that several changes write, the base, trunk and written blobs", () => {
    const sha = (c: string): Sha => c.repeat(40);
    const trunk: Record<Path, Sha | null> = { "stale.ts": sha("1"), "fresh.ts": sha("2"), "shared.ts": sha("3"), "gone.ts": sha("4") };
    const entries: PlanProposal[] = [
      entry(prop("a", { "stale.ts": sha("a"), "fresh.ts": sha("b") }), { "stale.ts": sha("0"), "fresh.ts": sha("2") }),
      entry(prop("b", { "shared.ts": sha("c") }), { "shared.ts": sha("3") }),
      entry(prop("c", { "shared.ts": sha("d"), "gone.ts": null }), { "shared.ts": sha("3"), "gone.ts": sha("4") }),
      entry(prop("d", { "new.ts": sha("e") }), { "new.ts": null }),
      // A file trunk deleted: one change writes it anew, another edits the version it started from (it may merge onto the new one).
      entry(prop("e", { "back.ts": sha("f") }), { "back.ts": null }),
      entry(prop("f", { "back.ts": sha("6") }), { "back.ts": sha("5") }),
    ];
    expect(mergeBlobs(entries, (path) => trunk[path] ?? null)).toEqual([sha("0"), sha("1"), sha("a"), sha("3"), sha("c"), sha("d"), sha("5"), sha("6"), sha("f")]);
    // Nothing to read when every file a change writes is still at its base on trunk.
    expect(mergeBlobs([entries[0]!], (path) => (path === "stale.ts" ? sha("0") : sha("2")))).toEqual([]);
  });

  it("is on per colony, read like FT_REVALIDATE", () => {
    expect(textMergeEnabled(undefined, "c1")).toBe(false);
    expect(textMergeEnabled(" off ", "c1")).toBe(false);
    expect(textMergeEnabled("on", "c1")).toBe(true);
    expect(textMergeEnabled("c2, c1", "c1")).toBe(true);
    expect(textMergeEnabled("c2", "c1")).toBe(false);
  });
});
