import { describe, expect, it } from "vitest";
import { utf8Bytes } from "../src/changeset.ts";
import { textMergeCandidate, validateProposal } from "../src/occ.ts";
import {
  MERGE_FILE_BYTES,
  MERGE_SNIFF_BYTES,
  isLockfile,
  lineDiff,
  mergeContentProblem,
  mergeProblem,
  mergeText,
  splitLines,
  utf8Length,
  type LineHunk,
  type TextMergeResult,
} from "../src/textmerge.ts";
import type { FileVersion, Path, Sha } from "../src/types.ts";

/** A small deterministic generator (xorshift32): r(n) is an integer in [0, n), the same sequence on every run. */
function generator(seed: number): (n: number) => number {
  let s = seed >>> 0 || 1;
  return (n) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
}

/** Length of a longest common subsequence (the table every shortest edit script must match). */
function lcs(a: readonly number[], b: readonly number[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    let diag = 0;
    for (let j = b.length - 1; j >= 0; j--) {
      const keep = row[j]!;
      row[j] = a[i] === b[j] ? diag + 1 : Math.max(row[j]!, row[j + 1]!);
      diag = keep;
    }
  }
  return row[0]!;
}

/** `a` with every hunk replaced by its lines of `b`, checking that each hunk starts where `b` has got to. */
function apply(a: readonly number[], b: readonly number[], hunks: LineHunk[]): number[] {
  const out: number[] = [];
  let x = 0;
  for (const h of hunks) {
    out.push(...a.slice(x, h.a0));
    expect(out.length).toBe(h.b0);
    out.push(...b.slice(h.b0, h.b1));
    x = h.a1;
  }
  out.push(...a.slice(x));
  return out;
}

const clean = (text: string): TextMergeResult => ({ clean: true, text });

describe("splitLines", () => {
  it("keeps each line's own ending, so the lines join back into the text", () => {
    expect(splitLines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a\r\n", "b\r\n"]);
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitLines("a\rb\n\n")).toEqual(["a\rb\n", "\n"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n")).toEqual(["\n"]);
    for (const text of ["x\r\ny\nz", "\n\n\r\n", "only"]) expect(splitLines(text).join("")).toBe(text);
  });
});

describe("lineDiff", () => {
  it("finds no hunk in equal sequences, and one for a pure insertion or deletion", () => {
    expect(lineDiff([1, 2, 3], [1, 2, 3])).toEqual([]);
    expect(lineDiff([], [])).toEqual([]);
    expect(lineDiff([1, 3], [1, 2, 3])).toEqual([{ a0: 1, a1: 1, b0: 1, b1: 2 }]);
    expect(lineDiff([1, 2, 3], [1, 3])).toEqual([{ a0: 1, a1: 2, b0: 1, b1: 1 }]);
    expect(lineDiff([1, 2, 3, 4, 5], [1, 9, 3, 4, 8])).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 2 },
      { a0: 4, a1: 5, b0: 4, b1: 5 },
    ]);
  });

  it("is a shortest edit script whose hunks rebuild the second sequence, each pair apart by an unchanged line (random cases)", () => {
    const r = generator(7);
    for (let n = 0; n < 3_000; n++) {
      const alphabet = 2 + r(4);
      const a = Array.from({ length: r(13) }, () => r(alphabet));
      const b = Array.from({ length: r(13) }, () => r(alphabet));
      const hunks = lineDiff(a, b)!;
      expect(apply(a, b, hunks)).toEqual(b);
      const edits = hunks.reduce((s, h) => s + (h.a1 - h.a0) + (h.b1 - h.b0), 0);
      expect(edits).toBe(a.length + b.length - 2 * lcs(a, b));
      for (let i = 1; i < hunks.length; i++) {
        expect(hunks[i]!.a0).toBeGreaterThan(hunks[i - 1]!.a1);
        expect(hunks[i]!.b0).toBeGreaterThan(hunks[i - 1]!.b1);
      }
    }
  });

  it("gives up past the edit limit, and not when the common head and tail leave a plain insertion", () => {
    const a = Array.from({ length: 40 }, (_, i) => i);
    const b = a.map((x) => (x % 2 === 0 ? x + 100 : x));
    expect(lineDiff(a, b, 10)).toBeNull();
    expect(lineDiff(a, b, 40)).not.toBeNull();
    expect(lineDiff(a, [...a.slice(0, 20), ...Array.from({ length: 50 }, (_, i) => 500 + i), ...a.slice(20)], 10)).toEqual([{ a0: 20, a1: 20, b0: 20, b1: 70 }]);
  });
});

describe("mergeText: as git's default merge decides", () => {
  it("merges edits to separate regions, and the same edit made on both sides once", () => {
    expect(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toEqual(clean("A\nb\nC\n"));
    expect(mergeText("a\nb\nc\nd\n", "a\nX\nc\nd\n", "a\nX\nc\nD\n")).toEqual(clean("a\nX\nc\nD\n"));
    expect(mergeText("a\nb\n", "a\nx\nb\n", "a\nx\nb\n")).toEqual(clean("a\nx\nb\n"));
    // A deletion on one side and an edit apart from it on the other.
    expect(mergeText("a\nb\nc\nd\n", "a\nc\nd\n", "a\nb\nc\nD\n")).toEqual(clean("a\nc\nD\n"));
    // Both delete the same line.
    expect(mergeText("a\nb\nc\nd\n", "a\nc\nd\n", "a\nc\nD\n")).toEqual(clean("a\nc\nD\n"));
  });

  it("conflicts on different edits that overlap, or that touch with no unchanged line between them", () => {
    expect(mergeText("a\nb\nc\n", "a\nB\nc\n", "a\nb2\nc\n")).toEqual({ clean: false, conflicts: 1, lines: [2] });
    // Adjacent lines changed by different sides.
    expect(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n")).toEqual({ clean: false, conflicts: 1, lines: [1] });
    // Different insertions at one place, and an insertion right after a line the other side changed.
    expect(mergeText("a\nb\n", "a\nx\nb\n", "a\ny\nb\n")).toEqual({ clean: false, conflicts: 1, lines: [2] });
    expect(mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nx\nb\nc\n")).toEqual({ clean: false, conflicts: 1, lines: [1] });
    // A line one side deletes and the other edits.
    expect(mergeText("a\nb\nc\nd\n", "a\nc\nd\n", "a\nB\nc\nd\n")).toEqual({ clean: false, conflicts: 1, lines: [2] });
    // Two separate conflicts are counted apart.
    expect(mergeText("a\nb\nc\nd\ne\n", "A1\nb\nc\nd\nE1\n", "A2\nb\nc\nd\nE2\n")).toEqual({ clean: false, conflicts: 2, lines: [1, 5] });
    // Additions to an empty file.
    expect(mergeText("", "x\n", "y\n")).toEqual({ clean: false, conflicts: 1, lines: [1] });
  });

  it("returns the other side when one side is unchanged, and either when both made the same change", () => {
    expect(mergeText("a\nb\n", "a\nb\n", "x\n")).toEqual(clean("x\n"));
    expect(mergeText("a\nb\n", "x\n", "a\nb\n")).toEqual(clean("x\n"));
    expect(mergeText("a\nb\n", "x\n", "x\n")).toEqual(clean("x\n"));
  });

  it("keeps CRLF line endings, a byte order mark and the final newline as the versions have them", () => {
    expect(mergeText("a\r\nb\r\nc\r\nd\r\n", "A\r\nb\r\nc\r\nd\r\n", "a\r\nb\r\nc\r\nD\r\n")).toEqual(clean("A\r\nb\r\nc\r\nD\r\n"));
    // Mixed endings: each line keeps its own.
    expect(mergeText("a\r\nb\nc\r\nd\n", "A\r\nb\nc\r\nd\n", "a\r\nb\nc\r\nD\n")).toEqual(clean("A\r\nb\nc\r\nD\n"));
    expect(mergeText("﻿a\nb\nc\n", "﻿a\nb\nC\n", "﻿A\nb\nc\n")).toEqual(clean("﻿A\nb\nC\n"));
    // No final newline in the base: one side adds it, the other edits the top.
    expect(mergeText("a\nb\nc", "A\nb\nc", "a\nb\nc\n")).toEqual(clean("A\nb\nc\n"));
    // One side drops the final newline.
    expect(mergeText("a\nb\nc\n", "a\nb\nc", "A\nb\nc\n")).toEqual(clean("A\nb\nc"));
    // Lines appended after a last line that had no newline.
    expect(mergeText("a\nb\nc", "A\nb\nc", "a\nb\nc\nd\n")).toEqual(clean("A\nb\nc\nd\n"));
    // Both touch the last line, one adding a newline, the other appending: a conflict, as in git.
    expect(mergeText("a\nb", "a\nb\n", "a\nb\nc")).toEqual({ clean: false, conflicts: 1, lines: [2] });
  });

  it("gives up, without a conflict count, when a side changed more lines than the limit", () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
    const ours = base.replace(/line (\d*[02468])\n/g, "LINE $1\n");
    const theirs = base.replace("line 29\n", "last\n");
    expect(mergeText(base, ours, theirs, 5)).toEqual({ clean: false, conflicts: 0, lines: [], limited: true });
    expect(mergeText(base, ours, theirs).clean).toBe(false); // line 28 changed next to line 29
    expect(mergeText(base, ours, base.replace("line 1\n", "first\n"), 5)).toEqual({ clean: false, conflicts: 0, lines: [], limited: true });
  });
});

/**
 * A base of segments of unique lines, and two sides that each edit some segments (replace them, or add lines before
 * or after them), never a segment beside one the other side edits; some segments both sides edit the same way. The
 * expected merge applies every edit. Endings are LF or CRLF at random, and some cases have no final newline.
 */
function disjointCase(r: (n: number) => number): { base: string; ours: string; theirs: string; expected: string } {
  const count = 2 + r(6);
  const eol = (): string => (r(3) === 0 ? "\r\n" : "\n");
  const segments = Array.from({ length: count }, (_, k) => Array.from({ length: 1 + r(3) }, (_, i) => `s${k}.${i}${eol()}`));
  const noFinal = r(3) === 0;
  // Who edits each segment: 0 nobody, 1 ours, 2 theirs, 3 both alike; two different editors are never side by side.
  const who: number[] = [];
  for (let k = 0; k < count; k++) {
    const w = r(4);
    const prev = who[k - 1] ?? 0;
    who.push(w !== 0 && prev !== 0 && prev !== w ? 0 : w);
  }
  const edit = (k: number, tag: string): string[] => {
    // The last segment keeps a line when the text ends without a newline, so the last line stays in it.
    const fresh = Array.from({ length: (noFinal && k === count - 1 ? 1 : 0) + r(3) }, (_, i) => `${tag}${k}.${i}${eol()}`);
    const mode = r(3);
    return mode === 0 ? fresh : mode === 1 ? [...segments[k]!, ...fresh] : [...fresh, ...segments[k]!];
  };
  const base: string[] = [];
  const ours: string[] = [];
  const theirs: string[] = [];
  const expected: string[] = [];
  segments.forEach((seg, k) => {
    const both = who[k] === 3 ? edit(k, "b") : null;
    const o = who[k] === 1 ? edit(k, "o") : (both ?? seg);
    const t = who[k] === 2 ? edit(k, "t") : (both ?? seg);
    base.push(...seg);
    ours.push(...o);
    theirs.push(...t);
    expected.push(...(who[k] === 1 ? o : who[k] === 2 ? t : (both ?? seg)));
  });
  const text = (lines: string[]): string => (noFinal ? lines.join("").replace(/\r?\n$/, "") : lines.join(""));
  return { base: text(base), ours: text(ours), theirs: text(theirs), expected: text(expected) };
}

describe("mergeText: properties (random cases, a fixed seed)", () => {
  it("merges disjoint edits into the text that applies them all, whichever side is which", () => {
    const r = generator(11);
    for (let n = 0; n < 2_000; n++) {
      const c = disjointCase(r);
      expect(mergeText(c.base, c.ours, c.theirs)).toEqual(clean(c.expected));
      expect(mergeText(c.base, c.theirs, c.ours)).toEqual(clean(c.expected));
      // Merging the result again changes nothing.
      expect(mergeText(c.base, c.ours, c.expected)).toEqual(clean(c.expected));
    }
  });

  it("returns the other side when one side is unchanged, and x for merge(base, x, x)", () => {
    const r = generator(5);
    const text = (): string => Array.from({ length: r(8) }, () => `${"abc"[r(3)]}${r(4) === 0 ? "\r\n" : "\n"}`).join("") + (r(2) === 0 ? "tail" : "");
    for (let n = 0; n < 500; n++) {
      const base = text();
      const x = text();
      expect(mergeText(base, base, x)).toEqual(clean(x));
      expect(mergeText(base, x, base)).toEqual(clean(x));
      expect(mergeText(base, x, x)).toEqual(clean(x));
    }
  });

  it("is symmetric, and a clean result never has a line without its ending before the last (repeated lines, overlapping edits)", () => {
    const r = generator(23);
    const line = (): string => `${"abcd"[r(4)]}${r(5) === 0 ? "\r\n" : "\n"}`;
    const mutate = (lines: string[]): string[] => {
      const out = [...lines];
      for (let e = r(4); e > 0; e--) {
        const at = r(out.length + 1);
        const op = r(3);
        if (op === 0) out.splice(at, 0, line());
        else if (op === 1 && at < out.length) out.splice(at, 1);
        else if (at < out.length) out[at] = line();
      }
      return out;
    };
    let cleanCount = 0;
    for (let n = 0; n < 3_000; n++) {
      const base = Array.from({ length: r(10) }, line);
      const finish = (lines: string[]): string => (r(4) === 0 ? lines.join("").replace(/\r?\n$/, "") : lines.join(""));
      const [b, o, t] = [finish(base), finish(mutate(base)), finish(mutate(base))];
      const one = mergeText(b, o, t);
      const two = mergeText(b, t, o);
      expect(two).toEqual(one);
      if (one.clean) {
        cleanCount++;
        const lines = splitLines(one.text);
        expect(lines.slice(0, -1).every((l) => l.endsWith("\n"))).toBe(true);
      } else {
        expect(one.conflicts).toBe(one.lines.length);
      }
    }
    // The cases exercise both outcomes.
    expect(cleanCount).toBeGreaterThan(300);
    expect(cleanCount).toBeLessThan(2_900);
  });
});

describe("what may be merged", () => {
  it("never merges a lockfile", () => {
    for (const path of ["package-lock.json", "web/yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock", "go.sum", "npm-shrinkwrap.json", "uv.lock", "Package.resolved"]) {
      expect(isLockfile(path)).toBe(true);
      expect(mergeProblem(path, ["a\n"])).toBe("a lockfile");
    }
    for (const path of ["src/lock.ts", "src/deadlock.ts", "docs/lockfile.md", "Cargo.toml", "package.json", "go.mod"]) {
      expect(isLockfile(path)).toBe(false);
      expect(mergeProblem(path, ["a\n", "b\n", "c\n"])).toBeNull();
    }
  });

  it("refuses binary content: a NUL byte in the first 8,000 bytes of any version, counted in UTF-8 bytes", () => {
    expect(mergeContentProblem(["a\n", "b\0c\n", "d\n"])).toBe("binary");
    expect(mergeContentProblem([new Uint8Array([97, 0, 98])])).toBe("binary");
    const late = new Uint8Array(MERGE_SNIFF_BYTES + 10).fill(97);
    late[MERGE_SNIFF_BYTES] = 0;
    expect(mergeContentProblem([late])).toBeNull();
    late[MERGE_SNIFF_BYTES - 1] = 0;
    expect(mergeContentProblem([late])).toBe("binary");
    // "é" is two bytes: 3,999 of them put the NUL at byte 7,998, 4,000 at byte 8,000 (not looked at).
    expect(mergeContentProblem([`${"é".repeat(3_999)}\0`])).toBe("binary");
    expect(mergeContentProblem([`${"é".repeat(4_000)}\0`])).toBeNull();
  });

  it("refuses a version over 512 KB, as text or bytes", () => {
    expect(mergeContentProblem(["a".repeat(MERGE_FILE_BYTES)])).toBeNull();
    expect(mergeContentProblem(["a".repeat(MERGE_FILE_BYTES + 1)])).toBe("larger than 512 KB");
    expect(mergeContentProblem(["é".repeat(MERGE_FILE_BYTES / 2 + 1)])).toBe("larger than 512 KB");
    expect(mergeContentProblem([new Uint8Array(MERGE_FILE_BYTES + 1)])).toBe("larger than 512 KB");
  });

  it("counts UTF-8 bytes as TextEncoder writes them (utf8Bytes is checked against it)", () => {
    for (const text of ["", "abc", "é", "😀 emoji and 中文\n", "\ud800", "a\udc00b", "\ud83d"]) expect(utf8Length(text)).toBe(utf8Bytes(text).length);
  });
});

describe("textMergeCandidate (the lane's and the trunk writer's pre-check)", () => {
  const sha = (c: string): Sha => c.repeat(40);
  const fv = (path: Path, blob: Sha | null): FileVersion => ({ path, blob });
  const stale = (p: { readSet: FileVersion[]; writeSet: FileVersion[] }, base: FileVersion[], trunk: Record<Path, Sha | null>) =>
    validateProposal(p, (path) => (path in trunk ? trunk[path] : null), base).stale;

  it("accepts a change stale only on files it writes, each on trunk and in its base", () => {
    const p = { readSet: [fv("src/a.ts", sha("1")), fv("src/b.ts", sha("2"))], writeSet: [fv("src/a.ts", sha("9"))] };
    const s = stale(p, [fv("src/a.ts", sha("1"))], { "src/a.ts": sha("3"), "src/b.ts": sha("2") });
    expect(s).toEqual([{ path: "src/a.ts", expected: sha("1"), actual: sha("3") }]);
    expect(textMergeCandidate(p, s)).toBe(true);
  });

  it("refuses a change that is not stale, stale on a file it only reads, or stale on a file it deletes", () => {
    const p = { readSet: [fv("src/b.ts", sha("2"))], writeSet: [fv("src/a.ts", sha("9"))] };
    expect(textMergeCandidate(p, [])).toBe(false);
    const both = stale(p, [fv("src/a.ts", sha("1"))], { "src/a.ts": sha("3"), "src/b.ts": sha("4") });
    expect(both.map((x) => x.path)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(textMergeCandidate(p, both)).toBe(false);
    const del = { readSet: [], writeSet: [fv("src/a.ts", null)] };
    expect(textMergeCandidate(del, stale(del, [fv("src/a.ts", sha("1"))], { "src/a.ts": sha("3") }))).toBe(false);
  });

  it("refuses a file new in its base or gone from trunk, and a lockfile", () => {
    const p = { readSet: [], writeSet: [fv("src/a.ts", sha("9"))] };
    expect(textMergeCandidate(p, stale(p, [fv("src/a.ts", null)], { "src/a.ts": sha("3") }))).toBe(false);
    expect(textMergeCandidate(p, stale(p, [fv("src/a.ts", sha("1"))], {}))).toBe(false);
    const lock = { readSet: [], writeSet: [fv("package-lock.json", sha("9"))] };
    expect(textMergeCandidate(lock, stale(lock, [fv("package-lock.json", sha("1"))], { "package-lock.json": sha("3") }))).toBe(false);
  });
});
