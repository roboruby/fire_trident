#!/usr/bin/env node
/**
 * False alarms of the decide stage's deterministic danger checks on real history: walks a local
 * git repository's commits, takes every modified script file that is not a test, runs the checks
 * the decide stage applies before any model (checks.ts: danger patterns, loosened guards,
 * governance paths) on its text before and after the commit, and reports the files scanned, the
 * files flagged and every hit. Read-only: it runs `git log` and `git cat-file` and nothing else.
 *
 *   node --experimental-transform-types packages/bench/src/danger/history.ts --repo <path> --name <label> --out <dir>
 *     [--rev <revision or range>] [--max-count <n>] [--exclude <path regex>] [--link <web base of the repository>]
 *
 * (The flag is needed because decide/danger.ts uses TypeScript that type stripping alone cannot run.)
 *
 * Selection: the non-merge commits `git log --no-merges <rev>` lists (at most --max-count), each
 * diffed against its parent with rename detection off, so a rename counts as a deletion and an
 * addition, as a colony sees it. Of their raw entries, a file is scanned when it is modified
 * (status M), a regular file on both sides with new content, a script (.js .jsx .mjs .cjs .ts
 * .tsx .mts .cts), not a test (decide/signals.ts isTestPath), and not matched by --exclude.
 * Merge commits' own conflict resolutions are not read.
 *
 * Checks: each file on its own, with no intent (nothing asked for), the default policy's
 * allowances (none), texts read under the decide stage's limits. A file is flagged when a hit
 * counts: one that sends the change to a person, or a danger signal a second opinion must clear.
 *
 * Writes <dir>/<label>.json (counts, every flagged file with its hits, the range, the command
 * line) and <dir>/<label>.md (a summary), with excerpts passed through output.ts publishable.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isTestPath } from "../../../worker/src/decide/signals.ts";
import { checkDangerFiles, readableText, SCRIPT_FILE, hitRows, type DangerTier, type HitRow } from "./checks.ts";
import { codeSpan, mdTable, publishable, publishableDeep, rate, rateText, type Rate } from "./output.ts";

/** The repository root of this checkout: paths under it are written relative to it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** One entry of git's raw diff for one commit. */
export interface RawEntry {
  commit: string;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  /** A, D, M or T (rename detection is off, so never R or C). */
  status: string;
  path: string;
}

/** A commit the log walked, with its committer date. */
export interface WalkedCommit {
  sha: string;
  date: string;
}

/**
 * Parse `git log -z --raw --no-abbrev --format='commit %H %cI'` output: NUL-separated tokens where
 * each commit line is followed by its raw entries, each a `:modes blobs status` token and then a path.
 */
export function parseRawLog(text: string): { commits: WalkedCommit[]; entries: RawEntry[] } {
  const commits: WalkedCommit[] = [];
  const entries: RawEntry[] = [];
  const tokens = text.split("\0");
  let current: WalkedCommit | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.replace(/^\n+/, "");
    if (t === "") continue;
    if (t.startsWith("commit ")) {
      const [sha = "", date = ""] = t.slice("commit ".length).trim().split(" ");
      current = { sha, date };
      commits.push(current);
    } else if (t.startsWith(":") && current) {
      const [oldMode = "", newMode = "", oldBlob = "", newBlob = "", status = ""] = t.slice(1).trim().split(/\s+/);
      const path = tokens[++i] ?? "";
      entries.push({ commit: current.sha, oldMode, newMode, oldBlob, newBlob, status: status.charAt(0), path });
    }
  }
  return { commits, entries };
}

/** Why an entry is not scanned. */
export type Skip = "not-modified" | "not-script" | "test" | "excluded" | "not-regular-file" | "mode-only";

/** The reason an entry is left out, or null when it is scanned (see the module comment). */
export function skipReason(e: RawEntry, exclude: RegExp | null): Skip | null {
  if (e.status !== "M") return "not-modified";
  if (!SCRIPT_FILE.test(e.path)) return "not-script";
  if (isTestPath(e.path)) return "test";
  if (exclude && exclude.test(e.path)) return "excluded";
  if (!/^100\d{3}$/.test(e.oldMode) || !/^100\d{3}$/.test(e.newMode)) return "not-regular-file";
  if (e.oldBlob === e.newBlob) return "mode-only";
  return null;
}

/** Reads blobs through one `git cat-file --batch` process; answers come back in the order asked. */
export class BlobReader {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buf: Buffer = Buffer.alloc(0);
  private readonly waiting: Array<{ resolve: (b: Buffer | null) => void; reject: (e: Error) => void }> = [];
  private failed: Error | null = null;
  private stderr = "";

  constructor(repo: string) {
    this.proc = spawn("git", ["-C", repo, "cat-file", "--batch"]);
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    this.proc.on("error", (e) => this.fail(e));
    this.proc.on("close", (code) => {
      if (this.waiting.length > 0) this.fail(new Error(`git cat-file exited (${code}): ${this.stderr.trim()}`));
    });
  }

  /** The blob's bytes, or null when it is missing or not a blob. */
  read(sha: string): Promise<Buffer | null> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((res, rej) => {
      this.waiting.push({ resolve: res, reject: rej });
      this.proc.stdin.write(`${sha}\n`);
    });
  }

  /** Stop the process. */
  close(): Promise<void> {
    return new Promise((res) => {
      if (this.proc.exitCode !== null) return res();
      this.proc.once("close", () => res());
      this.proc.stdin.end();
    });
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) return;
      const header = this.buf.subarray(0, nl).toString("utf8");
      if (/ missing$/.test(header)) {
        this.buf = this.buf.subarray(nl + 1);
        this.waiting.shift()!.resolve(null);
        continue;
      }
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!m) return this.fail(new Error(`unexpected git cat-file output: ${header.slice(0, 80)}`));
      const size = Number(m[2]);
      if (this.buf.length < nl + 1 + size + 1) return;
      const content = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + size));
      this.buf = this.buf.subarray(nl + 2 + size);
      this.waiting.shift()!.resolve(m[1] === "blob" ? content : null);
    }
  }

  private fail(e: Error): void {
    this.failed ??= e;
    for (const w of this.waiting.splice(0)) w.reject(e);
  }
}

/** What to walk. */
export interface SweepOptions {
  repo: string;
  /** A revision or range for `git log` (default HEAD). */
  rev?: string;
  maxCount?: number;
  /** Paths left out (tested against the repository path). */
  exclude?: RegExp | null;
  /** A web base for links to the flagged lines (`<link>/blob/<commit>/<path>#L<line>`). */
  link?: string | null;
}

/** One flagged file. */
export interface FlaggedFile {
  commit: string;
  date: string;
  path: string;
  tier: Exclude<DangerTier, "none">;
  classes: string[];
  hits: Array<HitRow & { link?: string }>;
}

/** What one sweep found (before redaction). */
export interface Sweep {
  commits: { walked: number; withScannedFiles: number; flagged: number; flaggedRate: Rate; newest: WalkedCommit | null; oldest: WalkedCommit | null };
  entries: { total: number; modified: number; modifiedScripts: number; skipped: Record<Skip, number> };
  files: {
    scanned: number;
    distinctPaths: number;
    /** Old or new text the decide stage would not read (over 512 KiB, a NUL, not UTF-8). */
    unreadable: number;
    missingBlobs: number;
    flagged: number;
    flaggedRate: Rate;
    toPerson: number;
    toPersonRate: Rate;
    secondOpinionOnly: number;
  };
  /** Per danger class: files with at least one hit of it, hits, and the rate over files scanned. */
  byClass: Record<string, { files: number; hits: number; rate: Rate }>;
  /** Per pattern: files and hits. */
  byPattern: Record<string, { files: number; hits: number }>;
  /** Paths flagged most often (in how many commits). */
  topPaths: Array<{ path: string; flagged: number }>;
  flagged: FlaggedFile[];
  elapsedMs: number;
}

/** Walk the history and run the checks on every selected file. */
export async function sweep(opts: SweepOptions): Promise<Sweep> {
  const t0 = Date.now();
  const rev = opts.rev ?? "HEAD";
  // Local settings that would change the output (signatures, colors, a hidden root commit) are overridden.
  const args = ["-C", opts.repo, "-c", "log.showSignature=false", "-c", "log.showRoot=true", "log", "--no-color", "-z", "--no-merges", "--no-renames", "--raw", "--no-abbrev", "--format=commit %H %cI"];
  if (opts.maxCount !== undefined) args.push(`--max-count=${opts.maxCount}`);
  args.push("--end-of-options", rev, "--");
  const log = parseRawLog(execFileSync("git", args, { maxBuffer: 1 << 30 }).toString("utf8"));
  const dates = new Map(log.commits.map((c) => [c.sha, c.date]));
  const skipped: Record<Skip, number> = { "not-modified": 0, "not-script": 0, test: 0, excluded: 0, "not-regular-file": 0, "mode-only": 0 };
  const selected: RawEntry[] = [];
  for (const e of log.entries) {
    const why = skipReason(e, opts.exclude ?? null);
    if (why) skipped[why]++;
    else selected.push(e);
  }
  const reader = new BlobReader(opts.repo);
  const flagged: FlaggedFile[] = [];
  const byClass: Sweep["byClass"] = {};
  const byPattern: Sweep["byPattern"] = {};
  const scannedCommits = new Set<string>();
  const flaggedCommits = new Set<string>();
  const paths = new Set<string>();
  const flaggedPaths = new Map<string, number>();
  let scanned = 0;
  let unreadable = 0;
  let missingBlobs = 0;
  let toPerson = 0;
  try {
    for (const e of selected) {
      const [oldBytes, newBytes] = await Promise.all([reader.read(e.oldBlob), reader.read(e.newBlob)]);
      if (!oldBytes || !newBytes) {
        missingBlobs++;
        continue;
      }
      scanned++;
      scannedCommits.add(e.commit);
      paths.add(e.path);
      const before = readableText(oldBytes);
      const read = readableText(newBytes);
      if (before === null || read === null) unreadable++;
      // As the decide engine reads a kept file: unreadable new text counts as empty.
      const o = checkDangerFiles([{ path: e.path, before, after: read ?? "", deleted: false }], null);
      if (!o.flagged) continue;
      if (o.tier === "person") toPerson++;
      flaggedCommits.add(e.commit);
      flaggedPaths.set(e.path, (flaggedPaths.get(e.path) ?? 0) + 1);
      const hits = hitRows(o).map((h) => (opts.link ? { ...h, link: lineLink(opts.link, e.commit, h.path, h.line) } : h));
      for (const cls of o.classes) {
        const row = (byClass[cls] ??= { files: 0, hits: 0, rate: rate(0, 0) });
        row.files++;
      }
      const patterns = new Set<string>();
      for (const h of hits) {
        byClass[h.cls]!.hits++;
        const row = (byPattern[h.pattern] ??= { files: 0, hits: 0 });
        row.hits++;
        if (!patterns.has(h.pattern)) row.files++;
        patterns.add(h.pattern);
      }
      flagged.push({ commit: e.commit, date: dates.get(e.commit) ?? "", path: e.path, tier: o.tier as Exclude<DangerTier, "none">, classes: o.classes, hits });
    }
  } finally {
    await reader.close();
  }
  for (const row of Object.values(byClass)) row.rate = rate(row.files, scanned);
  return {
    commits: {
      walked: log.commits.length,
      withScannedFiles: scannedCommits.size,
      flagged: flaggedCommits.size,
      flaggedRate: rate(flaggedCommits.size, scannedCommits.size),
      newest: log.commits[0] ?? null,
      oldest: log.commits[log.commits.length - 1] ?? null,
    },
    entries: { total: log.entries.length, modified: log.entries.filter((e) => e.status === "M").length, modifiedScripts: log.entries.filter((e) => e.status === "M" && SCRIPT_FILE.test(e.path)).length, skipped },
    files: {
      scanned,
      distinctPaths: paths.size,
      unreadable,
      missingBlobs,
      flagged: flagged.length,
      flaggedRate: rate(flagged.length, scanned),
      toPerson,
      toPersonRate: rate(toPerson, scanned),
      secondOpinionOnly: flagged.length - toPerson,
    },
    byClass: Object.fromEntries(Object.entries(byClass).sort(([, a], [, b]) => b.files - a.files)),
    byPattern: Object.fromEntries(Object.entries(byPattern).sort(([, a], [, b]) => b.files - a.files)),
    topPaths: [...flaggedPaths.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([path, n]) => ({ path, flagged: n })),
    flagged,
    elapsedMs: Date.now() - t0,
  };
}

/** A web link to a line of a file at a commit (the whole file for line 0). */
export function lineLink(base: string, commit: string, path: string, line: number): string {
  const file = path.split("/").map(encodeURIComponent).join("/");
  return `${base.replace(/\/+$/, "")}/blob/${commit}/${file}${line > 0 ? `#L${line}` : ""}`;
}

/** The results document: what was walked and how, then what the sweep found. */
export interface SweepReport extends Sweep {
  schema: "firetrident.danger-history/v1";
  name: string;
  rev: string;
  maxCount: number | null;
  exclude: string | null;
  command: string;
  generatedAt: string;
  selection: string;
  checks: string;
}

const SELECTION =
  "non-merge commits from git log --no-merges (rename detection off), each against its parent; modified (M) regular files with new content, scripts (.js .jsx .mjs .cjs .ts .tsx .mts .cts), not tests (decide/signals.ts isTestPath), not matched by --exclude";
const CHECKS =
  "decide/danger.ts scanDanger on each file with no intent (danger patterns, loosened guards, governance paths), the default policy's allowances (none), then triageDanger; texts read under the decide stage's limits (512 KiB, a NUL in the first 8 KiB, invalid UTF-8); flagged = a must-human hit or a danger signal";

/** The markdown summary of one sweep. */
export function sweepMarkdown(r: SweepReport, maxRows = 200): string {
  const f = r.files;
  const span = r.commits.newest && r.commits.oldest ? `${r.commits.oldest.sha.slice(0, 10)} (${r.commits.oldest.date.slice(0, 10)}) to ${r.commits.newest.sha.slice(0, 10)} (${r.commits.newest.date.slice(0, 10)})` : "no commits";
  const lines = [
    `# Deterministic danger checks on ${r.name} history`,
    "",
    `${r.commits.walked} non-merge commits walked (${codeSpan(r.rev)}${r.maxCount !== null ? `, at most ${r.maxCount}` : ""}${r.exclude ? `, excluding ${codeSpan(r.exclude)}` : ""}), ${span}. Command: ${codeSpan(r.command)}`,
    "",
    `Selection: ${r.selection}. Checks: ${r.checks}.`,
    "",
    mdTable(
      ["Measure", "Count"],
      [
        ["Modified script files (all)", r.entries.modifiedScripts],
        ["Left out as tests", r.entries.skipped.test],
        ["Left out by --exclude", r.entries.skipped.excluded],
        ["Mode change only, or not a regular file", r.entries.skipped["mode-only"] + r.entries.skipped["not-regular-file"]],
        ["Files scanned (commit and path)", f.scanned],
        ["Distinct paths scanned", f.distinctPaths],
        ["Texts the decide stage would not read", f.unreadable],
        ["Files flagged", f.flagged],
        ["Flagged: sent to a person", f.toPerson],
        ["Flagged: danger signals only (a second opinion must look)", f.secondOpinionOnly],
        ["Commits with a scanned file", r.commits.withScannedFiles],
        ["Commits with a flagged file", r.commits.flagged],
      ],
    ),
    "",
    `- Files flagged: ${rateText(f.flaggedRate)}`,
    `- Files sent to a person: ${rateText(f.toPersonRate)}`,
    `- Loosened guard: ${rateText(r.byClass["loosened-guard"]?.rate ?? rate(0, f.scanned))}`,
    `- Commits with a flagged file: ${rateText(r.commits.flaggedRate)}`,
  ];
  const classes = Object.entries(r.byClass);
  if (classes.length > 0) lines.push("", "## By danger class", "", mdTable(["Class", "Files", "Share of files scanned", "Hits"], classes.map(([c, x]) => [c, x.files, rateText(x.rate), x.hits])));
  const patterns = Object.entries(r.byPattern);
  if (patterns.length > 0) lines.push("", "## By pattern", "", mdTable(["Pattern", "Files", "Hits"], patterns.map(([p, x]) => [p, x.files, x.hits])));
  if (r.topPaths.length > 0) lines.push("", "## Paths flagged most often", "", mdTable(["Path", "Commits flagged"], r.topPaths.map((p) => [p.path, p.flagged])));
  if (r.flagged.length > 0) {
    lines.push(
      "",
      `## Flagged files${r.flagged.length > maxRows ? ` (the first ${maxRows} of ${r.flagged.length}; all of them are in the JSON)` : ""}`,
      "",
      mdTable(
        ["Commit", "Path", "Tier", "Hits"],
        r.flagged.slice(0, maxRows).map((x) => [
          x.commit.slice(0, 10),
          x.path,
          x.tier,
          x.hits
            .slice(0, 3)
            .map((h) => `${h.pattern} line ${h.line}: ${codeSpan(h.excerpt)}`)
            .join("; ") + (x.hits.length > 3 ? `; and ${x.hits.length - 3} more` : ""),
        ]),
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Parse arguments, sweep, and write <out>/<name>.json and <out>/<name>.md. */
export async function main(argv: string[]): Promise<{ json: string; md: string; report: SweepReport }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      name: { type: "string" },
      rev: { type: "string" },
      "max-count": { type: "string" },
      exclude: { type: "string" },
      link: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.repo) throw new Error("usage: history.ts --repo <path> --name <label> --out <dir> [--rev <revision>] [--max-count <n>] [--exclude <regex>] [--link <url>]");
  const maxCount = values["max-count"] === undefined ? undefined : Number(values["max-count"]);
  if (maxCount !== undefined && !(Number.isInteger(maxCount) && maxCount > 0)) throw new Error("--max-count must be a positive integer");
  const exclude = values.exclude ? new RegExp(values.exclude) : null;
  const name = (values.name ?? basename(resolve(values.repo))).replace(/[^\w.-]+/g, "-");
  const rev = values.rev ?? "HEAD";
  const found = await sweep({ repo: values.repo, rev, ...(maxCount !== undefined ? { maxCount } : {}), exclude, link: values.link ?? null });
  // Arguments a shell could read as anything but text (a regex's ^ or *, spaces) are single-quoted.
  const command = ["node --experimental-transform-types packages/bench/src/danger/history.ts", ...argv.map((a) => (/^[\w./:@=,+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))].join(" ");
  const report: SweepReport = publishableDeep({
    schema: "firetrident.danger-history/v1",
    name,
    rev,
    maxCount: maxCount ?? null,
    exclude: values.exclude ?? null,
    command: command.split(`${REPO_ROOT}/`).join("").split(REPO_ROOT).join("."),
    generatedAt: new Date().toISOString(),
    selection: SELECTION,
    checks: CHECKS,
    ...found,
  });
  const out = values.out ?? "danger-history";
  mkdirSync(out, { recursive: true });
  const json = join(out, `${name}.json`);
  const md = join(out, `${name}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(md, sweepMarkdown(report));
  console.log(
    `${name}: ${report.commits.walked} commits, ${report.files.scanned} files scanned, ${rateText(report.files.flaggedRate)} flagged (${report.files.toPerson} to a person), loosened guard ${report.byClass["loosened-guard"]?.files ?? 0}; ${(report.elapsedMs / 1000).toFixed(1)} s; wrote ${json} and ${md}`,
  );
  return { json, md, report };
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(publishable(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
