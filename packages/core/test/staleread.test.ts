import { describe, expect, it } from "vitest";
import { blobId } from "../src/changeset.ts";
import { changesNothing, staleWrittenReads, textMergeCandidate, validateProposal } from "../src/occ.ts";
import type { TrunkIndex } from "../src/occ.ts";
import { mergeText, type TextMergeResult } from "../src/textmerge.ts";
import type { FileVersion, Sha } from "../src/types.ts";

/**
 * A change that read a file at a version trunk has moved past (a stale read) never has an edit counted as already made:
 * text merge stops where it repeats an edit trunk made since its base (mergeText with `staleRead`), and it is not closed
 * as already on trunk (changesNothing). Two increments of one counter from one read then land as two, never as one.
 */

const PATH = "src/state.ts";

/** A file with a registry and two counters, separated by comment lines so edits of each never touch. */
function state(counter0: number, counter1 = 0, entries: readonly string[] = ["b", "d"]): string {
  return [
    "export const REGISTRY = [",
    ...entries.map((e) => `  "${e}",`),
    "];",
    "",
    "// Counter 0.",
    `export const COUNTER_0 = ${counter0};`,
    "",
    "// Counter 1.",
    `export const COUNTER_1 = ${counter1};`,
    "",
    "export function total(): number {",
    "  return COUNTER_0 + COUNTER_1;",
    "}",
    "",
  ].join("\n");
}

/** The line of the base where COUNTER_k is (1-based). */
const counterLine = (text: string, k: number): number => text.split("\n").findIndex((l) => l.startsWith(`export const COUNTER_${k} `)) + 1;

const stale = { staleRead: true };
const both = { staleRead: true, insertions: true };
const clean = (text: string, rule?: "insertions"): TextMergeResult => (rule ? { clean: true, text, rule } : { clean: true, text });
const repeated = (...lines: number[]): TextMergeResult => ({ clean: false, conflicts: 0, lines: [], repeated: lines });

describe("mergeText with staleRead: an edit trunk made since the base is not counted once", () => {
  const base = state(5);

  it("stops two increments of one counter from one read, and merges again once the change read trunk's version", () => {
    const first = state(6);
    // Without a stale read (the change did not read the file), the same edit counts once, as before.
    expect(mergeText(base, first, first)).toEqual(clean(first));
    // With one, it stops where the change repeats trunk's edit.
    expect(mergeText(base, first, first, undefined, stale)).toEqual(repeated(counterLine(base, 0)));
    // The redo read trunk's version and wrote 7: trunk did not move since, so it lands as it is (nothing to merge), and
    // a third increment from that read merges against a fourth on the other counter.
    expect(mergeText(first, state(6, 1), state(7), undefined, stale)).toEqual(clean(state(7, 1)));
  });

  it("still merges edits to lines trunk did not touch since the base, with or without the insertion rule", () => {
    const ours = state(6);
    const theirs = state(5, 1, ["a", "b", "d"]);
    for (const options of [stale, both]) expect(mergeText(base, ours, theirs, undefined, options)).toEqual(clean(state(6, 1, ["a", "b", "d"])));
  });

  it("stops when any region repeats trunk, even beside edits that would merge, and ahead of a conflict", () => {
    // The same increment of counter 0 on both sides, and counter 1 only by the change.
    expect(mergeText(base, state(6), state(6, 1), undefined, stale)).toEqual(repeated(counterLine(base, 0)));
    // A repeat and a conflict: the repeat is named, no conflict is, so nothing is handed on to be resolved once.
    expect(mergeText(base, state(6, 2), state(6, 3), undefined, stale)).toEqual(repeated(counterLine(base, 0)));
    expect(mergeText(base, state(6, 2), state(6, 3))).toEqual({ clean: false, conflicts: 1, lines: [counterLine(base, 1)] });
    // Different edits of one line still conflict as before.
    expect(mergeText(base, state(7), state(6), undefined, stale)).toEqual({ clean: false, conflicts: 1, lines: [counterLine(base, 0)] });
  });

  it("names a deletion both sides made, and a whole file both sides wrote the same way", () => {
    const less = base.replace('  "d",\n', "");
    expect(mergeText(base, less, less, undefined, stale)).toEqual(repeated(3));
    expect(mergeText("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n", "A\nb\nc\nd\nE\n", undefined, stale)).toEqual(repeated(1, 5));
  });

  it("with the insertion rule, stops a union that would leave out lines the change inserted because trunk inserted them too", () => {
    const at = (lines: string[]): string => base.replace("];\n", `${lines.map((l) => `  "${l}",\n`).join("")}];\n`);
    const end = 4; // the registry's closing line, where both insert
    // Different entries at one place: both land, trunk's first, as before.
    expect(mergeText(base, at(["x"]), at(["y"]), undefined, both)).toEqual(clean(at(["x", "y"]), "insertions"));
    // The change's entry is one trunk inserted there too: the union would land it once.
    expect(mergeText(base, at(["x", "y"]), at(["y"]), undefined, both)).toEqual(repeated(end));
    expect(mergeText(base, at(["x", "y"]), at(["y"]), undefined, { insertions: true })).toEqual(clean(at(["x", "y"]), "insertions"));
    // The very same insertion on both sides is a repeated region, with or without the rule.
    expect(mergeText(base, at(["y"]), at(["y"]), undefined, both)).toEqual(repeated(end));
  });

  it("merges every disjoint case as without it, and stops every case where both sides made one edit alike", () => {
    // Segments of unique lines; each side edits some, never two different editors side by side; `alike`: one edited by both.
    // A small deterministic generator (xorshift32): next(n) is an integer in [0, n), the same sequence on every run.
    let s = 7;
    const next = (n: number): number => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s % n;
    };
    let stopped = 0;
    for (let n = 0; n < 1_000; n++) {
      const count = 2 + next(5);
      const who = Array.from({ length: count }, () => next(4));
      for (let k = 1; k < count; k++) if (who[k] !== 0 && who[k - 1] !== 0 && who[k] !== who[k - 1]) who[k] = 0;
      const seg = (k: number): string => `s${k}\n`;
      const edit = (k: number, tag: string): string => `${tag}${k}\n${next(2) === 0 ? seg(k) : ""}`;
      const parts = who.map((w, k) => {
        const alike = w === 3 ? edit(k, "b") : null;
        return { base: seg(k), ours: w === 1 ? edit(k, "o") : (alike ?? seg(k)), theirs: w === 2 ? edit(k, "t") : (alike ?? seg(k)) };
      });
      const [b, o, t] = [parts.map((p) => p.base).join(""), parts.map((p) => p.ours).join(""), parts.map((p) => p.theirs).join("")];
      const plain = mergeText(b, o, t);
      const read = mergeText(b, o, t, undefined, stale);
      if (who.includes(3)) {
        stopped++;
        expect(read.clean).toBe(false);
        // One repeat per region edited alike (segments edited alike side by side may form one region), and no conflict.
        expect(read).toMatchObject({ conflicts: 0, lines: [] });
        const n = !read.clean ? (read.repeated?.length ?? 0) : 0;
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(who.filter((w) => w === 3).length);
      } else expect(read).toEqual(plain);
    }
    expect(stopped).toBeGreaterThan(100);
  });
});

describe("staleWrittenReads and changesNothing: the files a change wrote after reading a version trunk moved past", () => {
  const sha = (c: string): Sha => c.repeat(40);
  const [A, B, C] = [sha("a"), sha("b"), sha("c")];
  const fv = (path: string, blob: Sha | null): FileVersion => ({ path, blob });
  const trunkOf = (files: Record<string, Sha | null>): TrunkIndex => (path) => (Object.hasOwn(files, path) ? files[path] : undefined);

  it("names each written file read at another version than trunk's, once, in write order", () => {
    const trunk = trunkOf({ "x.ts": B, "y.ts": B, "z.ts": B });
    const p = { readSet: [fv("z.ts", A), fv("x.ts", A), fv("y.ts", B), fv("r.ts", A), fv("x.ts", A)], writeSet: [fv("x.ts", C), fv("y.ts", C), fv("z.ts", null), fv("w.ts", C)] };
    expect(staleWrittenReads(p, trunk)).toEqual(["x.ts", "z.ts"]);
    // Two reads of one file, one of them stale: stale. A read as absent of a file trunk now has: stale.
    expect(staleWrittenReads({ readSet: [fv("y.ts", B), fv("y.ts", A)], writeSet: [fv("y.ts", C)] }, trunk)).toEqual(["y.ts"]);
    expect(staleWrittenReads({ readSet: [fv("n.ts", null)], writeSet: [fv("n.ts", C)] }, trunkOf({ "n.ts": C }))).toEqual(["n.ts"]);
    expect(staleWrittenReads({ readSet: [fv("n.ts", null)], writeSet: [fv("n.ts", C)] }, trunkOf({}))).toEqual([]);
    expect(staleWrittenReads({ writeSet: [fv("x.ts", C)] }, trunk)).toEqual([]);
  });

  it("decides two increments from one read: the second goes back stale, and its redo on trunk's version lands 7", () => {
    const five = state(5);
    const six = state(6);
    const seven = state(7);
    const [b5, b6, b7] = [blobId(five), blobId(six), blobId(seven)];
    // The first landed 6; the second read 5 and wrote 6.
    const second = { readSet: [fv(PATH, b5)], writeSet: [fv(PATH, b6)] };
    const trunk = trunkOf({ [PATH]: b6 });
    const occ = validateProposal(second, trunk, [fv(PATH, b5)]);
    expect(occ.stale).toEqual([{ path: PATH, expected: b5, actual: b6 }]);
    expect(textMergeCandidate(second, occ.stale)).toBe(true);
    expect(staleWrittenReads(second, trunk)).toEqual([PATH]);
    // Not already on trunk, and its merge stops: it goes back stale.
    expect(changesNothing(second, trunk)).toBe(false);
    expect(mergeText(five, six, six, undefined, { staleRead: true, insertions: true })).toEqual(repeated(counterLine(five, 0)));
    // The redo reads 6 and writes 7 on trunk as it is: current, it lands, and the counter is 7.
    const redo = { readSet: [fv(PATH, b6)], writeSet: [fv(PATH, b7)] };
    expect(validateProposal(redo, trunk, [fv(PATH, b6)]).eligible).toBe(true);
    expect(changesNothing(redo, trunk)).toBe(false);
  });

  it("decides a typo fix two agents made from one read: the second goes back, and its redo closes as already on trunk", () => {
    const typo = "export const greeting = 'helo';\n";
    const fixed = "export const greeting = 'hello';\n";
    const [bt, bf] = [blobId(typo), blobId(fixed)];
    const trunk = trunkOf({ [PATH]: bf });
    const second = { readSet: [fv(PATH, bt)], writeSet: [fv(PATH, bf)] };
    expect(changesNothing(second, trunk)).toBe(false);
    expect(mergeText(typo, fixed, fixed, undefined, { staleRead: true })).toEqual(repeated(1));
    // The redo read trunk's version, found the fix there and wrote the same: nothing left to land.
    expect(changesNothing({ readSet: [fv(PATH, bf)], writeSet: [fv(PATH, bf)] }, trunk)).toBe(true);
  });
});
