import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mergeFile,
  overlapReadme,
  overlappingPairs,
  overlaps,
  ownEdits,
  pairOutcome,
  readmeCounts,
  README_ROWS,
  selectPrs,
  summarize,
  type MergedPr,
  type OverlapReport,
  type PairRecord,
} from "../src/overlap/pairs.ts";
import { compactJson, parseMergeTree, parseRawDiff, Replayer } from "../src/overlap/replay.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "../results/2026-10-17-hono-overlap");
const enc = (s: string) => new TextEncoder().encode(s);
const lines = (n: number, tag = "v") => Array.from({ length: n }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};\n`).join("");

/** A merged pull request with defaults: into main, opened and merged at the given times, changing the given files. */
function pr(number: number, createdAt: string, mergedAt: string, files: string[], extra: Partial<MergedPr> = {}): MergedPr {
  return { number, createdAt, mergedAt, baseRef: "main", headRef: `feature-${number}`, fromFork: false, baseSha: "b", headSha: `h${number}`, mergeSha: `m${number}`, files: [...files].sort(), changedFiles: files.length, ...extra };
}

describe("pairing", () => {
  it("pairs pull requests into the same branch whose open-to-merge windows overlapped, the earlier merged first", () => {
    const a = pr(1, "2026-01-01T00:00:00Z", "2026-01-05T00:00:00Z", ["src/a.ts", "src/b.ts"]);
    const b = pr(2, "2026-01-02T00:00:00Z", "2026-01-04T00:00:00Z", ["src/b.ts", "src/c.ts"]);
    const c = pr(3, "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z", ["src/a.ts"]);
    const d = pr(4, "2026-01-03T00:00:00Z", "2026-01-07T00:00:00Z", ["src/a.ts"], { baseRef: "next" });
    const e = pr(5, "2026-01-04T12:00:00Z", "2026-01-05T12:00:00Z", ["docs/x.md"]);
    expect(overlaps(a, b)).toBe(true);
    // Opened the moment the other merged: not open at the same time.
    expect(overlaps(a, c)).toBe(false);
    const pairs = overlappingPairs([c, d, e, a, b]).map((p) => [p.earlier.number, p.later.number, p.shared]);
    // #4 went into another branch; #2 merged before #5 opened; #3 opened the moment #1 merged.
    expect(pairs).toEqual([
      [2, 1, ["src/b.ts"]],
      [1, 5, []],
      [5, 3, []],
    ]);
  });

  it("selects a window, leaves out branch merges and other branches, and keeps the newest N", () => {
    const all = [
      pr(1, "2025-10-01T00:00:00Z", "2025-10-16T23:59:59Z", ["a"]),
      pr(2, "2025-10-10T00:00:00Z", "2025-10-17T00:00:00Z", ["a"]),
      pr(3, "2025-11-01T00:00:00Z", "2025-11-02T00:00:00Z", ["a"], { baseRef: "next" }),
      pr(4, "2025-11-03T00:00:00Z", "2025-11-04T00:00:00Z", ["a"], { headRef: "next" }),
      pr(5, "2025-11-05T00:00:00Z", "2025-11-06T00:00:00Z", ["a"], { headRef: "next", fromFork: true }),
      pr(6, "2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z", ["a"]),
    ];
    const win = { since: "2025-10-17T00:00:00Z", until: "2026-10-17T00:00:00Z" };
    const any = selectPrs(all, win);
    expect(any.prs.map((p) => p.number)).toEqual([2, 3, 5]);
    expect(any.branchMerges).toEqual([4]);
    expect(any.otherBase).toBe(0);
    const main = selectPrs(all, { ...win, base: "main" });
    expect(main.prs.map((p) => p.number)).toEqual([2, 5]);
    expect(main.otherBase).toBe(1);
    expect(selectPrs(all, { until: win.until, newest: 2 }).prs.map((p) => p.number)).toEqual([3, 5]);
  });
});

describe("mergeFile", () => {
  const base = lines(12);
  const edit = (text: string, n: number, line: string) => text.split("\n").map((l, i) => (i === n - 1 ? line : l)).join("\n");
  const v = (b: string | null, e: string | null, l: string | null) => ({ base: b === null ? null : enc(b), earlier: e === null ? null : enc(e), later: l === null ? null : enc(l) });

  it("lands edits to separate lines and names the hunk of edits to the same line", () => {
    expect(mergeFile("src/v.ts", v(base, edit(base, 2, "export const v2 = 20;"), edit(base, 11, "export const v11 = 110;")), false)).toEqual({ verdict: "clean" });
    expect(mergeFile("src/v.ts", v(base, edit(base, 6, "export const v6 = 60;"), edit(base, 6, "export const v6 = 66;")), true)).toEqual({ verdict: "conflict", lines: [6] });
  });

  it("lands two appends only with the insertion rule", () => {
    const both = v(base, `${base}export const a = 1;\n`, `${base}export const b = 2;\n`);
    expect(mergeFile("src/v.ts", both, false)).toEqual({ verdict: "conflict", lines: [13] });
    expect(mergeFile("src/v.ts", both, true)).toEqual({ verdict: "clean", rule: "insertions" });
  });

  it("does not merge what the trunk writer does not merge", () => {
    expect(mergeFile("src/v.ts", v(null, "a\n", "b\n"), true)).toEqual({ verdict: "not-mergeable", reason: "added on both sides" });
    expect(mergeFile("src/v.ts", v(base, null, edit(base, 2, "x")), true)).toEqual({ verdict: "not-mergeable", reason: "deleted on one side" });
    expect(mergeFile("pnpm-lock.yaml", v(base, edit(base, 2, "x"), edit(base, 9, "y")), true)).toEqual({ verdict: "not-mergeable", reason: "a lockfile" });
    expect(mergeFile("src/v.bin", v(base, "a\0b", base), true)).toEqual({ verdict: "not-mergeable", reason: "binary" });
    expect(mergeFile("src/v.txt", { base: enc(base), earlier: Uint8Array.from([0xff, 0x41]), later: enc(base) }, true)).toEqual({ verdict: "not-mergeable", reason: "not UTF-8" });
    expect(mergeFile("vendor/x", { ...v(base, base, base), submodule: true }, true)).toEqual({ verdict: "not-mergeable", reason: "a submodule" });
  });

  it("sends a pair back on any file it cannot merge, then on any conflict", () => {
    expect(pairOutcome([])).toBe("lands");
    expect(pairOutcome([{ verdict: "clean" }, { verdict: "conflict", lines: [3] }])).toBe("conflict");
    expect(pairOutcome([{ verdict: "conflict", lines: [3] }, { verdict: "not-mergeable", reason: "a lockfile" }])).toBe("not-mergeable");
  });
});

describe("compactJson", () => {
  it("keeps lists of plain values on one line and parses back to the same value", () => {
    const v = { a: [1, 2], b: { c: ["x", "y"], d: [] as unknown[], e: [[1, 2], [3, 4]], f: null }, g: [{ h: true }] };
    expect(compactJson(v)).toBe('{\n  "a": [1, 2],\n  "b": {\n    "c": ["x", "y"],\n    "d": [],\n    "e": [\n      [1, 2],\n      [3, 4]\n    ],\n    "f": null\n  },\n  "g": [\n    {\n      "h": true\n    }\n  ]\n}');
    expect(JSON.parse(compactJson(v))).toEqual(v);
    const prose = "x".repeat(101);
    expect(compactJson({ method: [prose, "y"] })).toBe(`{\n  "method": [\n    "${prose}",\n    "y"\n  ]\n}`);
  });
});

describe("git output parsers", () => {
  it("reads merge-tree's conflicted stages and conflict messages", () => {
    const out = [
      "fe73dac22606f599daa81964cce11c5549d1eb01",
      "100644 de980441c3ab03a8c07dda1ad27b8a11f39deb1e 1\tf.txt",
      "100644 f4ea702d479ef1388dde60e3430791a9c6eb8d4f 2\tf.txt",
      "100644 3b6f40af131104cca3a84e7a760c3c3475377106 3\tf.txt",
      "",
      "1", "f.txt", "Auto-merging", "Auto-merging f.txt\n",
      "1", "f.txt", "CONFLICT (contents)", "CONFLICT (content): Merge conflict in f.txt\n",
      "1", "g.txt", "CONFLICT (modify/delete)", "CONFLICT (modify/delete): g.txt deleted in one and modified in two.\n",
      "",
    ].join("\0");
    const parsed = parseMergeTree(out);
    expect(parsed.tree).toBe("fe73dac22606f599daa81964cce11c5549d1eb01");
    expect(parsed.conflicted.map((c) => [c.stage, c.path])).toEqual([[1, "f.txt"], [2, "f.txt"], [3, "f.txt"]]);
    expect(parsed.conflicts).toEqual([
      { type: "CONFLICT (contents)", paths: ["f.txt"] },
      { type: "CONFLICT (modify/delete)", paths: ["g.txt"] },
    ]);
    expect(parseMergeTree("4b825dc642cb6eb9a060e54bf8d69288fbee4904\0")).toEqual({ tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", conflicted: [], conflicts: [] });
  });

  it("reads diff-tree's raw entries, with absent sides as null", () => {
    const z = "0".repeat(40);
    const raw = [`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M`, "src/a.ts", `:000000 100644 ${z} ${"c".repeat(40)} A`, "src/new file.ts", `:100644 000000 ${"d".repeat(40)} ${z} D`, "old.ts", ""].join("\0");
    const d = parseRawDiff(raw);
    expect(d.get("src/a.ts")).toEqual({ oldMode: "100644", newMode: "100644", oldBlob: "a".repeat(40), newBlob: "b".repeat(40) });
    expect(d.get("src/new file.ts")?.oldBlob).toBeNull();
    expect(d.get("old.ts")?.newBlob).toBeNull();
  });
});

/**
 * A small repository with squash-merged pull requests, replayed with no network: separate lines, the same line, two
 * appends, a branch that merged main after the other landed, a branch opened on top of the other's merge, a lockfile
 * both changed, a pair that shares no file, and a branch stacked on the other's head.
 */
describe("replay on a local repository", () => {
  let dir = "";
  const prs: MergedPr[] = [];
  const env = { ...process.env, GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
  const write = (files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
  };
  const edit = (text: string, n: number, line: string) => text.split("\n").map((l, i) => (i === n - 1 ? line : l)).join("\n");
  /** A branch from `from` with one commit writing `files`; its head. */
  const branch = (name: string, from: string, files: Record<string, string>): string => {
    git("checkout", "-q", "-B", name, from);
    write(files);
    git("add", "-A");
    git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD");
  };
  /** Squash-merge a head onto main (its tree as main's next commit), recording the pull request. */
  const land = (number: number, head: string, day: number, opened: number, files: string[]) => {
    const merge = git("commit-tree", `${head}^{tree}`, "-p", "main", "-m", `squash #${number}`);
    git("update-ref", "refs/heads/main", merge);
    prs.push(pr(number, `2026-01-${String(day).padStart(2, "0")}T${String(opened).padStart(2, "0")}:00:00Z`, `2026-01-${String(day).padStart(2, "0")}T${number % 2 === 1 ? "10" : "11"}:00:00Z`, files, { headSha: head, mergeSha: merge }));
    return merge;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ft-overlap-"));
    git("init", "-q", "-b", "main");
    const seed = { "src/a.ts": lines(12, "a"), "src/b.ts": lines(12, "b"), "src/c.ts": lines(12, "c"), "src/d.ts": lines(12, "d"), "pnpm-lock.yaml": lines(12, "lock"), "src/e.ts": "e\n", "src/f.ts": "f\n" };
    write(seed);
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const root = git("rev-parse", "HEAD");
    // 1 and 2: separate lines of a.ts.
    const h1 = branch("p1", root, { "src/a.ts": edit(seed["src/a.ts"], 2, "export const a2 = 20;") });
    const h2 = branch("p2", root, { "src/a.ts": edit(seed["src/a.ts"], 11, "export const a11 = 110;") });
    land(1, h1, 1, 0, ["src/a.ts"]);
    land(2, h2, 1, 1, ["src/a.ts"]);
    // 3 and 4: the same line of b.ts.
    const h3 = branch("p3", root, { "src/b.ts": edit(seed["src/b.ts"], 5, "export const b5 = 50;") });
    const h4 = branch("p4", root, { "src/b.ts": edit(seed["src/b.ts"], 5, "export const b5 = 55;") });
    land(3, h3, 2, 0, ["src/b.ts"]);
    land(4, h4, 2, 1, ["src/b.ts"]);
    // 5 and 6: both append to c.ts.
    const h5 = branch("p5", root, { "src/c.ts": `${seed["src/c.ts"]}export const c13 = 13;\n` });
    const h6 = branch("p6", root, { "src/c.ts": `${seed["src/c.ts"]}export const c14 = 14;\n` });
    land(5, h5, 3, 0, ["src/c.ts"]);
    land(6, h6, 3, 1, ["src/c.ts"]);
    // 7 and 8: the same line of d.ts; 8 merges main (holding 7) into its branch before it lands.
    const h7 = branch("p7", root, { "src/d.ts": edit(seed["src/d.ts"], 3, "export const d3 = 30;") });
    const c8 = branch("p8", root, { "src/d.ts": edit(seed["src/d.ts"], 3, "export const d3 = 33;") });
    const m7 = land(7, h7, 4, 0, ["src/d.ts"]);
    const h8 = git("commit-tree", `${c8}^{tree}`, "-p", c8, "-p", m7, "-m", "merge main into p8");
    land(8, h8, 4, 1, ["src/d.ts"]);
    // 9 and 10: 10 is opened on top of 9's merge, so it has no commit of its own without it.
    const h9 = branch("p9", "main", { "src/e.ts": "e9\n" });
    const m9 = land(9, h9, 5, 0, ["src/e.ts"]);
    const h10 = branch("p10", m9, { "src/e.ts": "e10\n" });
    land(10, h10, 5, 1, ["src/e.ts"]);
    // 11 and 12: separate lines of the lockfile.
    const tip = git("rev-parse", "main");
    const h11 = branch("p11", tip, { "pnpm-lock.yaml": edit(seed["pnpm-lock.yaml"], 2, "lock2") });
    const h12 = branch("p12", tip, { "pnpm-lock.yaml": edit(seed["pnpm-lock.yaml"], 10, "lock10") });
    land(11, h11, 6, 0, ["pnpm-lock.yaml"]);
    land(12, h12, 6, 1, ["pnpm-lock.yaml"]);
    // 13 and 14: open together, no file in common.
    const t2 = git("rev-parse", "main");
    const h13 = branch("p13", t2, { "src/f.ts": "f13\n" });
    const h14 = branch("p14", t2, { "src/g.ts": "g14\n" });
    land(13, h13, 7, 0, ["src/f.ts"]);
    land(14, h14, 7, 1, ["src/g.ts"]);
    // 15 and 16: 16 is stacked on 15's head, which has two commits; 16 has no commit of its own without 15.
    const t3 = git("rev-parse", "main");
    branch("p15", t3, { "src/h.ts": "h1\n" });
    write({ "src/h.ts": "h1\nh2\n" });
    git("commit", "-q", "-am", "p15 second");
    const h15 = git("rev-parse", "HEAD");
    const h16 = branch("p16", h15, { "src/h.ts": "h1\nh2\nh3\n" });
    land(15, h15, 8, 0, ["src/h.ts"]);
    land(16, h16, 8, 1, ["src/h.ts"]);
  });

  afterAll(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("replays each pair and classifies it as git and text merge would", () => {
    const pairs = overlappingPairs(prs);
    expect(pairs.map((p) => [p.earlier.number, p.later.number, p.shared.length])).toEqual([
      [1, 2, 1],
      [3, 4, 1],
      [5, 6, 1],
      [7, 8, 1],
      [9, 10, 1],
      [11, 12, 1],
      [13, 14, 0],
      [15, 16, 1],
    ]);
    const replayer = new Replayer(dir, prs);
    const records = pairs.filter((p) => p.shared.length > 0).map((p) => replayer.replay(p));
    const by = (n: number) => records.find((r) => r.earlier === n)!;
    expect([by(1).status, by(1).git?.conflict, by(1).text, by(1).insertions]).toEqual(["replayed", false, "lands", "lands"]);
    expect([by(3).git?.conflict, by(3).git?.conflicts, by(3).text, by(3).files?.[0]?.text]).toEqual([true, [{ type: "CONFLICT (contents)", paths: ["src/b.ts"] }], "conflict", { verdict: "conflict", lines: [5] }]);
    expect(ownEdits(by(3))).toBe(true);
    expect([by(5).git?.conflict, by(5).text, by(5).insertions, by(5).files?.[0]?.insertions]).toEqual([true, "conflict", "lands", { verdict: "clean", rule: "insertions" }]);
    expect([by(7).status, by(7).laterHead, by(7).git?.conflict, by(7).text]).toEqual(["replayed-before-update", git("rev-parse", "p8"), true, "conflict"]);
    expect(by(9).status).toBe("later-contains-earlier");
    expect(by(15).status).toBe("later-contains-earlier");
    expect([by(11).git?.conflict, by(11).text, by(11).files?.[0]?.text]).toEqual([false, "not-mergeable", { verdict: "not-mergeable", reason: "a lockfile" }]);
    const { counts, stillConflictingBy } = summarize(prs.length, pairs.length, records);
    expect(counts).toEqual({
      prs: 16,
      overlappingPairs: 8,
      pairsSharingFile: 7,
      replayed: 5,
      replayedBeforeUpdate: 1,
      notReplayable: 2,
      missingCommits: 0,
      gitConflicts: 3,
      gitConflictsOwnEdits: 3,
      textMergeResolved: 0,
      insertionMergeResolved: 1,
      stillConflicting: 2,
      gitCleanTextBack: 1,
      gitCleanInsertionsBack: 1,
    });
    expect(stillConflictingBy).toEqual({ "overlapping edits": 2 });
  });

  it("marks a pair whose commits the clone lacks", () => {
    const ghost = [pr(1, "2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z", ["x"], { headSha: "f".repeat(40), mergeSha: null }), pr(2, "2026-02-01T01:00:00Z", "2026-02-03T00:00:00Z", ["x"], { headSha: "e".repeat(40), mergeSha: null })];
    const [pair] = overlappingPairs(ghost);
    expect(new Replayer(dir, ghost).replay(pair!).status).toBe("missing-commit");
  });
});

describe("the published results", () => {
  const report = JSON.parse(readFileSync(join(RESULTS, "overlap.json"), "utf8")) as OverlapReport;
  const readme = readFileSync(join(RESULTS, "README.md"), "utf8");

  it("README's headline numbers are the JSON's counts", () => {
    const shown = readmeCounts(readme);
    expect(Object.keys(shown).sort()).toEqual(README_ROWS.map(([k]) => k).sort());
    for (const [k] of README_ROWS) expect(shown[k], k).toBe(report.counts[k]);
    expect(readme).toBe(overlapReadme(report));
    expect(readme).toContain("MEASURED");
  });

  it("the JSON's counts are what its pull requests and pairs give", () => {
    const pairs = overlappingPairs(report.prs);
    expect(report.counts.prs).toBe(report.prs.length);
    expect(pairs.length).toBe(report.pairsWithoutSharedFile.length + report.pairs.length);
    expect(pairs.filter((p) => p.shared.length > 0).map((p) => [p.earlier.number, p.later.number, p.shared])).toEqual(report.pairs.map((p: PairRecord) => [p.earlier, p.later, p.shared]));
    expect(pairs.filter((p) => p.shared.length === 0).map((p) => [p.earlier.number, p.later.number])).toEqual(report.pairsWithoutSharedFile);
    expect(summarize(report.prs.length, pairs.length, report.pairs)).toEqual({ counts: report.counts, stillConflictingBy: report.stillConflictingBy });
    for (const p of report.pairs) if (p.files) {
      expect(p.text).toBe(pairOutcome(p.files.map((f) => f.text)));
      expect(p.insertions).toBe(pairOutcome(p.files.map((f) => f.insertions)));
    }
  });
});
