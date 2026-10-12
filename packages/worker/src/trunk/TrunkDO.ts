import { DurableObject } from "cloudflare:workers";
import { landingMessage, newId, regionOf, serializeNote, validateProposal } from "@fire_trident/core";
import type { AgentKind, ColonySnapshot, Decision, FileVersion, Id, Landing, LineageNote, OccResult, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import type { TreeEntry } from "isomorphic-git";
import type { Env } from "../env.ts";
import {
  LANDING_IDENTITY,
  NEW_FILE_MODE,
  NOTES_REF,
  TokenCache,
  applyTreeChanges,
  artifactsCode,
  blobAt,
  blobSha,
  commitTree,
  deleteLocalRef,
  diffTrees,
  dispose,
  ensureRepo,
  errorText,
  fetchRef,
  isAuthError,
  isSha,
  listTreeFiles,
  mintToken,
  pushRef,
  readLocalBlob,
  remoteBlobAt,
  resolveLocal,
  setRef,
  sleep,
  withArtifactsRetry,
  withRepo,
  writeCommitObject,
  writeLocalBlob,
  type GitRepo,
  type MintedToken,
  type PathChange,
  type PushOutcome,
} from "../artifacts/git.ts";
import { mapLine } from "./blame.ts";
import { addNotes } from "./notes.ts";
import { BoundedMap, applyTreeChangesDeferred, writePending, type PendingObject } from "./surgery.ts";
import { commitContent, objectId } from "./objects.ts";
import { pushPack } from "./push.ts";
import { CoChangeStore, mineHistory, type CoChangeStats, type Neighbor } from "./cochange.ts";
import { planCycle, resultsFor, uniqueProposals, type LandResult, type Outcome, type PlanProposal, type Returned } from "./plan.ts";
import { durableFs } from "../artifacts/workspace.ts";
import { TRUNK_NAMESPACE, bindingFor } from "../artifacts/shards.ts";

export type { LandResult, Returned } from "./plan.ts";

/** Trunk write token lifetime, and how long before expiry it is replaced. */
const TOKEN_TTL_S = 6 * 3600;
const TOKEN_MARGIN_MS = 10 * 60_000;
/** History fetched at init; older bases are read through the binding. */
const INIT_DEPTH = 1;
/** Rebuilds of one cycle on a moved trunk before its proposals go back. */
const MAX_REBUILDS = 3;
/** Retry delay for a failed notes push. */
const NOTES_RETRY_MS = 30_000;
/** Group commit: proposals one trunk cycle takes at most (whole lane batches; one oversized batch still runs alone). */
const CYCLE_MAX_PROPOSALS = 200;
/** Workspaces read at once while a cycle pulls new blobs, and base lookups at once while it screens. */
const PULL_CONCURRENCY = 20;
const BASE_CONCURRENCY = 8;
/** Trees and commit → tree ids kept in memory (immutable objects; a few thousand cover many cycles). */
const TREE_CACHE = 4_000;
/** Objects of a cycle written to the git store at once. */
const WRITE_CONCURRENCY = 16;
const COMMIT_CACHE = 2_000;
/** Recent cycle summaries kept for stats(). */
const CYCLE_LOG_KEEP = 50;
const STAGING_REF = "refs/heads/ft-landing";
const MAIN_REF = "refs/heads/main";
const WHY_LIMIT = 50;

/**
 * Optional lineage context for `land`: intent and agent details for the commit message and
 * the lineage note, and the decisions that admitted each proposal (keyed by proposal id).
 * Missing entries are looked up from the colony's snapshot, then fall back to the proposal.
 */
export interface LandContext {
  intents?: Record<Id, { title: string; why?: string; ruleId?: Id; parentId?: Id }>;
  agents?: Record<Id, { kind: AgentKind; model?: string }>;
  decisions?: Record<Id, Array<Pick<Decision, "kind" | "layer" | "p" | "action">>>;
}

type IntentInfo = { title: string; why: string; ruleId?: Id; parentId?: Id };
type AgentLite = { kind: AgentKind; model?: string };
type StagedChange = { blob: Sha; mode: string; size: number; before: Sha | null } | { blob: null; before: Sha | null };

/** Everything needed to record a landing, journaled before the trunk push. */
interface JournalData {
  landing: Landing;
  note: string;
  changes: Array<[Path, StagedChange]>;
}

/** One lane batch waiting for a trunk cycle; its caller awaits the result. */
interface LandRequest {
  batch: Proposal[];
  ctx: LandContext;
  at: number;
  resolve: (r: LandResult) => void;
  reject: (e: unknown) => void;
}

/** Per-cycle memo of commit → root tree and tree entries, shared by every base lookup of the cycle. */
interface BaseCaches {
  commits: Map<Sha, string | null>;
  trees: Map<string, TreeEntry[]>;
  remote: Map<string, ArtifactsTreeEntry[] | null>;
}

/** What one trunk cycle did, for stats() and the cycle log line. */
export interface CycleStat {
  at: number;
  batches: number;
  proposals: number;
  landings: number;
  landed: number;
  prior: number;
  returned: number;
  deferred: number;
  rebuilds: number;
  /** Oldest request's time in the queue before the cycle started. */
  waitMs: number;
  /** Time per phase: recover, screen, pull, plan, build, push, finalize. */
  ms: Record<string, number>;
  totalMs: number;
  error?: string;
}

/** A definitive problem with one proposal (it goes back to its agent). */
class ProposalProblem extends Error {}

/** A trunk push whose outcome could not be learned; its journal rows stay for recovery. */
class UnknownPush extends Error {}

/**
 * The only writer of trunk. Holds trunk cloned into a @cloudflare/computer Workspace (SQLite VFS,
 * no working tree), a path → blob index of trunk main, and the lineage tables. Every trunk
 * mutation (init, landing cycles, system commits, mirror) runs on one serial chain, so trunk
 * pushes are single-flight; the notes push is single-flight on its own and overlaps the next cycle.
 *
 * Landing is group commit: lanes' batches queue in memory and one cycle at a time takes all of
 * them (up to CYCLE_MAX_PROPOSALS), re-validates every proposal against trunk and against the
 * batches ahead of it, builds one chained commit per batch, pushes the tip once with
 * compare-and-swap, and writes every lineage note in one notes commit. A caller whose call fails
 * (eviction, deploy) retries; results are idempotent per proposal id.
 */
export class TrunkDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private gitRepo: GitRepo | null = null;
  private tokenCache: TokenCache | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly intentCache = new Map<Id, IntentInfo>();
  private readonly agentCache = new Map<Id, AgentLite>();
  private lastSnapshotAt = 0;
  /** Group commit: batches waiting for the next cycle, and the cycle running now (driven by a waiting land call). */
  private queue: LandRequest[] = [];
  private activeCycle: Promise<void> | null = null;
  private readonly cycleLog: CycleStat[] = [];
  private cycles = 0;
  /** Strictly increasing landing times, so the newest landing of a cycle sorts last everywhere. */
  private lastLandingAt = 0;
  /** Single-flight notes flush, and whether more notes arrived while it ran. */
  private notesRun: Promise<{ pending: number }> | null = null;
  private notesAgain = false;
  /** Tree entries and commit → root tree, kept across cycles and calls (objects are immutable by id). */
  private readonly trees = new BoundedMap<string, TreeEntry[]>(TREE_CACHE);
  private readonly commitTrees = new BoundedMap<Sha, string>(COMMIT_CACHE);
  /** The notes root tree of the latest notes commits, and the fanout subtrees (notes.ts) recently read or written. */
  private readonly notesTrees = new BoundedMap<string, TreeEntry[]>(2);
  private readonly notesSubtrees = new BoundedMap<string, TreeEntry[]>(1_024);
  /** Co-change map (trunk/cochange.ts), and its history mining run while one is in flight. */
  private cochangeStore: CoChangeStore | null = null;
  private mining: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ft_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ft_files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL, mode TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ft_landings (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, trunk_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ft_landing_paths (path TEXT NOT NULL, seq INTEGER NOT NULL, landing_id TEXT NOT NULL, before_blob TEXT, after_blob TEXT, PRIMARY KEY (path, seq))`,
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ft_notes (landing_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, note TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ft_landed (proposal_id TEXT PRIMARY KEY, landing_id TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ft_journal (landing_id TEXT PRIMARY KEY, state TEXT NOT NULL, commit_sha TEXT NOT NULL, parent_sha TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    );
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  /**
   * Clone trunk main into the local repo and index its tree. Idempotent: a repeat call
   * recovers the journal, catches up with the remote, and re-pushes missing notes.
   * `regionDepth` (default 1) sets how landing regions are derived from paths.
   */
  async init(p: { colonyId: Id; trunk: RepoRef; regionDepth?: number }): Promise<{ trunkSha: Sha; files: number }> {
    const out = await this.serial(() => this.initNow(p));
    this.cochangeSoon();
    return out;
  }

  /** Every file on trunk main with its size and blob id, sorted by path. */
  async files(): Promise<Array<{ path: Path; size: number; blob: Sha }>> {
    this.state();
    return this.sql.exec<{ path: string; size: number; blob: string }>(`SELECT path, size, blob FROM ft_files ORDER BY path`).toArray();
  }

  /** Current trunk blob for each path (null when absent). */
  async blobsFor(paths: Path[]): Promise<Record<Path, Sha | null>> {
    this.state();
    const out: Record<Path, Sha | null> = {};
    for (const path of paths) out[path] = this.indexBlob(path);
    return out;
  }

  /** Text of a trunk file (UTF-8), or null when absent. */
  async readFile(path: Path): Promise<string | null> {
    const st = this.state();
    const blob = this.indexBlob(path);
    if (blob === null) return null;
    try {
      return new TextDecoder().decode(await readLocalBlob(this.repo(), blob));
    } catch {
      const remote = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (r) => r.readBlob(blob));
      return remote ? remote.text() : null;
    }
  }

  /**
   * Blob of each path at commit `baseSha` (null when absent). Reads the local repo, then the
   * binding for commits older than the local history. An unknown commit yields nulls.
   */
  async baseBlobs(baseSha: Sha, paths: Path[]): Promise<FileVersion[]> {
    this.state();
    const map = await this.baseBlobMap(baseSha, paths).catch(() => null);
    return paths.map((path) => ({ path, blob: map?.get(path) ?? null }));
  }

  /**
   * Land a batch as one trunk commit, in the next group-commit cycle. Each proposal is
   * re-validated at landing time against trunk and against the batches landing ahead of it in
   * the same cycle (read set, base of the write set, tree shape, blob ids); failures come back
   * in `returned` with the exact reason. The batch's commit is chained onto the cycle's earlier
   * commits and the cycle pushes once with compare-and-swap; on a moved trunk the cycle is
   * rebuilt. Idempotent per proposal id: a proposal that already landed comes back in `prior`
   * with its landing, never as returned. `deferred` ones hit a transient error; send them again.
   */
  async land(batch: Proposal[], ctx?: LandContext): Promise<LandResult> {
    this.state();
    const list = Array.isArray(batch) ? batch : [];
    if (list.length === 0) return { returned: [] };
    let settled = false;
    const answer = new Promise<LandResult>((resolve, reject) => {
      const done = <T>(f: (v: T) => void) => (v: T): void => {
        settled = true;
        f(v);
      };
      this.queue.push({ batch: list, ctx: ctx ?? {}, at: Date.now(), resolve: done(resolve), reject: done(reject) });
    });
    // Cycles are driven by the calls waiting on them: whichever waiting call finds no cycle running
    // starts the next one, so a cycle always runs inside a live call (its logs and limits included).
    while (!settled) {
      if (this.activeCycle === null) {
        const run: Promise<void> = this.serial(async () => {
          const take = this.takeCycle();
          if (take.length > 0) await this.runCycle(take);
        })
          .catch(() => undefined)
          .finally(() => {
            if (this.activeCycle === run) this.activeCycle = null;
          });
        this.activeCycle = run;
      }
      await this.activeCycle;
    }
    return answer;
  }

  /**
   * The landing of each proposal that has landed (by proposal id). Lanes ask before they return
   * a proposal that looks stale: a proposal whose landing report was lost looks stale against
   * its own blob, and must be settled as landed instead.
   */
  async landingsOf(proposalIds: Id[]): Promise<Record<Id, Landing>> {
    this.state();
    if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_journal WHERE state = 'pushing'`).one().n > 0) {
      await this.serial(() => this.recoverJournal());
    }
    const ids = Array.isArray(proposalIds) ? proposalIds.filter((x): x is Id => typeof x === "string" && x !== "") : [];
    return Object.fromEntries(this.landingsByProposal(ids));
  }

  /**
   * Commit files to trunk as FireTrident itself (colony memory such as antibodies under
   * .firetrident/): one commit on current main, message plus an FT-Landing trailer, pushed with
   * compare-and-swap and rebuilt on a moved trunk. It is recorded like a landing with no proposals
   * (index, `why`, and `note` as its lineage note), so its history explains itself.
   */
  async systemCommit(p: { files: Array<{ path: Path; content: string | null }>; message: string; note: LineageNote & Record<string, unknown> }): Promise<Landing> {
    const landing = await this.serial(() => this.systemCommitNow(p));
    await this.notesSoon();
    return landing;
  }

  /**
   * Landings that changed `path`, newest first, with their lineage notes. With `line`
   * (1-based, in the current file), the landing that last changed that line comes first;
   * the order is unchanged when the line predates every landing.
   */
  async why(path: Path, line?: number): Promise<Array<{ landing: Landing; note: LineageNote }>> {
    const rows = this.sql
      .exec<{ landing: string; note: string | null; before_blob: string | null; after_blob: string | null }>(
        `SELECT l.data AS landing, n.note AS note, lp.before_blob AS before_blob, lp.after_blob AS after_blob FROM ft_landing_paths lp
           JOIN ft_landings l ON l.seq = lp.seq
           LEFT JOIN ft_notes n ON n.landing_id = lp.landing_id
         WHERE lp.path = ? ORDER BY lp.seq DESC LIMIT ?`,
        path,
        WHY_LIMIT,
      )
      .toArray();
    const out: Array<{ landing: Landing; note: LineageNote }> = [];
    let ownerAt = -1;
    const owner = line !== undefined && Number.isFinite(line) && line >= 1 ? await this.lineOwner(path, Math.floor(line), rows).catch(() => null) : null;
    rows.forEach((r, i) => {
      if (r.note === null) return;
      if (i === owner) ownerAt = out.length;
      out.push({ landing: JSON.parse(r.landing) as Landing, note: JSON.parse(r.note) as LineageNote });
    });
    if (ownerAt > 0) out.unshift(...out.splice(ownerAt, 1));
    return out;
  }

  /** The most recent landings, newest first (default 50). */
  async landings(limit = 50): Promise<Landing[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    return this.sql
      .exec<{ data: string }>(`SELECT data FROM ft_landings ORDER BY seq DESC LIMIT ?`, n)
      .toArray()
      .map((r) => JSON.parse(r.data) as Landing);
  }

  /** Mint a new trunk write token when the cached one is within 10 minutes of expiry. */
  async refreshTokenIfNeeded(): Promise<{ expiresAt: number }> {
    const t = await this.token();
    return { expiresAt: t.expiresAt };
  }

  /** Push notes for landings whose note has not reached the remote yet. */
  async flushNotes(): Promise<{ pending: number }> {
    this.state();
    return this.notesFlush();
  }

  /**
   * Force-push trunk main (and optionally the lineage notes) to another repo, such as a lane
   * repo or a read mirror. The target is overwritten; it never feeds back into trunk.
   */
  async mirrorTo(target: RepoRef, opts: { notes?: boolean } = {}): Promise<{ sha: Sha }> {
    return this.serial(async () => {
      const st = this.state();
      const binding = bindingFor(this.env, target.namespace);
      if (!binding) throw new Error(`no binding for namespace ${target.namespace}`);
      const tok = await mintToken(binding, target.name, "write", 600);
      const g = this.repo();
      const main = await pushRef(g, { url: target.remote, token: tok.token, localRef: MAIN_REF, remoteRef: MAIN_REF, force: true, remote: "mirror" });
      if (!main.ok) throw new Error(`mirror push to ${target.name} failed: ${main.detail}`);
      if (opts.notes && (await resolveLocal(g, NOTES_REF))) {
        await pushRef(g, { url: target.remote, token: tok.token, localRef: NOTES_REF, remoteRef: NOTES_REF, force: true, remote: "mirror" });
      }
      return { sha: st.trunkSha };
    });
  }

  /** Operational counters (for status pages and tests), with the group-commit queue and recent cycles. */
  async stats(): Promise<{
    trunkSha: Sha | null;
    files: number;
    landings: number;
    pendingNotes: number;
    notesTip: Sha | null;
    queued: { batches: number; proposals: number };
    cycles: number;
    recentCycles: CycleStat[];
  }> {
    return {
      trunkSha: this.meta("trunk_sha"),
      files: this.fileCount(),
      landings: this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_landings`).one().n,
      pendingNotes: this.pendingNotes(),
      notesTip: this.meta("notes_tip"),
      queued: { batches: this.queue.length, proposals: this.queue.reduce((n, r) => n + r.batch.length, 0) },
      cycles: this.cycles,
      recentCycles: this.cycleLog.slice(-20),
    };
  }

  /**
   * Erase this object (colony deletion): cancel the alarm and delete all storage, then replay
   * the DDL of its own `ft_` tables so a later init() starts from empty tables. The git storage
   * is rebuilt by the next repo().
   */
  async destroy(): Promise<{ cleared: true }> {
    const ddl = this.sql.exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE substr(name, 1, 3) = 'ft_' AND sql IS NOT NULL ORDER BY rowid`).toArray();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    for (const { sql } of ddl) this.sql.exec(sql);
    this.gitRepo = null;
    this.tokenCache = null;
    this.intentCache.clear();
    this.agentCache.clear();
    // Batches still waiting for a cycle belong to the erased colony.
    for (const r of this.queue.splice(0)) r.reject(new Error("trunk erased"));
    return { cleared: true };
  }

  /**
   * For each path, the files whose claims should repel work on it, strongest first (at most `k`,
   * coupling >= 0.1): co-change mined from trunk history at init and learned from every landing
   * since. Learns the landings recorded since the last call first, and starts history mining if
   * it never ran. Paths without neighbors are left out.
   */
  async neighbors(paths: Path[], k = 8): Promise<Record<Path, Neighbor[]>> {
    this.state();
    const cc = this.cochange();
    this.cochangeSoon();
    if (this.mining === null && cc.minedState() !== null) cc.catchUp();
    return cc.neighbors(Array.isArray(paths) ? paths : [], k);
  }

  /** Co-change map counts, mining state, and the landing watermark. */
  async cochangeStats(): Promise<CoChangeStats & { mining: boolean }> {
    this.state();
    return { ...this.cochange().stats(), mining: this.mining !== null };
  }

  /** Retries a failed notes push. */
  async alarm(): Promise<void> {
    if (this.meta("trunk_sha") === null) return;
    await this.notesFlush().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Init and sync
  // -------------------------------------------------------------------------

  private async initNow(p: { colonyId: Id; trunk: RepoRef; regionDepth?: number }): Promise<{ trunkSha: Sha; files: number }> {
    const prev = this.meta("trunk");
    if (prev !== null) {
      const old = JSON.parse(prev) as RepoRef;
      if (old.name !== p.trunk.name || old.namespace !== p.trunk.namespace) this.reset();
    }
    this.setMeta("colony_id", p.colonyId);
    this.setMeta("trunk", JSON.stringify(p.trunk));
    if (p.regionDepth !== undefined && Number.isFinite(p.regionDepth)) this.setMeta("region_depth", String(Math.max(1, Math.floor(p.regionDepth))));
    const g = this.repo();
    await ensureRepo(g, p.trunk.remote);
    if (this.meta("trunk_sha") === null) {
      const head = await this.authed((token) => fetchRef(g, { url: p.trunk.remote, token, ref: MAIN_REF, depth: INIT_DEPTH }));
      if (head === null) throw new Error(`trunk ${p.trunk.name} has no main branch`);
      await setRef(g, MAIN_REF, head);
      const notes = await this.authed((token) => fetchRef(g, { url: p.trunk.remote, token, ref: NOTES_REF }));
      if (notes !== null) {
        await setRef(g, NOTES_REF, notes);
        this.setMeta("notes_tip", notes);
      }
      await this.rebuildIndex(head);
    } else {
      await this.recoverJournal();
      await this.resync();
    }
    await this.notesFlush();
    return { trunkSha: this.state().trunkSha, files: this.fileCount() };
  }

  /** Replace the index with the full tree of commit `head`. */
  private async rebuildIndex(head: Sha): Promise<void> {
    const g = this.repo();
    const tree = await commitTree(g, head);
    if (tree === null) throw new Error(`trunk commit ${head} is missing locally`);
    const files = await listTreeFiles(g, tree);
    const rows: Array<{ path: string; blob: string; mode: string; size: number }> = [];
    for (const f of files) rows.push({ ...f, size: (await readLocalBlob(g, f.blob)).length });
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM ft_files`);
      for (const r of rows) this.sql.exec(`INSERT INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, ?)`, r.path, r.blob, r.size, r.mode);
      this.setMeta("trunk_sha", head);
    });
  }

  /**
   * Catch up with the remote main (an external push, or our own push recorded late).
   * Updates the index incrementally and returns the paths that changed.
   */
  private async resync(): Promise<Set<Path>> {
    const st = this.state();
    const g = this.repo();
    const head = await this.authed((token) => fetchRef(g, { url: st.trunk.remote, token, ref: MAIN_REF }));
    if (head === null) throw new Error(`trunk ${st.trunk.name} lost its main branch`);
    if (head === st.trunkSha) return new Set();
    const before = await commitTree(g, st.trunkSha);
    const after = await commitTree(g, head);
    if (after === null) throw new Error(`fetched trunk commit ${head} is missing locally`);
    if (before === null) {
      const old = new Map(this.files_().map((f) => [f.path, f.blob]));
      await this.rebuildIndex(head);
      await setRef(g, MAIN_REF, head);
      const changed = new Set<Path>();
      const now = new Map(this.files_().map((f) => [f.path, f.blob]));
      for (const path of new Set([...old.keys(), ...now.keys()])) if (old.get(path) !== now.get(path)) changed.add(path);
      return changed;
    }
    const deltas = await diffTrees(g, before, after);
    const rows: Array<{ path: string; blob: string; mode: string; size: number } | { path: string; blob: null }> = [];
    for (const d of deltas) {
      if (d.after) rows.push({ path: d.path, blob: d.after.blob, mode: d.after.mode, size: (await readLocalBlob(g, d.after.blob)).length });
      else rows.push({ path: d.path, blob: null });
    }
    this.ctx.storage.transactionSync(() => {
      for (const r of rows) {
        if (r.blob === null) this.sql.exec(`DELETE FROM ft_files WHERE path = ?`, r.path);
        else this.sql.exec(`INSERT OR REPLACE INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, ?)`, r.path, r.blob, r.size, r.mode);
      }
      this.setMeta("trunk_sha", head);
    });
    await setRef(g, MAIN_REF, head);
    return new Set(deltas.map((d) => d.path));
  }

  // -------------------------------------------------------------------------
  // Landing
  // -------------------------------------------------------------------------

  /** The next cycle's batches: whole batches in arrival order, up to CYCLE_MAX_PROPOSALS proposals (always at least one batch). */
  private takeCycle(): LandRequest[] {
    const out: LandRequest[] = [];
    let n = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (out.length > 0 && n + next.batch.length > CYCLE_MAX_PROPOSALS) break;
      out.push(this.queue.shift()!);
      n += next.batch.length;
    }
    return out;
  }

  /** Run one cycle and answer each of its batches. A failed cycle fails every batch; the lanes retry, idempotently per proposal id. */
  private async runCycle(reqs: LandRequest[]): Promise<void> {
    const at = Date.now();
    const stat: CycleStat = {
      at,
      batches: reqs.length,
      proposals: reqs.reduce((n, r) => n + r.batch.length, 0),
      landings: 0,
      landed: 0,
      prior: 0,
      returned: 0,
      deferred: 0,
      rebuilds: 0,
      waitMs: at - reqs.reduce((m, r) => Math.min(m, r.at), at),
      ms: {},
      totalMs: 0,
    };
    try {
      const results = await this.cycle(reqs, stat);
      reqs.forEach((r, i) => r.resolve(results[i] ?? { returned: [] }));
    } catch (e) {
      stat.error = errorText(e);
      for (const r of reqs) r.reject(e);
    } finally {
      stat.totalMs = Date.now() - at;
      this.cycles++;
      this.cycleLog.push(stat);
      if (this.cycleLog.length > CYCLE_LOG_KEEP) this.cycleLog.splice(0, this.cycleLog.length - CYCLE_LOG_KEEP);
      console.log(JSON.stringify({ ft: "trunk-cycle", colonyId: this.meta("colony_id"), ...stat }));
      void this.emitCycle(stat).catch(() => undefined);
    }
  }

  /**
   * Publish one cycle on the colony's live feed as `trunk.*` metric events (same `at` for the
   * cycle), so the UI shows group commit working and benchmarks can record every cycle.
   */
  private async emitCycle(stat: CycleStat): Promise<void> {
    const colonyId = this.meta("colony_id");
    const ns = this.env.COLONY as DurableObjectNamespace | undefined;
    if (colonyId === null || !ns) return;
    const metric = (name: string, value: number) => ({ t: "metric" as const, at: stat.at, name: `trunk.${name}`, value });
    const events = [
      metric("cycleMs", stat.totalMs),
      metric("waitMs", stat.waitMs),
      metric("batches", stat.batches),
      metric("proposals", stat.proposals),
      metric("landings", stat.landings),
      metric("landed", stat.landed),
      metric("returned", stat.returned),
      metric("screenMs", stat.ms.screen ?? 0),
      metric("pullMs", stat.ms.pull ?? 0),
      metric("buildMs", stat.ms.build ?? 0),
      metric("lineageMs", stat.ms.lineage ?? 0),
      metric("surgeryMs", stat.ms.surgery ?? 0),
      metric("commitMs", stat.ms.commit ?? 0),
      metric("pushMs", stat.ms.push ?? 0),
      metric("finalizeMs", stat.ms.finalize ?? 0),
    ];
    const stub = ns.get(ns.idFromName(colonyId)) as unknown as { emit(e: unknown[]): Promise<unknown> };
    await stub.emit(events);
  }

  /**
   * One group-commit cycle: idempotency per proposal id, screening against trunk, blob pulls,
   * the plan over the virtual trunk (plan.ts), one chained commit per batch, one push of the tip
   * with compare-and-swap, and the record of every landing in one transaction.
   */
  private async cycle(reqs: LandRequest[], stat: CycleStat): Promise<LandResult[]> {
    let mark = Date.now();
    const lap = (phase: string): void => {
      const now = Date.now();
      stat.ms[phase] = (stat.ms[phase] ?? 0) + (now - mark);
      mark = now;
    };
    this.state();
    await this.recoverJournal();
    lap("recover");
    const batches = reqs.map((r) => r.batch);
    const outcome = new Map<Id, Outcome>();
    const own: Array<Landing | undefined> = reqs.map(() => undefined);
    const direct: Returned[][] = batches.map((b) =>
      b.filter((p) => typeof p?.id !== "string" || p.id === "").map((p) => ({ proposalId: "", reason: shapeProblem(p) ?? "proposal has no id" })),
    );

    // 1. Each proposal once (a repeat shares the first one's outcome); malformed ones go back.
    let live: Array<{ request: number; p: Proposal }> = [];
    for (const e of uniqueProposals(batches)) {
      const shape = shapeProblem(e.p);
      if (shape) outcome.set(e.p.id, { kind: "returned", reason: shape });
      else live.push(e);
    }

    // 2. Idempotency: a proposal that already landed (its batch's answer was lost) is landed, never returned.
    const prior = this.landingsByProposal(live.map((e) => e.p.id));
    for (const [id, landing] of prior) outcome.set(id, { kind: "landed", landing });
    live = live.filter((e) => !prior.has(e.p.id));
    stat.prior = prior.size;

    // 3. Screen against current trunk with local reads (base blobs, OCC, structure); stale ones never pull.
    const caches: BaseCaches = { commits: new Map(), trees: new Map(), remote: new Map() };
    const bases = new Map<Id, FileVersion[]>();
    const screened = await mapLimit(live, BASE_CONCURRENCY, async (e): Promise<Outcome | null> => {
      try {
        const w = e.p.writeSet.map((f) => f.path);
        const base = await this.baseBlobMap(e.p.baseSha, w, caches);
        if (base === null) return { kind: "returned", reason: `unknown base commit ${e.p.baseSha}` };
        const fv = w.map((path) => ({ path, blob: base.get(path) ?? null }));
        bases.set(e.p.id, fv);
        const occ = validateProposal(e.p, (path) => this.indexBlob(path), fv);
        if (!occ.eligible) return { kind: "returned", reason: `stale: ${staleDetail(occ.stale)}` };
        const structural = this.structuralProblem(e.p);
        return structural ? { kind: "returned", reason: structural } : null;
      } catch (err) {
        return { kind: "deferred", reason: `base lookup failed: ${errorText(err)}` };
      }
    });
    live = live.filter((e, i) => {
      const o = screened[i];
      if (o) outcome.set(e.p.id, o);
      return !o;
    });
    lap("screen");

    // 4. Pull the new blobs from the agents' workspaces, many workspaces at once.
    const sizes = new Map<Id, Map<Path, number>>();
    const pulls = await mapLimit(live, PULL_CONCURRENCY, async (e): Promise<Outcome | null> => {
      try {
        sizes.set(e.p.id, await this.pullBlobs(e.p));
        return null;
      } catch (err) {
        if (err instanceof ProposalProblem) return { kind: "returned", reason: err.message };
        return { kind: "deferred", reason: `blob pull failed: ${errorText(err)}` };
      }
    });
    live = live.filter((e, i) => {
      const o = pulls[i];
      if (o) outcome.set(e.p.id, o);
      return !o;
    });
    lap("pull");

    // 5. Plan over the virtual trunk, build one chained commit per batch, push the tip once.
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        // Trunk moved underneath: the plan re-validates against the new index, structure too.
        live = live.filter((e) => {
          const s = this.structuralProblem(e.p);
          if (s) outcome.set(e.p.id, { kind: "returned", reason: s });
          return !s;
        });
      }
      const input: PlanProposal[][] = reqs.map(() => []);
      for (const e of live) input[e.request]!.push({ p: e.p, base: bases.get(e.p.id) ?? [] });
      const plan = planCycle(input, (path) => this.indexBlob(path));
      const back = (): void => {
        for (const r of plan.returned.flat()) outcome.set(r.proposalId, { kind: "returned", reason: r.reason });
      };
      lap("plan");
      const chain = await this.buildChain(reqs, plan.accepted, sizes, stat);
      lap("build");
      if (chain === null) {
        back();
        break;
      }
      const pushed = await this.pushChain(chain);
      lap("push");
      if (pushed.ok) {
        this.ctx.storage.transactionSync(() => {
          for (const it of chain.items) this.finalizeRows(it.data);
        });
        await setRef(this.repo(), MAIN_REF, chain.tip);
        for (const it of chain.items) {
          own[it.request] = it.data.landing;
          for (const id of it.data.landing.proposalIds) outcome.set(id, { kind: "landed", landing: it.data.landing });
          stat.landed += it.data.landing.proposalIds.length;
        }
        stat.landings = chain.items.length;
        back();
        lap("finalize");
        break;
      }
      if (attempt >= MAX_REBUILDS) {
        for (const it of chain.items) {
          for (const id of it.data.landing.proposalIds) outcome.set(id, { kind: "returned", reason: `trunk kept moving during landing (${pushed.detail}); propose again` });
        }
        back();
        break;
      }
      stat.rebuilds++;
      await this.resync();
      lap("resync");
    }

    // The landings are recorded; a failure to start the notes flush must not fail them (the journal keeps every note).
    if (stat.landings > 0) await this.notesSoon().catch((e: unknown) => console.error(`notes flush not started: ${errorText(e)}`));
    for (const o of outcome.values()) {
      if (o.kind === "returned") stat.returned++;
      else if (o.kind === "deferred") stat.deferred++;
    }
    return resultsFor(batches, outcome, own, direct);
  }

  /**
   * One commit per batch with accepted proposals, by tree surgery, each on top of the previous
   * one (the first on current main), with its message, landing and lineage note. Null when the
   * plan accepted nothing.
   */
  private async buildChain(
    reqs: LandRequest[],
    accepted: Proposal[][],
    sizes: Map<Id, Map<Path, number>>,
    stat?: CycleStat,
  ): Promise<{ parent: Sha; tip: Sha; items: Array<{ request: number; data: JournalData }>; objects: string[] } | null> {
    if (accepted.every((a) => a.length === 0)) return null;
    const st = this.state();
    const g = this.repo();
    let mark = Date.now();
    const lap = (phase: string): void => {
      const now = Date.now();
      if (stat) stat.ms[phase] = (stat.ms[phase] ?? 0) + (now - mark);
      mark = now;
    };
    const ctx = mergeContexts(reqs.map((r) => r.ctx));
    const info = await this.lineageInfo(accepted.flat(), ctx, st.colonyId);
    lap("lineage");
    const root = this.commitTrees.get(st.trunkSha) ?? (await commitTree(g, st.trunkSha));
    if (root === null) throw new Error(`trunk commit ${st.trunkSha} is missing locally`);
    let tree: string = root;
    let parent = st.trunkSha;
    const items: Array<{ request: number; data: JournalData }> = [];
    // Every object the chain adds (blobs, rewritten trees, commits): what its push must carry. Trees and
    // commits are computed in memory and written together after the loop (writePending).
    const objects = new Set<string>();
    const pending = new Map<string, PendingObject & { entries?: TreeEntry[] }>();
    for (let i = 0; i < accepted.length; i++) {
      const proposals = accepted[i]!;
      if (proposals.length === 0) continue;
      // No earlier batch of the cycle touches these paths (the plan), so `before` is current trunk.
      const changes = new Map<Path, StagedChange>();
      for (const p of proposals) {
        for (const w of p.writeSet) {
          const before = this.indexBlob(w.path);
          if (w.blob === null) {
            if (before !== null) changes.set(w.path, { blob: null, before });
          } else if (w.blob !== before) {
            const size = sizes.get(p.id)?.get(w.path) ?? (await readLocalBlob(g, w.blob)).length;
            changes.set(w.path, { blob: w.blob, mode: this.indexMode(w.path) ?? NEW_FILE_MODE, size, before });
          }
        }
      }
      const treeChanges = new Map<Path, PathChange>();
      for (const [path, c] of changes) treeChanges.set(path, c.blob === null ? null : { blob: c.blob, mode: c.mode });
      lap("changes");
      for (const c of changes.values()) if (c.blob !== null) objects.add(c.blob);
      if (treeChanges.size > 0) tree = await applyTreeChangesDeferred(g, this.trees, tree, treeChanges, pending);
      lap("surgery");
      const at = this.nextLandingAt();
      const id = newId("lnd_");
      const intentIds = unique(proposals.map((p) => p.intentId));
      const message = landingMessage({ id, intentIds }, proposals, info.titles);
      const content = commitContent({ tree, parents: [parent], message, name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: Math.floor(at / 1000) });
      const commit = objectId("commit", content);
      pending.set(commit, { type: "commit", content });
      this.commitTrees.set(commit, tree);
      lap("commit");
      const paths = [...changes.keys()].sort();
      const landing: Landing = {
        id,
        colonyId: st.colonyId,
        trunkSha: commit,
        parentSha: parent,
        proposalIds: proposals.map((p) => p.id),
        intentIds,
        paths,
        regions: unique(paths.map((path) => regionOf(path, st.regionDepth))).sort(),
        at,
      };
      const note = serializeNote(buildNote(landing, proposals, info, ctx));
      items.push({ request: i, data: { landing, note, changes: [...changes] } });
      parent = commit;
      lap("note");
    }
    await writePending(g, pending, WRITE_CONCURRENCY);
    for (const id of pending.keys()) objects.add(id);
    lap("write");
    return { parent: st.trunkSha, tip: parent, items, objects: [...objects] };
  }

  /**
   * Journal every landing of the chain, then push its tip to main with compare-and-swap on the
   * chain's parent (one push however many batches). On a stale main the journal rows are dropped
   * (nothing landed); when the outcome cannot be learned they stay for recoverJournal.
   */
  private async pushChain(chain: { parent: Sha; tip: Sha; items: Array<{ data: JournalData }>; objects?: string[] }): Promise<{ ok: true } | { ok: false; detail: string }> {
    const st = this.state();
    const g = this.repo();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const { data } of chain.items) {
        this.sql.exec(
          `INSERT INTO ft_journal (landing_id, state, commit_sha, parent_sha, data, created_at, updated_at) VALUES (?, 'pushing', ?, ?, ?, ?, ?)`,
          data.landing.id,
          data.landing.trunkSha,
          data.landing.parentSha,
          JSON.stringify(data),
          data.landing.at,
          now,
        );
      }
    });
    const drop = (): void => {
      this.ctx.storage.transactionSync(() => {
        for (const { data } of chain.items) this.dropJournal(data.landing.id);
      });
    };
    await setRef(g, STAGING_REF, chain.tip);
    /** Where main is when a push's outcome is unknown; journal kept (UnknownPush) when even that cannot be learned. */
    const head = async (e: unknown): Promise<Sha | null> => {
      try {
        return await this.remoteHead();
      } catch {
        throw new UnknownPush(`trunk push outcome unknown, journal kept for recovery: ${errorText(e)}`);
      }
    };
    const regular = (): Promise<PushOutcome> =>
      this.authed((token) => pushRef(g, { url: st.trunk.remote, token, localRef: STAGING_REF, remoteRef: MAIN_REF, expectedOld: chain.parent }));
    let outcome: PushOutcome;
    try {
      if (chain.objects && chain.objects.length > 0) {
        // Direct push of exactly the chain's new objects (push.ts); the regular push settles anything unexpected.
        try {
          outcome = await this.authed((token) => pushPack(g, { url: st.trunk.remote, token, ref: MAIN_REF, oldOid: chain.parent, newOid: chain.tip, oids: chain.objects! }));
          if (!outcome.ok && !outcome.stale) {
            console.error(`direct trunk push refused (${outcome.detail}); using the regular push`);
            outcome = await regular();
          }
        } catch (e) {
          const at = await head(e);
          if (at === chain.tip) return { ok: true };
          if (at !== chain.parent) {
            drop();
            return { ok: false, detail: `trunk main moved to ${at ?? "nothing"}` };
          }
          console.error(`direct trunk push failed (${errorText(e)}); using the regular push`);
          outcome = await regular();
        }
      } else {
        outcome = await regular();
      }
    } catch (e) {
      // The outcome is unknown (network): ask the binding where main is.
      if ((await head(e)) === chain.tip) return { ok: true };
      drop();
      throw new Error(`trunk push failed: ${errorText(e)}`);
    }
    if (outcome.ok) return { ok: true };
    drop();
    if (outcome.stale) return { ok: false, detail: outcome.detail };
    throw new Error(`trunk push rejected: ${outcome.detail}`);
  }

  /** Landing of each of these proposal ids that has landed. */
  private landingsByProposal(ids: Id[]): Map<Id, Landing> {
    const out = new Map<Id, Landing>();
    const parsed = new Map<string, Landing>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = this.sql
        .exec<{ proposal_id: string; landing_id: string; data: string }>(
          `SELECT ld.proposal_id AS proposal_id, ld.landing_id AS landing_id, l.data AS data FROM ft_landed ld
             JOIN ft_landings l ON l.id = ld.landing_id
           WHERE ld.proposal_id IN (SELECT value FROM json_each(?))`,
          JSON.stringify(ids.slice(i, i + 500)),
        )
        .toArray();
      for (const r of rows) {
        let l = parsed.get(r.landing_id);
        if (!l) {
          l = JSON.parse(r.data) as Landing;
          parsed.set(r.landing_id, l);
        }
        out.set(r.proposal_id, l);
      }
    }
    return out;
  }

  /** A landing time later than every earlier one, so a cycle's newest landing sorts last everywhere. */
  private nextLandingAt(): number {
    this.lastLandingAt = Math.max(Date.now(), this.lastLandingAt + 1);
    return this.lastLandingAt;
  }

  /** A file where a directory is needed (or the reverse), or a write into a submodule. */
  private structuralProblem(p: Proposal): string | null {
    for (const w of p.writeSet) {
      if (w.blob === null) continue;
      const parts = w.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        if (this.indexBlob(prefix) !== null) return `${prefix} is a file in trunk, so ${w.path} cannot be created`;
      }
      const child = this.sql.exec(`SELECT 1 AS x FROM ft_files WHERE path > ? AND path < ? LIMIT 1`, `${w.path}/`, `${w.path}0`).toArray();
      if (child.length > 0) return `${w.path} is a directory in trunk`;
      if (this.indexMode(w.path) === "160000") return `${w.path} is a submodule in trunk`;
    }
    return null;
  }

  /** Read every new blob of `p` from its workspace repo, verify its id, and write it locally. Returns each pulled blob's size by path. */
  private async pullBlobs(p: Proposal): Promise<Map<Path, number>> {
    const sizes = new Map<Path, number>();
    const needed = p.writeSet.filter((w) => w.blob !== null && w.blob !== this.indexBlob(w.path));
    if (needed.length === 0) return sizes;
    const binding = bindingFor(this.env, p.workspace.namespace);
    if (!binding) throw new ProposalProblem(`unknown workspace namespace ${p.workspace.namespace}`);
    const g = this.repo();
    let repo: ArtifactsRepo;
    try {
      repo = await withArtifactsRetry(() => binding.get(p.workspace.name));
    } catch (e) {
      if (artifactsCode(e) === "NOT_FOUND") throw new ProposalProblem(`workspace ${p.workspace.name} does not exist`);
      throw e;
    }
    try {
      const pulled = await mapLimit(needed, 6, async (w) => {
        const blob = await withArtifactsRetry(() => repo.readBlob(w.blob!));
        if (!blob) throw new ProposalProblem(`blob ${w.blob} for ${w.path} is not in workspace ${p.workspace.name}; push the commit first`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const sha = await blobSha(bytes);
        if (sha !== w.blob) throw new ProposalProblem(`blob for ${w.path} hashes to ${sha}, not ${w.blob}`);
        await writeLocalBlob(g, bytes);
        return { w, size: bytes.length };
      });
      for (const { w, size } of pulled) sizes.set(w.path, size);
    } finally {
      dispose(repo);
    }
    return sizes;
  }

  /** Build, push and record one system commit (see systemCommit); up to MAX_REBUILDS retries on a moved trunk. */
  private async systemCommitNow(p: { files: Array<{ path: Path; content: string | null }>; message: string; note: LineageNote & Record<string, unknown> }): Promise<Landing> {
    this.state();
    await this.recoverJournal();
    if (!Array.isArray(p.files) || p.files.length === 0) throw new Error("system commit has no files");
    for (const f of p.files) {
      const bad = pathProblem(f.path);
      if (bad) throw new Error(bad);
    }
    const enc = new TextEncoder();
    for (let attempt = 0; ; attempt++) {
      const st = this.state();
      const g = this.repo();
      const parent = st.trunkSha;
      const changes = new Map<Path, StagedChange>();
      for (const f of p.files) {
        const before = this.indexBlob(f.path);
        if (f.content === null) {
          if (before !== null) changes.set(f.path, { blob: null, before });
          continue;
        }
        const bytes = enc.encode(f.content);
        const blob = await writeLocalBlob(g, bytes);
        if (blob !== before) changes.set(f.path, { blob, mode: this.indexMode(f.path) ?? NEW_FILE_MODE, size: bytes.length, before });
      }
      if (changes.size === 0) throw new Error("system commit changes nothing");
      const treeChanges = new Map<Path, PathChange>();
      for (const [path, c] of changes) treeChanges.set(path, c.blob === null ? null : { blob: c.blob, mode: c.mode });
      const parentTree = await commitTree(g, parent);
      if (parentTree === null) throw new Error(`trunk commit ${parent} is missing locally`);
      const tree = await applyTreeChanges(g, parentTree, treeChanges);
      const at = this.nextLandingAt();
      const id = newId("lnd_");
      const message = `${p.message.replace(/\s+$/, "")}\nFT-Landing: ${id}`;
      const commit = await writeCommitObject(g, { tree, parents: [parent], message, at });
      const paths = [...changes.keys()].sort();
      const landing: Landing = {
        id,
        colonyId: st.colonyId,
        trunkSha: commit,
        parentSha: parent,
        proposalIds: [],
        intentIds: [],
        paths,
        regions: unique(paths.map((path) => regionOf(path, st.regionDepth))).sort(),
        at,
      };
      const note = serializeNote({ ...p.note, landingId: id, colonyId: st.colonyId });
      const data: JournalData = { landing, note, changes: [...changes] };
      this.sql.exec(
        `INSERT INTO ft_journal (landing_id, state, commit_sha, parent_sha, data, created_at, updated_at) VALUES (?, 'pushing', ?, ?, ?, ?, ?)`,
        id,
        commit,
        parent,
        JSON.stringify(data),
        at,
        at,
      );
      await setRef(g, STAGING_REF, commit);
      let outcome: PushOutcome;
      try {
        outcome = await this.authed((token) => pushRef(g, { url: st.trunk.remote, token, localRef: STAGING_REF, remoteRef: MAIN_REF, expectedOld: parent }));
      } catch (e) {
        // The outcome is unknown (network): ask the binding where main is; if that fails too, the journal row stays for recovery.
        let head: Sha | null;
        try {
          head = await this.remoteHead();
        } catch {
          throw new UnknownPush(`system commit push outcome unknown, journal kept for recovery: ${errorText(e)}`);
        }
        if (head !== commit) {
          this.dropJournal(id);
          throw new Error(`system commit push failed: ${errorText(e)}`);
        }
        outcome = { ok: true };
      }
      if (outcome.ok) {
        await this.finalize(data);
        return landing;
      }
      this.dropJournal(id);
      if (!outcome.stale || attempt >= MAX_REBUILDS) throw new Error(`system commit push rejected: ${outcome.detail}`);
      await this.resync();
    }
  }

  /** Record a pushed landing: index, lineage tables, trunk sha, and the journal moves to pending_note. */
  private async finalize(data: JournalData): Promise<void> {
    this.ctx.storage.transactionSync(() => this.finalizeRows(data));
    await setRef(this.repo(), MAIN_REF, data.landing.trunkSha);
  }

  /** The storage part of finalize (call inside a transaction; a cycle records all its landings in one). */
  private finalizeRows(data: JournalData): void {
    const { landing, note, changes } = data;
    for (const [path, c] of changes) {
      if (c.blob === null) this.sql.exec(`DELETE FROM ft_files WHERE path = ?`, path);
      else this.sql.exec(`INSERT OR REPLACE INTO ft_files (path, blob, size, mode) VALUES (?, ?, ?, ?)`, path, c.blob, c.size, c.mode);
    }
    const seq = this.sql
      .exec<{ seq: number }>(
        `INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES (?, ?, ?, ?, ?) RETURNING seq`,
        landing.id,
        landing.trunkSha,
        landing.parentSha,
        landing.at,
        JSON.stringify(landing),
      )
      .one().seq;
    for (const [path, c] of changes) {
      this.sql.exec(
        `INSERT OR REPLACE INTO ft_landing_paths (path, seq, landing_id, before_blob, after_blob) VALUES (?, ?, ?, ?, ?)`,
        path,
        seq,
        landing.id,
        c.before,
        c.blob,
      );
    }
    this.sql.exec(`INSERT OR REPLACE INTO ft_notes (landing_id, commit_sha, note) VALUES (?, ?, ?)`, landing.id, landing.trunkSha, note);
    for (const pid of landing.proposalIds) this.sql.exec(`INSERT OR REPLACE INTO ft_landed (proposal_id, landing_id) VALUES (?, ?)`, pid, landing.id);
    this.setMeta("trunk_sha", landing.trunkSha);
    this.sql.exec(`UPDATE ft_journal SET state = 'pending_note', updated_at = ? WHERE landing_id = ?`, Date.now(), landing.id);
  }

  /**
   * Settle landings whose trunk push outcome was never recorded (the object was evicted
   * mid-push, or the push outcome could not be learned): finalize, in chain order, those whose
   * commit reached main, and drop the rest. A cycle's landings are one chain, so they reach
   * main together or not at all.
   */
  private async recoverJournal(): Promise<void> {
    const rows = this.sql
      .exec<{ landing_id: string; commit_sha: string; data: string }>(`SELECT landing_id, commit_sha, data FROM ft_journal WHERE state = 'pushing' ORDER BY created_at, rowid`)
      .toArray();
    if (rows.length === 0) return;
    const st = this.state();
    const recent = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (r) => r.log({ ref: "main", limit: Math.min(500, rows.length + 50) }));
    const onMain = new Set(recent.map((c) => c.hash));
    const landed: JournalData[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        if (!onMain.has(row.commit_sha)) {
          this.dropJournal(row.landing_id);
          continue;
        }
        const data = JSON.parse(row.data) as JournalData;
        this.finalizeRows(data);
        landed.push(data);
      }
    });
    const tip = landed[landed.length - 1];
    if (tip) await setRef(this.repo(), MAIN_REF, tip.landing.trunkSha);
  }

  private dropJournal(landingId: Id): void {
    this.sql.exec(`DELETE FROM ft_journal WHERE landing_id = ?`, landingId);
  }

  /** Start the notes flush, with the alarm armed as the safety net in case this object is evicted first. */
  private async notesSoon(): Promise<void> {
    if (this.pendingNotes() === 0) return;
    await this.armAlarm(NOTES_RETRY_MS);
    void this.notesFlush().catch(() => undefined);
  }

  /**
   * Single-flight notes flush. It runs beside the trunk cycles (another ref, never two notes
   * pushes at once); notes that arrive while it runs get one more round before it settles.
   */
  private notesFlush(): Promise<{ pending: number }> {
    if (this.notesRun) {
      this.notesAgain = true;
      return this.notesRun;
    }
    const run = (async () => {
      try {
        let res: { pending: number; failed?: boolean };
        do {
          this.notesAgain = false;
          res = await this.flushNotesNow();
        } while (this.notesAgain && !res.failed);
        return { pending: res.pending };
      } finally {
        this.notesRun = null;
      }
    })();
    this.notesRun = run;
    return run;
  }

  /**
   * Push refs/notes/firetrident with compare-and-swap against the last known remote tip, after
   * adding every pending landing's note locally in ONE notes commit. On a moved remote notes
   * ref, rebuilds the pending notes on top of it once. A journal row is deleted only after its
   * note reached the remote, so no note is lost.
   */
  private async flushNotesNow(): Promise<{ pending: number; failed?: boolean }> {
    const pending = this.sql
      .exec<{ landing_id: string; commit_sha: string; note: string | null }>(
        `SELECT j.landing_id AS landing_id, j.commit_sha AS commit_sha, n.note AS note FROM ft_journal j
           LEFT JOIN ft_notes n ON n.landing_id = j.landing_id
         WHERE j.state = 'pending_note' ORDER BY j.created_at, j.rowid`,
      )
      .toArray();
    if (pending.length === 0) return { pending: 0 };
    const st = this.state();
    const g = this.repo();
    const notes = pending.filter((r) => r.note !== null).map((r) => ({ oid: r.commit_sha, note: r.note! }));
    try {
      const before = await resolveLocal(g, NOTES_REF);
      const added = await addNotes(g, { ref: NOTES_REF, notes, at: Date.now(), entriesByCommit: this.notesTrees, trees: this.notesSubtrees });
      const expected = this.meta("notes_tip");
      const regular = (): Promise<PushOutcome> =>
        this.authed((token) => pushRef(g, { url: st.trunk.remote, token, localRef: NOTES_REF, remoteRef: NOTES_REF, expectedOld: expected }));
      let res: PushOutcome;
      if (added.tip !== null && added.objects.length > 0 && before === expected) {
        // Only this flush's notes commit is new to the remote: push exactly its objects (push.ts).
        try {
          res = await this.authed((token) => pushPack(g, { url: st.trunk.remote, token, ref: NOTES_REF, oldOid: expected, newOid: added.tip!, oids: added.objects }));
          if (!res.ok && !res.stale) res = await regular();
        } catch (e) {
          console.error(`direct notes push failed (${errorText(e)}); using the regular push`);
          res = await regular();
        }
      } else {
        res = await regular();
      }
      if (!res.ok && res.stale) {
        const local = await resolveLocal(g, NOTES_REF);
        const remote = await this.authed((token) => fetchRef(g, { url: st.trunk.remote, token, ref: NOTES_REF }));
        if (remote !== null && remote === local) {
          res = { ok: true };
        } else {
          if (remote !== null) await setRef(g, NOTES_REF, remote);
          else await deleteLocalRef(g, NOTES_REF);
          await addNotes(g, { ref: NOTES_REF, notes, at: Date.now(), entriesByCommit: this.notesTrees, trees: this.notesSubtrees });
          res = await this.authed((token) => pushRef(g, { url: st.trunk.remote, token, localRef: NOTES_REF, remoteRef: NOTES_REF, expectedOld: remote }));
        }
      }
      if (!res.ok) throw new Error(`notes push rejected: ${res.detail}`);
      const tip = await resolveLocal(g, NOTES_REF);
      this.ctx.storage.transactionSync(() => {
        if (tip !== null) this.setMeta("notes_tip", tip);
        for (const row of pending) this.sql.exec(`DELETE FROM ft_journal WHERE landing_id = ? AND state = 'pending_note'`, row.landing_id);
      });
      return { pending: this.pendingNotes() };
    } catch (e) {
      console.error(`notes push for ${st.colonyId} failed: ${errorText(e)}`);
      await this.armAlarm(NOTES_RETRY_MS);
      return { pending: pending.length, failed: true };
    }
  }

  /** Make sure an alarm fires within `delayMs`. */
  private async armAlarm(delayMs: number): Promise<void> {
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // -------------------------------------------------------------------------
  // Lineage context
  // -------------------------------------------------------------------------

  private async lineageInfo(proposals: Proposal[], ctx: LandContext, colonyId: Id): Promise<{ titles: Record<Id, string>; intents: Map<Id, IntentInfo>; agents: Map<Id, AgentLite> }> {
    for (const [id, i] of Object.entries(ctx.intents ?? {})) this.intentCache.set(id, { title: i.title, why: i.why ?? "", ruleId: i.ruleId, parentId: i.parentId });
    for (const [id, a] of Object.entries(ctx.agents ?? {})) this.agentCache.set(id, { kind: a.kind, model: a.model });
    const missing = proposals.some((p) => !this.intentCache.has(p.intentId) || !this.agentCache.has(p.agentId));
    if (missing) await this.loadColonyContext(colonyId);
    const intents = new Map<Id, IntentInfo>();
    const agents = new Map<Id, AgentLite>();
    const titles: Record<Id, string> = {};
    for (const p of proposals) {
      const i = this.intentCache.get(p.intentId) ?? { title: p.declared?.summary || p.intentId, why: "" };
      intents.set(p.intentId, i);
      titles[p.intentId] = i.title;
      const a = this.agentCache.get(p.agentId);
      if (a) agents.set(p.agentId, a);
    }
    return { titles, intents, agents };
  }

  /** Best effort: fill the intent/agent caches from the colony snapshot (at most every 5 s). */
  private async loadColonyContext(colonyId: Id): Promise<void> {
    const ns = this.env.COLONY as DurableObjectNamespace | undefined;
    if (!ns || Date.now() - this.lastSnapshotAt < 5_000) return;
    this.lastSnapshotAt = Date.now();
    try {
      const stub = ns.get(ns.idFromName(colonyId)) as unknown as { snapshot(): Promise<ColonySnapshot> };
      const snap = await Promise.race([stub.snapshot(), sleep(2_500).then(() => null)]);
      if (!snap) return;
      for (const i of snap.intents ?? []) this.intentCache.set(i.id, { title: i.title, why: i.why, ruleId: i.ruleId, parentId: i.parentId });
      for (const a of snap.agents ?? []) this.agentCache.set(a.id, { kind: a.kind, model: a.model });
    } catch {
      // lineage falls back to proposal summaries
    }
  }

  // -------------------------------------------------------------------------
  // Co-change map
  // -------------------------------------------------------------------------

  private cochange(): CoChangeStore {
    if (!this.cochangeStore) this.cochangeStore = new CoChangeStore(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
    return this.cochangeStore;
  }

  /**
   * Mine trunk history into the co-change map once per trunk (retried 10 minutes after a failure).
   * It runs off the serial chain: it only reads through the binding, and its learning step is one
   * synchronous transaction on tables nothing else writes.
   */
  private cochangeSoon(): void {
    if (this.mining !== null) return;
    try {
      if (!this.cochange().shouldMine(Date.now())) return;
    } catch {
      return;
    }
    this.mining = this.mineCoChange()
      .catch((e: unknown) => {
        console.error(`co-change mining failed: ${errorText(e)}`);
        try {
          this.cochange().markMined(`failed: ${errorText(e).slice(0, 200)}`, Date.now());
        } catch {
          // erased meanwhile
        }
      })
      .finally(() => {
        this.mining = null;
      });
  }

  private async mineCoChange(): Promise<void> {
    const st = this.state();
    const t0 = Date.now();
    const mined = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (repo) => mineHistory(repo, st.trunkSha));
    // The trunk may have been replaced or erased while the history was read.
    const trunk = this.meta("trunk");
    if (trunk === null || (JSON.parse(trunk) as RepoRef).name !== st.trunk.name) return;
    const learned = this.cochange().learnHistory(mined, st.trunkSha, Date.now());
    console.log(
      JSON.stringify({ ft: "cochange-mined", colonyId: st.colonyId, head: st.trunkSha, listed: mined.listed, learned, skipped: mined.skipped, truncated: mined.truncated, reads: mined.reads, ms: Date.now() - t0 }),
    );
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /** Run `fn` after every earlier mutation finished; failures do not break the chain. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private state(): { colonyId: Id; trunk: RepoRef; trunkSha: Sha; regionDepth: number } {
    const colonyId = this.meta("colony_id");
    const trunk = this.meta("trunk");
    const trunkSha = this.meta("trunk_sha");
    if (colonyId === null || trunk === null || trunkSha === null) throw new Error("TrunkDO is not initialized; call init first");
    const depth = Number(this.meta("region_depth") ?? "1");
    return { colonyId, trunk: JSON.parse(trunk) as RepoRef, trunkSha, regionDepth: Number.isFinite(depth) && depth >= 1 ? depth : 1 };
  }

  private repo(): GitRepo {
    if (!this.gitRepo) {
      let dir = this.meta("dir");
      if (dir === null) {
        dir = "/trunk";
        this.setMeta("dir", dir);
      }
      this.gitRepo = { fs: durableFs(this.ctx.storage), dir, cache: {} };
    }
    return this.gitRepo;
  }

  private tokens(): TokenCache {
    if (!this.tokenCache) {
      this.tokenCache = new TokenCache(() => {
        const trunk = JSON.parse(this.meta("trunk") ?? "null") as RepoRef | null;
        if (!trunk) throw new Error("TrunkDO is not initialized; call init first");
        return mintToken(this.trunkBinding(trunk), trunk.name, "write", TOKEN_TTL_S);
      }, TOKEN_MARGIN_MS);
    }
    return this.tokenCache;
  }

  private token(): Promise<MintedToken> {
    return this.tokens().get();
  }

  /** Run a git network call with the trunk token; on 401/403 (expired or revoked) re-mint once and retry. */
  private async authed<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const t = await this.token();
    try {
      return await fn(t.token);
    } catch (e) {
      if (!isAuthError(e)) throw e;
      this.tokens().invalidate();
      return fn((await this.token()).token);
    }
  }

  private trunkBinding(trunk: RepoRef): Artifacts {
    return bindingFor(this.env, trunk.namespace || TRUNK_NAMESPACE) ?? this.env.ARTIFACTS;
  }

  private async remoteHead(): Promise<Sha | null> {
    const st = this.state();
    const log = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (r) => r.log({ ref: "main", limit: 1 }));
    return log[0]?.hash ?? null;
  }

  /** Blob of each path at `baseSha`, or null when the commit is unknown locally and remotely. */
  private async baseBlobMap(baseSha: Sha, paths: Path[], caches?: BaseCaches): Promise<Map<Path, Sha | null> | null> {
    const st = this.state();
    const out = new Map<Path, Sha | null>();
    if (baseSha === st.trunkSha) {
      for (const path of paths) out.set(path, this.indexBlob(path));
      return out;
    }
    if (!isSha(baseSha)) return null;
    const g = this.repo();
    let tree: string | null | undefined = this.commitTrees.get(baseSha) ?? caches?.commits.get(baseSha);
    if (tree === undefined) {
      tree = await commitTree(g, baseSha);
      if (tree !== null) this.commitTrees.set(baseSha, tree);
      else caches?.commits.set(baseSha, null);
    }
    if (tree !== null) {
      try {
        for (const path of paths) out.set(path, (await blobAt(g, tree, path, this.trees))?.blob ?? null);
        return out;
      } catch (e) {
        // A tree missing from the local store: read the commit through the binding instead.
        if ((e as { code?: string }).code !== "NotFoundError") throw e;
        out.clear();
      }
    }
    return withRepo(this.trunkBinding(st.trunk), st.trunk.name, async (repo) => {
      const commit = await repo.readCommit(baseSha).catch(() => null);
      if (!commit) return null;
      const trees = caches?.remote ?? new Map<string, ArtifactsTreeEntry[] | null>();
      for (const path of paths) out.set(path, await remoteBlobAt(repo, commit.treeHash, path, trees));
      return out;
    });
  }

  /**
   * Index into `history` (the path's landings, newest first) of the landing that last changed
   * line `line` of the current file: follow the line back through each landing's diff until
   * a landing added it. Null when the line came from outside the landings.
   */
  private async lineOwner(path: Path, line: number, history: Array<{ before_blob: string | null; after_blob: string | null }>): Promise<number | null> {
    let blob = this.indexBlob(path);
    if (blob === null) return null;
    const g = this.repo();
    const texts = new Map<string, string>();
    const text = async (oid: string): Promise<string> => {
      let t = texts.get(oid);
      if (t === undefined) {
        t = new TextDecoder().decode(await readLocalBlob(g, oid));
        texts.set(oid, t);
      }
      return t;
    };
    let idx = line - 1;
    for (let i = 0; i < history.length; i++) {
      const h = history[i]!;
      if (h.after_blob === null) return null;
      if (blob !== h.after_blob) {
        const m = mapLine(await text(h.after_blob), await text(blob), idx);
        if (m === null) return null;
        idx = m;
        blob = h.after_blob;
      }
      if (h.before_blob === null) return i;
      const older = mapLine(await text(h.before_blob), await text(h.after_blob), idx);
      if (older === null) return i;
      idx = older;
      blob = h.before_blob;
    }
    return null;
  }

  private landingById(id: Id): Landing | null {
    const row = this.sql.exec<{ data: string }>(`SELECT data FROM ft_landings WHERE id = ?`, id).toArray()[0];
    return row ? (JSON.parse(row.data) as Landing) : null;
  }

  private indexBlob(path: Path): Sha | null {
    return this.sql.exec<{ blob: string }>(`SELECT blob FROM ft_files WHERE path = ?`, path).toArray()[0]?.blob ?? null;
  }

  private indexMode(path: Path): string | null {
    return this.sql.exec<{ mode: string }>(`SELECT mode FROM ft_files WHERE path = ?`, path).toArray()[0]?.mode ?? null;
  }

  private files_(): Array<{ path: string; blob: string }> {
    return this.sql.exec<{ path: string; blob: string }>(`SELECT path, blob FROM ft_files`).toArray();
  }

  private fileCount(): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_files`).one().n;
  }

  private pendingNotes(): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_journal WHERE state = 'pending_note'`).one().n;
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>(`SELECT value FROM ft_meta WHERE key = ?`, key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)`, key, value);
  }

  /** Forget a previous trunk: clear the tables and move the local repo to a fresh directory. */
  private reset(): void {
    this.ctx.storage.transactionSync(() => {
      for (const t of ["ft_files", "ft_landings", "ft_landing_paths", "ft_notes", "ft_landed", "ft_journal", "ft_meta"]) this.sql.exec(`DELETE FROM ${t}`);
      this.cochange().reset();
      this.setMeta("dir", `/trunk-${Date.now().toString(36)}`);
    });
    this.gitRepo = null;
    this.tokenCache = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The lineage note for a landing. */
function buildNote(landing: Landing, proposals: Proposal[], info: { intents: Map<Id, IntentInfo>; agents: Map<Id, AgentLite> }, ctx: LandContext): LineageNote {
  return {
    schema: "firetrident.lineage/v1",
    landingId: landing.id,
    colonyId: landing.colonyId,
    proposals: proposals.map((p) => {
      const i = info.intents.get(p.intentId) ?? { title: p.intentId, why: "" };
      const a = info.agents.get(p.agentId);
      return {
        id: p.id,
        agentId: p.agentId,
        agentKind: a?.kind ?? "internal",
        model: a?.model,
        intent: { id: p.intentId, title: i.title, why: i.why, ruleId: i.ruleId, parentId: i.parentId },
        writeSet: p.writeSet,
        readSet: p.readSet,
        decisions: ctx.decisions?.[p.id] ?? [],
        evidence: p.evidence ?? { checks: [] },
      };
    }),
  };
}

/** Why a proposal is malformed, or null. */
function shapeProblem(p: Proposal): string | null {
  if (!p || typeof p.id !== "string" || p.id === "") return "proposal has no id";
  if (!p.workspace || typeof p.workspace.name !== "string" || typeof p.workspace.namespace !== "string") return "proposal has no workspace";
  if (!Array.isArray(p.writeSet) || !Array.isArray(p.readSet)) return "proposal has no write or read set";
  if (p.writeSet.length === 0) return "proposal writes nothing";
  const seen = new Map<Path, Sha | null>();
  for (const f of [...p.writeSet, ...p.readSet]) {
    const bad = pathProblem(f?.path);
    if (bad) return bad;
    if (f.blob !== null && !isSha(f.blob)) return `${f.path} has an invalid blob id`;
  }
  for (const f of p.writeSet) {
    if (seen.has(f.path) && seen.get(f.path) !== f.blob) return `${f.path} appears twice in the write set`;
    seen.set(f.path, f.blob);
  }
  return null;
}

/** Why a path is not a safe repository-relative POSIX path, or null. */
function pathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path === "") return "empty path";
  if (path.length > 4096) return "path too long";
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0")) return `invalid path ${JSON.stringify(path)}`;
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `invalid path ${JSON.stringify(path)}`;
    if (seg.toLowerCase() === ".git") return `path ${JSON.stringify(path)} touches .git`;
  }
  return null;
}

/** The stale paths of an OCC result, as reasons name them. */
function staleDetail(stale: OccResult["stale"]): string {
  return stale.map((s) => `${s.path} (expected ${s.expected ?? "absent"}, trunk has ${s.actual ?? "absent"})`).join(", ");
}

/** The lineage context of every batch in a cycle, merged. */
function mergeContexts(list: LandContext[]): Required<LandContext> {
  const out: Required<LandContext> = { intents: {}, agents: {}, decisions: {} };
  for (const c of list) {
    Object.assign(out.intents, c?.intents ?? {});
    Object.assign(out.agents, c?.agents ?? {});
    Object.assign(out.decisions, c?.decisions ?? {});
  }
  return out;
}

/** Distinct values, first occurrence first. */
function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
