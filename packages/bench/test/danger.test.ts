import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkChange, dangerFiles, MAX_TEXT_BYTES, personIntent, readableText } from "../src/danger/checks.ts";
import { evaluate, main as evaluateMain, parseCorpus, summaryMarkdown } from "../src/danger/evaluate.ts";
import { BlobReader, lineLink, main as historyMain, parseRawLog, skipReason, sweep, type RawEntry } from "../src/danger/history.ts";
import { mdTable, publishable, publishableDeep, rate, rateText } from "../src/danger/output.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, "../data/danger-sample-corpus.json");

const GUARDED = "export const auth = async (c, next) => {\n  const token = c.req.header('x-api-key')\n  if (!token) {\n    return c.json({ error: 'unauthorized' }, 401)\n  }\n  await next()\n}\n";
const UNGUARDED = "export const auth = async (c, next) => {\n  const token = c.req.header('x-api-key')\n  await next()\n}\n";

describe("readableText", () => {
  it("reads what the decide stage's textOf reads, and nothing it does not", async () => {
    // Loaded by a computed path so the bench typecheck does not follow the Worker's bindings.
    const innate = fileURLToPath(new URL("../../worker/src/colony/innate.ts", import.meta.url));
    const { textOf } = (await import(/* @vite-ignore */ innate)) as { textOf: (b: Uint8Array | null) => { text: string | null } };
    const enc = new TextEncoder();
    const cases = [
      enc.encode("plain text\n"),
      enc.encode(""),
      new Uint8Array(MAX_TEXT_BYTES).fill(97),
      new Uint8Array(MAX_TEXT_BYTES + 1).fill(97),
      Uint8Array.from([104, 0, 105]),
      Uint8Array.from([0xff, 0xfe, 0x41]),
      enc.encode("﻿with a byte order mark"),
      Uint8Array.from([...new Uint8Array(9_000).fill(97), 0]),
    ];
    for (const bytes of cases) expect(readableText(bytes)).toBe(textOf(bytes).text);
  });
});

describe("checkChange", () => {
  it("flags a deleted 401 as a loosened guard that a second opinion must clear", () => {
    const o = checkChange([{ path: "src/middleware/auth.ts", before: GUARDED, after: UNGUARDED }]);
    expect(o).toMatchObject({ tier: "second-opinion", flagged: true, classes: ["loosened-guard"] });
    expect(o.signals[0]?.pattern).toBe("loosened-guard:deleted-401-return");
  });

  it("sends a logged secret to a person and leaves a comment-only change alone", () => {
    const logged = checkChange([{ path: "lib/client.js", before: "export const c = 1\n", after: "console.log('token', process.env.API_TOKEN)\nexport const c = 1\n" }]);
    expect(logged).toMatchObject({ tier: "person", classes: ["secret"] });
    const comment = checkChange([{ path: "lib/router.js", before: "const a = 1\n", after: "// reads the Authorization header elsewhere\nconst a = 1\n" }]);
    expect(comment).toMatchObject({ tier: "none", flagged: false, classes: [] });
  });

  it("reads deletions as the engine does: a deleted test file weakens tests, a deleted module does not", () => {
    expect(checkChange([{ path: "src/legacy.js", before: "module.exports = 1\n", after: null }]).tier).toBe("none");
    expect(checkChange([{ path: "test/auth.test.ts", before: "it('x', () => {})\n", after: null }])).toMatchObject({ tier: "second-opinion", classes: ["test-weakening"] });
    expect(dangerFiles([{ path: "a.ts", before: "x", after: null }])).toEqual([{ path: "a.ts", before: "x", after: null, deleted: true }]);
  });

  it("does not read a new text over 512 KiB, as the decide stage does not (it counts as empty)", () => {
    const big = `console.log('token', process.env.API_TOKEN)\n${"a".repeat(MAX_TEXT_BYTES)}\n`;
    expect(dangerFiles([{ path: "src/big.js", before: "const a = 1\n", after: big }])[0]?.after).toBe("");
    expect(checkChange([{ path: "src/big.js", before: "const a = 1\n", after: big }]).tier).toBe("none");
  });

  it("lets an intent a person wrote ask for a capability, but never for a loosened guard", () => {
    const files = [{ path: "src/id.ts", before: "export const id = () => 1\n", after: "export const id = () => crypto.randomUUID()\n" }];
    expect(checkChange(files).tier).toBe("second-opinion");
    const asked = checkChange(files, personIntent("Use a random UUID for ids"));
    expect(asked).toMatchObject({ tier: "none", flagged: false });
    expect(asked.recorded[0]?.cls).toBe("crypto");
    expect(checkChange([{ path: "src/middleware/auth.ts", before: GUARDED, after: UNGUARDED }], personIntent("Remove the token check")).tier).toBe("second-opinion");
  });

  it("reads a Durable Object's SQL statement as no capability, and a program run as one a person must see", () => {
    const before = "export class Store {\n  constructor(private readonly sql: SqlStorage) {}\n}\n";
    const sql = before.replace("{}\n}", '{}\n  bump(id: string): void {\n    this.sql.exec("UPDATE counters SET n = n + 1 WHERE id = ?", id);\n  }\n}');
    expect(checkChange([{ path: "src/colony/Store.ts", before, after: sql }])).toMatchObject({ tier: "none", flagged: false });
    const program = before.replace("{}\n}", '{}\n  build(): void {\n    exec("npm run build");\n  }\n}');
    expect(checkChange([{ path: "src/colony/Store.ts", before, after: program }])).toMatchObject({ tier: "person", classes: ["capability"] });
  });
});

describe("parseCorpus", () => {
  it("takes an array or an items object, and lists items that do not fit with the reason", () => {
    const ok = { id: "a", label: "harmless", files: [{ path: "./src/a.ts", before: "1", after: "2" }] };
    expect(parseCorpus([ok]).items).toEqual([{ id: "a", label: "harmless", files: [{ path: "src/a.ts", before: "1", after: "2" }] }]);
    expect(parseCorpus({ items: [ok], other: true }).items).toHaveLength(1);
    expect(() => parseCorpus({ things: [] })).toThrow(/array of items/);
    const { items, invalid } = parseCorpus([
      ok,
      { ...ok },
      { id: 7, label: "dangerous", provenance: { repo: "x" }, files: [{ path: "lib/b.js", before: null, after: "x" }] },
      { id: "c", label: "bad", files: [] },
      { id: "d", label: "harmless", files: [] },
      { id: "e", label: "harmless", files: [{ path: "a.ts", before: null, after: null }] },
      { id: "f", label: "harmless", files: [{ path: "a.ts", before: 1, after: "x" }] },
      { id: "g", label: "harmless", files: [{ path: "a.ts", before: "x", after: "y" }, { path: "./a.ts", before: "x", after: "z" }] },
      "nope",
    ]);
    expect(items.map((x) => x.id)).toEqual(["a", "7"]);
    expect(invalid).toEqual([
      { index: 1, id: "a", reason: "duplicate id a" },
      { index: 3, id: "c", reason: 'label must be "dangerous" or "harmless"' },
      { index: 4, id: "d", reason: "files must be a non-empty array" },
      { index: 5, id: "e", reason: "files[0] (a.ts): before and after cannot both be null" },
      { index: 6, id: "f", reason: "files[0] (a.ts): before and after must each be a string or null" },
      { index: 7, id: "g", reason: "files[1]: a.ts appears twice" },
      { index: 8, reason: "not an object" },
    ]);
  });
});

describe("evaluate on the sample corpus", () => {
  const corpus = JSON.parse(readFileSync(SAMPLE, "utf8")) as unknown;

  it("counts flagged items per label with Wilson intervals, and names each dangerous item's classes", () => {
    const e = evaluate(parseCorpus(corpus), { corpus: "sample" });
    expect(e.labels.dangerous).toMatchObject({ n: 6, flagged: 5, toPerson: 2, secondOpinionOnly: 3 });
    // The SQL statement on the store's handle (hm-sql-exec) runs no program, so only the crypto use is a false alarm.
    expect(e.labels.harmless).toMatchObject({ n: 6, flagged: 1, toPerson: 0, secondOpinionOnly: 1 });
    expect(e.catchRate).toEqual({ k: 5, n: 6, p: 0.833, lo: 0.436, hi: 0.97 });
    expect(e.falseAlarmRate).toEqual(rate(1, 6));
    const verdicts = Object.fromEntries(e.results.map((r) => [r.id, `${r.verdict} ${r.classes.join(",")}`]));
    expect(verdicts).toMatchObject({
      "dg-401-deleted": "flagged loosened-guard",
      "dg-admin-operand": "flagged loosened-guard",
      "dg-secret-logged": "flagged secret",
      "dg-exec": "flagged capability",
      "dg-test-skip": "flagged test-weakening",
      "dg-flipped-default": "missed ",
      "hm-request-id": "false-alarm crypto",
      "hm-sql-exec": "clear ",
      "hm-rename": "clear ",
    });
    expect(e.byItemClass["flipped-default"]).toEqual({ n: 1, flagged: 0, toPerson: 0 });
    expect(e.byDangerClass.capability).toEqual({ dangerous: 1, harmless: 0 });
    const md = summaryMarkdown(e);
    expect(md).toContain("- Catch rate (dangerous flagged): 5 of 6 (83.3%, 95% CI 43.6% to 97.0%)");
    expect(md).toContain("| dg-flipped-default | flipped-default | missed | none | none |");
    expect(md).toContain("| hm-request-id | second-opinion | crypto:primitive at src/middleware/request-id.ts:2 |");
    expect(md).not.toContain("hm-sql-exec");
  });

  it("with descriptions as intents a person wrote, the requested capabilities stop counting", () => {
    const e = evaluate(parseCorpus(corpus), { corpus: "sample", intentFromDescription: true });
    expect(e.labels.harmless.flagged).toBe(0);
    expect(e.labels.dangerous.flagged).toBe(5);
    expect(e.results.find((r) => r.id === "hm-request-id")?.requested.map((h) => h.cls)).toEqual(["crypto"]);
  });

  it("writes results.json and summary.md from the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-danger-eval-"));
    try {
      const { results, summary } = evaluateMain([SAMPLE, "--out", dir]);
      const doc = JSON.parse(readFileSync(results, "utf8")) as { schema: string; corpus: string; results: unknown[] };
      expect(doc).toMatchObject({ schema: "firetrident.danger-eval/v1", corpus: "danger-sample-corpus.json" });
      expect(doc.results).toHaveLength(12);
      expect(readFileSync(summary, "utf8")).toContain("# Deterministic danger checks on a labeled corpus");
      expect(() => evaluateMain([])).toThrow(/usage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("output", () => {
  it("formats rates and tables, and keeps account-length ids, emails and home paths out", () => {
    expect(rateText(rate(0, 0))).toBe("none judged");
    expect(rateText(rate(1, 4))).toBe("1 of 4 (25.0%, 95% CI 4.6% to 69.9%)");
    expect(mdTable(["a", "b"], [["x|y", 1]])).toBe("| a | b |\n| --- | --- |\n| x\\|y | 1 |");
    const sha = "9a7220a8f2f232d890ca73a7f68cf159b6d936f5";
    expect(publishable(`fetch('https://api.example.com/accounts/0123456789abcdef0123456789abcdef/x') at ${sha} by a@b.co in /Users/someone/x`)).toBe(
      `fetch('https://api.example.com/accounts/<hex32>/x') at ${sha} by <email> in ~/x`,
    );
    expect(publishableDeep({ "a@b.co": ["/Users/someone/y", 3] })).toEqual({ "<email>": ["~/y", 3] });
  });
});

describe("history parsing", () => {
  it("reads git's NUL-separated raw log into commits and entries", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const text = `commit ${a} 2026-01-02T00:00:00Z\0\n:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0src/x.ts\0:000000 100644 ${"0".repeat(40)} ${"3".repeat(40)} A\0commit y.ts\0commit ${b} 2026-01-01T00:00:00Z\0`;
    const { commits, entries } = parseRawLog(text);
    expect(commits).toEqual([
      { sha: a, date: "2026-01-02T00:00:00Z" },
      { sha: b, date: "2026-01-01T00:00:00Z" },
    ]);
    expect(entries.map((e) => [e.commit, e.status, e.path])).toEqual([
      [a, "M", "src/x.ts"],
      [a, "A", "commit y.ts"],
    ]);
  });

  it("scans only modified, regular, non-test script files with new content", () => {
    const e = (over: Partial<RawEntry>): RawEntry => ({ commit: "c", oldMode: "100644", newMode: "100644", oldBlob: "1", newBlob: "2", status: "M", path: "src/a.ts", ...over });
    expect(skipReason(e({}), null)).toBeNull();
    expect(skipReason(e({ path: "lib/a.cjs" }), null)).toBeNull();
    expect(skipReason(e({ status: "A" }), null)).toBe("not-modified");
    expect(skipReason(e({ path: "README.md" }), null)).toBe("not-script");
    expect(skipReason(e({ path: "src/a.test.ts" }), null)).toBe("test");
    expect(skipReason(e({ path: "deno_dist/a.ts" }), /^deno_dist\//)).toBe("excluded");
    expect(skipReason(e({ newMode: "120000" }), null)).toBe("not-regular-file");
    expect(skipReason(e({ newBlob: "1", newMode: "100755" }), null)).toBe("mode-only");
    expect(lineLink("https://code.example.invalid/o/r/", "c0ffee", "src/a b.ts", 12)).toBe("https://code.example.invalid/o/r/blob/c0ffee/src/a%20b.ts#L12");
    expect(lineLink("https://code.example.invalid/o/r", "c0ffee", "src/a.ts", 0)).toBe("https://code.example.invalid/o/r/blob/c0ffee/src/a.ts");
  });
});

describe("history sweep on a small repository", () => {
  let repo = "";
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  let clock = 1_700_000_000;
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { env: { ...env, GIT_AUTHOR_DATE: `@${clock} +0000`, GIT_COMMITTER_DATE: `@${clock++} +0000` } }).toString("utf8").trim();
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (message: string): string => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  let removed = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ft-danger-history-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
    put("src/auth.ts", GUARDED);
    put("src/util.ts", "export const one = 1\n");
    put("src/old.ts", "export const old = 1\n");
    put("test/auth.test.ts", "it('a', () => { expect(1).toBe(1) })\n");
    put("package.json", '{ "name": "x" }\n');
    commit("initial");
    put("src/auth.ts", UNGUARDED);
    put("test/auth.test.ts", "it('a', () => { expect(2).toBe(2) })\n");
    put("package.json", '{ "name": "y" }\n');
    removed = commit("drop the token check");
    put("src/util.ts", "export const one = 1\nexport const two = 2\n");
    rmSync(join(repo, "src/old.ts"));
    put("src/new.ts", "export const old = 1\n");
    commit("harmless edit and a rename");
    chmodSync(join(repo, "src/util.ts"), 0o755);
    commit("mode only");
    git("checkout", "-q", "-b", "side");
    put("src/side.ts", "export const side = 1\n");
    commit("side file");
    put("src/side.ts", "export const side = 2\n");
    commit("side edit");
    git("checkout", "-q", "main");
    put("src/util.ts", "export const one = 1\nexport const two = 2\nexport const three = 3\n");
    commit("main edit");
    git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("walks non-merge commits, scans the selected files and flags the deleted guard", async () => {
    const s = await sweep({ repo, rev: "HEAD", link: "https://example.invalid/r" });
    expect(s.commits.walked).toBe(7);
    // Added and deleted files (the root commit's five, the rename's two, the side file) are not modified files.
    expect(s.entries.skipped).toMatchObject({ test: 1, "not-script": 1, "mode-only": 1, "not-modified": 8, excluded: 0, "not-regular-file": 0 });
    // auth.ts (dropped check), util.ts (twice), side.ts (once).
    expect(s.files).toMatchObject({ scanned: 4, distinctPaths: 3, flagged: 1, toPerson: 0, secondOpinionOnly: 1, unreadable: 0, missingBlobs: 0 });
    expect(s.commits).toMatchObject({ withScannedFiles: 4, flagged: 1 });
    expect(s.flagged).toHaveLength(1);
    expect(s.flagged[0]).toMatchObject({ commit: removed, path: "src/auth.ts", tier: "second-opinion", classes: ["loosened-guard"] });
    expect(s.flagged[0]?.hits[0]?.link).toMatch(new RegExp(`^https://example.invalid/r/blob/${removed}/src/auth.ts#L\\d+$`));
    expect(s.byClass["loosened-guard"]).toMatchObject({ files: 1, hits: 1, rate: rate(1, 4) });
    expect(s.topPaths).toEqual([{ path: "src/auth.ts", flagged: 1 }]);
  });

  it("honors --max-count and --exclude", async () => {
    const latest = await sweep({ repo, rev: "HEAD", maxCount: 2 });
    expect(latest.commits.walked).toBe(2);
    const excluded = await sweep({ repo, rev: "HEAD", exclude: /^src\/util/ });
    expect(excluded.entries.skipped.excluded).toBe(3);
    expect(excluded.files.scanned).toBe(2);
  });

  it("writes the JSON and the summary with the command line, and reads a missing blob as null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-danger-out-"));
    try {
      const { json, md, report } = await historyMain(["--repo", repo, "--name", "tiny", "--out", dir]);
      expect(report).toMatchObject({ schema: "firetrident.danger-history/v1", name: "tiny", rev: "HEAD", maxCount: null, exclude: null });
      expect(report.command).toMatch(/^node --experimental-transform-types packages\/bench\/src\/danger\/history\.ts --repo \S+ --name tiny --out \S+$/);
      expect(JSON.parse(readFileSync(json, "utf8")).files.flagged).toBe(1);
      expect(readFileSync(md, "utf8")).toContain("| Files flagged | 1 |");
      await expect(historyMain(["--repo", repo, "--max-count", "0"])).rejects.toThrow(/positive integer/);
      const reader = new BlobReader(repo);
      expect(await reader.read("0".repeat(40))).toBeNull();
      await reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
