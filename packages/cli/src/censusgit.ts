import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  LOG_FORMAT,
  LogReader,
  branchCredit,
  broughtIn,
  censusText,
  claimedCredit,
  creditOf,
  generations,
  mergedBranch,
  notices,
  sealedCredits,
  sinceSeconds,
  tally,
  type AliveInfo,
  type Attributed,
  type CensusCommand,
  type CensusReport,
  type Credit,
} from "./census.ts";
import { noteState, trailerOf } from "./clonecheck.ts";
import type { Colors } from "./format.ts";

/**
 * The git side of `ft census` (census.ts): stock git in the repository, read-only and offline. git's output is read as it
 * streams: the history from one `git log -z --numstat`, the lineage notes from one `git cat-file --batch`, and lines alive
 * from `git blame --line-porcelain HEAD`, a few files at a time, within BLAME_FILES files and BLAME_MS.
 */

/** Files git blame reads at most for lines alive. */
export const BLAME_FILES = 2_000;
/** How long git blame runs at most for lines alive, in milliseconds. */
export const BLAME_MS = 60_000;
/** Blames that run at once. */
const BLAME_AT_ONCE = 6;

/** The caps on lines alive (BLAME_FILES and BLAME_MS unless a test sets others). */
export interface CensusLimits {
  files: number;
  ms: number;
}

/** No prompt for credentials, and no lock taken for an index refresh: a census only reads. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

/** Run git in `dir`, handing each chunk of its stdout to `onData`; rejects with git's first stderr line when it fails. */
function stream(dir: string, args: string[], onData: (chunk: Buffer) => void, opts: { input?: string; signal?: AbortSignal } = {}): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("git", args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, stdio: ["pipe", "pipe", "pipe"], ...(opts.signal ? { signal: opts.signal } : {}) });
    let said = "";
    child.stdout.on("data", onData);
    child.stderr.on("data", (d: Buffer) => {
      if (said.length < 4_096) said += d.toString("utf8");
    });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(said.trim().split("\n")[0] || `git ${args.find((a) => !a.startsWith("-")) ?? ""} exited with ${code}`))));
    // git can exit before it reads all of its input (a failed command): that is reported by its exit, not by the pipe.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/** git's stdout as text. */
async function output(dir: string, args: string[]): Promise<string> {
  const chunks: Buffer[] = [];
  await stream(dir, args, (c) => void chunks.push(c));
  return Buffer.concat(chunks).toString("utf8");
}

/** One commit as the census keeps it while it reads: what its identities and trailers claim, and its FT-Note digest. */
interface Read {
  sha: string;
  parents: string[];
  files: Array<{ path: string; added: number }>;
  binary: string[];
  renames: Array<{ from: string; to: string }>;
  claimed: Credit | null;
  digest: string | null;
  /** A merge: the branch its subject says it merged. */
  branch: string | null;
}

/** Every commit reachable from HEAD (made since `since`), read as git log streams; the messages are not kept. */
async function readHistory(dir: string, since: string | undefined, progress?: (text: string) => void): Promise<Read[]> {
  const reader = new LogReader();
  const decoder = new StringDecoder("utf8");
  const out: Read[] = [];
  const keep = (list: ReturnType<LogReader["push"]>): void => {
    for (const c of list) {
      const merge = c.parents.length > 1;
      out.push({ sha: c.sha, parents: c.parents, files: c.files, binary: c.binary, renames: c.renames, claimed: claimedCredit(c), digest: trailerOf(c.message), branch: merge ? mergedBranch(c.message.split("\n")[0] ?? "") : null });
      if (progress && out.length % 1_000 === 0) progress(`reading history: ${out.length.toLocaleString("en-US")} commits`);
    }
  };
  // Whatever the repository's configuration: the first commit's files count as added, messages come as UTF-8, and no
  // signature check, external diff or color mixes into the stream.
  const args = ["-c", "core.quotepath=off", "-c", "log.showRoot=true", "log", "-z", "-M", "--numstat", "--encoding=UTF-8", "--no-show-signature", "--no-ext-diff", "--no-textconv", "--no-color", `--format=${LOG_FORMAT}`];
  if (since !== undefined) args.push(`--since=@${sinceSeconds(since)}`);
  await stream(dir, [...args, "HEAD", "--"], (chunk) => keep(reader.push(decoder.write(chunk))));
  keep(reader.push(decoder.end()));
  keep(reader.end());
  return out;
}

/** Objects by id from one `git cat-file --batch`, read as it streams; an id the repository does not have is left out. */
async function readObjects(dir: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  let buf: Buffer = Buffer.alloc(0);
  await stream(
    dir,
    ["cat-file", "--batch"],
    (chunk) => {
      buf = buf.length > 0 ? Buffer.concat([buf, chunk]) : chunk;
      let at = 0;
      for (;;) {
        const nl = buf.indexOf(10, at);
        if (nl < 0) break;
        const head = buf.toString("latin1", at, nl).split(" ");
        if (head[1] === "missing" || head.length < 3) {
          at = nl + 1;
          continue;
        }
        const size = Number(head[2]);
        if (buf.length < nl + 1 + size + 1) break;
        out.set(head[0]!, buf.toString("utf8", nl + 1, nl + 1 + size));
        at = nl + 2 + size;
      }
      buf = buf.subarray(at);
    },
    { input: `${ids.join("\n")}\n` },
  );
  return out;
}

/** Whether the repository has refs/notes/firetrident, and the note text of each of `commits` that has one. */
async function readNotes(dir: string, commits: ReadonlySet<string>): Promise<{ ref: boolean; notes: Map<string, string> }> {
  try {
    await output(dir, ["rev-parse", "--verify", "--quiet", "refs/notes/firetrident"]);
  } catch {
    return { ref: false, notes: new Map() };
  }
  const notes = new Map<string, string>();
  if (commits.size === 0) return { ref: true, notes };
  const blobOf = new Map<string, string>();
  for (const line of (await output(dir, ["notes", "--ref=firetrident", "list"])).split("\n")) {
    const [blob, commit] = line.trim().split(/\s+/);
    if (blob && commit && commits.has(commit)) blobOf.set(commit, blob);
  }
  const texts = await readObjects(dir, [...new Set(blobOf.values())]);
  for (const [commit, blob] of blobOf) {
    const t = texts.get(blob);
    if (t !== undefined) notes.set(commit, t);
  }
  return { ref: true, notes };
}

/** The files HEAD holds (blobs, by path). */
async function filesAtHead(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const entry of (await output(dir, ["ls-tree", "-r", "-z", "HEAD"])).split("\0")) {
    const m = /^\d{6} blob [0-9a-f]+\t(.*)$/s.exec(entry);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** How a line's commit is counted: by commit, by commit and path (a sealed commit with several changes), or not at all. */
type Want = (sha: string) => "commit" | "path" | null;

/**
 * One file's lines at HEAD per commit `want` counts (keys "<sha>", or "<sha>\0<path as that commit named it>"). The walk
 * covers the file's whole history: blame follows a renamed file to its old name, and any shorter range would cut a line's
 * true commit off at the range's edge.
 */
async function blameFile(dir: string, path: string, want: Want, signal: AbortSignal): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let sha = "";
  let file = path;
  const line = (l: string): void => {
    if (l.charCodeAt(0) === 9) {
      const how = want(sha);
      if (how === null) return;
      const key = how === "path" ? `${sha}\0${file}` : sha;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return;
    }
    const header = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+/.exec(l);
    if (header) sha = header[1]!;
    else if (l.startsWith("filename ")) file = l.slice(9);
  };
  await stream(
    dir,
    ["-c", "core.quotepath=off", "blame", "--line-porcelain", "HEAD", "--", path],
    (chunk) => {
      const parts = (rest + decoder.write(chunk)).split("\n");
      rest = parts.pop() ?? "";
      for (const l of parts) line(l);
    },
    { signal },
  );
  const last = rest + decoder.end();
  if (last !== "") line(last);
  return counts;
}

/**
 * Lines alive: `files` blamed a few at a time, at most `limits.files` of them and for at most `limits.ms`. A file blame
 * the time cap stops is not counted; nor is one git cannot blame.
 */
async function blameAll(dir: string, files: string[], want: Want, limits: CensusLimits, now: () => number, progress?: (text: string) => void): Promise<{ alive: Map<string, number>; info: AliveInfo }> {
  const started = now();
  const todo = files.slice(0, limits.files);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), limits.ms);
  timer.unref?.();
  const alive = new Map<string, number>();
  let blamed = 0;
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!stop.signal.aborted && next < todo.length) {
      const path = todo[next++]!;
      try {
        for (const [k, v] of await blameFile(dir, path, want, stop.signal)) alive.set(k, (alive.get(k) ?? 0) + v);
        blamed++;
        if (progress && blamed % 25 === 0) progress(`blaming files at HEAD: ${blamed.toLocaleString("en-US")} of ${todo.length.toLocaleString("en-US")}`);
      } catch {
        if (!stop.signal.aborted) failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLAME_AT_ONCE, todo.length) }, worker));
  clearTimeout(timer);
  const timedOut = stop.signal.aborted && blamed + failed < todo.length;
  const cap: AliveInfo["cap"] = timedOut ? { kind: "time", limit: limits.ms } : files.length > todo.length ? { kind: "files", limit: limits.files } : null;
  return { alive, info: { files: files.length, blamed, failed, cap, ms: now() - started } };
}

/** Where each renamed path went, the latest rename of a path winning (`history` is newest first, as git log gives it). */
function renamedTo(history: readonly Read[]): Map<string, string> {
  const to = new Map<string, string>();
  for (let i = history.length - 1; i >= 0; i--) for (const r of history[i]!.renames) to.set(r.from, r.to);
  return to;
}

/** A path's name at HEAD: itself, or where its renames took it (a cycle stops where it closes); null when HEAD has neither. */
function nameAtHead(path: string, atHead: ReadonlySet<string>, renamed: ReadonlyMap<string, string>): string | null {
  const seen = new Set<string>();
  let at = path;
  while (!atHead.has(at)) {
    const next = renamed.get(at);
    if (next === undefined || seen.has(next)) return null;
    seen.add(at);
    at = next;
  }
  return at;
}

/**
 * The files to blame, by their names at HEAD (a file renamed after an agent wrote to it is blamed under its new name,
 * and blame follows it back): those agents touched first, by the lines agents added to them, then those only bots touched.
 */
function blameOrder(commits: readonly Attributed[], atHead: ReadonlySet<string>, renamed: ReadonlyMap<string, string>): string[] {
  const weight = new Map<string, { agent: number; bot: number }>();
  for (const a of commits) {
    for (const f of a.files) {
      const c = creditOf(a, f.path);
      const head = c === null || f.added === 0 ? null : nameAtHead(f.path, atHead, renamed);
      if (c === null || head === null) continue;
      const w = weight.get(head) ?? { agent: 0, bot: 0 };
      w[c.kind] += f.added;
      weight.set(head, w);
    }
  }
  return [...weight]
    .sort(([pa, a], [pb, b]) => Number(b.agent > 0) - Number(a.agent > 0) || b.agent - a.agent || b.bot - a.bot || pa.localeCompare(pb))
    .map(([path]) => path);
}

/** What `readCensus` takes besides the repository. */
export interface CensusOptions {
  since?: string;
  limits?: CensusLimits;
  now?: () => number;
  /** Progress text for a terminal, without a newline. */
  progress?: (text: string) => void;
}

/** Count who wrote the repository at `dir` (census.ts); throws with a sentence when it is not a repository with commits. */
export async function readCensus(dir: string, opts: CensusOptions = {}): Promise<CensusReport> {
  const now = opts.now ?? Date.now;
  const limits = opts.limits ?? { files: BLAME_FILES, ms: BLAME_MS };
  const isDir = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) throw new Error(`${dir} is not a directory: give the path of a git repository, or run ft census inside one`);
  try {
    await output(dir, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`${dir} is not a git repository: run ft census inside a clone, or give its path`);
  }
  // Every path git prints is from the top of the work tree (ls-tree and blame would read paths from a subdirectory).
  const root = (await output(dir, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim() || dir;
  let head: string;
  try {
    head = (await output(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim();
  } catch {
    throw new Error(`${dir} has no commits yet: there is nothing to count`);
  }
  const branch = await output(root, ["symbolic-ref", "--short", "-q", "HEAD"]).then(
    (s) => s.trim() || null,
    () => null,
  );
  const shallow = await output(root, ["rev-parse", "--is-shallow-repository"]).then(
    (s) => s.trim() === "true",
    () => false,
  );

  const history = await readHistory(root, opts.since, opts.progress);
  const { ref, notes } = await readNotes(root, new Set(history.filter((c) => c.digest !== null).map((c) => c.sha)));
  const noteCounts = { ref, trailers: 0, sealed: 0, notSealed: 0 };
  const commits: Attributed[] = history.map((c) => {
    const base = { sha: c.sha, merge: c.parents.length > 1, files: c.files };
    if (c.digest !== null) {
      noteCounts.trailers++;
      const raw = notes.get(c.sha) ?? null;
      // The note ft verify checks (clonecheck.ts): its bytes as the trunk writer writes them, hashing to the trailer.
      const sealed = noteState(raw, c.digest) === "intact" ? sealedCredits(JSON.parse(raw!), [...c.files.map((f) => f.path), ...c.binary]) : null;
      if (sealed) {
        noteCounts.sealed++;
        return { ...base, credit: sealed.first, credits: sealed.all, ...(sealed.all.length > 1 ? { byPath: sealed.byPath } : {}) };
      }
      noteCounts.notSealed++;
    }
    return { ...base, credit: c.claimed, credits: c.claimed ? [c.claimed] : [] };
  });

  // Inferred: what merges of agents' branches brought in, oldest merge first, where nothing stronger names a writer.
  const merges = history.flatMap((c) => {
    const credit = c.branch !== null ? branchCredit(c.branch) : null;
    return credit ? [{ sha: c.sha, credit }] : [];
  });
  if (merges.length > 0) {
    const graph = new Map(history.map((c) => [c.sha, c.parents]));
    const gen = generations(graph);
    const bySha = new Map(commits.map((a) => [a.sha, a]));
    merges.sort((x, y) => (gen.get(x.sha) ?? 0) - (gen.get(y.sha) ?? 0));
    for (const m of merges) {
      for (const sha of broughtIn(graph, gen, m.sha)) {
        const a = bySha.get(sha);
        if (a && a.credit === null) {
          a.credit = m.credit;
          a.credits = [m.credit];
        }
      }
    }
  }

  const credited = new Map<string, "commit" | "path">();
  for (const a of commits) if (a.credit !== null) credited.set(a.sha, a.byPath ? "path" : "commit");
  const files = credited.size > 0 ? blameOrder(commits, await filesAtHead(root), renamedTo(history)) : [];
  opts.progress?.(files.length > 0 ? `blaming ${files.length.toLocaleString("en-US")} files at HEAD` : "");
  const { alive, info } = await blameAll(root, files, (sha) => credited.get(sha) ?? null, limits, now, opts.progress);
  return {
    repository: { dir: basename(resolve(root)), head, branch, shallow, since: opts.since ?? null },
    ...tally(commits, alive),
    alive: info,
    notes: noteCounts,
    notices: notices({ notes: noteCounts, shallow }),
  };
}

/** Where `ft census` writes. */
export interface CensusOut {
  json: boolean;
  c: Colors;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Progress on a terminal, without a newline; absent otherwise. */
  progress?: (text: string) => void;
}

/** `ft census`: the report as text, or as one JSON object with --json. Exits 0, or 2 when the repository cannot be read. */
export async function runCensus(cmd: CensusCommand, out: CensusOut): Promise<number> {
  const progress = out.progress;
  const show = progress ? (text: string): void => progress(`\r\u001b[K${text ? `ft census: ${text}` : ""}`) : undefined;
  let report: CensusReport;
  try {
    report = await readCensus(cmd.dir ?? process.cwd(), { ...(cmd.since !== undefined ? { since: cmd.since } : {}), ...(show ? { progress: show } : {}) });
  } catch (e) {
    show?.("");
    out.stderr(`ft: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  show?.("");
  if (out.json) out.stdout(JSON.stringify(report, null, 2));
  else for (const line of censusText(report, out.c)) out.stdout(line);
  return 0;
}
