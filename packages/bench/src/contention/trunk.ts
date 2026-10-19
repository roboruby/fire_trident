/**
 * The trunk as stock git sees it, for the contention-scale run (run.ts) and its check (check.ts): one local bare mirror
 * of the colony's trunk, fetched with the read-only trunk token a lease carries (passed to git through its environment,
 * never its command line), and read through one `git cat-file --batch` process. Agents read the hot files at their
 * lease's base from it, the way an agent reads its checkout; the check reads the final tree, the first-parent history
 * and the lineage notes (refs/notes/firetrident) from it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { git } from "../live.ts";
import type { TrunkCommit } from "./check.ts";

/** What the run and the check read of the trunk. */
export interface TrunkReader {
  /** Make sure commit `sha` can be read, fetching as needed; false when it had not arrived after `waitMs`. */
  ensure(sha: string, waitMs?: number): Promise<boolean>;
  /** A file's text at a commit, or null when it is absent there. */
  read(sha: string, path: string): Promise<string | null>;
  /** Fetch now and answer the head of main (null when it cannot be read). */
  refresh(): Promise<string | null>;
  /** main's first-parent history, newest first, with each commit's lineage note. */
  history(): Promise<TrunkCommit[]>;
  /** Every file at a commit with its text. */
  tree(sha: string): Promise<Map<string, string>>;
  /** Use this remote and read token from now on (the newest lease's); a reader with nothing to fetch ignores it. */
  setAuth?(auth: TrunkAuth): void;
  /** Stop the reader's git processes. */
  close(): void;
}

/** Where to fetch from: the trunk remote and a read token for it (from a lease). */
export interface TrunkAuth {
  remote: string;
  token: string;
}

/** Notes the trunk writer keeps on every landing commit. */
export const NOTES_REF = "refs/notes/firetrident";
/** File reads kept in memory at most (oldest dropped first). */
const CACHE_MAX = 20_000;

type Answer = { type: string; data: Buffer } | null;

/** One `git cat-file --batch` process: requests are answered in the order they were written. */
class CatFile {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly waiting: Array<(a: Answer) => void> = [];
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private dead: Error | null = null;

  constructor(dir: string) {
    this.proc = spawn("git", ["cat-file", "--batch"], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    const fail = (e: Error): void => {
      this.dead = e;
      for (const w of this.waiting.splice(0)) w(null);
    };
    this.proc.on("error", fail);
    this.proc.on("exit", () => fail(new Error("git cat-file exited")));
    this.proc.stdin.on("error", () => undefined);
  }

  private drain(): void {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl < 0 || this.waiting.length === 0) return;
      const header = this.buf.subarray(0, nl).toString("utf8");
      const m = /^[0-9a-f]{40,64} (\S+) (\d+)$/.exec(header);
      if (!m) {
        // "<request> missing" (or ambiguous): nothing follows the header.
        this.buf = this.buf.subarray(nl + 1);
        this.waiting.shift()!(null);
        continue;
      }
      const size = Number(m[2]);
      if (this.buf.length < nl + 1 + size + 1) return;
      const data = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + size));
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      this.waiting.shift()!({ type: m[1]!, data });
    }
  }

  /** The object a revision names (`<sha>:<path>`, a commit id, a blob id), or null when it is missing. */
  get(rev: string): Promise<Answer> {
    if (this.dead || /[\n\r]/.test(rev)) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.proc.stdin.write(`${rev}\n`);
    });
  }

  /** Answer what was asked, then exit. */
  end(): void {
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
  }
}

/** Split `git log --format=%H%x1f%P%x1f%ct%x1f%N%x1e` output into commits (first parent only, commit time in ms). */
export function parseHistory(out: string): TrunkCommit[] {
  return out
    .split("\x1e")
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter((rec) => rec.trim() !== "")
    .map((rec) => {
      const [sha = "", parents = "", time = "", note = ""] = rec.split("\x1f");
      const at = Number(time.trim()) * 1000;
      return { sha: sha.trim(), parent: parents.trim().split(/\s+/).filter(Boolean)[0] ?? null, note: note.trim() === "" ? null : note.trim(), ...(time.trim() && Number.isFinite(at) ? { at } : {}) };
    })
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
}

/** The trunk through a local bare mirror and stock git. */
export class GitTrunk implements TrunkReader {
  private readonly dir: string;
  private auth: TrunkAuth | null = null;
  private cat: CatFile | null = null;
  private fetching: Promise<boolean> | null = null;
  private readonly known = new Set<string>();
  private readonly cache = new Map<string, Promise<string | null>>();
  /** Fetches made and how long they took, for the report. */
  readonly fetches = { count: 0, failed: 0, ms: 0 };

  /** `dir`: an empty directory (or one this reader made before) for the bare mirror. */
  constructor(dir: string) {
    this.dir = dir;
  }

  /** Use this remote and read token from now on (the newest lease's). */
  setAuth(auth: TrunkAuth): void {
    this.auth = auth;
  }

  private async init(): Promise<void> {
    if (this.cat) return;
    mkdirSync(this.dir, { recursive: true });
    await git(["init", "--quiet", "--bare", this.dir], "");
    this.cat = new CatFile(this.dir);
  }

  /** One fetch of main and the notes; answers whether it worked. Concurrent callers share the fetch in flight. */
  private fetchOnce(): Promise<boolean> {
    if (this.fetching) return this.fetching;
    const run = async (): Promise<boolean> => {
      await this.init();
      const auth = this.auth;
      if (!auth) return false;
      const t0 = performance.now();
      this.fetches.count++;
      try {
        try {
          await git(["fetch", "--quiet", "--no-tags", auth.remote, "+refs/heads/main:refs/heads/main", `+${NOTES_REF}:${NOTES_REF}`], auth.token, this.dir);
        } catch {
          // A trunk with no notes yet has no notes ref: fetch main alone.
          await git(["fetch", "--quiet", "--no-tags", auth.remote, "+refs/heads/main:refs/heads/main"], auth.token, this.dir);
        }
        // New packs: a fresh reader sees them; the old one answers what it was asked, then exits.
        const old = this.cat;
        this.cat = new CatFile(this.dir);
        old?.end();
        return true;
      } catch {
        this.fetches.failed++;
        return false;
      } finally {
        this.fetches.ms += performance.now() - t0;
      }
    };
    this.fetching = run().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async hasCommit(sha: string): Promise<boolean> {
    if (this.known.has(sha)) return true;
    await this.init();
    const a = await this.cat!.get(sha);
    if (a?.type === "commit") {
      this.known.add(sha);
      return true;
    }
    return false;
  }

  async ensure(sha: string, waitMs = 60_000): Promise<boolean> {
    const until = performance.now() + waitMs;
    for (let attempt = 0; ; attempt++) {
      if (await this.hasCommit(sha)) return true;
      if (performance.now() >= until) return false;
      const ok = await this.fetchOnce();
      if (!ok) await new Promise((r) => setTimeout(r, Math.min(2_000, 250 * 2 ** Math.min(attempt, 3))));
    }
  }

  async read(sha: string, path: string): Promise<string | null> {
    const key = `${sha}:${path}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    await this.init();
    const p = this.cat!.get(key).then((a) => (a && a.type === "blob" ? a.data.toString("utf8") : null));
    this.cache.set(key, p);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  async refresh(): Promise<string | null> {
    await this.fetchOnce();
    try {
      return (await git(["rev-parse", "--verify", "--quiet", "refs/heads/main"], "", this.dir)).trim() || null;
    } catch {
      return null;
    }
  }

  async history(): Promise<TrunkCommit[]> {
    await this.init();
    const out = await git(["log", "--first-parent", `--notes=${NOTES_REF}`, "--format=%H%x1f%P%x1f%ct%x1f%N%x1e", "refs/heads/main"], "", this.dir);
    return parseHistory(out);
  }

  async tree(sha: string): Promise<Map<string, string>> {
    await this.init();
    const out = await git(["ls-tree", "-r", "--full-tree", sha], "", this.dir);
    const entries = out
      .split("\n")
      .map((l) => /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null);
    const texts = await Promise.all(entries.map((m) => this.cat!.get(m[1]!)));
    return new Map(entries.map((m, i) => [m[2]!, texts[i]?.data.toString("utf8") ?? ""]));
  }

  close(): void {
    this.cat?.end();
    this.cat = null;
  }
}
