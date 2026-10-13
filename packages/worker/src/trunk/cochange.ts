/**
 * The co-change map of a colony's trunk (Hebbian learning with STDP direction; the math is in
 * core/cochange.ts). TrunkDO keeps it in its SQLite storage:
 *
 * - at init, it mines the trunk's history through the Artifacts binding: the changed paths of
 *   each commit on the first-parent chain (about 200 commits are kept on import), by tree diffs,
 *   with each author's follow-up commits as STDP predecessors;
 * - after that, it learns every landing, one proposal at a time, from the lineage notes TrunkDO
 *   already records (a follow-up intent's change links back to its parent intent's change). It is a
 *   lazy derived index (trunk/derived.ts): the catch-up runs on demand from its cursor, so the
 *   landing path never waits for it;
 * - `neighbors(paths, k)` answers, for each file, the files whose claims should repel work on it.
 *
 * NeighborCache is the caller's side (ColonyDO.take): a short-lived cache with one RPC per miss
 * batch and a bounded wait, failing open.
 */
import type { Id, Path, Sha } from "@fire_trident/core";
import { pathsOverlap } from "@fire_trident/core";
// Direct import until packages/core/src/index.ts re-exports cochange.ts (orchestrator-owned).
import { changeFiles, followUps, learnChange, rankNeighbors } from "@fire_trident/core";
import type { CoChangeReader, CoChangeUpdate, CoEdge, CoFile, FileEdges, Neighbor, Predecessor } from "@fire_trident/core";
import { withArtifactsRetry } from "../artifacts/git.ts";
import { DerivedSet, trunkLog, type Derived, type TrunkLanding } from "./derived.ts";

export type { Neighbor } from "@fire_trident/core";

/** Commits of the first-parent chain mined at init (Artifacts imports keep 200). */
export const MINE_LIMIT = 200;
/** Wall-clock budget for mining; what was read by then is learned. */
export const MINE_BUDGET_MS = 20_000;
/** Tree reads in flight while mining. */
const MINE_CONCURRENCY = 8;
/** Tree reads per mining run at most. */
const MINE_MAX_READS = 6_000;
/** Proposals learned per catch-up step (a step finishes the landing it is in), and landings read per step at most. */
const CATCH_UP_PROPOSALS = 400;
const CATCH_UP_LANDINGS = 500;
/** The co-change map's name among the trunk's derived indexes (trunk/derived.ts). */
export const COCHANGE_INDEX = "cochange";
/** Neighbors per path at most, and the weakest coupling `neighbors` returns. */
export const NEIGHBORS_MAX = 16;
export const NEIGHBOR_MIN_WEIGHT = 0.1;
/** Paths per `neighbors` call at most. */
export const NEIGHBOR_PATHS_MAX = 2_000;
/** Directed edges kept at most; beyond it the weakest stored ones are pruned. */
const EDGES_CAP = 250_000;
/** Landed intents remembered for STDP, most recent kept. */
const INTENTS_KEEP = 20_000;
/** Colony memory, not code: never learned. */
const SYSTEM_PREFIX = ".firetrident/";

/** Tables (ft_ prefix: TrunkDO.destroy replays ft_ DDL). */
export const COCHANGE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ft_cc_files (path TEXT PRIMARY KEY, n INTEGER NOT NULL, mass REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ft_cc_edges (src TEXT NOT NULL, dst TEXT NOT NULL, hebb REAL NOT NULL, stdp REAL NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (src, dst))",
  "CREATE INDEX IF NOT EXISTS ft_cc_edges_dst ON ft_cc_edges(dst)",
  "CREATE TABLE IF NOT EXISTS ft_cc_intents (intent_id TEXT PRIMARY KEY, paths TEXT NOT NULL, seq INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ft_cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

/** One mined commit. */
export interface MinedCommit {
  sha: Sha;
  /** Commit time (ms). */
  at: number;
  author: string;
  paths: Path[];
}

/** What a mining run read. */
export interface MineResult {
  /** Learnable commits, oldest first. */
  commits: MinedCommit[];
  /** Commits listed by log. */
  listed: number;
  /** Merges, root commits, commits whose parent is beyond the import depth, and mass edits. */
  skipped: number;
  /** Stopped early (time or read budget). */
  truncated: boolean;
  reads: number;
}

/** Co-change state for status pages and tests. */
export interface CoChangeStats {
  files: number;
  edges: number;
  intents: number;
  /** History mining: state, the head it mined, commits learned, and when. */
  mined: { state: string | null; head: string | null; commits: number; at: number | null };
  /** Landings learned up to this sequence number, and proposals learned from them. */
  landingSeq: number;
  proposalsLearned: number;
}

const FILE_TYPES: ReadonlySet<string> = new Set(["blob", "exec", "symlink"]);

/** Edge columns as SQLite returns them. */
type EdgeRow = { hebb: number; stdp: number; at: number };

/**
 * Changed paths between two trees read through the binding (null = empty tree), descending only
 * into changed subtrees. Null when more than `cap` paths changed (a mass edit) or a tree is missing.
 */
export async function diffTreePaths(read: (hash: string) => Promise<ArtifactsTreeEntry[] | null>, a: string | null, b: string | null, cap: number): Promise<Path[] | null> {
  const out: Path[] = [];
  const entries = async (hash: string | null): Promise<Map<string, ArtifactsTreeEntry> | null> => {
    if (hash === null) return new Map();
    const list = await read(hash);
    return list ? new Map(list.map((e) => [e.name, e])) : null;
  };
  const walk = async (x: string | null, y: string | null, prefix: string): Promise<boolean> => {
    if (x === y) return true;
    const [ex, ey] = await Promise.all([entries(x), entries(y)]);
    if (ex === null || ey === null) throw new MissingTree();
    for (const name of new Set([...ex.keys(), ...ey.keys()])) {
      const e1 = ex.get(name);
      const e2 = ey.get(name);
      if (e1 && e2 && e1.hash === e2.hash && e1.mode === e2.mode) continue;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const t1 = e1?.type === "tree" ? e1.hash : null;
      const t2 = e2?.type === "tree" ? e2.hash : null;
      if ((t1 !== null || t2 !== null) && !(await walk(t1, t2, path))) return false;
      if ((e1 && FILE_TYPES.has(e1.type)) || (e2 && FILE_TYPES.has(e2.type))) {
        out.push(path);
        if (out.length > cap) return false;
      }
    }
    return true;
  };
  try {
    return (await walk(a, b, "")) ? out.sort() : null;
  } catch (e) {
    if (e instanceof MissingTree) return null;
    throw e;
  }
}

class MissingTree extends Error {}

/**
 * Mine the first-parent chain ending at `head` through the binding: the changed paths of each
 * single-parent commit against its parent, by tree diffs. Trees are memoized across commits
 * (neighbors share most of them). Landing and system commits (FT-Landing trailer) are skipped.
 * Stops at `budgetMs` or MINE_MAX_READS tree reads and keeps what it read. Commits come back
 * oldest first.
 */
export async function mineHistory(
  repo: ArtifactsRepo,
  head: Sha,
  opts: { limit?: number; maxFiles?: number; budgetMs?: number; concurrency?: number; now?: () => number } = {},
): Promise<MineResult> {
  const now = opts.now ?? Date.now;
  const start = now();
  const budget = opts.budgetMs ?? MINE_BUDGET_MS;
  const maxFiles = opts.maxFiles ?? 30;
  const log = await withArtifactsRetry(() => repo.log({ ref: head, limit: Math.max(1, Math.min(1000, opts.limit ?? MINE_LIMIT)) }));
  const trees = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  let reads = 0;
  let truncated = false;
  const read = (hash: string): Promise<ArtifactsTreeEntry[] | null> => {
    let p = trees.get(hash);
    if (!p) {
      if (reads >= MINE_MAX_READS || now() - start > budget) {
        truncated = true;
        return Promise.reject(new MissingTree());
      }
      reads++;
      p = withArtifactsRetry(() => repo.readTree(hash));
      trees.set(hash, p);
    }
    return p;
  };
  const found: Array<MinedCommit | null> = new Array(log.length).fill(null);
  let skipped = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < log.length && !truncated) {
      const i = next++;
      const c = log[i]!;
      // Merges and roots teach nothing; FireTrident's own commits are learned per proposal from their notes.
      if (c.parents.length !== 1 || /(^|\n)FT-Landing: /.test(c.message ?? "")) {
        skipped++;
        continue;
      }
      const parent = c.parents[0]!;
      let parentTree: string | null = log[i + 1]?.hash === parent ? log[i + 1]!.treeHash : null;
      if (parentTree === null) {
        const meta = await withArtifactsRetry(() => repo.readCommit(parent)).catch(() => null);
        parentTree = meta?.treeHash ?? null;
      }
      if (parentTree === null) {
        skipped++;
        continue;
      }
      const paths = await diffTreePaths(read, parentTree, c.treeHash, maxFiles).catch(() => null);
      if (paths === null || paths.length === 0) {
        skipped++;
        continue;
      }
      found[i] = { sha: c.hash, at: (c.committedAt || c.authoredAt || 0) * 1000, author: c.author?.email || c.author?.name || "", paths };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? MINE_CONCURRENCY, log.length)) }, worker));
  const commits = found.filter((c): c is MinedCommit => c !== null).reverse();
  return { commits, listed: log.length, skipped, truncated, reads };
}

/** Write paths of each proposal in a serialized lineage note, with its intent and parent intent. */
export function noteChanges(note: string): Array<{ intentId: Id | null; parentId: Id | null; paths: Path[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(note);
  } catch {
    return [];
  }
  const proposals = (parsed as { proposals?: unknown })?.proposals;
  if (!Array.isArray(proposals)) return [];
  const out: Array<{ intentId: Id | null; parentId: Id | null; paths: Path[] }> = [];
  for (const p of proposals as Array<{ writeSet?: Array<{ path?: unknown }>; intent?: { id?: unknown; parentId?: unknown } }>) {
    const paths = (Array.isArray(p?.writeSet) ? p.writeSet : [])
      .map((w) => w?.path)
      .filter((x): x is Path => typeof x === "string" && x !== "" && !x.startsWith(SYSTEM_PREFIX));
    if (paths.length === 0) continue;
    const intentId = typeof p.intent?.id === "string" ? p.intent.id : null;
    const parentId = typeof p.intent?.parentId === "string" ? p.intent.parentId : null;
    out.push({ intentId, parentId, paths });
  }
  return out;
}

/**
 * The co-change map in TrunkDO's SQLite storage. Stateless apart from its tables and its cursor. It
 * joins `derived` (TrunkDO's derived indexes) when given one, or keeps a set of its own over the
 * trunk writer's landing log.
 */
export class CoChangeStore implements CoChangeReader {
  private readonly derived: DerivedSet<TrunkLanding>;

  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: (fn: () => void) => void,
    derived?: DerivedSet<TrunkLanding>,
  ) {
    for (const stmt of COCHANGE_SCHEMA) sql.exec(stmt);
    this.derived = derived ?? new DerivedSet(sql, transaction, trunkLog(sql));
    this.derived.define(this.definition());
  }

  /**
   * The co-change map as a derived index (trunk/derived.ts). Lazy: it learns the landings recorded
   * since its cursor when it is read (catchUp), never in the landing path. A landing is learned once:
   * its seq becomes the map's own watermark (landing_seq) in the transaction that learns it, and a
   * landing at or before the watermark teaches nothing again (a map kept before cursors existed also
   * resumes there). A version change forgets the map, mined history included, so TrunkDO mines it
   * again before the landings are learned again (neighbors() waits for mining).
   */
  private definition(): Derived<TrunkLanding> {
    return {
      name: COCHANGE_INDEX,
      version: 1,
      mode: "lazy",
      apply: (e) => this.learnLanding(e.seq, e.landing.note),
      reset: () => {
        for (const t of ["ft_cc_files", "ft_cc_edges", "ft_cc_intents", "ft_cc_meta"]) this.sql.exec(`DELETE FROM ${t}`);
        return 0;
      },
      adopt: () => this.watermark(),
      settle: () => this.prune(),
    };
  }

  /** A file's learning state. */
  file(path: Path): CoFile | undefined {
    const r = this.sql.exec<{ n: number; mass: number }>("SELECT n, mass FROM ft_cc_files WHERE path = ?", path).toArray()[0];
    return r ? { n: r.n, mass: r.mass } : undefined;
  }

  /** The stored edge src -> dst. */
  edge(src: Path, dst: Path): CoEdge | undefined {
    const r = this.sql.exec<EdgeRow>("SELECT hebb, stdp, at FROM ft_cc_edges WHERE src = ? AND dst = ?", src, dst).toArray()[0];
    return r ? { hebb: r.hebb, stdp: r.stdp, at: r.at } : undefined;
  }

  /** Learn one change and store it (call inside a transaction for atomicity). True when it taught something. */
  learn(paths: Path[], predecessors: Predecessor[] = []): boolean {
    const update = learnChange(this, paths, predecessors);
    this.write(update);
    return update.files.length > 0;
  }

  /** Learn mined history (oldest first, STDP from each author's follow-ups) in one transaction. Returns commits learned. */
  learnHistory(mined: MineResult, head: Sha, at: number): number {
    let learned = 0;
    const preds = followUps(mined.commits);
    this.transaction(() => {
      mined.commits.forEach((c, i) => {
        if (this.learn(c.paths, preds[i] ?? [])) learned++;
      });
      this.setMeta("mined_state", mined.truncated ? "partial" : "done");
      this.setMeta("mined_head", head);
      this.setMeta("mined_commits", String(learned));
      this.setMeta("mined_at", String(at));
      this.prune();
    });
    return learned;
  }

  /**
   * Learn the landings recorded since the cursor, oldest first: each proposal's write set is
   * one change; a proposal whose intent has a landed parent intent follows that change (STDP).
   * Stops after about CATCH_UP_PROPOSALS proposals (finishing its landing). Returns proposals learned.
   */
  catchUp(): number {
    return this.derived.catchUp(COCHANGE_INDEX, { landings: CATCH_UP_LANDINGS, work: CATCH_UP_PROPOSALS, slice: CATCH_UP_LANDINGS }).work;
  }

  /** Learn one landing's proposals (the derived apply); nothing for a landing at or before the watermark. Returns proposals learned. */
  private learnLanding(seq: number, note: string | null): number {
    if (seq <= this.watermark()) return 0;
    let learned = 0;
    for (const ch of note ? noteChanges(note) : []) {
      const parent = ch.parentId ? this.intentPaths(ch.parentId) : null;
      if (this.learn(ch.paths, parent ? [{ paths: parent, lag: 1 }] : [])) learned++;
      if (ch.intentId) this.sql.exec("INSERT OR REPLACE INTO ft_cc_intents (intent_id, paths, seq) VALUES (?, ?, ?)", ch.intentId, JSON.stringify(changeFiles(ch.paths) ?? []), seq);
    }
    this.setMeta("landing_seq", String(seq));
    if (learned > 0) this.setMeta("proposals_learned", String(Number(this.meta("proposals_learned") ?? "0") + learned));
    return learned;
  }

  /** The last landing learned (landing_seq). */
  private watermark(): number {
    const n = Number(this.meta("landing_seq") ?? "0");
    return Number.isFinite(n) ? n : 0;
  }

  /** For each path (at most NEIGHBOR_PATHS_MAX), its top `k` neighbors (at most NEIGHBORS_MAX) with weight >= minWeight. Paths with none are left out. */
  neighbors(paths: Path[], k: number, minWeight = NEIGHBOR_MIN_WEIGHT): Record<Path, Neighbor[]> {
    const limit = Math.max(1, Math.min(NEIGHBORS_MAX, Math.floor(Number.isFinite(k) ? k : 8)));
    const out: Record<Path, Neighbor[]> = {};
    const fileCache = new Map<Path, CoFile | undefined>();
    const fileOf = (p: Path): CoFile | undefined => {
      if (!fileCache.has(p)) fileCache.set(p, this.file(p));
      return fileCache.get(p);
    };
    for (const path of new Set(paths.slice(0, NEIGHBOR_PATHS_MAX))) {
      if (typeof path !== "string" || path === "") continue;
      const file = fileOf(path);
      if (!file && this.sql.exec("SELECT 1 FROM ft_cc_edges WHERE dst = ? LIMIT 1", path).toArray().length === 0) continue;
      const edges: FileEdges = {
        file,
        out: this.sql.exec<EdgeRow & { dst: string }>("SELECT dst, hebb, stdp, at FROM ft_cc_edges WHERE src = ?", path).toArray().map((r) => ({ path: r.dst, edge: { hebb: r.hebb, stdp: r.stdp, at: r.at } })),
        in: this.sql
          .exec<EdgeRow & { src: string }>("SELECT src, hebb, stdp, at FROM ft_cc_edges WHERE dst = ?", path)
          .toArray()
          .map((r) => ({ path: r.src, edge: { hebb: r.hebb, stdp: r.stdp, at: r.at }, file: fileOf(r.src) })),
      };
      const nb = rankNeighbors(path, edges, limit, minWeight);
      if (nb.length > 0) out[path] = nb;
    }
    return out;
  }

  /** History mining state for this trunk (null before the first run). */
  minedState(): string | null {
    return this.meta("mined_state");
  }

  /** Whether history should be mined now: never mined, or the last run failed more than `retryMs` ago. */
  shouldMine(now: number, retryMs = 10 * 60_000): boolean {
    const state = this.meta("mined_state");
    if (state === null) return true;
    return state.startsWith("failed") && now - Number(this.meta("mined_at") ?? "0") > retryMs;
  }

  /** Record that mining did not happen (failed or skipped), so landings are learned anyway. */
  markMined(state: string, at: number): void {
    this.setMeta("mined_state", state);
    this.setMeta("mined_at", String(at));
  }

  /** Counts and watermarks. */
  stats(): CoChangeStats {
    const n = (sql: string): number => this.sql.exec<{ n: number }>(sql).one().n;
    const minedAt = this.meta("mined_at");
    return {
      files: n("SELECT COUNT(*) AS n FROM ft_cc_files"),
      edges: n("SELECT COUNT(*) AS n FROM ft_cc_edges"),
      intents: n("SELECT COUNT(*) AS n FROM ft_cc_intents"),
      mined: { state: this.meta("mined_state"), head: this.meta("mined_head"), commits: Number(this.meta("mined_commits") ?? "0"), at: minedAt === null ? null : Number(minedAt) },
      landingSeq: Number(this.meta("landing_seq") ?? "0"),
      proposalsLearned: Number(this.meta("proposals_learned") ?? "0"),
    };
  }

  /** Forget everything (a new trunk): the map, its mining state and its cursor. */
  reset(): void {
    this.derived.rebuild(COCHANGE_INDEX);
  }

  private write(u: CoChangeUpdate): void {
    for (const { path, file } of u.files) this.sql.exec("INSERT OR REPLACE INTO ft_cc_files (path, n, mass) VALUES (?, ?, ?)", path, file.n, file.mass);
    for (const { src, dst, edge } of u.edges) {
      this.sql.exec("INSERT OR REPLACE INTO ft_cc_edges (src, dst, hebb, stdp, at) VALUES (?, ?, ?, ?, ?)", src, dst, edge.hebb, edge.stdp, edge.at);
    }
  }

  private intentPaths(intentId: Id): Path[] | null {
    const r = this.sql.exec<{ paths: string }>("SELECT paths FROM ft_cc_intents WHERE intent_id = ?", intentId).toArray()[0];
    if (!r) return null;
    try {
      const paths = JSON.parse(r.paths) as unknown;
      return Array.isArray(paths) ? paths.filter((x): x is Path => typeof x === "string") : null;
    } catch {
      return null;
    }
  }

  /** Keep the tables bounded: the weakest stored edges past EDGES_CAP, the oldest intents past INTENTS_KEEP. */
  private prune(): void {
    const edges = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ft_cc_edges").one().n;
    if (edges > EDGES_CAP) {
      this.sql.exec(
        "DELETE FROM ft_cc_edges WHERE rowid IN (SELECT rowid FROM ft_cc_edges ORDER BY (hebb + abs(stdp)) ASC, at ASC LIMIT ?)",
        edges - Math.floor(EDGES_CAP * 0.9),
      );
    }
    const intents = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ft_cc_intents").one().n;
    if (intents > INTENTS_KEEP) {
      this.sql.exec("DELETE FROM ft_cc_intents WHERE intent_id IN (SELECT intent_id FROM ft_cc_intents ORDER BY seq ASC LIMIT ?)", intents - Math.floor(INTENTS_KEEP * 0.9));
    }
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM ft_cc_meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO ft_cc_meta (key, value) VALUES (?, ?)", key, value);
  }
}

// ---------------------------------------------------------------------------
// The caller's side (ColonyDO.take)
// ---------------------------------------------------------------------------

/** Cached neighbors of a path, or a cached miss. */
interface CacheEntry {
  neighbors: Neighbor[];
  until: number;
}

/**
 * Neighbors for self-assignment: a short-lived cache in front of TrunkDO.neighbors. A take asks for
 * the files of its candidates; cached ones answer at once, the rest go out in one call (shared
 * with concurrent takes that need the same paths) and are awaited at most `waitMs`. Whatever has
 * not arrived by then counts as no neighbors (fail open); it lands in the cache for the next take.
 */
export class NeighborCache {
  private readonly cache = new Map<Path, CacheEntry>();
  private readonly inflight = new Map<Path, Promise<void>>();
  private failedUntil = 0;

  constructor(
    private readonly fetchNeighbors: (paths: Path[]) => Promise<Record<Path, Neighbor[]>>,
    private readonly opts: { ttlMs?: number; emptyTtlMs?: number; failMs?: number; maxEntries?: number } = {},
  ) {}

  /** Neighbors of each of `paths` (plain files; directory and glob entries are skipped). */
  async get(paths: Iterable<Path>, now: number, waitMs: number): Promise<Map<Path, Neighbor[]>> {
    const out = new Map<Path, Neighbor[]>();
    const missing: Path[] = [];
    const pending: Array<Promise<void>> = [];
    for (const path of new Set(paths)) {
      if (typeof path !== "string" || path === "" || /[*?{]|\/$/.test(path)) continue;
      const hit = this.cache.get(path);
      if (hit && hit.until > now) {
        if (hit.neighbors.length > 0) out.set(path, hit.neighbors);
        continue;
      }
      const flying = this.inflight.get(path);
      if (flying) pending.push(flying);
      else missing.push(path);
    }
    if (missing.length > 0 && now >= this.failedUntil) pending.push(this.fetch(missing));
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(pending), new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, waitMs))))]);
      if (timer !== undefined) clearTimeout(timer);
      const after = Date.now();
      for (const path of new Set(paths)) {
        if (out.has(path)) continue;
        const hit = this.cache.get(path);
        if (hit && hit.until > Math.min(now, after) && hit.neighbors.length > 0) out.set(path, hit.neighbors);
      }
    }
    return out;
  }

  /** Drop every cached entry (for example after a reset of the map). */
  clear(): void {
    this.cache.clear();
  }

  /** Cached entries (for tests). */
  get size(): number {
    return this.cache.size;
  }

  private fetch(paths: Path[]): Promise<void> {
    const ttl = this.opts.ttlMs ?? 60_000;
    // A path without neighbors is asked again sooner: right after import the map may still be mining.
    const emptyTtl = Math.min(ttl, this.opts.emptyTtlMs ?? 15_000);
    const run = (async () => {
      try {
        const got = await this.fetchNeighbors(paths);
        const now = Date.now();
        this.trim(paths.length);
        for (const path of paths) {
          const nb = got && Object.hasOwn(got, path) && Array.isArray(got[path]) ? got[path]!.filter((n) => typeof n?.path === "string" && n.weight > 0) : [];
          this.cache.set(path, { neighbors: nb, until: now + (nb.length > 0 ? ttl : emptyTtl) });
        }
      } catch (err) {
        // TrunkDO without the map (an older class mid-deploy, or not initialized): no co-change for a while.
        this.failedUntil = Date.now() + (this.opts.failMs ?? 10_000);
        console.warn(`co-change neighbors unavailable: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        for (const path of paths) this.inflight.delete(path);
      }
    })();
    for (const path of paths) this.inflight.set(path, run);
    return run;
  }

  private trim(incoming: number): void {
    const max = this.opts.maxEntries ?? 50_000;
    if (this.cache.size + incoming <= max) return;
    const now = Date.now();
    for (const [path, e] of this.cache) if (e.until <= now) this.cache.delete(path);
    if (this.cache.size + incoming > max) this.cache.clear();
  }
}

/**
 * Claim value on a path as a take sees it, for neighbor repulsion: the claims in the reading of
 * the path's region (the taker's own removed) plus recent claims the reading may predate, each
 * worth `strength`. Exact paths are looked up directly; directory and glob claims are checked by
 * overlap. Each region is indexed once, on first use.
 */
export function claimLookup(
  views: ReadonlyMap<string, { byPath: Record<Path, { claim?: number }>; unseen: ReadonlyArray<{ paths: ReadonlySet<Path> }> }>,
  regionFor: (path: Path) => string,
  strength: number,
): (path: Path) => number {
  const pattern = /[*?{]|\/$/;
  const indexes = new Map<string, { exact: Map<Path, number>; patterns: Array<[Path, number]> } | null>();
  const index = (region: string) => {
    if (indexes.has(region)) return indexes.get(region)!;
    const view = views.get(region);
    let built: { exact: Map<Path, number>; patterns: Array<[Path, number]> } | null = null;
    if (view) {
      const exact = new Map<Path, number>();
      const patterns: Array<[Path, number]> = [];
      for (const [p, v] of Object.entries(view.byPath)) {
        const claim = v.claim ?? 0;
        if (!(claim > 0)) continue;
        if (pattern.test(p)) patterns.push([p, claim]);
        else exact.set(p, (exact.get(p) ?? 0) + claim);
      }
      for (const c of view.unseen) {
        for (const p of c.paths) {
          if (pattern.test(p)) patterns.push([p, strength]);
          else exact.set(p, (exact.get(p) ?? 0) + strength);
        }
      }
      built = { exact, patterns };
    }
    indexes.set(region, built);
    return built;
  };
  return (path) => {
    const idx = index(regionFor(path));
    if (!idx) return 0;
    let v = idx.exact.get(path) ?? 0;
    for (const [p, claim] of idx.patterns) if (pathsOverlap(p, path)) v += claim;
    return v;
  };
}
