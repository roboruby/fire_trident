import { DurableObject } from "cloudflare:workers";
import { blobId, landingMessage, mergeContentProblem, newId, regionOf, revalidationCandidate, revalidationEnabled, serializeNote, textMergeCandidate, validateProposal } from "@fire_trident/core";
import type { AgentKind, ColonyEvent, ColonySnapshot, Decision, ExportSurface, FileVersion, Id, Landing, LineageNote, NoteResolves, NotesVerification, OccResult, Path, Proposal, RepoRef, Revalidated, Sha, TextMerged, TrunkPublish } from "@fire_trident/core";
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
  isAncestor,
  isAuthError,
  isSha,
  listRemoteRefs,
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
import { maskNote } from "./mask.ts";
import { addNotes } from "./notes.ts";
import { sealNote, withNoteDigest } from "./digest.ts";
import { noteSigner, publishedKeys, withSignature } from "./signature.ts";
import { noteProvenance } from "./provenance.ts";
import { bindingSource, checkLandings, layered, localSource, summarize, verifyLimit } from "./verify.ts";
import { findLanding, landingOf, landingRow, storedNote, verifyOne } from "./landing-note.ts";
import { BoundedMap, applyTreeChangesDeferred, writePending, type PendingObject } from "./surgery.ts";
import { commitContent, objectId } from "./objects.ts";
import { pushPack } from "./push.ts";
import { CoChangeStore, mineHistory, type CoChangeStats, type Neighbor } from "./cochange.ts";
import { DerivedSet, trunkLog, type DerivedStatus, type TrunkLanding } from "./derived.ts";
import { HISTORY_LIMIT, PATH_HISTORY, pathHistory, pathHistoryDerived, type PathHistoryEntry } from "./history.ts";
import { IMPORTS_INDEX, IMPORT_LINKS_MAX, ImportIndex, deletionImports, importsDerived, type ImportLinks } from "./imports.ts";
import { importerWalk, type ImporterWalk, type ImporterWalkOptions, type TrunkFiles } from "./impact.ts";
import {
  deletionGuardEnabled,
  exportSurface,
  mergeBlobs,
  planCycle,
  resultsFor,
  surfaceBlobs,
  textMergeEnabled,
  uniqueProposals,
  type DeletionImports,
  type LandResult,
  type Outcome,
  type PlanProposal,
  type Returned,
  type TextMergeInput,
} from "./plan.ts";
import { mergeInsertionsEnabled } from "./plan.ts";
import { ExportMemo, exportGuardEnabled } from "./exportguard.ts";
import { exportImports } from "./imports.ts";
import type { ExportImports } from "./plan.ts";
import { runRevert, sqlRevertTrunk, type RevertResult, type RevertTrunk } from "./revert.ts";
import { durableFs } from "../artifacts/workspace.ts";
import { TRUNK_NAMESPACE, bindingFor } from "../artifacts/shards.ts";
import { noteAlternatives, type ContestAlternative } from "../decide/contest.ts";
import { noteUndoes, removedLineOwners, sqlLineageSource, type RemovedLinesAnswer, type RemovedLinesQuery } from "../decide/undone.ts";
import type { DirectionInfo } from "../colony/direction.ts";
import { ftError } from "../colony/errors.ts";
import { INLINE_FETCH_BYTES, isInlineChange } from "../colony/inline.ts";
import { noteResolves } from "../colony/resolver-merge.ts";
import { notePriority } from "../colony/priority.ts";
import { DIRECTION_TABLE, FENCE_WAIT_MS, directionReturns, fenceAnswer, mergeDirection, parseDirection, pushDelayMs, settlesWithin, type FenceAnswer } from "./direction.ts";
import { PUBLISH_BOUND, addedObjects, asyncPublishEnabled, publishBackoffMs, publishChain, settlePublish, withinBound, type PublishBound, type RecordedCommit } from "./publish.ts";
import { PROTECT_TABLE, keepProtect, protectReturns } from "./protect.ts";
import { keepHolds, mergeLocks } from "./mergelock.ts";
import { landingRange as rangeOfLandings, type LandingRange, type RangeQuery } from "../certify/range.ts";
import { FoldedIndex, cycleCollisions, structureProblem, submoduleProblems, type SubmoduleOutcome } from "./structure.ts";
import { readTreeCached } from "./surgery.ts";
import { foldPath } from "../decide/pathfold.ts";

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
/** Import-name revalidation: export surfaces (with top-level statements) kept by blob id, and what one cycle reads at most to compute new ones. */
const SURFACE_CACHE = 2_000;
const SURFACE_READS = 400;
const SURFACE_BYTES = 8 * 1024 * 1024;
/** Text merge: blobs one cycle reads at most for the texts its merges need, and bytes. */
const MERGE_READS = 400;
const MERGE_BYTES = 8 * 1024 * 1024;
/** Recent cycle summaries kept for stats(). */
const CYCLE_LOG_KEEP = 50;
const STAGING_REF = "refs/heads/ft-landing";
/** Local ref the publish loop's regular push sends from (asynchronous publishing). */
const PUBLISH_REF = "refs/heads/ft-publish";
const MAIN_REF = "refs/heads/main";
/** Moves only to trunk commits whose own tests passed (trunk certification). */
const CERTIFIED_REF = "refs/heads/certified";
const WHY_LIMIT = 50;
/** How long verifyNotes reuses the trunk repository's notes tip it read (ms). */
const NOTES_TIP_TTL_MS = 15_000;
/** How long a path history read spends catching the index up at most (ms); the rest waits for the next read. */
const PATH_HISTORY_MS = 250;

/**
 * Optional lineage context for `land`: intent and agent details for the commit message and
 * the lineage note, and the decisions that admitted each proposal (keyed by proposal id).
 * Missing entries are looked up from the colony's snapshot, then fall back to the proposal.
 */
export interface LandContext {
  /** `priority` and `requestedPriority`: only when an agent asked for more than its intent was granted (colony/priority.ts). */
  intents?: Record<Id, { title: string; why?: string; ruleId?: Id; parentId?: Id; priority?: number; requestedPriority?: number }>;
  /** `resumeKey`: an external agent holds an MCP resume key (it joined over MCP), for the note's provenance. */
  agents?: Record<Id, { kind: AgentKind; model?: string; resumeKey?: boolean }>;
  decisions?: Record<Id, Array<Pick<Decision, "kind" | "layer" | "p" | "action">>>;
  /** Contest mode: the other attempts at a winner's intent and why each lost (keyed by the winner's proposal id). */
  alternatives?: Record<Id, ContestAlternative[]>;
  /** Conflict resolver: what each change the platform's resolver wrote resolves (keyed by its proposal id; colony/resolver.ts). */
  resolves?: Record<Id, NoteResolves>;
}

type IntentInfo = { title: string; why: string; ruleId?: Id; parentId?: Id; priority?: number; requestedPriority?: number };
type AgentLite = { kind: AgentKind; model?: string; resumeKey?: boolean };
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

/** Text merge: the texts one cycle read for its merges (null: no text), and what reading them cost, kept across its rebuilds. */
interface MergeLoad {
  texts: Map<Sha, string | null>;
  reads: number;
  bytes: number;
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
  /** Proposals that landed over files they read that changed, their imported names still exported (assumption revalidation). */
  revalidated?: number;
  /** Proposals that landed with files they wrote on an older version merged line by line with the newer one (text merge). */
  merged?: number;
  /** Of those, the ones with a file merged by the insertion rule (FT_MERGE_INSERTIONS: both sides only inserted lines at one place). */
  insertions?: number;
  /**
   * The export guard (FT_EXPORT_GUARD), in cycles that change trunk script files: checks of changed files it left undone
   * (exports or importers it could not read for sure, or its input not ready in time). Its reads are timed as `ms.exports`.
   */
  exportsUncovered?: number;
  /** Oldest request's time in the queue before the cycle started. */
  waitMs: number;
  /**
   * Time per phase: recover, publishWait (asynchronous publishing, or commits left to publish), screen, pull, assumptions
   * (revalidation on), deletions (deletion guard on, cycles that delete files), merges (text merge on: reading texts),
   * plan, build, push (not with asynchronous publishing), finalize.
   */
  ms: Record<string, number>;
  /** Asynchronous publishing (FT_ASYNC_PUBLISH) as the cycle ended: the published head, and the landings recorded but not published and the age of the oldest. */
  publish?: { publishedSha: Sha | null; unpublished: number; lagMs: number };
  totalMs: number;
  error?: string;
}

/** A definitive problem with one proposal (it goes back to its agent). */
class ProposalProblem extends Error {}

/** A trunk push whose outcome could not be learned; its journal rows stay for recovery. */
class UnknownPush extends Error {}

/** A system commit file whose trunk blob is not the one the caller expected (a guarded revert raced a landing). */
class StaleSystemCommit extends Error {}

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
  /** Import index (trunk/imports.ts), created on its first read. */
  private importStore: ImportIndex | null = null;
  /** The derived indexes of the landing log and their cursors (trunk/derived.ts), created with the object. */
  private derivedStore: DerivedSet<TrunkLanding> | null = null;
  /** Import-name revalidation: the names each version of a file exports and its top-level statements, by blob id (immutable, so cached across cycles). */
  private readonly surfaces = new BoundedMap<Sha, ExportSurface | null>(SURFACE_CACHE);
  /** Export guard (FT_EXPORT_GUARD): the exports of versions it read, by blob id, and its pause after a stalled read. */
  private readonly exportMemo = new ExportMemo();
  /** Trunk's paths by folded form, for the case-collision check at landing (trunk/structure.ts); rebuilt when trunk moves. */
  private readonly foldedIndex = new FoldedIndex();
  /**
   * Asynchronous publishing (FT_ASYNC_PUBLISH, trunk/publish.ts): the publish attempt in flight (single-flight), the loop
   * that drives attempts beside the cycles and whether it should go round again, whether everything recorded before this
   * object started has been published, and the failures in a row with the latest one.
   */
  private publishing: Promise<number> | null = null;
  private publishDriver: Promise<void> | null = null;
  private publishWanted = false;
  private publishedSinceStart = false;
  private publishFailures = 0;
  private publishError: string | null = null;
  /** The bound on unpublished landings (tests shrink it). */
  private publishBound: PublishBound = PUBLISH_BOUND;
  /** Moves when this object's storage is erased: a publish attempt of an earlier epoch writes nothing more. */
  private epoch = 0;
  /** The trunk repository's notes tip as verifyNotes last read it (remoteNotesTip), and when. */
  private notesTipRead: { at: number; tip: Promise<Sha | null> } | null = null;

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
    // The direction fence (direction()): each intent's latest change of direction, read by every landing cycle.
    this.sql.exec(DIRECTION_TABLE);
    // Protected paths (trunk/protect.ts): the colony's protected globs, read by every landing cycle.
    this.sql.exec(PROTECT_TABLE);
    // Derived indexes (trunk/derived.ts): their tables are created here, outside any landing transaction.
    this.derivedSet();
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
   * The direction fence: the commit point of a change of direction. The colony calls it after a person
   * withdrew or amended intents (`intents`: their new direction) and it sent their changes in flight back
   * (`proposalIds`). The direction is recorded first (merged with any earlier record, trunk/direction.ts);
   * every landing cycle reads the record once before it builds, and a change whose direction is stale goes
   * back. Then the fence waits for the cycles that may have read the old direction (the serial chain as it
   * stands, at most FENCE_WAIT_MS), settles any push whose outcome was not recorded, and answers from the
   * landing records: each change that landed with its landing, and the ones it cannot vouch for yet
   * (`undetermined`). Every other change asked about never lands. The answer leaves only once the record
   * is durable (output gate).
   */
  async direction(p: { intents: Record<Id, DirectionInfo>; proposalIds: Id[] }): Promise<FenceAnswer> {
    this.state();
    const now = Date.now();
    const incoming: Array<[Id, DirectionInfo]> = [];
    for (const [id, x] of Object.entries(p?.intents ?? {})) {
      const info = parseDirection(x);
      if (id !== "" && info) incoming.push([id, info]);
    }
    if (incoming.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const [id, info] of incoming) {
          const prev = parseDirection(this.sql.exec<{ info: string | null }>(`SELECT info FROM ft_direction WHERE intent_id = ?`, id).toArray()[0]?.info);
          this.sql.exec(`INSERT OR REPLACE INTO ft_direction (intent_id, info, at) VALUES (?, ?, ?)`, id, JSON.stringify(mergeDirection(prev, info)), now);
        }
      });
    }
    const ids = [...new Set((Array.isArray(p?.proposalIds) ? p.proposalIds : []).filter((x): x is Id => typeof x === "string" && x !== ""))];
    if (ids.length === 0) return { landed: [], landings: [], undetermined: [] };
    // Every cycle that may have read the old direction is on the serial chain as it stands now; a later one reads the record.
    const settled = await settlesWithin(this.chain, FENCE_WAIT_MS);
    // A push of one of these changes whose outcome was not recorded (a later cycle's push never holds one): settle it now.
    const pending = this.pushingProposals();
    let open = pending;
    if (pending === null || ids.some((id) => pending.has(id))) {
      const recovery = this.serial(() => this.recoverJournal()).catch((e: unknown) => console.error(`direction fence: journal recovery failed: ${errorText(e)}`));
      await settlesWithin(recovery, Math.max(0, now + FENCE_WAIT_MS - Date.now()));
      open = this.pushingProposals();
    }
    return fenceAnswer(ids, this.landingsByProposal(ids), settled, open);
  }

  /**
   * Protected paths (trunk/protect.ts): the colony's protected globs, recorded the way a change of direction is. The
   * colony calls it when its globs change, with the changes it stopped (`proposalIds`). The record is kept when it is
   * newer than the writer's own; every later landing cycle reads it before it builds and sends back a change that writes
   * a path protected after a person last approved it. Then the answer for those changes, as direction() gives it: each
   * one a cycle that read the old record landed, with its landing, and the ones it cannot vouch for yet.
   */
  async protect(p: { record: unknown; proposalIds: Id[] }): Promise<FenceAnswer> {
    this.state();
    keepProtect(this.sql, p?.record, Date.now());
    return this.direction({ intents: {}, proposalIds: Array.isArray(p?.proposalIds) ? p.proposalIds : [] });
  }

  /**
   * Commit files to trunk as FireTrident itself (colony memory such as antibodies under
   * .firetrident/): one commit on current main, message plus an FT-Landing trailer, pushed with
   * compare-and-swap and rebuilt on a moved trunk. It is recorded like a landing with no proposals
   * (index, `why`, and `note` as its lineage note), so its history explains itself.
   */
  async systemCommit(p: { files: Array<{ path: Path; content: string | null; expect?: Sha | null }>; message: string; note: LineageNote & Record<string, unknown> }): Promise<Landing> {
    const landing = await this.serial(() => this.systemCommitNow(p));
    await this.notesSoon();
    return landing;
  }

  /**
   * Undo one landing as a new commit on current main (`ft revert`, a person's decision), through
   * the same serialized path as system commits. Guarded like a landing: every path the landing wrote
   * must still hold the blob it produced, or nothing changes and the answer names the paths that
   * moved and the latest landing that moved each (checked again inside the commit, so a landing cycle cannot
   * slip in between). A file the landing created would be deleted, so the revert is also refused
   * while other trunk files import it, naming them (also checked again inside the commit, reading
   * only the files that changed in between). `ref` is a landing id or a trunk commit (40 hex, or a
   * unique prefix of 7+). The steps are trunk/revert.ts: runRevert.
   */
  async revert(ref: string, p: { by: string; reason: string }): Promise<RevertResult> {
    this.state();
    return runRevert(this.revertTrunk(), ref, { by: p.by, reason: p.reason });
  }

  /**
   * Undo one proposal of a landing (`ft revert <colony> <prp_...>`): `revert` limited to the paths
   * that proposal wrote (the landing's recorded paths its lineage note names), with every guard on
   * them; the landing's other proposals stay. 404 when the proposal did not land in that landing. A
   * method of its own, so a trunk writer still on the previous class refuses the call (deploys reach
   * objects gradually) instead of undoing the whole landing.
   */
  async revertProposal(ref: string, p: { by: string; reason: string; proposal: Id }): Promise<RevertResult> {
    this.state();
    return runRevert(this.revertTrunk(), ref, { by: p.by, reason: p.reason, proposal: String(p.proposal ?? "") });
  }

  /** Trunk as a revert reads and writes it (trunk/revert.ts): these tables, local blobs, the serial chain, system commits. */
  private revertTrunk(): RevertTrunk {
    return sqlRevertTrunk(this.sql, {
      landing: (ref) => this.landingByRef(ref),
      read: (blob) => this.blobBytes(blob),
      serial: (fn) => this.serial(fn),
      commitNow: async (commit) => {
        try {
          return { landing: await this.systemCommitNow(commit) };
        } catch (e) {
          if (e instanceof StaleSystemCommit) return { stale: e.message };
          throw e;
        }
      },
      notesSoon: () => this.notesSoon(),
    });
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

  /**
   * Goal conflicts (FT_GOAL_CONFLICT; decide/undone.ts): for each file a change modifies or deletes, the recent landings
   * that wrote the lines it removes from the version at its base, with how many of their lines that version holds and
   * the intent each wrote them for. Read only, like `why` per line: the landing log, lineage notes and blobs; bounded.
   */
  async removedLineOwners(q: RemovedLinesQuery): Promise<RemovedLinesAnswer> {
    this.state();
    return removedLineOwners(sqlLineageSource(this.sql, (blob) => this.blobBytes(blob)), q);
  }

  /** The most recent landings, newest first (default 50). */
  async landings(limit = 50): Promise<Landing[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    return this.sql
      .exec<{ data: string }>(`SELECT data FROM ft_landings ORDER BY seq DESC LIMIT ?`, n)
      .toArray()
      .map((r) => JSON.parse(r.data) as Landing);
  }

  /**
   * The newest `limit` landings' lineage notes on the trunk repository (default 20, at most 200), each checked against
   * the FT-Note trailer its commit carries (trunk/digest.ts, trunk/verify.ts): intact, altered, missing, pending (its push
   * is still due), no-trailer (landed before the trailer) or unreadable. `ownCopy` says whether this object's own copy
   * of a note still matches its trailer. Read only: it resolves refs/notes/firetrident on the trunk repository (at most
   * every 15 s) and reads notes locally when it wrote them, through the binding otherwise.
   */
  async verifyNotes(limit?: number): Promise<NotesVerification> {
    const st = this.state();
    const rows = this.sql
      .exec<{ id: string; trunk_sha: string; at: number; note: string | null }>(
        `SELECT l.id AS id, l.trunk_sha AS trunk_sha, l.at AS at, n.note AS note FROM ft_landings l LEFT JOIN ft_notes n ON n.landing_id = l.id ORDER BY l.seq DESC LIMIT ?`,
        verifyLimit(limit),
      )
      .toArray();
    const due = new Set(
      this.sql
        .exec<{ landing_id: string }>(`SELECT landing_id FROM ft_journal WHERE landing_id IN (SELECT value FROM json_each(?))`, JSON.stringify(rows.map((r) => r.id)))
        .toArray()
        .map((r) => r.landing_id),
    );
    let tip: Sha | null;
    try {
      tip = await this.remoteNotesTip();
    } catch (e) {
      throw ftError(502, `the trunk repository's notes ref could not be read: ${errorText(e)}`);
    }
    // The binding's handle is opened only if a commit or note is not in the local repository.
    const opened: { repo?: Promise<ArtifactsRepo> } = {};
    const remote = bindingSource(() => (opened.repo ??= this.trunkBinding(st.trunk).get(st.trunk.name)));
    try {
      const notes = await checkLandings(
        rows.map((r) => ({ landingId: r.id, trunkSha: r.trunk_sha, at: r.at, note: r.note, waiting: due.has(r.id) })),
        { src: layered(localSource(this.repo()), remote), tip, keys: await publishedKeys(this.env.FT_NOTE_KEY) },
      );
      return summarize(st.colonyId, tip, notes, Date.now());
    } finally {
      if (opened.repo) dispose(await opened.repo.catch(() => null));
    }
  }

  /**
   * One landing's lineage note checked as verifyNotes checks the newest (trunk/landing-note.ts): `ref` is a landing id or
   * the trunk commit it produced (40 hex, or a unique prefix of 7+); null when no landing matches. A method of its own, so
   * a trunk writer still on older code refuses the call instead of answering for the newest landings. Read only.
   */
  async verifyLanding(ref: string): Promise<NotesVerification | null> {
    const st = this.state();
    const found = findLanding(this.sql, String(ref ?? ""));
    if (!found) return null;
    const opened: { repo?: Promise<ArtifactsRepo> } = {};
    const remote = bindingSource(() => (opened.repo ??= this.trunkBinding(st.trunk).get(st.trunk.name)));
    try {
      return await verifyOne(landingRow(this.sql, found), { colonyId: st.colonyId, tip: () => this.remoteNotesTip(), src: layered(localSource(this.repo()), remote), keys: await publishedKeys(this.env.FT_NOTE_KEY) });
    } finally {
      if (opened.repo) dispose(await opened.repo.catch(() => null));
    }
  }

  /** A landing (by id or trunk commit, as verifyLanding takes it) with the writer's copy of its lineage note, null when it has none (the public diff route, api/landing.ts). Read only. */
  async landingNote(ref: string): Promise<{ landing: Landing; note: LineageNote | null } | null> {
    const st = this.state();
    const found = findLanding(this.sql, String(ref ?? ""));
    return found ? { landing: landingOf(found, st.colonyId), note: storedNote(this.sql, found.id) } : null;
  }

  /**
   * Trunk certification's view of trunk: the current commit, the landing that produced it, and the
   * files a test run may load (.ts, .js, .mjs, .json; dependency and dot directories left out). One
   * synchronous read, so the listing is exactly that commit's; contents are then read by blob id.
   */
  async certifySnapshot(p: { maxFiles?: number } = {}): Promise<{ trunkSha: Sha; landingId: Id | null; files: Array<{ path: Path; size: number; blob: Sha }>; truncated: boolean }> {
    const st = this.state();
    const max = Math.max(1, Math.min(20_000, Math.floor(p?.maxFiles ?? 10_000)));
    const files = this.sql
      .exec<{ path: string; size: number; blob: string }>(
        `SELECT path, size, blob FROM ft_files
           WHERE (path LIKE '%.ts' OR path LIKE '%.js' OR path LIKE '%.mjs' OR path LIKE '%.json')
             AND path NOT LIKE 'node_modules/%' AND path NOT LIKE '%/node_modules/%' AND path NOT LIKE '.%' AND path NOT LIKE '%/.%'
           ORDER BY path LIMIT ?`,
        max + 1,
      )
      .toArray();
    const newest = this.sql.exec<{ id: string; trunk_sha: string }>(`SELECT id, trunk_sha FROM ft_landings ORDER BY seq DESC LIMIT 1`).toArray()[0];
    let landingId = newest && newest.trunk_sha === st.trunkSha ? newest.id : null;
    if (newest && landingId === null) landingId = this.sql.exec<{ id: string }>(`SELECT id FROM ft_landings WHERE trunk_sha = ? LIMIT 1`, st.trunkSha).toArray()[0]?.id ?? null;
    return { trunkSha: st.trunkSha, landingId, files: files.slice(0, max), truncated: files.length > max };
  }

  /** Texts of blobs by id (UTF-8; null when unreadable), for trunk certification: at most 500 blobs and 8 MB per call. */
  async readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>> {
    const st = this.state();
    const want = [...new Set((Array.isArray(blobs) ? blobs : []).filter((b) => isSha(b)))].slice(0, 500);
    const out: Record<Sha, string | null> = {};
    const decoder = new TextDecoder();
    let bytes = 0;
    for (const blob of want) {
      if (bytes > 8 * 1024 * 1024) {
        out[blob] = null;
        continue;
      }
      try {
        const data = await readLocalBlob(this.repo(), blob);
        bytes += data.length;
        out[blob] = decoder.decode(data);
      } catch {
        const remote = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (r) => r.readBlob(blob)).catch(() => null);
        const text = remote ? await remote.text() : null;
        if (text !== null) bytes += text.length;
        out[blob] = text;
      }
    }
    return out;
  }

  /**
   * Trunk certification's first red search (certify/bisect.ts): the landings after commit `from` up to commit `to`,
   * oldest first, from the landing log, while each one's parent is the one before it (certify/range.ts); or why there
   * is no such range. Read only.
   */
  async landingRange(q: RangeQuery): Promise<LandingRange> {
    this.state();
    return rangeOfLandings(this.sql, q);
  }

  /**
   * Add fields to a landing's lineage note after it landed (trunk certification adds its result).
   * The note is rewritten here and goes out with the next notes flush, which runs beside the
   * landing cycles; the landing's own commit and push are untouched. False when the landing has no note.
   */
  async annotate(landingId: Id, patch: Record<string, unknown>): Promise<boolean> {
    this.state();
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
    // A flush in progress may hold this landing's pending row with the old text and delete it once
    // pushed: wait for it, then rewrite the note and mark it pending in one synchronous step.
    while (this.notesRun) await this.notesRun.catch(() => undefined);
    const row = this.sql.exec<{ note: string; commit_sha: string }>(`SELECT note, commit_sha FROM ft_notes WHERE landing_id = ?`, landingId).toArray()[0];
    if (!row) return false;
    let note: LineageNote & Record<string, unknown>;
    try {
      note = JSON.parse(row.note) as LineageNote & Record<string, unknown>;
    } catch {
      return false;
    }
    const text = serializeNote({ ...note, ...patch } as LineageNote);
    if (text === row.note) return true;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE ft_notes SET note = ? WHERE landing_id = ?`, text, landingId);
      // A landing whose note already reached the remote gets a pending row again; one still pending keeps its own.
      this.sql.exec(
        `INSERT OR IGNORE INTO ft_journal (landing_id, state, commit_sha, parent_sha, data, created_at, updated_at) VALUES (?, 'pending_note', ?, '', '{}', ?, ?)`,
        landingId,
        row.commit_sha,
        now,
        now,
      );
    });
    await this.notesSoon();
    return true;
  }

  /**
   * Point the trunk repository's `certified` branch at a commit whose tests passed (trunk
   * certification calls this on every green verdict). Main moves on every landing; `certified` only
   * moves to commits the project's own tests passed, so any git client can check out the last green
   * trunk. Forward only: a commit that does not descend from the current certified one is ignored.
   * The remote update is a compare-and-swap; a remote that moved without being recorded here (a push
   * that landed but whose answer was lost) is followed when it is behind. False when nothing moved.
   * `certified` moves only to commits on the trunk repository: with asynchronous publishing, a recorded
   * commit not published yet is kept as the branch's next move (the newest wins), and the publish loop
   * moves the branch once that commit is published.
   */
  async markCertified(sha: Sha): Promise<boolean> {
    this.state();
    if (!isSha(sha)) return false;
    const current = this.meta("certified_sha");
    if (current === sha) return true;
    if (this.isUnpublished(sha)) {
      this.deferCertified(sha);
      return false;
    }
    const g = this.repo();
    if (current !== null && (await isAncestor(g, current, sha)) === false) return false;
    await setRef(g, CERTIFIED_REF, sha);
    const push = (expectedOld: string | null): Promise<PushOutcome> => this.pushTrunkRef(CERTIFIED_REF, expectedOld);
    let out = await push(current);
    if (!out.ok && out.stale && out.remoteOid !== current) {
      const remote = out.remoteOid;
      if (remote === sha) out = { ok: true };
      else if (remote === null || (await isAncestor(g, remote, sha)) !== false) out = await push(remote);
    }
    if (!out.ok) {
      console.warn(`certified ref not moved to ${sha.slice(0, 7)}: ${out.detail}`);
      return false;
    }
    this.setMeta("certified_sha", sha);
    return true;
  }

  /**
   * Asynchronous publishing (FT_ASYNC_PUBLISH): the newest commit on the trunk repository's main (leases start from it;
   * `certified` and the lineage notes follow it), the newest recorded commit, and how far publishing lags. With nothing
   * waiting, both heads are the same. Starts the publish loop when commits wait and it is not running (after a restart).
   */
  async publishState(): Promise<TrunkPublish> {
    const st = this.state();
    const lag = this.publishLag();
    if (lag.unpublished > 0 && this.publishDriver === null) this.publishSoon();
    const at = Number(this.meta("published_at") ?? "0");
    return {
      on: this.asyncPublish(st.colonyId),
      publishedSha: this.publishedHead() ?? st.trunkSha,
      trunkSha: st.trunkSha,
      unpublished: lag.unpublished,
      lagMs: lag.oldestAt === null ? 0 : Math.max(0, Date.now() - lag.oldestAt),
      running: this.publishing !== null,
      failures: this.publishFailures,
      ...(this.publishError !== null ? { lastError: this.publishError } : {}),
      ...(Number.isFinite(at) && at > 0 ? { publishedAt: at } : {}),
    };
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

  /** Operational counters (for status pages and tests), with the group-commit queue, recent cycles and publishing. */
  async stats(): Promise<{
    trunkSha: Sha | null;
    files: number;
    landings: number;
    pendingNotes: number;
    notesTip: Sha | null;
    queued: { batches: number; proposals: number };
    cycles: number;
    recentCycles: CycleStat[];
    /** The newest commit on the trunk repository (the recorded head when nothing waits to be published), and the publish queue. */
    publishedSha: Sha | null;
    unpublished: number;
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
      publishedSha: this.publishedHead(),
      unpublished: this.publishLag().unpublished,
    };
  }

  /**
   * Erase this object (colony deletion): cancel the alarm and delete all storage, then replay
   * the DDL of its own `ft_` tables so a later init() starts from empty tables. The git storage
   * is rebuilt by the next repo().
   */
  async destroy(): Promise<{ cleared: true }> {
    // A publish in flight belongs to the erased trunk: from here on it writes nothing.
    this.stopPublishing();
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

  /**
   * For each path, its direct relative imports and the trunk script files that import it (each
   * sorted, at most `max`), from the import index: built from the trunk index on the first call and
   * brought up to date with the landings since before each answer. Paths with neither are left out.
   * Import-aware take() reads it (ColonyDO, FT_IMPORT_WEIGHT); the deletion guard (FT_DELETION_GUARD)
   * also builds and reads the index, in cycles that delete files.
   */
  async importLinks(paths: Path[], max = IMPORT_LINKS_MAX): Promise<Record<Path, ImportLinks>> {
    const st = this.state();
    const index = this.importIndex();
    // Its cursor first (a version change forgets the index; a landing the hook left behind is marked now).
    this.derivedSet().catchUp(IMPORTS_INDEX);
    try {
      await index.sync({ head: () => this.meta("trunk_sha"), read: (blob) => this.blobBytes(blob), label: st.colonyId });
    } catch (e) {
      // Answer from the index as it stands; the next call syncs again.
      console.error(`import index sync failed: ${errorText(e)}`);
    }
    return index.links(Array.isArray(paths) ? paths : [], max);
  }

  /**
   * What a change to these paths reaches through imports (trunk/impact.ts): the trunk files that import them, up to three
   * levels and IMPACT_FILES files, nearest first, each with the file it imports on the way. Directories and globs name
   * the trunk files they cover. The import index is brought up to date first (built on first use) for IMPACT_SYNC_MS at
   * most; past that the answer comes from the index as it stands and says so. A read only (the colony's impact report).
   */
  async importerWalk(paths: Path[], opts: ImporterWalkOptions = {}): Promise<ImporterWalk> {
    const st = this.state();
    // Its cursor first (a version change forgets the index; a landing the hook left behind is marked now).
    this.derivedSet().catchUp(IMPORTS_INDEX);
    const source = { head: () => this.meta("trunk_sha"), read: (blob: Sha) => this.blobBytes(blob), label: st.colonyId };
    const files: TrunkFiles = {
      has: (path) => this.indexBlob(path) !== null,
      range: (from, to, limit) => this.sql.exec<{ path: string }>(`SELECT path FROM ft_files WHERE path >= ? AND path < ? ORDER BY path LIMIT ?`, from, to, limit).toArray().map((r) => r.path),
    };
    return importerWalk(this.importIndex(), source, files, Array.isArray(paths) ? paths : [], opts ?? {});
  }

  /**
   * The landings that changed `path`, newest first (at most `limit`, default 20, at most 200), each
   * with the proposal that wrote it, its intent and agent, and the intent's title, without reading
   * lineage notes: path history (trunk/history.ts), a lazy derived index that first catches up from
   * its cursor, for at most PATH_HISTORY_MS. `behind` counts the landings it has not reached yet
   * (the newest ones: ask again).
   */
  async pathHistory(path: Path, limit = HISTORY_LIMIT): Promise<{ entries: PathHistoryEntry[]; behind: number }> {
    this.state();
    const budget = { landings: 10_000, ms: PATH_HISTORY_MS };
    let caught = this.derivedSet().catchUp(PATH_HISTORY, budget);
    // A new version was just forgotten: build it now.
    if (caught.rebuilt) caught = this.derivedSet().catchUp(PATH_HISTORY, budget);
    return { entries: typeof path === "string" && path !== "" ? pathHistory(this.sql, path, limit) : [], behind: caught.behind };
  }

  /** Each derived index of the landing log (trunk/derived.ts): its mode, version and cursor, and how many landings it has not applied yet. */
  async derivedStats(): Promise<DerivedStatus[]> {
    return this.derivedSet().status();
  }

  /** Publishes recorded commits left waiting (asynchronous publishing; the loop's safety net), then retries a failed notes push. */
  async alarm(): Promise<void> {
    if (this.meta("trunk_sha") === null) return;
    if (this.hasBacklog()) {
      try {
        await this.publishNow();
        this.publishedSinceStart = true;
      } catch (e) {
        console.error(`publish from the alarm failed: ${errorText(e)}`);
        this.publishSoon();
      }
    }
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
      // Commits recorded and not yet published go out before catching up with the remote (resync builds on it).
      if (this.hasBacklog()) await this.publishNow();
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
    // Recorded commits the remote does not have yet would be dropped from the index: they are published first.
    if (this.hasBacklog()) throw new Error("trunk has recorded commits that are not published yet; publish them before catching up with the remote");
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
      // Asynchronous publishing: the publish queue and its lag as the cycle ended, and the cycle's wait for publishing.
      ...(stat.publish
        ? [metric("unpublished", stat.publish.unpublished), metric("publishLagMs", stat.publish.lagMs), metric("publishWaitMs", stat.ms.publishWait ?? 0)]
        : []),
      // Text merge: changes that landed with files merged line by line (only cycles that merged one).
      ...(stat.merged ? [metric("merged", stat.merged)] : []),
      // The insertion rule (FT_MERGE_INSERTIONS): those merged by it (only cycles where it merged one).
      ...(stat.insertions ? [metric("mergedInsertions", stat.insertions)] : []),
      // The export guard (FT_EXPORT_GUARD): checks of changed script files it left undone (only cycles that left one).
      ...(stat.exportsUncovered ? [metric("exportsUncovered", stat.exportsUncovered)] : []),
    ];
    const stub = ns.get(ns.idFromName(colonyId)) as unknown as { emit(e: unknown[]): Promise<unknown> };
    await stub.emit(events);
  }

  /**
   * Publish one publish push on the colony's live feed as `trunk.publish.*` metric events (same `at`): how long it took,
   * the landings and objects it carried, how long the oldest of them waited, what is left, and the failures before it.
   */
  private async emitPublish(p: { at: number; ms: number; landings: number; objects: number; lagMs: number; left: number; failures: number }): Promise<void> {
    const colonyId = this.meta("colony_id");
    const ns = (this.env as unknown as { COLONY?: DurableObjectNamespace } | undefined)?.COLONY;
    if (colonyId === null || !ns) return;
    const metric = (name: string, value: number) => ({ t: "metric" as const, at: p.at, name: `trunk.publish.${name}`, value });
    const stub = ns.get(ns.idFromName(colonyId)) as unknown as { emit(e: unknown[]): Promise<unknown> };
    await stub.emit([
      metric("ms", p.ms),
      metric("landings", p.landings),
      metric("objects", p.objects),
      metric("lagMs", p.lagMs),
      metric("unpublished", p.left),
      metric("failures", p.failures),
    ]);
  }

  /**
   * Publish a `revalidated` event on the colony's live feed for each landed proposal that landed over
   * files it read that changed (assumption revalidation): which files, and the names that held.
   */
  private async emitRevalidated(landed: Proposal[], revalidated: Map<Id, Revalidated[]>): Promise<void> {
    const colonyId = this.meta("colony_id");
    const ns = this.env.COLONY as DurableObjectNamespace | undefined;
    if (colonyId === null || !ns) return;
    const at = Date.now();
    const events: ColonyEvent[] = [];
    for (const p of landed) {
      const r = revalidated.get(p.id);
      if (!r) continue;
      events.push({ t: "revalidated", at, proposalId: p.id, intentId: p.intentId, paths: unique(r.map((x) => x.path)), names: unique(r.flatMap((x) => x.names)).sort() });
    }
    if (events.length === 0) return;
    const stub = ns.get(ns.idFromName(colonyId)) as unknown as { emit(e: unknown[]): Promise<unknown> };
    await stub.emit(events);
  }

  /**
   * Import-name revalidation: the export surface and top-level statements of every version a stale read
   * of this cycle could land on, and of the version it read (the growth check compares the two). For each
   * file a proposal read and imports names from, that is trunk's blob and each new blob a proposal of the
   * cycle writes there (pulled already), then the blob it read (in trunk history). Read from the local
   * store and cached by blob id; at most SURFACE_READS new blobs and SURFACE_BYTES per cycle. A blob that
   * cannot be read maps to null, and its readers go back as stale.
   */
  private async assumptionSurfaces(proposals: Proposal[]): Promise<Map<Sha, ExportSurface | null>> {
    const out = new Map<Sha, ExportSurface | null>();
    let reads = 0;
    let bytes = 0;
    for (const { blob, path } of surfaceBlobs(proposals, (p) => this.indexBlob(p))) {
      const hit = this.surfaces.get(blob);
      if (hit !== undefined) {
        out.set(blob, hit);
        continue;
      }
      if (reads >= SURFACE_READS || bytes > SURFACE_BYTES) {
        out.set(blob, null);
        continue;
      }
      reads++;
      const data = await this.blobBytes(blob).catch(() => null);
      if (data === null) {
        out.set(blob, null); // not cached: a read that failed now may work next cycle
        continue;
      }
      bytes += data.length;
      const surface = exportSurface(data, path);
      this.surfaces.set(blob, surface);
      out.set(blob, surface);
    }
    return out;
  }

  /**
   * Text merge (FT_TEXT_MERGE): the texts a cycle's merges may read (plan.ts mergeBlobs: for each file a change writes
   * on a base that trunk has moved past, or that more than one change of the cycle writes, its base, trunk and written
   * versions). The pull step wrote the changes' blobs to the local store and base blobs are in trunk history (blobBytes
   * reads the trunk repository for one the local store lacks). `load` keeps them for the whole cycle, so a rebuilt plan
   * reads only what is new, at most MERGE_READS blobs and MERGE_BYTES in all. A blob larger than 512 KB, binary, not
   * UTF-8 or unreadable has no text, and so does one past the budget: a change that needs it goes back as stale.
   */
  private async mergeTexts(entries: PlanProposal[], load: MergeLoad): Promise<TextMergeInput> {
    // Fatal and BOM-keeping, so a text encodes back to exactly the bytes it was read from.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (const blob of mergeBlobs(entries, (path) => this.indexBlob(path))) {
      if (load.texts.has(blob)) continue;
      if (load.reads >= MERGE_READS || load.bytes > MERGE_BYTES) break;
      load.reads++;
      const data = await this.blobBytes(blob).catch(() => null);
      let text: string | null = null;
      if (data !== null) {
        load.bytes += data.length;
        if (mergeContentProblem([data]) === null) {
          try {
            text = decoder.decode(data);
          } catch {
            text = null;
          }
        }
      }
      load.texts.set(blob, text);
    }
    return { text: (blob) => load.texts.get(blob) ?? null, blobOf: blobId };
  }

  /**
   * Text merge: write a cycle's merged texts to the local store (commits name them; the push and the publish loop read
   * them there). Their sizes by blob id, or null when one could not be stored under the id the plan gave it.
   */
  private async storeMerged(texts: Map<Sha, string>): Promise<Map<Sha, number> | null> {
    const g = this.repo();
    const enc = new TextEncoder();
    const sizes = new Map<Sha, number>();
    try {
      for (const [blob, text] of texts) {
        const bytes = enc.encode(text);
        const stored = await writeLocalBlob(g, bytes);
        if (stored !== blob) throw new Error(`a merged text hashes to ${stored}, not ${blob}`);
        sizes.set(blob, bytes.length);
      }
    } catch (e) {
      console.error(`text merge left out of this cycle: merged files not stored: ${errorText(e)}`);
      return null;
    }
    return sizes;
  }

  /**
   * One group-commit cycle: idempotency per proposal id, screening against trunk, blob pulls,
   * the plan over the virtual trunk (plan.ts), one chained commit per batch, one push of the tip
   * with compare-and-swap, and the record of every landing in one transaction. With asynchronous
   * publishing the record is the commit point: no push, the publish loop pushes beside the cycles.
   */
  private async cycle(reqs: LandRequest[], stat: CycleStat): Promise<LandResult[]> {
    let mark = Date.now();
    const lap = (phase: string): void => {
      const now = Date.now();
      stat.ms[phase] = (stat.ms[phase] ?? 0) + (now - mark);
      mark = now;
    };
    const st = this.state();
    await this.recoverJournal();
    lap("recover");
    // Asynchronous publishing (FT_ASYNC_PUBLISH, trunk/publish.ts): commits recorded before this object started (or
    // while publishing was asynchronous, when it no longer is) are published before anything else, and past the bound
    // on unpublished landings the cycle waits for publishing.
    const asyncPublish = this.asyncPublish(st.colonyId);
    const drained = await this.publishFirst(asyncPublish);
    if (asyncPublish) await this.publishRoom();
    if (asyncPublish || drained) lap("publishWait");
    // Import-name revalidation (FT_REVALIDATE): a proposal stale only through files it read can still land
    // when the names it imports from them hold on the trunk it lands on and those files only grew (new
    // top-level declarations) since it read them. Off: stale means back.
    const revalidating = revalidationEnabled((this.env as unknown as { FT_REVALIDATE?: string } | undefined)?.FT_REVALIDATE, st.colonyId);
    // Deletion guard (FT_DELETION_GUARD): a change goes back while a trunk file's import of a file it deletes would
    // resolve to nothing. Only cycles that delete a trunk file read the import index.
    const guarding = deletionGuardEnabled((this.env as unknown as { FT_DELETION_GUARD?: string } | undefined)?.FT_DELETION_GUARD, st.colonyId);
    // Export guard (FT_EXPORT_GUARD): a change goes back while a script file imports a name it stops exporting. Only cycles
    // that change trunk script files read their versions, and only the ones that remove a name read the import index.
    const exportGuarding = exportGuardEnabled((this.env as unknown as { FT_EXPORT_GUARD?: string } | undefined)?.FT_EXPORT_GUARD, st.colonyId);
    // Text merge (FT_TEXT_MERGE): a change stale only on files it writes lands when each of them merges cleanly, line by
    // line, with the version it would land on (core/textmerge.ts). Off: stale means back.
    const merging = textMergeEnabled((this.env as unknown as { FT_TEXT_MERGE?: string } | undefined)?.FT_TEXT_MERGE, st.colonyId);
    // Conflict resolver (FT_RESOLVER, colony/resolver.ts): a change sent back for overlapping hunks carries them to its
    // colony (paths, blobs, lines), so the resolver never parses a reason. Off: returns carry only their reasons.
    const resolving = revalidationEnabled((this.env as unknown as { FT_RESOLVER?: string } | undefined)?.FT_RESOLVER, st.colonyId);
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

    // 2b. Direction, the fence's commit point (see direction()): a change whose intent was withdrawn, or amended
    //     substantively after the revision it was built on, goes back before anything is built. One read per cycle.
    const redirected = this.redirected(live.map((e) => e.p), new Set(prior.keys()));
    if (redirected.size > 0) {
      for (const [id, reason] of redirected) outcome.set(id, { kind: "returned", reason });
      live = live.filter((e) => !redirected.has(e.p.id));
    }

    // 2c. Protected paths (trunk/protect.ts), the same commit point: a change that writes a path protected after a person
    //     last approved it (or that none approved) goes back to a person before anything is built. One read per cycle.
    const guarded = protectReturns(this.sql, live.map((e) => ({ p: e.p, ctx: reqs[e.request]?.ctx })), Date.now());
    if (guarded.size > 0) {
      for (const [id, reason] of guarded) outcome.set(id, { kind: "returned", reason });
      live = live.filter((e) => !guarded.has(e.p.id));
    }

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
        // A revalidation candidate (stale only through files it read, each covered by a name assumption), or a
        // text merge candidate (stale only on files it writes), is decided by the plan, which reads those files.
        if (!occ.eligible && !(revalidating && revalidationCandidate(e.p, occ.stale)) && !(merging && textMergeCandidate(e.p, occ.stale))) {
          return { kind: "returned", reason: `stale: ${staleDetail(occ.stale)}` };
        }
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
    // 3b. Submodules (trunk/structure.ts): a change that writes or deletes a submodule, or a path inside one, goes back.
    const submodules = await this.submoduleProblems(live.map((e) => e.p));
    if (submodules.size > 0) {
      for (const [id, o] of submodules) outcome.set(id, o);
      live = live.filter((e) => !submodules.has(e.p.id));
    }
    // 3c. Second spellings inside the cycle (trunk/structure.ts): of two changes adding paths that are one file on a
    //     case-insensitive file system, the later waits for the next cycle, where the first is trunk.
    const spelled = cycleCollisions(live.map((e) => e.p), (path) => this.indexBlob(path) !== null);
    if (spelled.size > 0) {
      for (const [id, reason] of spelled) outcome.set(id, { kind: "deferred", reason });
      live = live.filter((e) => !spelled.has(e.p.id));
    }
    lap("screen");

    // 4. Pull the new blobs: an inline change's from its contents (pullInline: no workspace read, one call to the
    //    colony for the cycle), every other change's from its agent's workspace, many workspaces at once.
    const sizes = new Map<Id, Map<Path, number>>();
    const inlineIds = new Set(live.filter((e) => isInlineChange(e.p)).map((e) => e.p.id));
    const inline = inlineIds.size > 0 ? await this.pullInline(live.filter((e) => inlineIds.has(e.p.id)).map((e) => e.p), st.colonyId, sizes) : new Map<Id, Outcome>();
    const pulls = await mapLimit(live, PULL_CONCURRENCY, async (e): Promise<Outcome | null> => {
      if (inlineIds.has(e.p.id)) return inline.get(e.p.id) ?? null;
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
    const mergeLoad: MergeLoad = { texts: new Map(), reads: 0, bytes: 0 };
    // Merge locks (trunk/mergelock.ts): a change a person approved, or one with a danger pattern a person must see or a
    // protected write, lands merged with a newer trunk only once a person approved that merge. Unreadable: no merges.
    const locks = merging ? mergeLocks(this.sql, live.map((e) => ({ p: e.p, ctx: reqs[e.request]?.ctx }))) : null;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        // Trunk moved underneath: the plan re-validates against the new index, structure too.
        live = live.filter((e) => {
          const s = this.structuralProblem(e.p);
          if (s) outcome.set(e.p.id, { kind: "returned", reason: s });
          return !s;
        });
        // Submodules too, in the tree trunk moved to (trunk/structure.ts).
        const moved = await this.submoduleProblems(live.map((e) => e.p));
        if (moved.size > 0) {
          for (const [id, o] of moved) outcome.set(id, o);
          live = live.filter((e) => !moved.has(e.p.id));
        }
      }
      const input: PlanProposal[][] = reqs.map(() => []);
      for (const e of live) input[e.request]!.push({ p: e.p, base: bases.get(e.p.id) ?? [], ...(locks?.has(e.p.id) ? { lock: locks.get(e.p.id)! } : {}) });
      const surfaces = revalidating ? await this.assumptionSurfaces(live.map((e) => e.p)) : null;
      if (surfaces) lap("assumptions");
      const deletions = guarding ? await this.deletionGuardInput(live.map((e) => e.p)) : undefined;
      if (deletions !== undefined) lap("deletions");
      const exportInput = exportGuarding ? await this.exportGuardInput(live.map((e) => e.p)) : undefined;
      if (exportInput !== undefined) lap("exports");
      const merge = merging && locks !== null ? await this.mergeTexts(input.flat(), mergeLoad) : undefined;
      if (merge) lap("merges");
      // Text merge's insertion rule (FT_MERGE_INSERTIONS): insertions by both sides at one place land as their union.
      if (merge && mergeInsertionsEnabled((this.env as unknown as { FT_MERGE_INSERTIONS?: string } | undefined)?.FT_MERGE_INSERTIONS, st.colonyId)) merge.insertions = true;
      const trunkBlob = (path: Path): Sha | null => this.indexBlob(path);
      const exported = surfaces ? (_path: Path, blob: Sha) => surfaces.get(blob) ?? null : undefined;
      let plan = planCycle(input, trunkBlob, exported, deletions, merge, exportInput);
      // Merged files go to the local store before a commit names them. One that cannot be stored there: the cycle plans
      // again without merging, and the changes it would have merged go back as stale.
      let mergedSizes = plan.mergedTexts.size > 0 ? await this.storeMerged(plan.mergedTexts) : new Map<Sha, number>();
      if (mergedSizes === null) {
        plan = planCycle(input, trunkBlob, exported, deletions, undefined, exportInput);
        mergedSizes = new Map();
      }
      const back = (): void => {
        for (const r of plan.returned.flat()) outcome.set(r.proposalId, { kind: "returned", reason: r.reason, ...(resolving && r.conflicts ? { conflicts: r.conflicts } : {}), ...(r.held ? { held: r.held } : {}) });
        // Merge locks: the merges held for a person this cycle; an approval given after this lands them.
        keepHolds(this.sql, plan.returned.flat(), Date.now());
      };
      lap("plan");
      if (exportInput !== undefined) stat.exportsUncovered = plan.exportsUncovered ?? 0;
      const chain = await this.buildChain(reqs, plan.accepted, sizes, stat, plan.revalidated, { merged: plan.merged, sizes: mergedSizes });
      lap("build");
      if (chain === null) {
        back();
        break;
      }
      // Test hook (FT_TEST_PUSH_DELAY_MS, previews only): hold the cycle between its direction read and its push
      // (its record, with asynchronous publishing).
      const hold = pushDelayMs((this.env as unknown as { FT_TEST_PUSH_DELAY_MS?: string } | undefined)?.FT_TEST_PUSH_DELAY_MS);
      if (hold > 0) await sleep(hold);
      // Asynchronous publishing: recorded is landed, so nothing is pushed here; each landing joins the publish queue
      // in the transaction that records it.
      const pushed = asyncPublish ? { ok: true as const } : await this.pushChain(chain);
      if (!asyncPublish) lap("push");
      if (pushed.ok) {
        this.ctx.storage.transactionSync(() => {
          for (const it of chain.items) {
            this.finalizeRows(it.data);
            if (asyncPublish) this.queuePublish(it.data.landing);
          }
        });
        if (asyncPublish) this.publishSoon();
        await setRef(this.repo(), MAIN_REF, chain.tip);
        for (const it of chain.items) {
          own[it.request] = it.data.landing;
          for (const id of it.data.landing.proposalIds) outcome.set(id, { kind: "landed", landing: it.data.landing });
          stat.landed += it.data.landing.proposalIds.length;
        }
        stat.landings = chain.items.length;
        if (plan.revalidated.size > 0) {
          stat.revalidated = plan.revalidated.size;
          void this.emitRevalidated(plan.accepted.flat(), plan.revalidated).catch(() => undefined);
        }
        if (plan.merged.size > 0) stat.merged = plan.merged.size;
        const byInsertions = [...plan.merged.values()].filter((files) => files.some((f) => f.rule === "insertions")).length;
        if (byInsertions > 0) stat.insertions = byInsertions;
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
    // With asynchronous publishing the publish loop pushes them, and starts the notes flush once they are published.
    if (asyncPublish) {
      const lag = this.publishLag();
      stat.publish = { publishedSha: this.publishedHead(), unpublished: lag.unpublished, lagMs: lag.oldestAt === null ? 0 : Math.max(0, Date.now() - lag.oldestAt) };
    } else if (stat.landings > 0) await this.notesSoon().catch((e: unknown) => console.error(`notes flush not started: ${errorText(e)}`));
    for (const o of outcome.values()) {
      if (o.kind === "returned") stat.returned++;
      else if (o.kind === "deferred") stat.deferred++;
    }
    return resultsFor(batches, outcome, own, direct);
  }

  /**
   * One commit per batch with accepted proposals, by tree surgery, each on top of the previous
   * one (the first on current main), with its message, landing and lineage note. Null when the
   * plan accepted nothing. `merges`: the files the plan merged (text merge) per proposal, and the
   * sizes of the merged blobs, which the local store holds.
   */
  private async buildChain(
    reqs: LandRequest[],
    accepted: Proposal[][],
    sizes: Map<Id, Map<Path, number>>,
    stat?: CycleStat,
    revalidated: Map<Id, Revalidated[]> = new Map(),
    merges: { merged: Map<Id, TextMerged[]>; sizes: Map<Sha, number> } = { merged: new Map(), sizes: new Map() },
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
    // What the chain's earlier commits left at the paths they changed (null: deleted).
    const chained = new Map<Path, { blob: Sha; mode: string } | null>();
    // Signed lineage notes (trunk/signature.ts): FT_NOTE_KEY's signer, or null, and the commits are built as before.
    const signer = await noteSigner(this.env.FT_NOTE_KEY);
    for (let i = 0; i < accepted.length; i++) {
      const proposals = accepted[i]!;
      if (proposals.length === 0) continue;
      // A path no earlier batch of the cycle changed is as current trunk has it. One an earlier batch changed (a later
      // batch writes it again only through a text merge onto that batch's version) is as that commit left it.
      const changes = new Map<Path, StagedChange>();
      for (const p of proposals) {
        for (const w of p.writeSet) {
          const prev = chained.get(w.path);
          const before = prev !== undefined ? (prev?.blob ?? null) : this.indexBlob(w.path);
          if (w.blob === null) {
            if (before !== null) changes.set(w.path, { blob: null, before });
          } else if (w.blob !== before) {
            // A merged blob's size is known from the merge; the pull step measured the proposal's own blobs.
            const size = merges.sizes.get(w.blob) ?? sizes.get(p.id)?.get(w.path) ?? (await readLocalBlob(g, w.blob)).length;
            changes.set(w.path, { blob: w.blob, mode: prev?.mode ?? this.indexMode(w.path) ?? NEW_FILE_MODE, size, before });
          }
        }
      }
      for (const [path, c] of changes) chained.set(path, c.blob === null ? null : { blob: c.blob, mode: c.mode });
      const treeChanges = new Map<Path, PathChange>();
      for (const [path, c] of changes) treeChanges.set(path, c.blob === null ? null : { blob: c.blob, mode: c.mode });
      lap("changes");
      for (const c of changes.values()) if (c.blob !== null) objects.add(c.blob);
      if (treeChanges.size > 0) tree = await applyTreeChangesDeferred(g, this.trees, tree, treeChanges, pending);
      lap("surgery");
      const at = this.nextLandingAt();
      const id = newId("lnd_");
      const intentIds = unique(proposals.map((p) => p.intentId));
      // The note names the landing, never the commit, so it is final here and the commit carries its digest as the
      // FT-Note trailer (trunk/digest.ts); certification, added after landing, is left out of the digest.
      const note = await sealNote(buildNote({ id, colonyId: st.colonyId }, proposals, info, ctx, revalidated, merges.merged));
      lap("note");
      const message = withNoteDigest(await withSignature(landingMessage({ id, intentIds }, proposals, info.titles), signer, { digest: note.digest, tree, parents: [parent] }), note.digest);
      const content = commitContent({ tree, parents: [parent], message, name: LANDING_IDENTITY.name, email: LANDING_IDENTITY.email, timestamp: Math.floor(at / 1000) });
      const commit = objectId("commit", content);
      pending.set(commit, { type: "commit", content });
      this.commitTrees.set(commit, tree);
      lap("commit");
      const paths = [...changes.keys()].sort();
      // Text merge: the blob that landed for each merged file (its proposal wrote another).
      const mergedHere = proposals.flatMap((p) => (merges.merged.get(p.id) ?? []).map((f) => ({ proposalId: p.id, path: f.path, blob: f.result, ...(f.rule ? { rule: f.rule } : {}) })));
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
        ...(mergedHere.length > 0 ? { merged: mergedHere } : {}),
      };
      items.push({ request: i, data: { landing, note: note.text, changes: [...changes] } });
      parent = commit;
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
    const regular = (): Promise<PushOutcome> => this.regularPush(chain);
    let outcome: PushOutcome;
    try {
      if (chain.objects && chain.objects.length > 0) {
        // Direct push of exactly the chain's new objects (push.ts); the regular push settles anything unexpected.
        try {
          outcome = await this.directPush(chain);
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
    // A stale answer whose remote value is this chain's tip: an earlier attempt of this push landed it (a direct push whose
    // reply was lost or unclear, retried with the regular push). The chain is on main; keep its journal.
    if (outcome.stale && (await this.landedAnyway(outcome.remoteOid, chain.tip))) return { ok: true };
    drop();
    if (outcome.stale) return { ok: false, detail: outcome.detail };
    throw new Error(`trunk push rejected: ${outcome.detail}`);
  }

  /** Whether main is at `tip` after a stale answer: the answer's remote value, or the binding's when it gave none. */
  private async landedAnyway(remoteOid: Sha | null, tip: Sha): Promise<boolean> {
    if (remoteOid !== null) return remoteOid === tip;
    try {
      return (await this.remoteHead()) === tip;
    } catch {
      return false;
    }
  }

  /** The direct push of exactly the chain's new objects (push.ts), with compare-and-swap on the chain's parent. */
  private directPush(chain: { parent: Sha; tip: Sha; objects?: string[] }): Promise<PushOutcome> {
    const st = this.state();
    const g = this.repo();
    return this.authed((token) => pushPack(g, { url: st.trunk.remote, token, ref: MAIN_REF, oldOid: chain.parent, newOid: chain.tip, oids: chain.objects ?? [] }));
  }

  /** The regular push of the staging ref to main (isomorphic-git), with compare-and-swap on the chain's parent. */
  private regularPush(chain: { parent: Sha; tip: Sha }): Promise<PushOutcome> {
    const st = this.state();
    const g = this.repo();
    return this.authed((token) => pushRef(g, { url: st.trunk.remote, token, localRef: STAGING_REF, remoteRef: MAIN_REF, expectedOld: chain.parent }));
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

  /**
   * One cycle's direction check (the fence's commit point): the reason each change whose direction went stale
   * goes back, by proposal id, from one read of the fence's record; one that already landed (`landed`) stays
   * landed. A read that fails is logged and stops nothing, as before the fence existed (the lane checked
   * direction just before it handed the batch over).
   */
  private redirected(proposals: Proposal[], landed: ReadonlySet<Id>): Map<Id, string> {
    if (proposals.length === 0) return new Map();
    try {
      const direction = new Map<Id, DirectionInfo>();
      const intents = unique(proposals.map((p) => p.intentId));
      for (let i = 0; i < intents.length; i += 500) {
        const rows = this.sql
          .exec<{ intent_id: string; info: string | null }>(`SELECT intent_id, info FROM ft_direction WHERE intent_id IN (SELECT value FROM json_each(?))`, JSON.stringify(intents.slice(i, i + 500)))
          .toArray();
        for (const r of rows) {
          const info = parseDirection(r.info);
          if (info) direction.set(r.intent_id, info);
        }
      }
      return directionReturns(proposals, direction, landed);
    } catch (e) {
      console.error(`direction check skipped in this cycle: ${errorText(e)}`);
      return new Map();
    }
  }

  /** The proposals of the landings whose push outcome is not recorded yet; null when a journal row cannot be read. */
  private pushingProposals(): Set<Id> | null {
    const out = new Set<Id>();
    for (const r of this.sql.exec<{ data: string }>(`SELECT data FROM ft_journal WHERE state = 'pushing'`).toArray()) {
      try {
        for (const id of (JSON.parse(r.data) as JournalData).landing.proposalIds ?? []) out.add(id);
      } catch {
        return null;
      }
    }
    return out;
  }

  /** A landing time later than every earlier one, so a cycle's newest landing sorts last everywhere. */
  private nextLandingAt(): number {
    this.lastLandingAt = Math.max(Date.now(), this.lastLandingAt + 1);
    return this.lastLandingAt;
  }

  /** A file where a directory is needed (or the reverse), a write into a submodule, a symbolic link retargeted, or a second spelling of a trunk file. */
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
    // A symbolic link retargeted, or a second spelling of a trunk file (trunk/structure.ts).
    return structureProblem(p.writeSet, {
      file: (path) => this.sql.exec<{ blob: string; mode: string }>(`SELECT blob, mode FROM ft_files WHERE path = ?`, path).toArray()[0] ?? null,
      folded: () => this.foldedIndex.get(this.meta("trunk_sha") ?? "", () => this.sql.exec<{ path: string }>(`SELECT path FROM ft_files`).toArray().map((r) => r.path)),
    });
  }

  /**
   * The proposals that write or delete a submodule of trunk, or a path inside one, read from trunk's current tree (the
   * index lists no submodules): each returned with its reason, or deferred when the tree cannot be read (trunk/structure.ts).
   */
  private async submoduleProblems(proposals: Proposal[]): Promise<Map<Id, SubmoduleOutcome>> {
    if (proposals.length === 0) return new Map();
    const g = this.repo();
    const sha = this.state().trunkSha;
    let root: string | null;
    try {
      root = this.commitTrees.get(sha) ?? (await commitTree(g, sha));
    } catch (err) {
      root = null;
      console.error(`submodule check: trunk commit ${sha} unreadable: ${errorText(err)}`);
    }
    if (root === null) return new Map(proposals.map((p) => [p.id, { kind: "deferred", reason: `trunk commit ${sha} is missing locally, so submodules could not be checked` }]));
    return submoduleProblems(proposals, root, (oid) => readTreeCached(g, this.trees, oid));
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

  /**
   * The new blobs of this cycle's inline changes (colony/inline.ts), with no workspace read: a change's texts come
   * with its batch, or from the colony that keeps them, in one call for the cycle (more only past
   * INLINE_FETCH_BYTES, so an answer, and the texts held at once, stay bounded). Each text must hash to the blob id
   * its write set names before it is written to the local store. Fills `sizes` for the changes pulled and returns an
   * outcome for each one that cannot land: a text missing or wrong sends it back, a colony that does not answer defers it.
   */
  private async pullInline(proposals: Proposal[], colonyId: Id, sizes: Map<Id, Map<Path, number>>): Promise<Map<Id, Outcome>> {
    const out = new Map<Id, Outcome>();
    const g = this.repo();
    const enc = new TextEncoder();
    const needed = (p: Proposal): FileVersion[] => p.writeSet.filter((w) => w.blob !== null && w.blob !== this.indexBlob(w.path));
    const write = async (p: Proposal, texts: unknown): Promise<void> => {
      const got = new Map<Path, number>();
      try {
        for (const w of needed(p)) {
          const blob = w.blob as Sha;
          const text = texts && typeof texts === "object" && Object.hasOwn(texts, blob) ? (texts as Record<Sha, unknown>)[blob] : undefined;
          if (typeof text !== "string") throw new ProposalProblem(`no text for ${w.path} (blob ${blob}) in this inline change; propose it again`);
          const bytes = enc.encode(text);
          const sha = await blobSha(bytes);
          if (sha !== blob) throw new ProposalProblem(`the text for ${w.path} hashes to ${sha}, not ${blob}`);
          await writeLocalBlob(g, bytes);
          got.set(w.path, bytes.length);
        }
        sizes.set(p.id, got);
      } catch (err) {
        out.set(p.id, err instanceof ProposalProblem ? { kind: "returned", reason: err.message } : { kind: "deferred", reason: `blob write failed: ${errorText(err)}` });
      }
    };
    // A change that needs no new blob asks for nothing; one whose batch carries every text it needs uses them.
    const carried: Proposal[] = [];
    let ask: Proposal[] = [];
    for (const p of proposals) {
      const need = needed(p);
      const texts = p.contents && typeof p.contents === "object" ? p.contents : null;
      if (need.length === 0) sizes.set(p.id, new Map());
      else if (texts && need.every((w) => Object.hasOwn(texts, w.blob as Sha) && typeof texts[w.blob as Sha] === "string")) carried.push(p);
      else ask.push(p);
    }
    await mapLimit(carried, WRITE_CONCURRENCY, (p) => write(p, p.contents));
    const ns = this.env.COLONY as DurableObjectNamespace | undefined;
    const colony = ns ? (ns.get(ns.idFromName(colonyId)) as unknown as { inlineContents(ids: Id[], maxBytes?: number): Promise<{ contents?: Record<Id, Record<Sha, string>>; more?: Id[] }> }) : null;
    while (ask.length > 0) {
      let answer: { contents?: Record<Id, Record<Sha, string>>; more?: Id[] };
      try {
        if (!colony) throw new Error("no colony binding");
        answer = await colony.inlineContents(ask.map((p) => p.id), INLINE_FETCH_BYTES);
      } catch (err) {
        for (const p of ask) out.set(p.id, { kind: "deferred", reason: `inline contents not fetched from the colony: ${errorText(err)}` });
        break;
      }
      const more = new Set(Array.isArray(answer?.more) ? answer.more : []);
      const answered = ask.filter((p) => !more.has(p.id));
      if (answered.length === 0) {
        // An answer that moves nothing on would loop: the rest waits for a later cycle.
        for (const p of ask) out.set(p.id, { kind: "deferred", reason: "inline contents not fetched: the colony sent none" });
        break;
      }
      const contents: Record<Id, unknown> = answer?.contents && typeof answer.contents === "object" ? answer.contents : {};
      await mapLimit(answered, WRITE_CONCURRENCY, (p) => write(p, Object.hasOwn(contents, p.id) ? contents[p.id] : undefined));
      ask = ask.filter((p) => more.has(p.id));
    }
    return out;
  }

  /**
   * Build, push and record one system commit (see systemCommit); up to MAX_REBUILDS retries on a moved trunk. With
   * asynchronous publishing it is built on the recorded head (unpublished commits included) and recorded like a
   * landing; the publish loop pushes it after every commit recorded before it.
   */
  private async systemCommitNow(p: { files: Array<{ path: Path; content: string | null; expect?: Sha | null }>; message: string; note: LineageNote & Record<string, unknown> }): Promise<Landing> {
    const asyncPublish = this.asyncPublish(this.state().colonyId);
    await this.recoverJournal();
    await this.publishFirst(asyncPublish);
    if (asyncPublish) await this.publishRoom();
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
        if (f.expect !== undefined && before !== f.expect) throw new StaleSystemCommit(`${f.path} ${before === null ? "deleted" : "changed"} since`);
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
      // Sealed like a landing's note: the commit's last trailer is the note's digest (trunk/digest.ts).
      const note = await sealNote({ ...p.note, landingId: id, colonyId: st.colonyId });
      // Signed like a landing too, when FT_NOTE_KEY holds a key (trunk/signature.ts).
      const signer = await noteSigner(this.env.FT_NOTE_KEY);
      const message = withNoteDigest(await withSignature(`${p.message.replace(/\s+$/, "")}\nFT-Landing: ${id}`, signer, { digest: note.digest, tree, parents: [parent] }), note.digest);
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
      const data: JournalData = { landing, note: note.text, changes: [...changes] };
      if (asyncPublish) {
        // Recorded is landed: it joins the publish queue in the transaction that records it.
        this.ctx.storage.transactionSync(() => {
          this.finalizeRows(data);
          this.queuePublish(landing);
        });
        this.publishSoon();
        await setRef(g, MAIN_REF, commit);
        return landing;
      }
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
    // Derived indexes (trunk/derived.ts): the eager ones apply this landing now, the lazy ones when read. Never throws.
    this.derivedSet().landed({ seq, landing: { landing, note, changes } });
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
  // Asynchronous publishing (FT_ASYNC_PUBLISH, trunk/publish.ts)
  // -------------------------------------------------------------------------

  /** Whether asynchronous publishing is on for this colony. */
  private asyncPublish(colonyId: Id): boolean {
    return asyncPublishEnabled((this.env as unknown as { FT_ASYNC_PUBLISH?: string } | undefined)?.FT_ASYNC_PUBLISH, colonyId);
  }

  /**
   * Put a recorded landing in the publish queue, inside the transaction that records it: a journal row in state
   * `recorded`. The first of a backlog pins the published head to its parent (the recorded head before it).
   */
  private queuePublish(landing: Landing): void {
    if (!this.hasBacklog()) this.setMeta("published_sha", landing.parentSha);
    this.sql.exec(
      `INSERT INTO ft_journal (landing_id, state, commit_sha, parent_sha, data, created_at, updated_at) VALUES (?, 'recorded', ?, ?, '{}', ?, ?)`,
      landing.id,
      landing.trunkSha,
      landing.parentSha,
      landing.at,
      Date.now(),
    );
  }

  /** Whether any recorded commit waits to be published. */
  private hasBacklog(): boolean {
    return this.sql.exec(`SELECT 1 AS x FROM ft_journal WHERE state = 'recorded' LIMIT 1`).toArray().length > 0;
  }

  /** The publish queue: landings recorded and not published, and when the oldest of them was recorded. */
  private publishLag(): { unpublished: number; oldestAt: number | null } {
    const r = this.sql.exec<{ n: number; oldest: number | null }>(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM ft_journal WHERE state = 'recorded'`).one();
    return { unpublished: r.n, oldestAt: r.oldest };
  }

  /** The recorded commits waiting to be published, in the order they were recorded. */
  private recordedRows(): RecordedCommit[] {
    return this.sql
      .exec<{ landing_id: string; commit_sha: string; parent_sha: string; created_at: number }>(
        `SELECT landing_id, commit_sha, parent_sha, created_at FROM ft_journal WHERE state = 'recorded' ORDER BY rowid`,
      )
      .toArray()
      .map((r) => ({ landingId: r.landing_id, commit: r.commit_sha, parent: r.parent_sha, at: r.created_at }));
  }

  /** The newest commit on the trunk repository's main as far as this writer knows: the recorded head when nothing waits. */
  private publishedHead(): Sha | null {
    if (!this.hasBacklog()) return this.meta("trunk_sha");
    return this.meta("published_sha") ?? this.recordedRows()[0]?.parent ?? null;
  }

  /** Whether `sha` is a recorded commit not published yet. */
  private isUnpublished(sha: Sha): boolean {
    return this.recordedOrder(sha) >= 0;
  }

  /** The order a waiting commit was recorded in (its journal row), or -1 when it is not waiting to be published. */
  private recordedOrder(sha: Sha): number {
    return this.sql.exec<{ n: number }>(`SELECT rowid AS n FROM ft_journal WHERE state = 'recorded' AND commit_sha = ? LIMIT 1`, sha).toArray()[0]?.n ?? -1;
  }

  /** Keep `sha` as `certified`'s next move until it is published. Recorded commits form one chain, so the later one wins. */
  private deferCertified(sha: Sha): void {
    const pending = this.meta("certified_pending");
    if (pending !== null && pending !== sha && this.recordedOrder(pending) > this.recordedOrder(sha)) return;
    this.setMeta("certified_pending", sha);
  }

  /**
   * Publish every recorded commit now, before a cycle or system commit goes on, when it must: once after this object
   * starts (commits recorded before a restart are published before anything else), and always while publishing is not
   * asynchronous (commits left from when it was: a pushing cycle builds on the published head). True when it had
   * commits to publish. Throws when publishing fails: the caller fails and is retried, and nothing new is recorded.
   */
  private async publishFirst(asyncOn: boolean): Promise<boolean> {
    if (asyncOn && this.publishedSinceStart) return false;
    const due = this.hasBacklog();
    if (due) await this.publishNow();
    this.publishedSinceStart = true;
    return due;
  }

  /**
   * The hard bound on how far the recorded head runs ahead of the published one (PUBLISH_BOUND): past it, wait for
   * publishing, at most the bound's waitMs, then fail (a cycle's lanes send their batches again).
   */
  private async publishRoom(): Promise<void> {
    const bound = this.publishBound;
    const until = Date.now() + bound.waitMs;
    for (;;) {
      const lag = this.publishLag();
      if (withinBound(lag, Date.now(), bound)) return;
      const left = until - Date.now();
      if (left <= 0) {
        const age = lag.oldestAt === null ? 0 : Math.round((Date.now() - lag.oldestAt) / 1000);
        throw new Error(`publishing is behind: ${lag.unpublished} landing(s) recorded and not published, the oldest for ${age} s; landing waits for publishing`);
      }
      this.publishSoon();
      const attempt = this.publishOnce().then(
        () => undefined,
        () => sleep(Math.min(1_000, Math.max(0, until - Date.now()))),
      );
      await settlesWithin(attempt, left);
    }
  }

  /**
   * Publish until nothing recorded is left (a few rounds at most while cycles keep recording). Throws on the first failure,
   * and when it takes longer than the bound's waitMs (the attempt in flight goes on, and the next caller joins it).
   */
  private async publishNow(): Promise<void> {
    const waitMs = this.publishBound.waitMs;
    const until = Date.now() + waitMs;
    for (let round = 0; round < 8; round++) {
      const out: { left?: number; failure?: unknown } = {};
      const attempt = this.publishOnce().then(
        (left) => void (out.left = left),
        (e: unknown) => void (out.failure = e ?? new Error("publish failed")),
      );
      if (!(await settlesWithin(attempt, until - Date.now()))) {
        throw new Error(`publishing did not finish within ${waitMs >= 1_000 ? `${Math.round(waitMs / 1000)} s` : `${waitMs} ms`}; landing waits for publishing`);
      }
      if (out.failure !== undefined) throw out.failure;
      if (out.left === 0) return;
    }
  }

  /** One publish attempt, single-flight: a caller while one runs shares it. Resolves to the landings still unpublished. */
  private publishOnce(): Promise<number> {
    if (this.publishing === null) {
      const run: Promise<number> = this.publishStep().finally(() => {
        if (this.publishing === run) this.publishing = null;
      });
      this.publishing = run;
    }
    return this.publishing;
  }

  /**
   * One publish: push every recorded commit that chains from the published head to trunk main, in one push with
   * compare-and-swap on the published head, so no commit is published twice (a repeat finds main moved). When the
   * answer is lost or the push refused, where main is decides: at the published head, nothing was published (it fails
   * and is retried); at one of the pushed commits, the commits up to it are; anywhere else, something else wrote trunk,
   * and publishing fails until a person looks. Published rows move to `pending_note` (their notes follow). Resolves to
   * the landings still unpublished.
   */
  private async publishStep(): Promise<number> {
    const epoch = this.epoch;
    const st = this.state();
    const rows = this.recordedRows();
    if (rows.length === 0) return 0;
    const base = this.meta("published_sha") ?? rows[0]!.parent;
    const { chain, broken } = publishChain(base, rows);
    if (broken) console.error(`recorded commit ${broken.commit} (${broken.landingId}) does not build on the published chain from ${base}; it is not published`);
    const tip = chain[chain.length - 1];
    if (!tip) throw new Error(`no recorded commit builds on the published head ${base}`);
    const t0 = Date.now();
    const oids = await this.publishObjects(chain);
    let outcome: PushOutcome | null = null;
    let failure: unknown = null;
    try {
      outcome = await this.publishPush(base, tip.commit, oids);
    } catch (e) {
      failure = e;
    }
    let upTo = chain.length - 1;
    if (!outcome?.ok) {
      const remote = outcome && !outcome.ok && outcome.stale && outcome.remoteOid !== null ? outcome.remoteOid : await this.remoteHead();
      const settled = settlePublish(base, chain, remote);
      if (settled.kind === "none") throw new Error(outcome && !outcome.ok ? `publish push rejected: ${outcome.detail}` : `publish push failed: ${errorText(failure)}`);
      if (settled.kind === "foreign") throw new Error(`trunk main is at ${remote ?? "nothing"}, a commit this writer did not record (published head ${base}); publishing waits for a person`);
      upTo = settled.index;
    }
    // An attempt that outlived its storage (the trunk was erased meanwhile) records nothing.
    if (epoch !== this.epoch) throw new Error("trunk erased while publishing");
    const done = chain.slice(0, upTo + 1);
    const now = Date.now();
    this.markPublished(done, now);
    const left = this.publishLag().unpublished;
    const report = { ms: now - t0, landings: done.length, objects: oids.length, lagMs: Math.max(0, now - done[0]!.at), left, failures: this.publishFailures };
    console.log(JSON.stringify({ ft: "trunk-publish", colonyId: st.colonyId, published: done[done.length - 1]!.commit, ...report, ...(outcome?.ok ? {} : { settled: true }) }));
    void this.emitPublish({ at: now, ...report }).catch(() => undefined);
    this.afterPublish();
    return left;
  }

  /** The objects a publish of `chain` carries: each commit, and the trees and blobs it adds to its parent's tree. */
  private async publishObjects(chain: RecordedCommit[]): Promise<string[]> {
    const g = this.repo();
    const rootOf = async (commit: Sha): Promise<string | null> => this.commitTrees.get(commit) ?? (await commitTree(g, commit));
    const out = new Set<string>();
    for (const c of chain) {
      const tree = await rootOf(c.commit);
      if (tree === null) throw new Error(`recorded commit ${c.commit} is missing locally`);
      out.add(c.commit);
      await addedObjects(g, this.trees, await rootOf(c.parent), tree, out);
    }
    return [...out];
  }

  /**
   * Push the recorded commits up to `target` to trunk main with compare-and-swap on `expected` (the published head):
   * exactly their objects in one receive-pack request (push.ts), or the regular push when that is refused for a reason
   * other than a moved main. Throws when the outcome cannot be learned.
   */
  private async publishPush(expected: Sha, target: Sha, oids: string[]): Promise<PushOutcome> {
    const st = this.state();
    const g = this.repo();
    const direct = await this.authed((token) => pushPack(g, { url: st.trunk.remote, token, ref: MAIN_REF, oldOid: expected, newOid: target, oids }));
    if (direct.ok || direct.stale) return direct;
    console.error(`direct publish push refused (${direct.detail}); using the regular push`);
    await setRef(g, PUBLISH_REF, target);
    return this.authed((token) => pushRef(g, { url: st.trunk.remote, token, localRef: PUBLISH_REF, remoteRef: MAIN_REF, expectedOld: expected }));
  }

  /** Push local `ref` to the same ref of the trunk repository with compare-and-swap (`certified`). */
  private pushTrunkRef(ref: string, expectedOld: string | null): Promise<PushOutcome> {
    const st = this.state();
    const g = this.repo();
    return this.authed((token) => pushRef(g, { url: st.trunk.remote, token, localRef: ref, remoteRef: ref, expectedOld }));
  }

  /** Record that trunk main holds `done`, the start of the recorded chain: their rows move to `pending_note`, in one transaction. */
  private markPublished(done: RecordedCommit[], at: number): void {
    const tip = done[done.length - 1];
    if (!tip) return;
    this.ctx.storage.transactionSync(() => {
      for (const c of done) this.sql.exec(`UPDATE ft_journal SET state = 'pending_note', updated_at = ? WHERE landing_id = ? AND state = 'recorded'`, at, c.landingId);
      this.setMeta("published_sha", tip.commit);
      this.setMeta("published_at", String(at));
    });
  }

  /** After a publish: the published landings' notes go out, and `certified` moves to a commit that waited to be published. */
  private afterPublish(): void {
    void this.notesSoon().catch((e: unknown) => console.error(`notes flush not started: ${errorText(e)}`));
    const pending = this.meta("certified_pending");
    if (pending === null || this.isUnpublished(pending)) return;
    this.sql.exec(`DELETE FROM ft_meta WHERE key = 'certified_pending'`);
    void this.markCertified(pending).catch((e: unknown) => console.warn(`certified ref not moved to ${pending.slice(0, 7)}: ${errorText(e)}`));
  }

  /**
   * Run the publish loop beside the cycles: attempts one after another while recorded commits wait, never two at once,
   * pausing after each failure (1 s, 2 s, 4 s, ... 30 s), which is logged. The alarm is its safety net when this object
   * goes away first.
   */
  private publishSoon(): void {
    this.publishWanted = true;
    if (this.publishDriver !== null) return;
    const epoch = this.epoch;
    void this.armAlarm(NOTES_RETRY_MS).catch(() => undefined);
    const run: Promise<void> = (async () => {
      while (this.publishWanted && epoch === this.epoch) {
        this.publishWanted = false;
        try {
          if ((await this.publishOnce()) > 0) this.publishWanted = true;
          this.publishFailures = 0;
          this.publishError = null;
        } catch (e) {
          if (epoch !== this.epoch) break;
          this.publishFailures++;
          this.publishError = errorText(e).slice(0, 500);
          const delay = this.publishDelayMs(this.publishFailures);
          console.error(JSON.stringify({ ft: "trunk-publish-failed", colonyId: this.meta("colony_id"), failures: this.publishFailures, retryInMs: delay, error: this.publishError }));
          await this.armAlarm(delay + 5_000).catch(() => undefined);
          await sleep(delay);
          if (epoch !== this.epoch) break;
          this.publishWanted = true;
        }
      }
    })().finally(() => {
      if (this.publishDriver === run) this.publishDriver = null;
    });
    this.publishDriver = run;
  }

  /** The pause after the n-th failed publish attempt in a row (tests shorten it). */
  private publishDelayMs(failures: number): number {
    return publishBackoffMs(failures);
  }

  /** Forget publishing in flight (the trunk was erased or replaced): an attempt or loop of the earlier epoch writes nothing more. */
  private stopPublishing(): void {
    this.epoch++;
    this.publishing = null;
    this.publishDriver = null;
    this.publishWanted = false;
    this.publishFailures = 0;
    this.publishError = null;
  }

  // -------------------------------------------------------------------------
  // Lineage context
  // -------------------------------------------------------------------------

  private async lineageInfo(proposals: Proposal[], ctx: LandContext, colonyId: Id): Promise<{ titles: Record<Id, string>; intents: Map<Id, IntentInfo>; agents: Map<Id, AgentLite> }> {
    for (const [id, i] of Object.entries(ctx.intents ?? {})) this.intentCache.set(id, { title: i.title, why: i.why ?? "", ruleId: i.ruleId, parentId: i.parentId, ...notePriority(i) });
    for (const [id, a] of Object.entries(ctx.agents ?? {})) this.agentCache.set(id, { kind: a.kind, model: a.model, ...(typeof a.resumeKey === "boolean" ? { resumeKey: a.resumeKey } : {}) });
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
      for (const i of snap.intents ?? []) this.intentCache.set(i.id, { title: i.title, why: i.why, ruleId: i.ruleId, parentId: i.parentId, ...notePriority(i) });
      // A snapshot does not say who holds a resume key: keep what a land context said.
      for (const a of snap.agents ?? []) this.agentCache.set(a.id, { ...this.agentCache.get(a.id), kind: a.kind, model: a.model });
    } catch {
      // lineage falls back to proposal summaries
    }
  }

  // -------------------------------------------------------------------------
  // Co-change map
  // -------------------------------------------------------------------------

  private cochange(): CoChangeStore {
    if (!this.cochangeStore) this.cochangeStore = new CoChangeStore(this.sql, (fn) => this.ctx.storage.transactionSync(fn), this.derivedSet());
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
    // History is read from the trunk repository, which holds published commits only (asynchronous publishing).
    const head = this.publishedHead() ?? st.trunkSha;
    const mined = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (repo) => mineHistory(repo, head));
    // The trunk may have been replaced or erased while the history was read.
    const trunk = this.meta("trunk");
    if (trunk === null || (JSON.parse(trunk) as RepoRef).name !== st.trunk.name) return;
    const learned = this.cochange().learnHistory(mined, head, Date.now());
    console.log(
      JSON.stringify({ ft: "cochange-mined", colonyId: st.colonyId, head, listed: mined.listed, learned, skipped: mined.skipped, truncated: mined.truncated, reads: mined.reads, ms: Date.now() - t0 }),
    );
  }

  // -------------------------------------------------------------------------
  // Derived indexes
  // -------------------------------------------------------------------------

  /**
   * The derived indexes of the landing log (trunk/derived.ts), with their cursors: the import index
   * (eager: the landing hook in finalizeRows marks each landing), the co-change map and path history
   * (lazy: caught up when read).
   */
  private derivedSet(): DerivedSet<TrunkLanding> {
    if (!this.derivedStore) {
      const set = new DerivedSet(this.sql, (fn) => this.ctx.storage.transactionSync(fn), trunkLog(this.sql), [importsDerived(this.sql), pathHistoryDerived(this.sql)], {
        label: () => this.meta("colony_id"),
      });
      this.derivedStore = set;
      // The co-change store adds its own definition to the set.
      this.cochange();
    }
    return this.derivedStore;
  }

  // -------------------------------------------------------------------------
  // Import index
  // -------------------------------------------------------------------------

  /** The import index (its tables are created here, outside any landing transaction). */
  private importIndex(): ImportIndex {
    if (!this.importStore) this.importStore = new ImportIndex(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
    return this.importStore;
  }

  /**
   * The deletion guard's input for one cycle's proposals (imports.ts deletionImports): undefined when none deletes a
   * trunk file; null when the import index could not be brought up to date in time (the guard sits the cycle out).
   */
  private async deletionGuardInput(proposals: Proposal[]): Promise<DeletionImports | null | undefined> {
    try {
      const source = { head: () => this.meta("trunk_sha"), read: (blob: Sha) => this.blobBytes(blob), label: this.state().colonyId };
      const index = (): ImportIndex => {
        // Its cursor first (a version change forgets the index; a landing the hook left behind is marked now).
        this.derivedSet().catchUp(IMPORTS_INDEX);
        return this.importIndex();
      };
      return await deletionImports(index, source, proposals, (path) => this.indexBlob(path));
    } catch (e) {
      // The guard never fails a cycle.
      console.error(`deletion guard skipped: ${errorText(e)}`);
      return null;
    }
  }

  /**
   * The export guard's input for one cycle's proposals (imports.ts exportImports): undefined when none changes a trunk
   * script file; null when the guard sits the cycle out (the import index not current in time, or blob reads stalled).
   */
  private async exportGuardInput(proposals: Proposal[]): Promise<ExportImports | null | undefined> {
    try {
      const source = { head: () => this.meta("trunk_sha"), read: (blob: Sha) => this.blobBytes(blob), label: this.state().colonyId };
      const index = (): ImportIndex => {
        this.derivedSet().catchUp(IMPORTS_INDEX);
        return this.importIndex();
      };
      return await exportImports(index, source, proposals, (path) => this.indexBlob(path), this.exportMemo);
    } catch (e) {
      // The guard never fails a cycle.
      console.error(`export guard skipped: ${errorText(e)}`);
      return null;
    }
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

  /**
   * The notes commit refs/notes/firetrident names on the trunk repository (its ref advertisement), or null when it has
   * none. Read at most every NOTES_TIP_TTL_MS: verifyNotes is a public read, and git requests are limited per repository.
   */
  private remoteNotesTip(): Promise<Sha | null> {
    const now = Date.now();
    if (this.notesTipRead && now - this.notesTipRead.at < NOTES_TIP_TTL_MS) return this.notesTipRead.tip;
    const st = this.state();
    const tip = this.authed((token) => listRemoteRefs(st.trunk.remote, token)).then((refs) => refs.find((r) => r.ref === NOTES_REF)?.oid ?? null);
    const read = { at: now, tip };
    this.notesTipRead = read;
    // A failed read is not kept.
    tip.catch(() => {
      if (this.notesTipRead === read) this.notesTipRead = null;
    });
    return tip;
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

  /** A landing by id, or by the trunk commit it produced (40 hex, or a unique prefix of 7+). */
  private landingByRef(ref: string): Landing | null {
    if (ref.startsWith("lnd_")) return this.landingById(ref);
    if (!/^[0-9a-f]{7,40}$/.test(ref)) return null;
    const rows = this.sql.exec<{ data: string }>(`SELECT data FROM ft_landings WHERE substr(trunk_sha, 1, ?) = ? LIMIT 2`, ref.length, ref).toArray();
    return rows.length === 1 ? (JSON.parse(rows[0]!.data) as Landing) : null;
  }

  /** A blob's bytes: the local repository first, else the trunk repository (verified, then kept locally). */
  private async blobBytes(blob: Sha): Promise<Uint8Array | null> {
    const g = this.repo();
    try {
      return await readLocalBlob(g, blob);
    } catch {
      const st = this.state();
      const remote = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (r) => r.readBlob(blob)).catch(() => null);
      if (!remote) return null;
      const bytes = new Uint8Array(await remote.arrayBuffer());
      if ((await blobSha(bytes)) !== blob) return null;
      await writeLocalBlob(g, bytes);
      return bytes;
    }
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
      // Every derived index (the co-change map, the import index, path history) and its cursor.
      this.derivedSet().reset();
      this.setMeta("dir", `/trunk-${Date.now().toString(36)}`);
    });
    this.gitRepo = null;
    this.tokenCache = null;
    this.stopPublishing();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The lineage note for a landing. A proposal that landed over files it read that changed records each
* of them under `revalidated`: the blob it read, the blob it landed on, and the names that held. One
* whose files were merged line by line records each under `merged` (its base blob, the blob it landed
* on, the blob it wrote, the result); its write set names the results. One a person approved over a goal conflict
* records the lines of other intents' recent landings it undid under `undoes`. Each proposal's `provenance` says
* how its author and model are known, from the colony's record of the agent (trunk/provenance.ts); a
* proposal whose agent the writer does not know gets none. The note names the landing, never its commit,
* so it is final before the commit is built (the commit carries its digest). Notes are public, so the free
* text agents and people wrote is masked where it looks like a secret (mask.ts). A change the conflict
* resolver wrote records under `resolves` the change it resolves, from the colony's record (the land context).
 */
function buildNote(
  landing: Pick<Landing, "id" | "colonyId">,
  proposals: Proposal[],
  info: { intents: Map<Id, IntentInfo>; agents: Map<Id, AgentLite> },
  ctx: LandContext,
  revalidated: Map<Id, Revalidated[]> = new Map(),
  merged: Map<Id, TextMerged[]> = new Map(),
): LineageNote {
  return maskNote({
    schema: "firetrident.lineage/v1",
    landingId: landing.id,
    colonyId: landing.colonyId,
    proposals: proposals.map((p) => {
      const i = info.intents.get(p.intentId) ?? { title: p.intentId, why: "" };
      const a = info.agents.get(p.agentId);
      const provenance = noteProvenance(a, p.evidence);
      return {
        id: p.id,
        agentId: p.agentId,
        agentKind: a?.kind ?? "internal",
        model: a?.model,
        // What an agent asked for, only when the cap lowered its intent's priority (colony/priority.ts).
        intent: { id: p.intentId, title: i.title, why: i.why, ruleId: i.ruleId, parentId: i.parentId, ...notePriority(i) },
        writeSet: p.writeSet,
        readSet: p.readSet,
        decisions: ctx.decisions?.[p.id] ?? [],
        evidence: p.evidence ?? { checks: [] },
        ...(revalidated.has(p.id) ? { revalidated: revalidated.get(p.id) } : {}),
        ...(merged.has(p.id) ? { merged: merged.get(p.id) } : {}),
        ...noteUndoes(p.undoes),
        ...noteAlternatives(ctx.alternatives, p.id),
        // Conflict resolver: the returned change this one resolves, from the colony's record (colony/resolver.ts).
        ...noteResolves(ctx.resolves, p.id),
        ...(provenance ? { provenance } : {}),
      };
    }),
  });
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
    if (foldPath(seg) === ".git") return `path ${JSON.stringify(path)} touches .git`;
  }
  return null;
}

/** The stale paths of an OCC result, as reasons name them. */
function staleDetail(stale: OccResult["stale"]): string {
  return stale.map((s) => `${s.path} (expected ${s.expected ?? "absent"}, trunk has ${s.actual ?? "absent"})`).join(", ");
}

/** The lineage context of every batch in a cycle, merged. */
function mergeContexts(list: LandContext[]): Required<LandContext> {
  const out: Required<LandContext> = { intents: {}, agents: {}, decisions: {}, alternatives: {}, resolves: {} };
  for (const c of list) {
    Object.assign(out.intents, c?.intents ?? {});
    Object.assign(out.agents, c?.agents ?? {});
    Object.assign(out.decisions, c?.decisions ?? {});
    Object.assign(out.alternatives, c?.alternatives ?? {});
    Object.assign(out.resolves, c?.resolves ?? {});
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
