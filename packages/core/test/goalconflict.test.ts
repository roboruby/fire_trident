import { describe, expect, it } from "vitest";
import {
  GOAL_CONFLICT_LANDINGS,
  GOAL_CONFLICT_WINDOW_MS,
  LineTrace,
  ageText,
  alignLines,
  findGoalConflict,
  goalConflictEnabled,
  goalConflictReason,
  lineKeys,
  relatedIntents,
  removedLines,
  undoesEnough,
  type IntentFacts,
  type RemovedOwner,
} from "../src/goalconflict.ts";
import type { Id } from "../src/types.ts";

const NOW = 1_000_000_000_000;
const MIN = 60_000;

/** An intent table: each intent's source, parent, title and why. */
function intents(list: Record<Id, Partial<IntentFacts>>): (id: Id) => IntentFacts | null {
  return (id) => (list[id] ? { title: `Intent ${id}`, why: `Why ${id}.`, ...list[id] } : null);
}

/** One traced owner: a landing that wrote `lines` lines of src/backend.ts, `removed` of which the change removes. */
function owner(over: Partial<RemovedOwner> = {}): RemovedOwner {
  return { landingId: "lnd_1", at: NOW - 5 * MIN, rank: 0, path: "src/backend.ts", removed: 5, lines: 5, intentId: "int_rust", proposalId: "prp_1", ...over };
}

const TABLE = intents({ int_go: {}, int_rust: { title: "Move the backend to Rust", why: "One static binary." }, int_ts: {} });

describe("goalConflictEnabled", () => {
  it("reads FT_GOAL_CONFLICT like the other flags: on, a list of colony ids, or off when absent", () => {
    expect(goalConflictEnabled("on", "a")).toBe(true);
    expect(goalConflictEnabled("a, b", "b")).toBe(true);
    expect(goalConflictEnabled("a,b", "c")).toBe(false);
    expect(goalConflictEnabled(undefined, "a")).toBe(false);
    expect(goalConflictEnabled("", "a")).toBe(false);
    expect(goalConflictEnabled("off", "a")).toBe(false);
  });
});

describe("lines as the check compares them", () => {
  it("splits at newlines, a final newline ending the last line, with whitespace collapsed", () => {
    expect(lineKeys("")).toEqual([]);
    expect(lineKeys("a\nb\n")).toEqual(["a", "b"]);
    expect(lineKeys("a\r\n  b  c\t\r\n\n")).toEqual(["a", "b c", ""]);
    expect(lineKeys("x")).toEqual(["x"]);
  });

  it("aligns the kept lines of two versions, and matches equal lines in order when the edit script is too long", () => {
    expect([...alignLines([1, 2, 3, 4], [1, 9, 3, 4, 5])]).toEqual([0, -1, 2, 3, -1]);
    expect([...alignLines([1, 2, 3], [3, 2, 1], 0)]).toEqual([2, 1, 0]);
    expect([...alignLines([1, 1, 2], [1, 7, 1, 1], 0)]).toEqual([0, -1, 1, -1]);
    expect([...alignLines([], [1, 2])]).toEqual([-1, -1]);
  });

  it("finds the lines a change removes: rewritten or deleted ones, never blank or re-indented ones", () => {
    const before = "const a = 1;\n\nconst b = 2;\nconst c = 3;\n";
    expect(removedLines(before, "const a = 1;\n\nconst b = 20;\nconst c = 3;\n")).toEqual([2]);
    expect(removedLines(before, "  const a = 1;\nconst b = 2;\n    const c = 3;\n")).toEqual([]);
    expect(removedLines(before, null)).toEqual([0, 2, 3]);
    expect(removedLines(before, "")).toEqual([0, 2, 3]);
    expect(removedLines("", "x\n")).toEqual([]);
  });
});

describe("LineTrace: who wrote each line", () => {
  // Three versions of one file: L1 created it, L2 rewrote two lines, the change's base is L2's version.
  const v1 = "seed one\nseed two\nlang python\nbuild pip\nseed three\n";
  const v2 = "seed one\nseed two\nlang rust\nbuild cargo\nseed three\n";

  it("gives each removed line to the landing that added it, counting that landing's lines in the version", () => {
    const t = new LineTrace(v2, removedLines(v2, "seed one\nseed two\nlang go\nbuild go\nseed three\n"));
    expect(t.done).toBe(false);
    expect(t.step(v1)).toBe(0);
    expect(t.done).toBe(true);
    expect(t.owners()).toEqual([{ step: 0, removed: 2, lines: 2 }]);
  });

  it("goes back further for lines the newest landing kept, and a landing that created the file owns the rest", () => {
    const t = new LineTrace(v2, removedLines(v2, "lang go\nbuild go\n"));
    t.step(v1);
    expect(t.done).toBe(false);
    t.step(null);
    expect(t.done).toBe(true);
    expect(t.owners()).toEqual([
      { step: 0, removed: 2, lines: 2 },
      { step: 1, removed: 3, lines: 3 },
    ]);
  });

  it("stops following a line when the history skips a version that dropped it", () => {
    const t = new LineTrace(v2, [0, 2]);
    // The landing it reaches produced a version without "seed one": that line cannot be followed.
    t.step(v1, "seed two\nlang rust\nbuild cargo\nseed three\n");
    expect(t.done).toBe(true);
    expect(t.owners()).toEqual([{ step: 0, removed: 1, lines: 2 }]);
  });

  it("ignores removed lines it cannot know (blank, out of range) and counts its work", () => {
    const t = new LineTrace("a\n\nb\n", [1, 7, -1, 0]);
    expect(t.work).toBe(3);
    t.step("");
    expect(t.owners()).toEqual([{ step: 0, removed: 1, lines: 2 }]);
    expect(t.work).toBe(3);
  });
});

describe("findGoalConflict", () => {
  const base = { intentId: "int_go", intent: TABLE, now: NOW };

  it("names the landing a change would undo, with the intent it was for, its age and why", () => {
    const c = findGoalConflict({ ...base, owners: [owner()] });
    expect(c?.undoes).toEqual([{ landingId: "lnd_1", intentId: "int_rust", path: "src/backend.ts", lines: 5 }]);
    expect(c?.reason).toBe(
      'would undo 5 lines in src/backend.ts that landing lnd_1 wrote 5 minutes ago for intent "Move the backend to Rust" (One static binary.), a different intent; a person decides which goal stands',
    );
  });

  it("needs at least three lines, and at least half of the landing's lines still in the file", () => {
    expect(findGoalConflict({ ...base, owners: [owner({ removed: 2, lines: 2 })] })).toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ removed: 4, lines: 9 })] })).toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ removed: 4, lines: 8 })] })?.undoes[0]?.lines).toBe(4);
    expect(undoesEnough(3, 6)).toBe(true);
    expect(undoesEnough(3, 7)).toBe(false);
    expect(undoesEnough(2, 2)).toBe(false);
  });

  it("only counts recent landings: within the window and among the colony's newest landings", () => {
    expect(findGoalConflict({ ...base, owners: [owner({ at: NOW - GOAL_CONFLICT_WINDOW_MS - 1 })] })).toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ at: NOW - GOAL_CONFLICT_WINDOW_MS })] })).not.toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ rank: GOAL_CONFLICT_LANDINGS })] })).toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ rank: GOAL_CONFLICT_LANDINGS - 1 })] })).not.toBeNull();
    // The decide policy can narrow or widen both.
    expect(findGoalConflict({ ...base, windowMs: 2 * MIN, owners: [owner()] })).toBeNull();
    expect(findGoalConflict({ ...base, landings: 3, owners: [owner({ rank: 3 })] })).toBeNull();
    expect(findGoalConflict({ ...base, windowMs: 2 * 60 * MIN, owners: [owner({ at: NOW - 90 * MIN })] })).not.toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ at: Number.NaN })] })).toBeNull();
  });

  it("never counts an ancestor or a descendant of the change's intent, at any depth", () => {
    const tree = intents({ root: {}, mid: { parentId: "root" }, leaf: { parentId: "mid" }, other: { parentId: "root" } });
    for (const [mine, theirs] of [
      ["leaf", "root"],
      ["root", "leaf"],
      ["mid", "leaf"],
    ] as const) {
      expect(findGoalConflict({ intentId: mine, intent: tree, now: NOW, owners: [owner({ intentId: theirs })] })).toBeNull();
    }
    // Siblings and cousins are different goals.
    expect(findGoalConflict({ intentId: "leaf", intent: tree, now: NOW, owners: [owner({ intentId: "other" })] })).not.toBeNull();
    expect(relatedIntents("leaf", "root", tree)).toBe(true);
    expect(relatedIntents("leaf", "other", tree)).toBe(false);
    // A parent cycle ends the walk instead of looping.
    const loop = intents({ a: { parentId: "b" }, b: { parentId: "a" }, c: {} });
    expect(relatedIntents("a", "c", loop)).toBe(false);
  });

  it("leaves repairs of trunk certification alone, on either side", () => {
    const t = intents({ fix: { source: "certify" }, int_go: {}, int_rust: {} });
    expect(findGoalConflict({ intentId: "fix", intent: t, now: NOW, owners: [owner()] })).toBeNull();
    expect(findGoalConflict({ intentId: "int_go", intent: t, now: NOW, owners: [owner({ intentId: "fix" })] })).toBeNull();
  });

  it("leaves the colony's own intents alone, on either side (a megafile split moves other intents' lines)", () => {
    const t = intents({ split: { source: "system" }, int_go: {}, int_rust: {} });
    expect(findGoalConflict({ intentId: "split", intent: t, now: NOW, owners: [owner()] })).toBeNull();
    expect(findGoalConflict({ intentId: "int_go", intent: t, now: NOW, owners: [owner({ intentId: "split" })] })).toBeNull();
  });
  
  it("leaves intents a rule declared alone, on either side", () => {
    const t = intents({ conform: { source: "rule" }, int_go: {}, int_rust: {} });
    expect(findGoalConflict({ intentId: "conform", intent: t, now: NOW, owners: [owner()] })).toBeNull();
    expect(findGoalConflict({ intentId: "int_go", intent: t, now: NOW, owners: [owner({ intentId: "conform" })] })).toBeNull();
  });

  it("never counts FireTrident's own commits, lines no proposal wrote, the same intent, or an intent the colony does not know", () => {
    expect(findGoalConflict({ ...base, owners: [owner({ system: true })] })).toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ intentId: undefined })] })).toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ intentId: "int_go" })] })).toBeNull();
    expect(findGoalConflict({ ...base, owners: [owner({ intentId: "int_unknown" })] })).toBeNull();
  });

  it("counts a deleted file like any other removal, one record per file, and orders landings by lines undone", () => {
    const c = findGoalConflict({
      ...base,
      owners: [
        owner({ landingId: "lnd_1", path: "src/a.ts", removed: 3, lines: 3 }),
        owner({ landingId: "lnd_2", intentId: "int_ts", path: "src/b.ts", removed: 9, lines: 9, at: NOW - 30_000 }),
        owner({ landingId: "lnd_1", path: "src/c.ts", removed: 4, lines: 6 }),
        owner({ landingId: "lnd_3", intentId: "int_ts", path: "src/d.ts", removed: 1, lines: 1 }),
      ],
    });
    expect(c?.undoes.map((u) => `${u.landingId} ${u.path} ${u.lines}`)).toEqual(["lnd_1 src/a.ts 3", "lnd_2 src/b.ts 9", "lnd_1 src/c.ts 4"]);
    expect(c?.landings.map((l) => `${l.landingId} ${l.lines} ${l.paths.join(",")}`)).toEqual(["lnd_2 9 src/b.ts", "lnd_1 7 src/a.ts,src/c.ts"]);
    expect(c?.reason).toBe(
      'would undo 9 lines in src/b.ts that landing lnd_2 wrote 30 seconds ago for intent "Intent int_ts" (Why int_ts.), a different intent, and 7 lines that 1 more recent landing wrote for other intents (lnd_1); a person decides which goal stands',
    );
  });
});

describe("the reason", () => {
  it("quotes at most 160 characters of the why on one line, and says how long ago in plain words", () => {
    const why = `${"word ".repeat(60)}\nend`;
    const r = goalConflictReason([{ landingId: "lnd_9", intentId: "int_x", title: "A\nB", why, at: NOW - 2 * 60 * MIN - 5 * MIN, lines: 12, paths: ["a.ts", "b.ts", "c.ts", "d.ts"] }], NOW);
    expect(r).toMatch(/^would undo 12 lines in 4 files that landing lnd_9 wrote 2 hours 5 minutes ago for intent "A B" \(word word/);
    const quoted = /\((.*)\), a different intent/.exec(r)?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(160);
    expect(quoted.endsWith("…")).toBe(true);
    expect(goalConflictReason([], NOW)).toBe("");
  });

  it("reads ages in seconds, minutes and hours", () => {
    expect(ageText(0)).toBe("0 seconds");
    expect(ageText(1_000)).toBe("1 second");
    expect(ageText(61_000)).toBe("1 minute");
    expect(ageText(59 * MIN)).toBe("59 minutes");
    expect(ageText(60 * MIN)).toBe("1 hour");
    expect(ageText(12 * 60 * MIN + 3 * MIN)).toBe("12 hours");
    expect(ageText(-5)).toBe("0 seconds");
  });
});
