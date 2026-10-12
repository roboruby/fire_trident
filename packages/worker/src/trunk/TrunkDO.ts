import { DurableObject } from "cloudflare:workers";
import { landingMessage, newId, regionOf, serializeNote, validateProposal } from "@fire_trident/core";
import type { AgentKind, ColonySnapshot, Decision, FileVersion, Id, Landing, LineageNote, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import {
  NEW_FILE_MODE,
  NOTES_REF,
  TokenCache,
  addNoteObject,
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
  readNoteText,
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
import { durableFs } from "../artifacts/workspace.ts";
import { TRUNK_NAMESPACE, bindingFor } from "../artifacts/shards.ts";

/** Trunk write token lifetime, and how long before expiry it is replaced. */
const TOKEN_TTL_S = 6 * 3600;
const TOKEN_MARGIN_MS = 10 * 60_000;
/** History fetched at init; older bases are read through the binding. */
const INIT_DEPTH = 1;
/** Rebuilds of one batch on a moved trunk before its proposals go back. */
const MAX_REBUILDS = 3;
/** Retry delay for a failed notes push. */
const NOTES_RETRY_MS = 30_000;
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

/** A proposal sent back from `land`, with the exact reason. */
export interface Returned {
  proposalId: Id;
  reason: string;
}

type IntentInfo = { title: string; why: string; ruleId?: Id; parentId?: Id };
type AgentLite = { kind: AgentKind; model?: string };
type StagedChange = { blob: Sha; mode: string; size: number; before: Sha | null } | { blob: null; before: Sha | null };

/** A proposal that passed screening, with its effective changes (new blobs already written locally). */
interface Staged {
  p: Proposal;
  changes: Map<Path, StagedChange>;
}

/** Everything needed to record a landing, journaled before the trunk push. */
interface JournalData {
  landing: Landing;
  note: string;
  changes: Array<[Path, StagedChange]>;
}

/** A definitive problem with one proposal (it goes back to its agent). */
class ProposalProblem extends Error {}

/**
 * The only writer of trunk. Holds trunk cloned into a @cloudflare/computer Workspace (SQLite VFS,
 * no working tree), a path → blob index of trunk main, and the lineage tables. Every mutation
 * (init, land, notes flush, mirror) runs on one serial chain.
 */
export class TrunkDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private gitRepo: GitRepo | null = null;
  private tokenCache: TokenCache | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly intentCache = new Map<Id, IntentInfo>();
  private readonly agentCache = new Map<Id, AgentLite>();
  private lastSnapshotAt = 0;

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
    return this.serial(() => this.initNow(p));
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
   * Land a batch as one trunk commit. Each proposal is re-validated against trunk at landing
   * time (read set, base of the write set, tree shape, blob ids); failures come back in
   * `returned` with the reason. The rest build one commit by tree surgery on main, pushed
   * with compare-and-swap; on a moved trunk the batch is rebuilt if its paths are untouched.
   * The lineage note is pushed right after, on the same serial chain.
   */
  async land(batch: Proposal[], ctx?: LandContext): Promise<{ landing?: Landing; returned: Returned[] }> {
    const out = await this.serial(() => this.landNow(batch, ctx ?? {}));
    if (this.pendingNotes() > 0) {
      // The alarm is the safety net if this object is evicted before the flush below runs.
      await this.armAlarm(NOTES_RETRY_MS);
      void this.serial(() => this.flushNotesNow()).catch(() => undefined);
    }
    return out;
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
    return this.serial(() => this.flushNotesNow());
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

  /** Operational counters (for status pages and tests). */
  async stats(): Promise<{ trunkSha: Sha | null; files: number; landings: number; pendingNotes: number; notesTip: Sha | null }> {
    return {
      trunkSha: this.meta("trunk_sha"),
      files: this.fileCount(),
      landings: this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_landings`).one().n,
      pendingNotes: this.pendingNotes(),
      notesTip: this.meta("notes_tip"),
    };
  }

  /** Retries a failed notes push. */
  async alarm(): Promise<void> {
    await this.serial(() => this.flushNotesNow()).catch(() => undefined);
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
    await this.flushNotesNow();
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

  private async landNow(batch: Proposal[], ctx: LandContext): Promise<{ landing?: Landing; returned: Returned[] }> {
    this.state();
    await this.recoverJournal();
    const returned: Returned[] = [];

    // Idempotency: a retried batch that already landed gets its landing back.
    const fresh: Proposal[] = [];
    const prior = new Map<Id, Id>();
    for (const p of batch) {
      const row = this.sql.exec<{ landing_id: string }>(`SELECT landing_id FROM ft_landed WHERE proposal_id = ?`, p?.id ?? "").toArray()[0];
      if (row) prior.set(p.id, row.landing_id);
      else fresh.push(p);
    }
    if (prior.size > 0) {
      const ids = [...new Set(prior.values())];
      if (fresh.length === 0 && ids.length === 1) {
        const landing = this.landingById(ids[0]!);
        if (landing) return { landing, returned: [] };
      }
      for (const [proposalId, landingId] of prior) returned.push({ proposalId, reason: `already landed in ${landingId}` });
    }
    if (fresh.length === 0) return { returned };

    const screened = await this.screen(fresh);
    returned.push(...screened.returned);
    let staged = screened.staged;
    for (let attempt = 0; staged.length > 0; attempt++) {
      const res = await this.commitAndPush(staged, ctx);
      if (res.landing) return { landing: res.landing, returned };
      if (attempt >= MAX_REBUILDS) {
        for (const s of staged) returned.push({ proposalId: s.p.id, reason: `trunk kept moving during landing (${res.detail}); propose again` });
        break;
      }
      const moved = await this.resync();
      const keep: Staged[] = [];
      for (const s of staged) {
        const touched = unique(proposalPaths(s.p)).filter((path) => [...moved].some((m) => overlaps(m, path)));
        if (touched.length > 0) returned.push({ proposalId: s.p.id, reason: `stale: trunk advanced underneath (${touched.join(", ")} changed)` });
        else keep.push(s);
      }
      staged = keep;
    }
    return { returned };
  }

  /**
   * Validate each proposal against current trunk (in batch order) and pull its new blobs
   * from its workspace into the local object store.
   */
  private async screen(proposals: Proposal[]): Promise<{ staged: Staged[]; returned: Returned[] }> {
    const staged: Staged[] = [];
    const returned: Returned[] = [];
    const writes = new Set<Path>();
    const reads = new Set<Path>();
    for (const p of proposals) {
      try {
        const shape = shapeProblem(p);
        if (shape) throw new ProposalProblem(shape);
        const w = p.writeSet.map((f) => f.path);
        const r = p.readSet.map((f) => f.path);
        const clash = w.find((path) => reads.has(path) || [...writes].some((x) => overlaps(x, path))) ?? r.find((path) => writes.has(path));
        if (clash !== undefined) throw new ProposalProblem(`conflicts with another proposal in this landing on ${clash}`);
        const base = await this.baseBlobMap(p.baseSha, w);
        if (base === null) throw new ProposalProblem(`unknown base commit ${p.baseSha}`);
        const occ = validateProposal(p, (path) => this.indexBlob(path), w.map((path) => ({ path, blob: base.get(path) ?? null })));
        if (!occ.eligible) {
          const detail = occ.stale.map((s) => `${s.path} (expected ${s.expected ?? "absent"}, trunk has ${s.actual ?? "absent"})`).join(", ");
          throw new ProposalProblem(`stale: ${detail}`);
        }
        const structural = this.structuralProblem(p);
        if (structural) throw new ProposalProblem(structural);
        const changes = await this.pullBlobs(p);
        staged.push({ p, changes });
        for (const path of w) writes.add(path);
        for (const path of r) reads.add(path);
      } catch (e) {
        if (e instanceof ProposalProblem) returned.push({ proposalId: p?.id ?? "", reason: e.message });
        else throw e;
      }
    }
    return { staged, returned };
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

  /** Read every new blob of `p` from its workspace repo, verify its id, and write it locally. */
  private async pullBlobs(p: Proposal): Promise<Map<Path, StagedChange>> {
    const changes = new Map<Path, StagedChange>();
    const needed: FileVersion[] = [];
    for (const w of p.writeSet) {
      const current = this.indexBlob(w.path);
      if (w.blob === null) {
        if (current !== null) changes.set(w.path, { blob: null, before: current });
      } else if (w.blob !== current) {
        needed.push(w);
      }
    }
    if (needed.length === 0) return changes;
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
      for (const { w, size } of pulled) {
        changes.set(w.path, { blob: w.blob!, mode: this.indexMode(w.path) ?? NEW_FILE_MODE, size, before: this.indexBlob(w.path) });
      }
    } finally {
      dispose(repo);
    }
    return changes;
  }

  /** Build the landing commit on current main and push it with compare-and-swap. */
  private async commitAndPush(staged: Staged[], ctx: LandContext): Promise<{ landing: Landing; detail?: undefined } | { landing?: undefined; detail: string }> {
    const st = this.state();
    const g = this.repo();
    const parent = st.trunkSha;
    const merged = new Map<Path, StagedChange>();
    for (const s of staged) for (const [path, c] of s.changes) merged.set(path, c);
    const treeChanges = new Map<Path, PathChange>();
    for (const [path, c] of merged) treeChanges.set(path, c.blob === null ? null : { blob: c.blob, mode: c.mode });
    const parentTree = await commitTree(g, parent);
    if (parentTree === null) throw new Error(`trunk commit ${parent} is missing locally`);
    const tree = treeChanges.size > 0 ? await applyTreeChanges(g, parentTree, treeChanges) : parentTree;

    const proposals = staged.map((s) => s.p);
    const at = Date.now();
    const id = newId("lnd_");
    const intentIds = unique(proposals.map((p) => p.intentId));
    const info = await this.lineageInfo(proposals, ctx, st.colonyId);
    const message = landingMessage({ id, intentIds }, proposals, info.titles);
    const commit = await writeCommitObject(g, { tree, parents: [parent], message, at });
    const paths = [...merged.keys()].sort();
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
    const data: JournalData = { landing, note, changes: [...merged] };
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
      // The outcome is unknown (network): ask the binding where main is.
      const head = await this.remoteHead().catch(() => null);
      if (head !== commit) {
        this.dropJournal(id);
        throw new Error(`trunk push failed: ${errorText(e)}`);
      }
      outcome = { ok: true };
    }
    if (!outcome.ok) {
      this.dropJournal(id);
      if (outcome.stale) return { detail: outcome.detail };
      throw new Error(`trunk push rejected: ${outcome.detail}`);
    }
    await this.finalize(data);
    return { landing };
  }

  /** Record a pushed landing: index, lineage tables, trunk sha, and the journal moves to pending_note. */
  private async finalize(data: JournalData): Promise<void> {
    const { landing, note, changes } = data;
    this.ctx.storage.transactionSync(() => {
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
    });
    await setRef(this.repo(), MAIN_REF, landing.trunkSha);
  }

  /**
   * Settle landings whose trunk push outcome was never recorded (the object was evicted
   * mid-push): finalize those whose commit reached main, drop the rest.
   */
  private async recoverJournal(): Promise<void> {
    const rows = this.sql.exec<{ landing_id: string; commit_sha: string; data: string }>(`SELECT landing_id, commit_sha, data FROM ft_journal WHERE state = 'pushing' ORDER BY created_at`).toArray();
    if (rows.length === 0) return;
    const st = this.state();
    const recent = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (r) => r.log({ ref: "main", limit: 50 }));
    const onMain = new Set(recent.map((c) => c.hash));
    for (const row of rows) {
      if (onMain.has(row.commit_sha)) await this.finalize(JSON.parse(row.data) as JournalData);
      else this.dropJournal(row.landing_id);
    }
  }

  private dropJournal(landingId: Id): void {
    this.sql.exec(`DELETE FROM ft_journal WHERE landing_id = ?`, landingId);
  }

  /**
   * Push refs/notes/firetrident with compare-and-swap against the last known remote tip,
   * after making sure every pending landing has its note locally. On a moved remote notes
   * ref, rebuilds the pending notes on top of it once.
   */
  private async flushNotesNow(): Promise<{ pending: number }> {
    const pending = this.sql
      .exec<{ landing_id: string; commit_sha: string }>(`SELECT landing_id, commit_sha FROM ft_journal WHERE state = 'pending_note' ORDER BY created_at`)
      .toArray();
    if (pending.length === 0) return { pending: 0 };
    const st = this.state();
    const g = this.repo();
    try {
      await this.ensureLocalNotes(pending);
      const expected = this.meta("notes_tip");
      let res = await this.authed((token) => pushRef(g, { url: st.trunk.remote, token, localRef: NOTES_REF, remoteRef: NOTES_REF, expectedOld: expected }));
      if (!res.ok && res.stale) {
        const local = await resolveLocal(g, NOTES_REF);
        const remote = await this.authed((token) => fetchRef(g, { url: st.trunk.remote, token, ref: NOTES_REF }));
        if (remote !== null && remote === local) {
          res = { ok: true };
        } else {
          if (remote !== null) await setRef(g, NOTES_REF, remote);
          else await deleteLocalRef(g, NOTES_REF);
          await this.ensureLocalNotes(pending, true);
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
      return { pending: pending.length };
    }
  }

  /** Make sure an alarm fires within `delayMs`. */
  private async armAlarm(delayMs: number): Promise<void> {
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /** Add the stored note for each pending landing that the local notes ref lacks (all of them with `force`). */
  private async ensureLocalNotes(rows: Array<{ landing_id: string; commit_sha: string }>, force = false): Promise<void> {
    const g = this.repo();
    for (const row of rows) {
      const note = this.sql.exec<{ note: string }>(`SELECT note FROM ft_notes WHERE landing_id = ?`, row.landing_id).toArray()[0]?.note;
      if (note === undefined) continue;
      if (!force && (await readNoteText(g, NOTES_REF, row.commit_sha)) === note) continue;
      await addNoteObject(g, { ref: NOTES_REF, oid: row.commit_sha, note, at: Date.now() });
    }
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
  private async baseBlobMap(baseSha: Sha, paths: Path[]): Promise<Map<Path, Sha | null> | null> {
    const st = this.state();
    const out = new Map<Path, Sha | null>();
    if (baseSha === st.trunkSha) {
      for (const path of paths) out.set(path, this.indexBlob(path));
      return out;
    }
    if (!isSha(baseSha)) return null;
    const g = this.repo();
    const tree = await commitTree(g, baseSha);
    if (tree !== null) {
      const trees = new Map();
      for (const path of paths) out.set(path, (await blobAt(g, tree, path, trees))?.blob ?? null);
      return out;
    }
    return withRepo(this.trunkBinding(st.trunk), st.trunk.name, async (repo) => {
      const commit = await repo.readCommit(baseSha).catch(() => null);
      if (!commit) return null;
      const trees = new Map<string, ArtifactsTreeEntry[] | null>();
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

/** Every path a proposal reads or writes. */
function proposalPaths(p: Proposal): Path[] {
  return [...p.writeSet.map((f) => f.path), ...p.readSet.map((f) => f.path)];
}

/** Same path, or one is a directory prefix of the other. */
function overlaps(a: Path, b: Path): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
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
