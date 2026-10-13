import { revalidationEnabled } from "@fire_trident/core";
import type { Id, Path, Sha } from "@fire_trident/core";
import { dispose, withArtifactsRetry } from "../artifacts/git.ts";
import { isLiteralPath } from "./change.ts";
import { TreeIndex, dirOf } from "./context.ts";
import type { BaseFile, NetStats } from "./loop.ts";

/**
 * Virtual checkouts (FT_VIRTUAL_CHECKOUT). An in-platform agent reads trunk like a client that asks only for the
 * objects it wants: at its base commit it reads the commit, then the root tree, then the subtrees along each path
 * it needs, then the blobs, straight from the trunk repo through the Artifacts binding. It never clones. Every
 * object is immutable and named by its id, so a cache keyed by id never goes stale; the agents of one isolate share
 * it. The change then travels inline (change.ts inlineChange): nothing is committed or pushed.
 */

/** Is FT_VIRTUAL_CHECKOUT on for this colony? Read like FT_REVALIDATE: "on", a comma-separated list of colony ids, or absent / "off". */
export function virtualCheckoutEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** A tree entry as the binding returns it (`type` "tree", "blob", "exec", "symlink" or "gitlink"). */
export interface ObjectEntry {
  name: string;
  mode: string;
  hash: Sha;
  type: string;
}

/** The trunk repo's objects by id, and where `main` points (AgentDO serves them from the binding: trunkObjects). */
export interface TrunkObjects {
  /** The root tree of a commit, or null when the repo does not have the commit. */
  readCommit(id: Sha): Promise<{ treeHash: Sha } | null>;
  readTree(id: Sha): Promise<ObjectEntry[] | null>;
  readBlob(id: Sha): Promise<Uint8Array | null>;
  /** The commit `main` points at, or null when the repo has no main. */
  tip(): Promise<Sha | null>;
}

/** Bytes of trunk objects one isolate keeps (its agents share them; the least recently used go first). */
export const CACHE_BYTES = 8 * 1024 * 1024;
/** Blobs larger than this are read again when asked again, never kept. */
export const CACHE_BLOB_MAX = 512 * 1024;
/** Binding calls one agent has in flight at most. */
export const MAX_IN_FLIGHT = 8;
/** Directories one walk enters at most, and files a footprint listing returns at most. */
export const LIST_TREES_MAX = 2_000;
export const LIST_FILES_MAX = 20_000;
/** Runs of a question about a tree that loads on demand (each run loads what the last one asked about). */
const SETTLE_RUNS = 6;
/** Sibling directories a walk asks for ahead of the one it is in, and how far down each one's first subdirectories. */
const READ_AHEAD = 4;
const READ_AHEAD_DEPTH = 6;

/**
 * Immutable git objects by id, the least recently used dropped once `maxBytes` is passed. A read of an object
 * already on its way joins that read, so asking for one id from many places at once costs one call.
 */
export class ObjectCache {
  private readonly held = new Map<string, { value: unknown; bytes: number }>();
  private readonly reading = new Map<string, Promise<unknown>>();
  private used = 0;

  constructor(readonly maxBytes = CACHE_BYTES) {}

  /** The object under `key`: kept, on its way, or read now (and kept unless absent or over `keepMax` bytes). */
  async get<T>(key: string, read: () => Promise<T | null>, bytesOf: (v: T) => number, keepMax = Number.POSITIVE_INFINITY): Promise<T | null> {
    const hit = this.held.get(key);
    if (hit) {
      this.held.delete(key);
      this.held.set(key, hit);
      return hit.value as T;
    }
    const pending = this.reading.get(key);
    if (pending) return pending as Promise<T | null>;
    const p = read().then((value) => {
      if (value !== null) {
        const bytes = bytesOf(value);
        if (bytes <= keepMax) this.keep(key, value, bytes);
      }
      return value;
    });
    this.reading.set(key, p);
    try {
      return await p;
    } finally {
      this.reading.delete(key);
    }
  }

  /** Objects and bytes held now. */
  size(): { objects: number; bytes: number } {
    return { objects: this.held.size, bytes: this.used };
  }

  private keep(key: string, value: unknown, bytes: number): void {
    if (bytes > this.maxBytes) return;
    const old = this.held.get(key);
    if (old) {
      this.held.delete(key);
      this.used -= old.bytes;
    }
    this.held.set(key, { value, bytes });
    this.used += bytes;
    for (const [k, v] of this.held) {
      if (this.used <= this.maxBytes) break;
      this.held.delete(k);
      this.used -= v.bytes;
    }
  }
}

/** The cache the agents of this isolate share (AgentDO). */
export const SHARED_OBJECTS = new ObjectCache();

const isTree = (e: ObjectEntry): boolean => e.type === "tree" || e.mode === "40000" || e.mode === "040000";
const isGitlink = (e: ObjectEntry): boolean => e.type === "gitlink" || e.type === "commit" || e.mode === "160000";
const treeBytes = (entries: readonly ObjectEntry[]): number => entries.reduce((n, e) => n + e.name.length + 64, 64);
const join = (dir: Path, name: string): Path => (dir === "" ? name : `${dir}/${name}`);
const baseName = (p: Path): string => p.slice(p.lastIndexOf("/") + 1);
/** A tree sorts like a name ending in "/", which walks files in the order of a sorted listing of full paths. */
const sortKey = (e: ObjectEntry): string => (isTree(e) ? `${e.name}/` : e.name);
const inPathOrder = (a: ObjectEntry, b: ObjectEntry): number => {
  const x = sortKey(a);
  const y = sortKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Reads of trunk at a commit for one agent, object by object through `objects`, cached by id in `cache`. It
 * answers what a clone answers (loop.ts ReadOps): the same paths, blob ids, modes and bytes.
 */
export class VirtualReads {
  private net: NetStats = { requests: 0, sentBytes: 0, receivedBytes: 0, ms: 0 };
  private asks = 0;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly objects: TrunkObjects,
    private readonly cache: ObjectCache = SHARED_OBJECTS,
  ) {}

  /** Cost since the last call (binding calls, bytes they brought, time in them, objects answered without a call), then reset. */
  takeNetStats(): NetStats {
    const out: NetStats = { ...this.net, hits: Math.max(0, this.asks - this.net.requests) };
    this.net = { requests: 0, sentBytes: 0, receivedBytes: 0, ms: 0 };
    this.asks = 0;
    return out;
  }

  /** The base commit when trunk has it; otherwise trunk's tip with `fallback` set, as a clone that cannot reach the base does. */
  async ensureBase(p: { baseSha: Sha }): Promise<{ baseSha: Sha; fallback: boolean }> {
    if ((await this.commit(p.baseSha)) !== null) return { baseSha: p.baseSha, fallback: false };
    const tip = await this.fetchTip();
    if (!tip) throw new Error("trunk has no main branch");
    return { baseSha: tip, fallback: true };
  }

  /** The commit trunk's main points at in the repo, or null. Never cached: main moves. */
  async fetchTip(): Promise<Sha | null> {
    this.asks++;
    return this.call(() => this.objects.tip(), () => 0);
  }

  /** A file at the commit with its blob id, mode and bytes; null when absent or not a file (a directory or a submodule). */
  async readFile(baseSha: Sha, path: Path): Promise<BaseFile | null> {
    const e = await this.entryAt(baseSha, path);
    if (!e || isTree(e) || isGitlink(e)) return null;
    return { blob: e.hash, mode: e.mode, bytes: await this.blob(e.hash) };
  }

  /** Blob id of each path at a commit (null when absent or not a file); reads trees only. */
  async blobsAt(sha: Sha, paths: Path[]): Promise<Map<Path, Sha | null>> {
    const found = await Promise.all(paths.map((p) => this.entryAt(sha, p)));
    return new Map(
      paths.map((p, i): [Path, Sha | null] => {
        const e = found[i];
        return [p, e && !isTree(e) && !isGitlink(e) ? e.hash : null];
      }),
    );
  }

  /** The commit's tree as a view that loads directories on demand (answers like the clone's TreeIndex). */
  async tree(baseSha: Sha): Promise<PartialTree> {
    return new PartialTree(this, await this.root(baseSha));
  }

  /**
   * File paths at a commit in path order (every entry but directories, as a clone lists them). With `scope`
   * (footprint entries), only the directories its glob and directory entries can match under are walked. Stops
   * after LIST_FILES_MAX files or LIST_TREES_MAX directories.
   */
  async listFiles(baseSha: Sha, scope?: string[]): Promise<Path[]> {
    const tree = await this.tree(baseSha);
    const prefixes = scope === undefined ? [""] : scope.filter((e) => !isLiteralPath(e)).map(footprintPrefix);
    const everywhere = prefixes.includes("");
    const under = (p: Path, pre: Path): boolean => p === pre || p.startsWith(`${pre}/`);
    const out: Path[] = [];
    await tree.walk(
      (p) => {
        if (everywhere || prefixes.some((pre) => under(p, pre))) out.push(p);
        return out.length < LIST_FILES_MAX;
      },
      (dir) => everywhere || prefixes.some((pre) => under(dir, pre) || pre.startsWith(`${dir}/`)),
    );
    return out;
  }

  /** The entry at `path` in a commit: null when absent, or when a directory on the way is missing or a file. */
  async entryAt(commit: Sha, path: Path): Promise<ObjectEntry | null> {
    const parts = path.split("/");
    let entries = await this.treeEntries(await this.root(commit));
    for (let i = 0; i < parts.length; i++) {
      const e = entries.find((x) => x.name === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e;
      if (!isTree(e)) return null;
      entries = await this.treeEntries(e.hash);
    }
    return null;
  }

  /** The root tree of a commit; throws when trunk does not have the commit. */
  async root(commit: Sha): Promise<Sha> {
    const tree = await this.commit(commit);
    if (tree === null) throw new Error(`commit ${commit} is not in the trunk repository`);
    return tree;
  }

  /** A tree's entries by id; throws when it is missing (a commit trunk has always has its trees). */
  async treeEntries(id: Sha): Promise<readonly ObjectEntry[]> {
    this.asks++;
    const entries = await this.cache.get(`t:${id}`, () => this.call(() => this.objects.readTree(id), treeBytes), treeBytes);
    if (entries === null) throw new Error(`tree ${id} is missing from the trunk repository`);
    return entries;
  }

  private commit(id: Sha): Promise<Sha | null> {
    this.asks++;
    return this.cache.get(`c:${id}`, () => this.call(async () => (await this.objects.readCommit(id))?.treeHash ?? null, () => 0), () => 100);
  }

  private async blob(id: Sha): Promise<Uint8Array> {
    this.asks++;
    const size = (b: Uint8Array): number => b.byteLength;
    const bytes = await this.cache.get(`b:${id}`, () => this.call(() => this.objects.readBlob(id), size), size, CACHE_BLOB_MAX);
    if (bytes === null) throw new Error(`blob ${id} is missing from the trunk repository`);
    return bytes;
  }

  /** One binding call: at most MAX_IN_FLIGHT at once, booked with its time and the bytes it brought. */
  private async call<T>(fn: () => Promise<T | null>, bytesOf: (v: T) => number): Promise<T | null> {
    while (this.active >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    this.net.requests++;
    const t0 = Date.now();
    try {
      const value = await fn();
      if (value !== null) this.net.receivedBytes += bytesOf(value);
      return value;
    } finally {
      this.net.ms += Date.now() - t0;
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * One commit's tree for the questions loop.ts and context.ts ask of a TreeIndex (is this a file, a directory, what
 * does it hold), loading directories on demand. A question about a directory not loaded yet answers "no" and notes
 * it; `settle` loads what was noted and asks again, so every answer it returns holds for the whole tree.
 */
export class PartialTree extends TreeIndex {
  private readonly dirs = new Map<Path, Map<string, ObjectEntry>>();
  private readonly asked = new Set<Path>();

  constructor(
    private readonly reads: VirtualReads,
    private readonly rootId: Sha,
  ) {
    super([]);
  }

  override isFile(p: Path): boolean {
    if (p === "") return false;
    const e = this.entriesOf(dirOf(p), p)?.get(baseName(p));
    return e !== undefined && !isTree(e);
  }

  override isDir(p: Path): boolean {
    if (p === "") {
      if (this.dirs.has("")) return true;
      this.asked.add("");
      return false;
    }
    const e = this.entriesOf(dirOf(p), p)?.get(baseName(p));
    return e !== undefined && isTree(e);
  }

  override list(dir: Path): string[] {
    const entries = this.entriesOf(dir, dir);
    return entries ? [...entries.values()].map((e) => (isTree(e) ? `${e.name}/` : e.name)).sort() : [];
  }

  /** Run `ask` until it touches no directory that is not loaded, loading what each run touched (at most SETTLE_RUNS runs). */
  override async settle<T>(ask: () => T): Promise<T> {
    for (let run = 1; ; run++) {
      this.asked.clear();
      const out = ask();
      if (this.asked.size === 0) return out;
      if (run >= SETTLE_RUNS) throw new Error(`the tree view still asked for ${[...this.asked].slice(0, 3).join(", ")} after ${SETTLE_RUNS} runs`);
      await this.need(this.asked);
    }
  }

  /**
   * The first `limit` file paths in path order, read from the root down; complete is false when more exist. Past the
   * limit no directory is entered: git stores no empty tree, so any entry left means more files.
   */
  override async paths(limit: number): Promise<{ paths: Path[]; complete: boolean }> {
    const out: Path[] = [];
    let more = false;
    const full = (): boolean => {
      if (out.length < limit) return false;
      more = true;
      return true;
    };
    const walked = await this.walk(
      (p) => {
        if (full()) return false;
        out.push(p);
        return true;
      },
      () => !full(),
    );
    return { paths: out, complete: walked && !more };
  }

  /** Load every directory along each path, and the path itself when it is a directory. */
  async need(paths: Iterable<Path>): Promise<void> {
    await Promise.all([...new Set(paths)].map((p) => this.loadAlong(p)));
  }

  /**
   * Visit file paths in path order, loading directories from the root down; while one subdirectory is walked, the
   * next READ_AHEAD of its siblings are asked for. `enter` says, when the walk gets to a directory, whether to walk
   * into it; `visit` returns false to stop. Returns false when stopped, by `visit` or after `maxTrees` directories.
   */
  async walk(visit: (path: Path) => boolean, enter: (dir: Path) => boolean = () => true, maxTrees = LIST_TREES_MAX): Promise<boolean> {
    let trees = 0;
    const go = async (dir: Path, entries: Map<string, ObjectEntry>): Promise<boolean> => {
      const sorted = [...entries.values()].sort(inPathOrder);
      const subdirs = sorted.filter(isTree);
      let asked = 0;
      let reached = 0;
      for (const e of sorted) {
        const path = join(dir, e.name);
        if (!isTree(e)) {
          if (!visit(path)) return false;
          continue;
        }
        for (reached++; asked < Math.min(subdirs.length, reached + READ_AHEAD); asked++) {
          const next = join(dir, subdirs[asked]!.name);
          if (asked >= reached && enter(next)) this.readAhead(next, subdirs[asked]!.hash, enter, READ_AHEAD_DEPTH);
        }
        if (!enter(path)) continue;
        if (++trees > maxTrees) return false;
        if (!(await go(path, await this.load(path, e.hash)))) return false;
      }
      return true;
    };
    return go("", await this.load("", this.rootId));
  }

  /**
   * Load a directory ahead of the walk, then the first subdirectory the walk will enter in it, and so on `depth`
   * levels down: entering a directory waits on its first subdirectory, so having that chain loaded is what saves
   * time. A failed read surfaces when the walk gets there.
   */
  private readAhead(dir: Path, id: Sha, enter: (dir: Path) => boolean, depth: number): void {
    this.load(dir, id).then(
      (entries) => {
        if (depth <= 0) return;
        const first = [...entries.values()].filter(isTree).sort(inPathOrder)[0];
        const path = first ? join(dir, first.name) : null;
        if (first && path && enter(path)) this.readAhead(path, first.hash, enter, depth - 1);
      },
      () => undefined,
    );
  }

  /** The loaded entries of `dir`; null when it is not a directory or not loaded yet (then `p` is noted for settle). */
  private entriesOf(dir: Path, p: Path): Map<string, ObjectEntry> | null {
    const loaded = this.dirs.get(dir);
    if (loaded) return loaded;
    let entries = this.dirs.get("");
    let at: Path = "";
    for (const seg of dir === "" ? [] : dir.split("/")) {
      if (!entries) break;
      const e = entries.get(seg);
      // A loaded directory on the way that lacks the next one: `dir` does not exist, which is an answer.
      if (!e || !isTree(e)) return null;
      at = join(at, seg);
      entries = this.dirs.get(at);
    }
    this.asked.add(p);
    return null;
  }

  private async loadAlong(p: Path): Promise<void> {
    let dir: Path = "";
    let entries = await this.load("", this.rootId);
    for (const seg of p === "" ? [] : p.split("/")) {
      const e = entries.get(seg);
      if (!e || !isTree(e)) return;
      dir = join(dir, seg);
      entries = await this.load(dir, e.hash);
    }
  }

  private async load(dir: Path, id: Sha): Promise<Map<string, ObjectEntry>> {
    const have = this.dirs.get(dir);
    if (have) return have;
    const entries = new Map((await this.reads.treeEntries(id)).map((e): [string, ObjectEntry] => [e.name, e]));
    this.dirs.set(dir, entries);
    return entries;
  }
}

/** Characters that make a footprint segment a pattern (core's matcher reads * ? and braces; the rest only narrow the walk less). */
const PATTERN = /[*?{}[\]!]/;

/**
 * The directory a footprint entry (a glob or a directory) can match under: its leading literal segments, or "" when
 * it may match anywhere. Leading "./" and "/" are dropped as the glob matcher drops them.
 */
export function footprintPrefix(entry: string): Path {
  let e = entry;
  while (e.startsWith("./") || e.startsWith("/")) e = e.slice(e.startsWith("./") ? 2 : 1);
  const segments = e.split("/");
  segments.pop(); // the last segment names files, or is empty for a directory entry
  const out: string[] = [];
  for (const s of segments) {
    if (PATTERN.test(s)) break;
    if (s === "" || s === "." || s === "..") return "";
    out.push(s);
  }
  return out.join("/");
}

/**
 * Trunk objects through the Artifacts binding, for one repo (`<colony>--trunk` in ft-trunk). The repo handle opens
 * on the first read and is kept until `release` (AgentDO releases it when a tick ends); transient errors are retried.
 */
export function trunkObjects(binding: Pick<Artifacts, "get">, name: string): TrunkObjects & { release(): void } {
  let repo: Promise<ArtifactsRepo> | null = null;
  const open = (): Promise<ArtifactsRepo> => {
    if (!repo) {
      const opening = binding.get(name);
      repo = opening;
      opening.catch(() => {
        if (repo === opening) repo = null;
      });
    }
    return repo;
  };
  const read = <T>(fn: (r: ArtifactsRepo) => Promise<T>): Promise<T> => withArtifactsRetry(async () => fn(await open()));
  return {
    readCommit: async (id) => {
      const c = await read((r) => r.readCommit(id));
      return c ? { treeHash: c.treeHash } : null;
    },
    readTree: async (id) => (await read((r) => r.readTree(id))) ?? null,
    readBlob: async (id) => {
      const b = await read((r) => r.readBlob(id));
      return b ? new Uint8Array(await b.arrayBuffer()) : null;
    },
    tip: async () => (await read((r) => r.log({ ref: "main", limit: 1 })))[0]?.hash ?? null,
    release: () => {
      const r = repo;
      repo = null;
      if (r) r.then(dispose, () => undefined);
    },
  };
}
