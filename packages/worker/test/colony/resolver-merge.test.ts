import { describe, expect, it } from "vitest";
import { mergeText } from "@fire_trident/core";
import { checkMerged, cleanConflicts, cleanResolves, isMarker, keptLines, lineLikeness, mergeSides, noteResolves, type ConflictedMerge } from "../../src/colony/resolver-merge.ts";

/** The conflict resolver's merge split and the validation of a model's merged text (colony/resolver-merge.ts). */

/** Eight numbered lines, some replaced (a value of null drops the line). */
function file(changes: Record<number, string | null> = {}): string {
  return Array.from({ length: 8 }, (_, i) => {
    const n = i + 1;
    const c = changes[n];
    return c === null ? "" : `${c ?? `export const v${n} = ${n};`}\n`;
  }).join("");
}

const BASE = file();
// Trunk renamed v6 and changed v2; the change set v6 to 66 and changed v8.
const OURS = file({ 2: "export const v2 = 20;", 6: "export const six = 6;" });
const THEIRS = file({ 6: "export const v6 = 66;", 8: "export const v8 = 80;" });
const BOTH = file({ 2: "export const v2 = 20;", 6: "export const six = 66;", 8: "export const v8 = 80;" });

function conflicted(base: string, ours: string, theirs: string): ConflictedMerge {
  const m = mergeSides(base, ours, theirs);
  if (m.clean || m.limited) throw new Error("expected a conflict");
  return m;
}

/** A small deterministic random source (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random edit of a text: lines replaced, dropped or inserted, from a small alphabet so lines repeat. */
function edit(text: string, r: () => number): string {
  const lines = text.split("\n").slice(0, -1);
  const out: string[] = [];
  for (const line of lines) {
    const x = r();
    if (x < 0.12) out.push(`x${Math.floor(r() * 4)}`);
    else if (x < 0.2) continue;
    else if (x < 0.28) out.push(line, `y${Math.floor(r() * 3)}`);
    else out.push(line);
  }
  return out.map((l) => `${l}\n`).join("");
}

describe("mergeSides", () => {
  it("merges what one side changed and splits at the hunk both changed differently", () => {
    const m = conflicted(BASE, OURS, THEIRS);
    expect(m.conflicts).toEqual([{ line: 6, base: ["export const v6 = 6;\n"], ours: ["export const six = 6;\n"], theirs: ["export const v6 = 66;\n"], oursLine: 6, theirsLine: 6 }]);
    expect(m.segments.map((s) => s.join(""))).toEqual([file({ 2: "export const v2 = 20;", 6: null, 7: null, 8: null }), "export const v7 = 7;\nexport const v8 = 80;\n"]);
  });

  it("is clean where core mergeText is clean, with the same text", () => {
    expect(mergeSides(BASE, OURS, file({ 8: "export const v8 = 80;" }))).toEqual({ clean: true, text: file({ 2: "export const v2 = 20;", 6: "export const six = 6;", 8: "export const v8 = 80;" }) });
    expect(mergeSides(BASE, BASE, THEIRS)).toEqual({ clean: true, text: THEIRS });
    expect(mergeSides(BASE, OURS, BASE)).toEqual({ clean: true, text: OURS });
  });

  it("agrees with core mergeText on every decision (random edits of one text, lines that repeat)", () => {
    const r = rng(7);
    let conflicts = 0;
    let accepted = 0;
    for (let n = 0; n < 400; n++) {
      const base = Array.from({ length: 4 + Math.floor(r() * 10) }, () => `l${Math.floor(r() * 5)}\n`).join("");
      const ours = edit(base, r);
      const theirs = edit(base, r);
      const core = mergeText(base, ours, theirs);
      const mine = mergeSides(base, ours, theirs);
      expect(mine.clean).toBe(core.clean);
      if (core.clean && mine.clean) expect(mine.text).toBe(core.text);
      if (!core.clean && !mine.clean && !mine.limited) {
        conflicts++;
        expect(mine.conflicts.map((c) => c.line)).toEqual(core.lines);
        expect(mine.segments).toHaveLength(mine.conflicts.length + 1);
        // The segments with each conflict resolved one way: trunk's side alone is always refused (it drops the change's
        // edit there), however the lines repeat; both sides' lines are kept when that is no side's version whole and
        // each segment between conflicts fits in one place only (otherwise the check may refuse it as ambiguous).
        const resolved = (pick: (c: ConflictedMerge["conflicts"][number]) => string[]) => mine.segments.flatMap((s, i) => [...(i > 0 ? pick(mine.conflicts[i - 1]!) : []), ...s]).join("");
        expect(checkMerged(mine, resolved((c) => c.ours)).ok).toBe(false);
        expect(checkMerged(mine, resolved((c) => c.theirs)).ok).toBe(false);
        const both = (c: ConflictedMerge["conflicts"][number]) => [...c.ours, ...c.theirs];
        const whole = mine.conflicts.some((c) => [c.ours, c.theirs, c.base].some((v) => v.join("") === both(c).join("")));
        const text = resolved(both);
        const runs = (seg: string[]) => text.split("\n").slice(0, -1).filter((_, i, all) => seg.every((l, q) => `${all[i + q]}\n` === l)).length;
        if (!whole && mine.segments.slice(1, -1).every((s) => runs(s) === 1)) {
          accepted++;
          expect(checkMerged(mine, text)).toMatchObject({ ok: true });
        }
      }
    }
    expect(conflicts).toBeGreaterThan(20);
    expect(accepted).toBeGreaterThan(10);
  });

  it("gives up as core does when a side changed more than the edit limit", () => {
    expect(mergeSides("a\nb\n", "c\nd\n", "e\nf\n", 1)).toEqual({ clean: false, limited: true });
  });
});

describe("checkMerged", () => {
  const m = conflicted(BASE, OURS, THEIRS);

  it("accepts a merge that keeps both changes, and returns how each conflict was resolved", () => {
    expect(checkMerged(m, BOTH)).toEqual({ ok: true, resolutions: [["export const six = 66;\n"]] });
  });

  it("accepts lines added inside the conflicting hunk", () => {
    expect(checkMerged(m, file({ 2: "export const v2 = 20;", 6: "export const six = 66;\nexport const v6 = six;", 8: "export const v8 = 80;" })).ok).toBe(true);
  });

  it("rejects a merge that drops trunk's change outside the conflicting hunk", () => {
    expect(checkMerged(m, file({ 6: "export const six = 66;", 8: "export const v8 = 80;" }))).toEqual({ ok: false, problem: "changes or drops line 2, which is outside the conflicting hunks" });
  });

  it("rejects a merge that drops the change's own edit outside the conflicting hunk", () => {
    const r = checkMerged(m, file({ 2: "export const v2 = 20;", 6: "export const six = 66;" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problem).toMatch(/after the last conflicting hunk/);
  });

  it("rejects a merge that changes a line neither side changed", () => {
    expect(checkMerged(m, file({ 2: "export const v2 = 20;", 3: "export const v3 = 300;", 6: "export const six = 66;", 8: "export const v8 = 80;" })).ok).toBe(false);
  });

  it("rejects a conflicting hunk resolved to one side's version whole, or to the base's", () => {
    const pick = (line6: string) => checkMerged(m, file({ 2: "export const v2 = 20;", 6: line6, 8: "export const v8 = 80;" }));
    expect(pick("export const six = 6;")).toEqual({ ok: false, problem: "takes trunk's version of the conflicting hunk at line 6 of the base whole, which drops the change's edit there" });
    expect(pick("export const v6 = 66;")).toEqual({ ok: false, problem: "takes the change's version of the conflicting hunk at line 6 of the base whole, which drops the edit that landed first" });
    expect(pick("export const v6 = 6;")).toEqual({ ok: false, problem: "puts back the base version of the conflicting hunk at line 6 of the base, which drops both changes there" });
  });

  it("rejects a conflict marker left in a resolved hunk, unless the versions had that line", () => {
    const r = checkMerged(m, file({ 2: "export const v2 = 20;", 6: "<<<<<<< trunk\nexport const six = 66;", 8: "export const v8 = 80;" }));
    expect(r).toEqual({ ok: false, problem: "leaves a conflict marker in the conflicting hunk at line 6 of the base" });
    const md = conflicted("Title\n=======\ntext\n", "Title\n=======\ntext one\n", "Title\n=======\ntext two\n");
    expect(checkMerged(md, "Title\n=======\ntext one and two\n").ok).toBe(true);
    expect(isMarker(">>>>>>> change\n")).toBe(true);
    expect(isMarker("=======\r\n")).toBe(true);
    expect(isMarker("======== not one\n")).toBe(false);
  });

  it("accepts two deletions merged to nothing", () => {
    const d = conflicted("a\nb\nc\nd\n", "a\nc\nd\n", "a\nb\nd\n");
    expect(checkMerged(d, "a\nd\n")).toEqual({ ok: true, resolutions: [[]] });
  });

  it("finds every segment in order with several conflicts, even where a resolution repeats a segment's line", () => {
    // Both sides rewrote the same two lines: each rewrite shares words with the line it replaced, so the merge combines them.
    const base = "let a = 0;\n}\nlet b = 0;\n}\nc\n";
    const multi = conflicted(base, "let a = 1;\n}\nlet b = 1;\n}\nc\n", "let a = 2;\n}\nlet b = 2;\n}\nc\n");
    expect(multi.conflicts.map((c) => c.line)).toEqual([1, 3]);
    expect(checkMerged(multi, "let a = 3;\n}\nlet b = 3;\n}\nc\n")).toEqual({ ok: true, resolutions: [["let a = 3;\n"], ["let b = 3;\n"]] });
    expect(checkMerged(multi, "let a = 3;\n}\nlet b = 3;\nc\n").ok).toBe(false);
  });

  it("refuses trunk's side taken whole even where a repeated line lets the segments fit elsewhere", () => {
    const base = "l3\nl2\nl3\nl2\nl3\nl3\nl3\nl2\nl3\nl3\nl3\nl4\n";
    const ours = "l3\nl2\nl3\nl3\ny2\nl3\ny2\nx2\nl2\nl3\nl3\ny0\nl3\nl4\n";
    const theirs = "l3\nl2\nx1\nl2\nx0\nl3\ny2\nx2\nx3\nl3\nl3\nl3\nl4\n";
    const c = conflicted(base, ours, theirs);
    // Segment [l3] fits right after the first hunk's trunk line as well as where it belongs. That placement is tried
    // first, and there the first hunk keeps none of the lines the change added.
    const trunkSide = c.segments.flatMap((s, i) => [...(i > 0 ? c.conflicts[i - 1]!.ours : []), ...s]).join("");
    expect(checkMerged(c, trunkSide)).toEqual({ ok: false, problem: "drops a line the change added in the conflicting hunk at line 3 of the base (line 3 of the change's version)" });
  });

  it("refuses a text whose repeated lines make too many placements to try", () => {
    const n = 40;
    // Both sides rewrote every value line (each rewrite shares words with its base line), so no line has to be kept and
    // the extra "}" lines of the merge let every resolution start and end in many places.
    const base = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `let v${i} = 0;\n` : "}\n")).join("");
    const ours = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `let v${i} = 1;\n` : "}\n")).join("");
    const theirs = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `let v${i} = 2;\n` : "}\n")).join("");
    const c = conflicted(base, ours, theirs);
    expect(c.conflicts).toHaveLength(n / 2);
    const merged = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `let v${i} = 3;\n}\n}\n` : "}\n")).join("");
    expect(checkMerged(c, merged)).toEqual({ ok: false, problem: "repeats lines so often that its conflicting hunks cannot be told apart" });
  });

  describe("keeps every line each side added in a conflicting hunk", () => {
    const BASE_FN = ["export function handler(req) {", "  const user = load(req);", "  return render(user);", "}", ""].join("\n");
    // Trunk added an auth check above the line the change rewrote: one conflicting hunk at line 2.
    const TRUNK_FN = ["export function handler(req) {", "  requireAuth(req);", "  const user = load(req);", "  return render(user);", "}", ""].join("\n");
    const CHANGE_FN = ["export function handler(req) {", "  const user = loadUser(req);", "  return render(user);", "}", ""].join("\n");
    const fn = (...body: string[]) => ["export function handler(req) {", ...body, "  return render(user);", "}", ""].join("\n");

    it("refuses a merge that drops the requireAuth() call trunk added inside the hunk, naming the line", () => {
      const c = conflicted(BASE_FN, TRUNK_FN, CHANGE_FN);
      expect(c.conflicts).toMatchObject([{ line: 2, ours: ["  requireAuth(req);\n", "  const user = load(req);\n"], theirs: ["  const user = loadUser(req);\n"], oursLine: 2, theirsLine: 2 }]);
      // Neither side's version whole, so only the kept lines catch it.
      expect(checkMerged(c, fn("  const user = loadUser(req);", "  audit(user);"))).toEqual({
        ok: false,
        problem: "drops a line trunk added in the conflicting hunk at line 2 of the base (line 2 of trunk's version)",
      });
      // Trunk kept the line the change rewrote, so the change's rewrite is kept too.
      expect(checkMerged(c, fn("  requireAuth(req);", "  const user = load(req, true);"))).toEqual({
        ok: false,
        problem: "drops a line the change added in the conflicting hunk at line 2 of the base (line 2 of the change's version)",
      });
      expect(checkMerged(c, fn("  requireAuth(req);", "  const user = loadUser(req);"))).toEqual({ ok: true, resolutions: [["  requireAuth(req);\n", "  const user = loadUser(req);\n"]] });
      // Indentation may change in a merge; the text may not.
      expect(checkMerged(c, fn("    requireAuth(req);", "  const user = loadUser(req);")).ok).toBe(true);
    });

    it("accepts both sides' added lines interleaved, and refuses one side's lines out of order", () => {
      const base = "const routes = [\n];\n";
      const c = conflicted(base, 'const routes = [\n  "/a",\n  "/b",\n];\n', 'const routes = [\n  "/c",\n  "/d",\n];\n');
      expect(c.conflicts).toHaveLength(1);
      expect(checkMerged(c, 'const routes = [\n  "/a",\n  "/c",\n  "/b",\n  "/d",\n];\n')).toMatchObject({ ok: true });
      expect(checkMerged(c, 'const routes = [\n  "/c",\n  "/a",\n  "/d",\n  "/b",\n];\n')).toMatchObject({ ok: true });
      expect(checkMerged(c, 'const routes = [\n  "/b",\n  "/a",\n  "/c",\n  "/d",\n];\n')).toEqual({
        ok: false,
        problem: "changes the order of the lines trunk added in the conflicting hunk at line 2 of the base (line 3 of trunk's version is out of order)",
      });
      expect(checkMerged(c, 'const routes = [\n  "/a",\n  "/b",\n  "/c",\n];\n')).toEqual({
        ok: false,
        problem: "drops a line the change added in the conflicting hunk at line 2 of the base (line 3 of the change's version)",
      });
    });

    it("lets a kept line gain the separator a joined list needs, and nothing else", () => {
      const c = conflicted('const routes = [\n  "/x"\n];\n', 'const routes = [\n  "/x",\n  "/a"\n];\n', 'const routes = [\n  "/x",\n  "/c"\n];\n');
      expect(checkMerged(c, 'const routes = [\n  "/x",\n  "/a",\n  "/c"\n];\n')).toMatchObject({ ok: true });
      expect(checkMerged(c, 'const routes = [\n  "/x",\n  "/a2",\n  "/c"\n];\n')).toEqual({
        ok: false,
        problem: "drops a line trunk added in the conflicting hunk at line 2 of the base (line 3 of trunk's version)",
      });
    });

    it("counts repeated identical lines: each copy a side added is kept, and a line both added once serves both", () => {
      const base = "start();\nend();\n";
      const c = conflicted(base, "start();\nlog();\nlog();\nend();\n", "start();\nlog();\ncheck();\nend();\n");
      expect(keptLines(c.conflicts[0]!)).toEqual({
        ours: [
          { text: "log()", line: 2 },
          { text: "log()", line: 3 },
        ],
        theirs: [
          { text: "log()", line: 2 },
          { text: "check()", line: 3 },
        ],
      });
      expect(checkMerged(c, "start();\nlog();\nlog();\ncheck();\nend();\n")).toMatchObject({ ok: true });
      expect(checkMerged(c, "start();\nlog();\ncheck();\nlog();\nend();\n")).toMatchObject({ ok: true });
      // One log() for two: dropped (the change's version whole would be refused as that, before this check).
      expect(checkMerged(c, "start();\ncheck();\nlog();\nend();\n")).toEqual({
        ok: false,
        problem: "drops a line trunk added in the conflicting hunk at line 2 of the base (line 3 of trunk's version)",
      });
    });

    it("lets go of a line the other side deleted, and of blank lines", () => {
      // Trunk moved x() below y(); the change deleted x() and added w(): x() may go, since the change deleted it.
      const v = { line: 1, base: ["x();\n", "y();\n"], ours: ["y();\n", "x();\n"], theirs: ["y();\n", "w();\n"], oursLine: 1, theirsLine: 1 };
      expect(keptLines(v)).toEqual({ ours: [], theirs: [{ text: "w()", line: 2 }] });
      // A blank line a side added is not kept by rule.
      const c = conflicted("a = 0;\nz();\n", "a = 1;\n\nlog(a);\nz();\n", "a = 2;\nz();\n");
      expect(keptLines(c.conflicts[0]!).ours).toEqual([{ text: "log(a)", line: 3 }]);
      expect(checkMerged(c, "a = 3;\nlog(a);\nz();\n")).toMatchObject({ ok: true });
    });

    it("tells a rewritten line from an inserted one by the words it shares with the line it replaced", () => {
      expect(lineLikeness("export const v6 = 6;", "export const six = 6;")).toBe(0.75);
      expect(lineLikeness("  const user = load(req);", "  requireAuth(req);")).toBeCloseTo(1 / 3, 6);
      expect(lineLikeness("  x();", "x();")).toBe(1);
      expect(lineLikeness("}", "});")).toBe(0);
    });
  });

  it("rejects a text shorter than what both changes left as it was", () => {
    expect(checkMerged(m, "x\n")).toEqual({ ok: false, problem: "is shorter than the lines both changes left as they are" });
  });
});

describe("conflict and record shapes", () => {
  const sha = (c: string) => c.repeat(40);

  it("keeps only well-formed conflicts, each path once", () => {
    const good = { path: "src/a.ts", base: sha("a"), trunk: sha("b"), theirs: sha("c"), lines: [6, 0, -1, 2.5, 9] };
    expect(cleanConflicts([good, { ...good }, { path: "src/b.ts", base: "nope", trunk: sha("b"), theirs: sha("c"), lines: [] }, null, 7])).toEqual([{ ...good, lines: [6, 9] }]);
    expect(cleanConflicts("not a list")).toEqual([]);
  });

  it("keeps a resolves record's ids and paths, and hands it only to its own proposal", () => {
    expect(cleanResolves({ proposalId: "prp_b", landingIds: ["lnd_a", "lnd_a", 3], paths: ["src/a.ts"], extra: "x" })).toEqual({ proposalId: "prp_b", landingIds: ["lnd_a"], paths: ["src/a.ts"] });
    expect(cleanResolves({ landingIds: [] })).toBeNull();
    const all = { prp_r: { proposalId: "prp_b", landingIds: ["lnd_a"], paths: ["src/a.ts"] } };
    expect(noteResolves(all, "prp_r")).toEqual({ resolves: { proposalId: "prp_b", landingIds: ["lnd_a"], paths: ["src/a.ts"] } });
    expect(noteResolves(all, "prp_x")).toEqual({});
    expect(noteResolves(undefined, "prp_r")).toEqual({});
    expect(noteResolves(Object.create({ prp_r: all.prp_r }) as Record<string, unknown>, "prp_r")).toEqual({});
  });
});
