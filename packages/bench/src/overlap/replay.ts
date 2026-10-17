#!/usr/bin/env node
/**
 * Historical overlap replay: how often pull requests that were open at the same time touched the same files, how often
 * stock git could not merge them, and what FireTrident's text merge would have done. Lists a GitHub repository's merged
 * pull requests (a date window, or the newest N), pairs those whose open-to-merge windows overlapped, counts the pairs
 * that changed a file in common (what per-file locks would have serialized), and for each of those replays the merge on
 * a local clone: `git merge-tree` of the two heads over their merge base, then core mergeText (text merge, and with the
 * insertion rule) on every file both changed. No model calls, no FireTrident deployment.
 *
 *   node packages/bench/src/overlap/replay.ts --repository honojs/hono --since 2025-10-17 --until 2026-10-17 \
 *     --cache <dir> --out packages/bench/results/2026-10-17-hono-overlap
 *     [--newest <n>] [--base <branch>] [--repo <existing clone>]
 *
 * GitHub is read with the `gh` CLI (GraphQL, one page at a time with a pause between pages); every response is kept
 * under --cache and never fetched again. The clone (--cache/repo.git unless --repo names one) is made once; pull request
 * heads it lacks are fetched once from refs/pull/<n>/head, and merge commits no branch holds by their ids. Writes
 * <out>/overlap.json (every pair and its verdicts) and <out>/README.md (the counts), both through the bench evidence
 * redaction.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { redactDeep, redactEvidence } from "../evidence.ts";
import {
  mergeFile,
  overlapReadme,
  overlappingPairs,
  pairOutcome,
  selectPrs,
  summarize,
  type GitConflict,
  type MergedPr,
  type OverlapPair,
  type OverlapReport,
  type PairFile,
  type PairRecord,
  type ReplayStatus,
} from "./pairs.ts";

/** The repository root of this checkout: paths under it are written relative to it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** Pause after each GitHub request and each fetch, so the replay stays well inside GitHub's rate limits. */
const PAUSE_MS = 1_500;
/** Refs or commits fetched per `git fetch`. */
const FETCH_BATCH = 100;
/** The all-zero object id git's raw diff gives for a side where the file does not exist. */
const ZERO = /^0+$/;

/** Block for `ms` milliseconds (the replay is synchronous from start to end). */
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// ---------------------------------------------------------------------------------------------------------------------
// GitHub: merged pull requests through GraphQL, every page cached on disk.

const PULLS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt mergedAt updatedAt baseRefName baseRefOid headRefName headRefOid isCrossRepository changedFiles
        mergeCommit { oid }
        files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path changeType } }
      }
    }
  }
}`;

const FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { path changeType } }
    }
  }
}`;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
interface FilesConn {
  pageInfo: PageInfo;
  nodes: Array<{ path: string; changeType: string }>;
}
interface PullNode {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  updatedAt: string;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  changedFiles: number;
  mergeCommit: { oid: string } | null;
  files: FilesConn | null;
}
interface PullsPage {
  data: { repository: { pullRequests: { pageInfo: PageInfo; nodes: PullNode[] } } };
}
interface FilesPage {
  data: { repository: { pullRequest: { files: FilesConn | null } | null } };
}

/** GitHub GraphQL through `gh api graphql`, each answer kept under `dir` by the hash of its query and variables. */
class GitHubCache {
  fetched = 0;
  cached = 0;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** The answer to one query: from the cache when there, else from GitHub (then a pause). */
  query<T>(name: string, query: string, vars: Record<string, string | number | null>): T {
    const key = createHash("sha256").update(JSON.stringify({ query, vars })).digest("hex").slice(0, 20);
    const file = join(this.dir, `${name}-${key}.json`);
    if (existsSync(file)) {
      this.cached++;
      return JSON.parse(readFileSync(file, "utf8")) as T;
    }
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) continue;
      args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
    }
    const text = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(text) as T & { errors?: unknown };
    if (parsed.errors) throw new Error(`GitHub answered with errors: ${JSON.stringify(parsed.errors).slice(0, 300)}`);
    writeFileSync(file, text);
    this.fetched++;
    sleep(PAUSE_MS);
    return parsed;
  }
}

/** Every changed file of one pull request, paging past the first 100. */
function allFiles(gh: GitHubCache, owner: string, name: string, pr: PullNode): FilesConn["nodes"] {
  const files = [...(pr.files?.nodes ?? [])];
  let info = pr.files?.pageInfo ?? { hasNextPage: false, endCursor: null };
  while (info.hasNextPage) {
    const page = gh.query<FilesPage>(`files-${pr.number}`, FILES_QUERY, { owner, name, number: pr.number, cursor: info.endCursor });
    const conn = page.data.repository.pullRequest?.files;
    if (!conn) break;
    files.push(...conn.nodes);
    info = conn.pageInfo;
  }
  return files;
}

/** What listMergedPrs found: the merged pull requests read, and how many renamed entries their file lists hold. */
interface Listing {
  prs: MergedPr[];
  renamed: Map<number, number>;
}

/**
 * The repository's merged pull requests that may fall in the selection, newest update first, with their files. Pages are
 * read until no later one can hold a pull request merged in the window: a pull request's last update is never before its
 * merge, so once a page ends before `since` (or, for the newest N, before the Nth newest merge found), the walk stops.
 */
function listMergedPrs(gh: GitHubCache, repository: string, opts: { since?: string; until?: string; newest?: number; base?: string }): Listing {
  const [owner = "", name = ""] = repository.split("/");
  const out: MergedPr[] = [];
  const renamed = new Map<number, number>();
  let cursor: string | null = null;
  const until = opts.until ? Date.parse(opts.until) : Infinity;
  for (let page = 1; ; page++) {
    const res: PullsPage = gh.query<PullsPage>(`pulls-p${page}`, PULLS_QUERY, { owner, name, cursor });
    const repo = res.data.repository;
    const nodes = repo.pullRequests.nodes;
    for (const pr of nodes) {
      if (!pr.mergedAt) continue;
      const files = allFiles(gh, owner, name, pr);
      const r = files.filter((f) => f.changeType === "RENAMED").length;
      if (r > 0) renamed.set(pr.number, r);
      out.push({
        number: pr.number,
        createdAt: pr.createdAt,
        mergedAt: pr.mergedAt,
        baseRef: pr.baseRefName,
        baseSha: pr.baseRefOid,
        headRef: pr.headRefName,
        fromFork: pr.isCrossRepository,
        headSha: pr.headRefOid,
        mergeSha: pr.mergeCommit?.oid ?? null,
        files: [...new Set(files.map((f) => f.path))].sort(),
        changedFiles: pr.changedFiles,
      });
    }
    const oldest = nodes.length > 0 ? Date.parse(nodes[nodes.length - 1]!.updatedAt) : -Infinity;
    if (!repo.pullRequests.pageInfo.hasNextPage) break;
    if (opts.newest !== undefined) {
      // As selectPrs counts them: into --base when given, branch merges left out.
      const targets = new Set(out.map((p) => p.baseRef));
      const merged = out
        .filter((p) => (opts.base === undefined || p.baseRef === opts.base) && !(!p.fromFork && targets.has(p.headRef)) && Date.parse(p.mergedAt) < until)
        .map((p) => Date.parse(p.mergedAt))
        .sort((a, b) => b - a);
      if (merged.length >= opts.newest && oldest < merged[opts.newest - 1]!) break;
    } else if (opts.since && oldest < Date.parse(opts.since)) break;
    cursor = repo.pullRequests.pageInfo.endCursor;
    console.error(`  page ${page}: ${out.length} merged pull requests read, oldest update ${new Date(oldest).toISOString().slice(0, 10)}`);
  }
  return { prs: out, renamed };
}

// ---------------------------------------------------------------------------------------------------------------------
// git: stock git on a local clone.

/** Run git in `repo` and return its output; throws on a non-zero exit. */
function git(repo: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
}

/** Run git in `repo` and return its exit code and output. */
function gitStatus(repo: string, args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, out: r.stdout };
}

/** Which of these objects the clone has (`git cat-file --batch-check`). */
function present(repo: string, objects: readonly string[]): Set<string> {
  if (objects.length === 0) return new Set();
  const lines = git(repo, ["cat-file", "--batch-check"], `${objects.join("\n")}\n`).split("\n");
  const have = new Set<string>();
  lines.forEach((line, i) => {
    if (i < objects.length && !line.endsWith(" missing")) have.add(objects[i]!);
  });
  return have;
}

/** Clone the repository bare into `dir` unless it is there already. */
function ensureClone(dir: string, url: string): void {
  if (existsSync(join(dir, "HEAD"))) return;
  mkdirSync(dirname(dir), { recursive: true });
  console.error(`cloning ${url} into ${dir}`);
  execFileSync("git", ["clone", "--bare", "--no-tags", "--quiet", url, dir], { stdio: ["ignore", "inherit", "inherit"] });
}

/**
 * Fetch what the clone lacks, in batches: each pull request's head (refs/pull/<n>/head) and each merge commit no branch
 * holds any more (by its id).
 */
function ensureCommits(repo: string, url: string, prs: readonly MergedPr[]): void {
  const have = present(repo, prs.flatMap((p) => [`${p.headSha}^{commit}`, ...(p.mergeSha ? [`${p.mergeSha}^{commit}`] : [])]));
  const wants = [
    ...prs.filter((p) => !have.has(`${p.headSha}^{commit}`)).map((p) => `+refs/pull/${p.number}/head:refs/pull/${p.number}/head`),
    ...prs.filter((p) => p.mergeSha && !have.has(`${p.mergeSha}^{commit}`)).map((p) => p.mergeSha!),
  ];
  if (wants.length > 0) console.error(`fetching ${wants.length} pull request heads and merge commits`);
  for (let i = 0; i < wants.length; i += FETCH_BATCH) {
    execFileSync("git", ["-C", repo, "fetch", "--no-tags", "--quiet", url, ...wants.slice(i, i + FETCH_BATCH)], { stdio: ["ignore", "inherit", "inherit"] });
    sleep(PAUSE_MS);
  }
}

/** One entry of the raw tree diff: the path's blob and mode on each side (null blob: absent). */
interface RawChange {
  oldMode: string;
  newMode: string;
  oldBlob: string | null;
  newBlob: string | null;
}

/** Parse `git diff-tree -r -z --no-renames` raw output: path to its change. */
export function parseRawDiff(text: string): Map<string, RawChange> {
  const out = new Map<string, RawChange>();
  const tokens = text.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldBlob = "", newBlob = ""] = t.slice(1).split(" ");
    const path = tokens[++i] ?? "";
    out.set(path, { oldMode, newMode, oldBlob: ZERO.test(oldBlob) ? null : oldBlob, newBlob: ZERO.test(newBlob) ? null : newBlob });
  }
  return out;
}

/** What `git merge-tree --write-tree -z` said: the tree, the conflicted paths with their stages, and its conflict messages. */
export interface MergeTreeOutput {
  tree: string;
  conflicted: Array<{ mode: string; object: string; stage: number; path: string }>;
  conflicts: GitConflict[];
}

/**
 * Parse `git merge-tree --write-tree -z` output: the tree id, then (when it conflicted) one `<mode> <object> <stage>\t<path>`
 * entry per conflicted stage, an empty entry, and the messages, each `<count>`, that many paths, a type and the text.
 * Only messages whose type starts with CONFLICT are kept.
 */
export function parseMergeTree(text: string): MergeTreeOutput {
  const tokens = text.split("\0");
  const tree = tokens[0] ?? "";
  const conflicted: MergeTreeOutput["conflicted"] = [];
  let i = 1;
  for (; i < tokens.length && tokens[i] !== ""; i++) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(tokens[i]!);
    if (m) conflicted.push({ mode: m[1]!, object: m[2]!, stage: Number(m[3]), path: m[4]! });
  }
  const conflicts: GitConflict[] = [];
  for (i++; i < tokens.length; ) {
    const count = Number(tokens[i]);
    if (!Number.isInteger(count) || tokens[i] === "") break;
    const paths = tokens.slice(i + 1, i + 1 + count);
    const type = tokens[i + 1 + count] ?? "";
    i += count + 3;
    if (type.startsWith("CONFLICT")) conflicts.push({ type, paths });
  }
  return { tree, conflicted, conflicts };
}

/** Read blobs with one `git cat-file --batch`: id to bytes (missing ids are left out). */
function readBlobs(repo: string, ids: readonly string[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const r = spawnSync("git", ["-C", repo, "cat-file", "--batch"], { input: `${unique.join("\n")}\n`, maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw r.error;
  const buf = r.stdout;
  let at = 0;
  for (const id of unique) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    out.set(id, new Uint8Array(buf.subarray(at, at + size)));
    at += size + 1;
  }
  return out;
}

/** The replay of pairs on one clone, with what it learns about commits kept for the next pair. */
export class Replayer {
  private readonly ancestors = new Map<string, boolean>();
  private readonly ownBases = new Map<string, string | null>();
  private readonly diffs = new Map<string, Map<string, RawChange>>();
  private readonly have: Set<string>;
  private readonly repo: string;

  constructor(repo: string, prs: readonly MergedPr[]) {
    this.repo = repo;
    this.have = present(repo, prs.flatMap((p) => [p.headSha, ...(p.mergeSha ? [p.mergeSha] : [])]));
  }

  /** Whether commit `a` is an ancestor of (or is) commit `b` (null: no commit, false). Both must be in the clone. */
  private isAncestor(a: string | null, b: string): boolean {
    if (a === null) return false;
    const key = `${a} ${b}`;
    let v = this.ancestors.get(key);
    if (v === undefined) {
      const r = gitStatus(this.repo, ["merge-base", "--is-ancestor", a, b]);
      if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-base --is-ancestor ${a} ${b} exited ${r.code}`);
      v = r.code === 0;
      this.ancestors.set(key, v);
    }
    return v;
  }

  /**
   * The own base of a pull request's commit: the newest commit of the branch the pull request merged into that the
   * commit holds (its merge base with the merge's first parent). Null when the merge commit is unknown.
   */
  private ownBase(p: MergedPr, head: string): string | null {
    let v = this.ownBases.get(head);
    if (v === undefined) {
      const r = p.mergeSha ? gitStatus(this.repo, ["merge-base", `${p.mergeSha}^1`, head]) : { code: 1, out: "" };
      v = r.code === 0 ? r.out.trim() : null;
      this.ownBases.set(head, v);
    }
    return v;
  }

  /** The raw tree diff from `base` to `head`, without rename detection. */
  private diff(base: string, head: string): Map<string, RawChange> {
    const key = `${base} ${head}`;
    let v = this.diffs.get(key);
    if (!v) {
      v = parseRawDiff(git(this.repo, ["diff-tree", "-r", "-z", "--no-renames", base, head]));
      this.diffs.set(key, v);
    }
    return v;
  }

  /**
   * The later pull request's last commit of its own from before it took in the earlier one: the newest commit on its
   * head's first-parent line that holds neither the earlier merge nor the earlier head, when that commit is neither on
   * the branch the later one merged into (a rebased branch has none: its line reaches that branch first) nor in the
   * earlier one's history (a branch opened on top of the other reaches the other's commits first). Null otherwise.
   */
  private beforeUpdate(earlier: MergedPr, later: MergedPr): string | null {
    if (later.mergeSha === null) return null;
    for (const c of git(this.repo, ["rev-list", "--first-parent", later.headSha]).split("\n").filter(Boolean)) {
      if (this.isAncestor(earlier.mergeSha, c) || this.isAncestor(earlier.headSha, c)) continue;
      if (this.isAncestor(c, earlier.headSha)) return null;
      return gitStatus(this.repo, ["merge-base", "--is-ancestor", c, `${later.mergeSha}^1`]).code === 0 ? null : c;
    }
    return null;
  }

  /**
   * Replay one pair sharing a file: git merge-tree of the two heads over their merge base, then text merge on every file
   * both changed. When the later head already holds the earlier one, the later one's last commit of its own from before
   * that is replayed instead (beforeUpdate), or the pair is not replayed.
   */
  replay(pair: OverlapPair): PairRecord {
    const { earlier, later, shared } = pair;
    const rec = (status: ReplayStatus): PairRecord => ({ earlier: earlier.number, later: later.number, shared, status });
    const needed = [earlier.headSha, later.headSha, ...(earlier.mergeSha ? [earlier.mergeSha] : []), ...(later.mergeSha ? [later.mergeSha] : [])];
    if (!needed.every((c) => this.have.has(c))) return rec("missing-commit");
    if (this.isAncestor(later.headSha, earlier.headSha)) return rec("earlier-contains-later");
    if (this.isAncestor(earlier.mergeSha, later.headSha) || this.isAncestor(earlier.headSha, later.headSha)) {
      const before = this.beforeUpdate(earlier, later);
      return before === null ? rec("later-contains-earlier") : this.merge(pair, before, "replayed-before-update");
    }
    return this.merge(pair, later.headSha, "replayed");
  }

  /** git merge-tree of the earlier head and `laterHead` over their merge base, and text merge of every file both changed. */
  private merge(pair: OverlapPair, laterHead: string, status: ReplayStatus): PairRecord {
    const { earlier, later, shared } = pair;
    const bases = gitStatus(this.repo, ["merge-base", "--all", earlier.headSha, laterHead]).out.trim().split("\n").filter(Boolean);
    const mergeBase = bases[0];
    const head = laterHead === later.headSha ? {} : { laterHead };
    if (!mergeBase) return { earlier: earlier.number, later: later.number, shared, status: "missing-commit", ...head };
    const mt = gitStatus(this.repo, ["merge-tree", "--write-tree", "-z", `--merge-base=${mergeBase}`, earlier.headSha, laterHead]);
    if (mt.code !== 0 && mt.code !== 1) throw new Error(`git merge-tree of #${earlier.number} and #${later.number} exited ${mt.code}`);
    const parsed = parseMergeTree(mt.out);
    const gitConflicted = new Set(parsed.conflicted.map((c) => c.path));
    for (const c of parsed.conflicts) for (const p of c.paths) gitConflicted.add(p);
    const left = this.diff(mergeBase, earlier.headSha);
    const right = this.diff(mergeBase, laterHead);
    const both: Array<{ path: string; l: RawChange; r: RawChange }> = [];
    for (const [path, l] of left) {
      const r = right.get(path);
      if (r && l.newBlob !== r.newBlob) both.push({ path, l, r });
    }
    // Whether each file both changed was the same at the two pull requests' own bases.
    const eb = this.ownBase(earlier, earlier.headSha);
    const lb = this.ownBase(later, laterHead);
    const atBases = new Map<string, boolean | null>();
    if (eb && lb && both.length > 0) {
      const lines = git(this.repo, ["cat-file", "--batch-check=%(objectname)"], `${both.flatMap((f) => [`${eb}:${f.path}`, `${lb}:${f.path}`]).join("\n")}\n`).split("\n");
      both.forEach((f, i) => atBases.set(f.path, lines[2 * i] === lines[2 * i + 1]));
    }
    const isFile = (mode: string) => mode !== "160000";
    const blobs = readBlobs(
      this.repo,
      both.flatMap((f) => [f.l.oldBlob, f.l.newBlob, f.r.newBlob].filter((b, k): b is string => b !== null && isFile(k === 0 ? f.l.oldMode : k === 1 ? f.l.newMode : f.r.newMode))),
    );
    const bytes = (b: string | null) => (b === null ? null : (blobs.get(b) ?? null));
    const files: PairFile[] = both.map(({ path, l, r }) => {
      const versions = { base: bytes(l.oldBlob), earlier: bytes(l.newBlob), later: bytes(r.newBlob), submodule: [l.oldMode, l.newMode, r.newMode].includes("160000") };
      return {
        path,
        base: l.oldBlob,
        earlier: l.newBlob,
        later: r.newBlob,
        gitConflict: gitConflicted.has(path),
        sameAtBothBases: atBases.get(path) ?? null,
        text: mergeFile(path, versions, false),
        insertions: mergeFile(path, versions, true),
      };
    });
    return {
      earlier: earlier.number,
      later: later.number,
      shared,
      status,
      ...head,
      mergeBase,
      mergeBases: bases.length,
      git: { conflict: mt.code === 1, conflicts: parsed.conflicts },
      files,
      text: pairOutcome(files.map((f) => f.text)),
      insertions: pairOutcome(files.map((f) => f.insertions)),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The run.

const METHOD = (base: string | null): string[] => [
  `Pull requests: merged ${base ? `into \`${base}\`` : "into any branch"} inside the window, read with GitHub's GraphQL API (number, open and merge times, base and head branches and commits, merge commit, changed files). Branch merges are left out: a pull request from a branch of the repository that others merge into (a release merging one long-lived branch into another) carries other pull requests' work. A pull request merged before the window that overlapped one inside it is not paired.`,
  "Overlap: two pull requests into the same branch overlap when each was opened before the other merged (open-to-merge windows, drafts counted as open); pull requests into different branches never merge into one trunk and are not paired. The earlier is the one merged first: it is trunk's side of the merge, the later one is the change landing on it.",
  "Sharing a file: a path both pull requests' changed-file lists name. Per-file locks would have held the later one until the earlier merged.",
  "Updated after the other landed: when the later pull request's final head already holds the earlier one's merge commit or head (its author merged the branch it targets into it, or rebased, after the earlier landed), the replay takes the later one's last commit of its own from before that: the newest commit on its head's first-parent line that holds neither, when that commit is neither on the branch it merged into nor in the earlier one's history. That is the work as it stood when its author took in the earlier one, so a conflict they resolved by hand while updating shows. A rebased branch has no such commit, nor does one opened on top of the other's merge or stacked on its branch (nor an earlier head that holds the later one): those pairs are counted and not replayed.",
  "git: `git merge-tree --write-tree --merge-base=<base>` of the two heads, where the base is `git merge-base` of the two heads (the first when git finds more than one; mergeBases records how many). Stock git with its default merge (rename detection on).",
  "Text merge: every file both heads changed against that base to different results (rename detection off, as a colony sees writes) is merged with `packages/core` mergeText as the trunk writer calls it (trunk/plan.ts mergeWrites): base, the earlier head's version as trunk's, the later head's as the change's. A file added on both sides or deleted on one, a lockfile, a submodule, a version over 512 KB, binary or not UTF-8, or a side past the edit limit is not merged and the later change goes back. A pair lands only when every such file merges. With the insertion rule, mergeText runs with `insertions` (FT_MERGE_INSERTIONS). git and mergeText (a plain Myers diff) can place an insertion differently when the lines around it repeat (closing braces), so one can conflict where the other does not; both verdicts are recorded per file.",
  "Own edits: a git-conflicting file is the two pull requests' own collision when it was the same at both pull requests' own bases (each head's merge base with the branch as it stood just before its merge); otherwise the branch they merged into also changed it between the two bases, and part of the conflict is with that.",
];

const LIMITS = (renamedEntries: number, renamedPrs: number, multiBase: number, truncated: number): string[] => [
  "Read sets are not measurable from pull request data: a pair git merges cleanly where one pull request changed what the other only read (an import, a called function's signature, a type) is invisible here. FireTrident checks reads at landing (stale reads go back or are revalidated); this replay measures writes only.",
  "Commits, not working trees. The replay sees the commits a pull request's branch kept: a rebase or force-push drops the work as it stood before (those pairs are not replayed), and work an author held locally before pushing does not show.",
  "Pairwise, against the earlier head. On a colony the later change merges with trunk as it is when it lands (every landing since its base), not with the earlier head alone; and when the two bases differ, what the branch changed between them counts as the side with the newer base (see own edits).",
  "The conflict resolver (FT_RESOLVER, one model call per conflicting file) is not replayed: no model calls. Still-conflicting pairs are the ones it would be asked to merge.",
  `Changed-file lists name a renamed file by its new path only (${renamedEntries} renamed ${renamedEntries === 1 ? "entry" : "entries"} in ${renamedPrs} pull ${renamedPrs === 1 ? "request" : "requests"}), so a pair where one renamed a file the other changed is not counted as sharing it.`,
  ...(multiBase > 0 ? [`${multiBase} replayed ${multiBase === 1 ? "pair" : "pairs"} had more than one best merge base; both merges used the first, where stock git's default would merge the bases first.`] : []),
  ...(truncated > 0 ? [`${truncated} pull requests list fewer files than GitHub counts for them.`] : []),
];

/** JSON indented by two spaces, with each array of plain values (a file list, a pair) on one line unless it holds prose (a string over 100 characters). */
export function compactJson(value: unknown, indent = ""): string {
  const plain = (v: unknown) => v === null || typeof v !== "object";
  if (plain(value)) return JSON.stringify(value) ?? "null";
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => plain(v) && !(typeof v === "string" && v.length > 100))) return `[${value.map((v) => JSON.stringify(v) ?? "null").join(", ")}]`;
    return `[\n${value.map((v) => `${inner}${compactJson(v, inner)}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compactJson(v, inner)}`).join(",\n")}\n${indent}}`;
}

/** Where the redaction changed a string of the report: each JSON path with the string before and after. */
function redactionChanges(before: unknown, after: unknown, at = "$"): string[] {
  if (typeof before === "string") return before === after ? [] : [`${at}: ${JSON.stringify(before.slice(0, 120))} -> ${JSON.stringify(String(after).slice(0, 120))}`];
  if (Array.isArray(before)) return before.flatMap((x, i) => redactionChanges(x, (after as unknown[])[i], `${at}[${i}]`));
  if (before && typeof before === "object") return Object.entries(before).flatMap(([k, x]) => redactionChanges(x, (after as Record<string, unknown>)[k], `${at}.${k}`));
  return [];
}

/** Today's date at 00:00 UTC, and the same day `months` earlier. */
function defaultWindow(months: number): { since: string; until: string } {
  const now = new Date();
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth() - months, until.getUTCDate()));
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
}

/** A date or a time, as ISO (a bare date is 00:00 UTC). */
function isoOf(v: string, flag: string): string {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(t)) throw new Error(`${flag} must be a date (YYYY-MM-DD) or an ISO time`);
  return new Date(t).toISOString();
}

/** Parse arguments, list, pair, replay, and write <out>/overlap.json and <out>/README.md. */
export function main(argv: string[]): { report: OverlapReport; json: string; readme: string } {
  const { values } = parseArgs({
    args: argv,
    options: {
      repository: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      newest: { type: "string" },
      base: { type: "string" },
      cache: { type: "string" },
      repo: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  const repository = values.repository ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !values.out) throw new Error("usage: replay.ts --repository <owner/name> --out <dir> [--since <date>] [--until <date>] [--newest <n>] [--base <branch>] [--cache <dir>] [--repo <clone>]");
  const newest = values.newest === undefined ? undefined : Number(values.newest);
  if (newest !== undefined && !(Number.isInteger(newest) && newest > 1)) throw new Error("--newest must be an integer above 1");
  const fallback = defaultWindow(12);
  const until = isoOf(values.until ?? fallback.until, "--until");
  const since = newest !== undefined && values.since === undefined ? undefined : isoOf(values.since ?? fallback.since, "--since");
  const cache = resolve(values.cache ?? join(tmpdir(), `ft-overlap-${repository.replace("/", "-")}`));
  const url = `https://github.com/${repository}.git`;
  const t0 = Date.now();

  console.error(`listing merged pull requests of ${repository}`);
  const gh = new GitHubCache(join(cache, "github"));
  const base = values.base ?? null;
  const listing = listMergedPrs(gh, repository, { ...(since ? { since } : {}), until, ...(newest !== undefined ? { newest } : {}), ...(base ? { base } : {}) });
  const selection = selectPrs(listing.prs, { ...(base ? { base } : {}), ...(since ? { since } : {}), until, ...(newest !== undefined ? { newest } : {}) });
  const prs = selection.prs;
  console.error(`${prs.length} pull requests merged into ${base ?? "any branch"}, ${selection.branchMerges.length} branch merges left out (GitHub: ${gh.fetched} requests, ${gh.cached} from the cache)`);

  const pairs = overlappingPairs(prs);
  const sharing = pairs.filter((p) => p.shared.length > 0);
  console.error(`${pairs.length} overlapping pairs, ${sharing.length} sharing a file`);

  const repo = values.repo ? resolve(values.repo) : join(cache, "repo.git");
  if (!values.repo) ensureClone(repo, url);
  ensureCommits(repo, url, prs);
  const replayer = new Replayer(repo, prs);
  const records: PairRecord[] = [];
  for (const [i, p] of sharing.entries()) {
    records.push(replayer.replay(p));
    if ((i + 1) % 250 === 0) console.error(`  replayed ${i + 1} of ${sharing.length}`);
  }

  const { counts, stillConflictingBy } = summarize(prs.length, pairs.length, records);
  const renamedPrs = prs.filter((p) => listing.renamed.has(p.number));
  const renamedEntries = renamedPrs.reduce((s, p) => s + (listing.renamed.get(p.number) ?? 0), 0);
  // The command as run, with the local cache and clone paths left as placeholders.
  const shown = argv.map((a, i) => (argv[i - 1] === "--cache" ? "<cache>" : argv[i - 1] === "--repo" ? "<clone>" : a));
  const command = ["node packages/bench/src/overlap/replay.ts", ...shown.map((a) => (/^[\w./:@=,+<>-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))].join(" ");
  const report: OverlapReport = {
    schema: "firetrident.overlap-replay/v1",
    label: "MEASURED",
    repository,
    base,
    window: { since: since ?? null, until, newest: newest ?? null, firstMerged: prs[0]?.mergedAt ?? null, lastMerged: prs[prs.length - 1]?.mergedAt ?? null },
    otherBase: selection.otherBase,
    branchMerges: selection.branchMerges,
    command,
    generatedAt: new Date().toISOString(),
    method: METHOD(base),
    limits: LIMITS(renamedEntries, renamedPrs.length, records.filter((r) => (r.mergeBases ?? 1) > 1).length, prs.filter((p) => p.files.length < p.changedFiles).length),
    counts,
    stillConflictingBy,
    prs,
    pairsWithoutSharedFile: pairs.filter((p) => p.shared.length === 0).map((p) => [p.earlier.number, p.later.number]),
    pairs: records,
  };
  const opts = { repoRoot: REPO_ROOT };
  const published = redactDeep(report, opts);
  for (const d of redactionChanges(report, published).slice(0, 10)) console.error(`redacted ${d}`);
  mkdirSync(values.out, { recursive: true });
  const json = join(values.out, "overlap.json");
  const readme = join(values.out, "README.md");
  writeFileSync(json, `${compactJson(published)}\n`);
  writeFileSync(readme, redactEvidence(overlapReadme(published), opts));
  const c = counts;
  console.log(
    `${repository}: ${c.prs} pull requests, ${c.overlappingPairs} overlapping pairs, ${c.pairsSharingFile} sharing a file, ${c.replayed} replayed, ${c.gitConflicts} git conflicts, text merge resolves ${c.textMergeResolved}, with the insertion rule ${c.insertionMergeResolved}, ${c.stillConflicting} still conflicting; ${((Date.now() - t0) / 1000).toFixed(1)} s; wrote ${json} and ${readme}`,
  );
  return { report: published, json, readme };
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
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(redactEvidence(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}
