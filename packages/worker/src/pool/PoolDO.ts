import { DurableObject } from "cloudflare:workers";
import type { Id, RepoRef, Sha, WorkspaceLease } from "@fire_trident/core";
import { WORKSPACE_SHARDS, type Env } from "../env.ts";
import {
  TokenCache,
  artifactsCode,
  ensureRepo,
  errorText,
  fetchRef,
  getRepoIfExists,
  isAuthError,
  dispose,
  mintToken,
  pushRef,
  resolveLocal,
  setRef,
  sleep,
  withArtifactsRetry,
  withRepo,
  type GitRepo,
  type MintedToken,
} from "../artifacts/git.ts";
import { durableFs } from "../artifacts/workspace.ts";
import { TRUNK_NAMESPACE, bindingFor, seedRepoName, workspaceBinding, workspaceNamespace, workspaceRepoName } from "../artifacts/shards.ts";
import { CLEAN_AFTER_MS, SlotBook, TOKEN_TTL_S, reusable, type SlotRow, type SlotState, type SlotToken, type TokenOps } from "./slots.ts";
import { LEGACY_FLOOR, LeaseGuard, QUIET_MS, SWEEP_EVERY_MS, nextSweepAt, oldLeases, shrunkTarget, sweepLeases } from "./upkeep.ts";

/** Most workspaces one colony may hold (thousands of concurrent agents each hold one). */
const MAX_TARGET = 8_192;
/** Forks issued in parallel: six per workspace shard, so the four namespaces fork side by side. */
const FORK_BATCH = 24;
/** Trunk read token lifetime (seconds). */
const LEASE_TTL_S = 3600;
/** Background token work (cleaning released slots, pre-minting) per alarm, and its concurrency. */
const CHORES_PER_ALARM = 400;
const CHORE_CONCURRENCY = 8;
/** A released slot is looked at again once its token may be cleaned. */
const CLEAN_DELAY_MS = CLEAN_AFTER_MS + 5_000;
/** Leases waiting on Artifacts calls (a token to replace, a fork on demand) at once; more answer null (see lease). */
const MAX_SLOW_LEASES = 16;
/** Forks of a repo pushed less than this long ago fail often; wait it out. */
const SEED_SETTLE_MS = 2_000;
/** Backoff between fork attempts on INTERNAL_ERROR. */
const FORK_RETRY_MS = [500, 1_000, 2_000, 4_000];
/** Attempts per workspace slot before it is left failed. */
const MAX_SLOT_ATTEMPTS = 5;
/** Work per alarm. */
const GROW_BUDGET_MS = 20_000;
/** Seeds older than this are refreshed to current trunk before more forks. */
const SEED_REFRESH_MS = 10 * 60_000;
/** A cached trunk read token is reused while it has this much life left. */
const TRUNK_READ_MARGIN_MS = 15 * 60_000;

type SeedRow = {
  shard: number;
  name: string;
  remote: string;
  sha: string | null;
  pushed_at: number | null;
};

/**
 * Warm pool of workspace repos for one colony. Forks stay in their source's namespace, so
 * each workspace shard (ft-ws-0..3) holds a seed repo that mirrors trunk main, and workspace
 * `<colony>--ws-<n>` is a fork of the seed in shard n % 4. Seeds are pushed only when they
 * are created or refreshed, so forks almost never race a push.
 */
export class PoolDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private gitRepo: GitRepo | null = null;
  private trunkRead: TokenCache | null = null;
  private seedJob: Promise<void> | null = null;
  private growJob: Promise<number> | null = null;
  private choreJob: Promise<number> | null = null;
  /** Leases in flight that wait on Artifacts calls (see MAX_SLOW_LEASES). */
  private slowLeases = 0;
  /** Slots, leases and their tokens (pool/slots.ts): the lease path is SQL only. */
  private book: SlotBook;
  /** Agents the lease sweep leaves alone while their lease calls run (pool/upkeep.ts), and when it last ran. */
  private readonly leaseGuard = new LeaseGuard();
  private lastSweepAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ft_pool_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // The slot table (with lease affinity and per-slot tokens; older pools get the columns added).
    this.book = new SlotBook(this.sql, this.tokenOps());
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ft_pool_seeds (shard INTEGER PRIMARY KEY, name TEXT NOT NULL, remote TEXT NOT NULL, sha TEXT, pushed_at INTEGER)`);
  }

  /** The Artifacts calls behind slot tokens: a write token per workspace, revoked by id. */
  private tokenOps(): TokenOps {
    return {
      mint: async (slot): Promise<SlotToken> => {
        const t = await mintToken(workspaceBinding(this.env, slot.shard), slot.name, "write", TOKEN_TTL_S);
        return { id: t.id, token: t.token, expiresAt: t.expiresAt };
      },
      revoke: async (slot, tokenId): Promise<void> => {
        await withArtifactsRetry(() => withRepo(workspaceBinding(this.env, slot.shard), slot.name, (repo) => repo.revokeToken(tokenId)));
      },
    };
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  /**
   * Configure the pool and start filling it: create the four shard seeds from trunk main,
   * fork the first batch (up to FORK_BATCH) before returning, and grow the rest toward `target`
   * (at most MAX_TARGET) on the alarm. Calling it again updates the target.
   */
  async init(p: { colonyId: Id; trunk: RepoRef; target: number }): Promise<void> {
    const prev = this.meta("trunk");
    if (prev !== null && (JSON.parse(prev) as RepoRef).name !== p.trunk.name) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM ft_pool_ws`);
        this.sql.exec(`DELETE FROM ft_pool_seeds`);
      });
      this.book.touched();
      this.trunkRead = null;
    }
    this.setMeta("colony_id", p.colonyId);
    this.setMeta("trunk", JSON.stringify(p.trunk));
    this.setMeta("target", String(clampTarget(p.target)));
    // The target a quiet pool comes back down to, and the start of its quiet period (pool/upkeep.ts).
    this.setMeta("floor", String(clampTarget(p.target)));
    this.setMeta("raised_at", String(Date.now()));
    await this.ensureSeeds(false);
    await this.grow(GROW_BUDGET_MS, 1);
    await this.schedule(500);
  }

  /**
   * Lease a ready workspace to `agentId` (the same one again if it already holds a lease)
   * with a workspace write token (at least 30 minutes of life left) and a read-only trunk token.
   * Affinity: an agent gets back the workspace it last held when that one is ready, else one
   * with a clean pre-minted token, else a never-used one, else the longest idle. Its local
   * clone already has that workspace's objects, so its next push carries only what is new.
   * In steady state this is SQL only: the slot's token is the agent's own from its last lease or
   * a clean one minted in the background (pool/slots.ts); only a slot another agent left behind
   * needs its token revoked and replaced here. Forks one on demand when none is ready and raises
   * the target; null if that fails.
   */
  async lease(agentId: Id, trunkSha: Sha): Promise<WorkspaceLease | null> {
    // The lease sweep (pool/upkeep.ts) never frees an agent's slot while its lease call runs.
    this.leaseGuard.enter(agentId);
    try {
      return await this.leaseNow(agentId, trunkSha);
    } finally {
      this.leaseGuard.leave(agentId);
    }
  }

  /** lease(), inside the sweep's guard. */
  private async leaseNow(agentId: Id, trunkSha: Sha): Promise<WorkspaceLease | null> {
    const st = this.state();
    for (let attempt = 0; attempt < 3; attempt++) {
      let row: SlotRow | null = this.book.take(agentId);
      if (!row) {
        this.raiseTarget();
        // The pool is out of workspaces: fork one now, unless enough leases already wait on Artifacts.
        if (this.slowLeases >= MAX_SLOW_LEASES) {
          await this.schedule(250);
          return null;
        }
        this.slowLeases++;
        try {
          row = await this.forkOnDemand(agentId);
        } finally {
          this.slowLeases--;
        }
        if (!row) {
          await this.schedule(1_000);
          return null;
        }
      }
      // A slot whose token must be replaced (another agent's, or none yet) costs Artifacts calls. Those are
      // capped: past MAX_SLOW_LEASES the lease answers null at once (the agent retries shortly) instead of
      // queueing every take behind the control plane, and the pool grows so agents keep their own workspaces.
      const slow = !reusable(row, agentId, Date.now());
      if (slow && this.slowLeases >= MAX_SLOW_LEASES) {
        this.book.unlease(row.n, agentId);
        this.raiseTarget();
        await this.schedule(250);
        return null;
      }
      if (slow) this.slowLeases++;
      let ws: SlotToken;
      let trunkTok: MintedToken;
      try {
        const [armed, t] = await Promise.all([this.book.arm(row, agentId), this.trunkReadToken()]);
        ws = armed.token;
        trunkTok = t;
      } catch (e) {
        if (artifactsCode(e) === "NOT_FOUND") {
          this.sql.exec(`UPDATE ft_pool_ws SET state = 'failed', agent_id = NULL, error = ? WHERE n = ?`, `workspace vanished: ${errorText(e)}`, row.n);
          this.book.touched();
          continue;
        }
        this.book.unlease(row.n, agentId);
        throw e;
      } finally {
        if (slow) this.slowLeases--;
      }
      const c = this.book.counts();
      if (c.ready < Math.ceil(this.target() / 4)) await this.schedule(250);
      return {
        repo: { namespace: workspaceNamespace(row.shard), name: row.name, remote: row.remote ?? "" },
        token: ws.token,
        tokenExpiresAt: ws.expiresAt,
        baseSha: trunkSha,
        leasedAt: row.leased_at ?? Date.now(),
        trunk: { remote: st.trunk.remote, token: trunkTok.token, sha: trunkSha },
      };
    }
    return null;
  }

  /**
   * Return `agentId`'s workspace to the pool. Its token stays valid for that agent, which usually
   * leases the same workspace again within seconds; if it does not, the alarm revokes the token
   * and mints a clean one within about a minute. No other agent ever gets a slot before its
   * previous agent's token is revoked (SlotBook.arm).
   */
  async release(agentId: Id): Promise<void> {
    if (this.book.release(agentId) > 0) await this.armAlarm(CLEAN_DELAY_MS);
  }

  /** release() for many agents in one call (a landing settles a whole batch). Returns the slots released. */
  async releaseMany(agentIds: Id[]): Promise<number> {
    let n = 0;
    for (const id of new Set(Array.isArray(agentIds) ? agentIds : [])) if (typeof id === "string" && id !== "") n += this.book.release(id);
    if (n > 0) await this.armAlarm(CLEAN_DELAY_MS);
    return n;
  }

  /** Pool counters. */
  async status(): Promise<{ ready: number; leased: number; forking: number; target: number }> {
    const c = this.counts();
    return { ready: c.ready, leased: c.leased, forking: c.forking, target: this.target() };
  }

  /** Detailed state for operators and tests: slots, seeds, failures. */
  async stats(): Promise<{
    target: number;
    counts: Record<SlotState, number>;
    seeds: Array<{ shard: number; name: string; sha: string | null; pushedAt: number | null }>;
    failures: Array<{ n: number; name: string; attempts: number; error: string | null }>;
    /** Ready slots holding a clean token (leased without an Artifacts call), and token chores waiting. */
    tokens: { clean: number; chores: number };
  }> {
    return {
      target: this.target(),
      counts: this.counts(),
      tokens: this.book.readiness(),
      seeds: this.sql.exec<SeedRow>(`SELECT * FROM ft_pool_seeds ORDER BY shard`).toArray().map((s) => ({ shard: s.shard, name: s.name, sha: s.sha, pushedAt: s.pushed_at })),
      failures: this.sql
        .exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE state = 'failed' ORDER BY n`)
        .toArray()
        .map((r) => ({ n: r.n, name: r.name, attempts: r.attempts, error: r.error })),
    };
  }

  /** Delete every workspace and seed repo of this pool and forget them (colony teardown). */
  async teardown(): Promise<{ deleted: number; errors: string[] }> {
    await this.ctx.storage.deleteAlarm();
    this.setMeta("target", "0");
    const slots = this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws`).toArray();
    const seeds = this.sql.exec<SeedRow>(`SELECT * FROM ft_pool_seeds`).toArray();
    const jobs = [...slots.map((s) => ({ shard: s.shard, name: s.name })), ...seeds.map((s) => ({ shard: s.shard, name: s.name }))];
    const errors: string[] = [];
    let deleted = 0;
    for (let i = 0; i < jobs.length; i += 4) {
      await Promise.all(
        jobs.slice(i, i + 4).map(async (j) => {
          try {
            if (await withArtifactsRetry(() => workspaceBinding(this.env, j.shard).delete(j.name))) deleted++;
          } catch (e) {
            errors.push(`${workspaceNamespace(j.shard)}/${j.name}: ${errorText(e)}`);
          }
        }),
      );
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM ft_pool_ws`);
      this.sql.exec(`DELETE FROM ft_pool_seeds`);
    });
    this.book.touched();
    return { deleted, errors };
  }

  /**
   * Erase this object (colony deletion, after teardown): cancel the alarm and delete all storage,
   * then replay the DDL of its own `ft_` tables so a later init() starts from empty tables.
   * The git storage is rebuilt on next use.
   */
  async destroy(): Promise<{ cleared: true }> {
    const ddl = this.sql.exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE substr(name, 1, 3) = 'ft_' AND sql IS NOT NULL ORDER BY rowid`).toArray();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    for (const { sql } of ddl) this.sql.exec(sql);
    this.gitRepo = null;
    this.trunkRead = null;
    this.book.touched();
    return { cleared: true };
  }

  /**
   * Keep growing toward the target (back off when every fork fails), then the token chores: slots
   * an agent left a while ago get their token revoked and a clean one minted, new and expiring
   * slots get one, so leases find tokens ready.
   */
  async alarm(): Promise<void> {
    if (this.meta("trunk") === null) return;
    let made = 0;
    let cleaned = 0;
    // Upkeep (pool/upkeep.ts): free leases whose agents hold no workspace any more, and lower a quiet pool's target.
    try {
      await this.upkeep();
    } catch (e) {
      console.error(`pool upkeep failed: ${errorText(e)}`);
    }
    try {
      made = await this.grow(GROW_BUDGET_MS, Infinity);
    } catch (e) {
      console.error(`pool grow failed: ${errorText(e)}`);
    }
    try {
      cleaned = await this.chores();
    } catch (e) {
      console.error(`pool token chores failed: ${errorText(e)}`);
    }
    await this.schedule(made > 0 ? 250 : 30_000);
    const pending = this.book.readiness().chores;
    if (pending > 0) await this.armAlarm(cleaned > 0 ? 250 : 30_000);
    else {
      const at = this.book.nextChoreAt();
      if (at !== null) await this.armAlarm(Math.max(250, at - Date.now()));
    }
    // The next lease sweep, while anything is leased.
    const sweepAt = nextSweepAt(this.sql, this.lastSweepAt);
    if (sweepAt !== null) await this.armAlarm(Math.max(250, sweepAt - Date.now()));
  }

  /**
   * One round of upkeep (pool/upkeep.ts): at most every SWEEP_EVERY_MS, the old leases whose agents the colony no longer
   * counts as holding a workspace are released (a colony that does not answer frees nothing); and after a quiet period
   * with no raise, the target comes down toward the leases held now, never below the target the pool was created with.
   */
  private async upkeep(): Promise<void> {
    const now = Date.now();
    const colonyId = this.meta("colony_id");
    if (colonyId && now - this.lastSweepAt >= SWEEP_EVERY_MS && oldLeases(this.sql, now, 1).length > 0) {
      this.lastSweepAt = now;
      const colony = this.env.COLONY.get(this.env.COLONY.idFromName(colonyId)) as unknown as { leaseHolders(agentIds: Id[]): Promise<Id[]> };
      const swept = await sweepLeases({ sql: this.sql, now, guard: this.leaseGuard, holders: (ids) => colony.leaseHolders(ids), release: (id) => this.book.release(id) });
      if (swept.skipped) console.warn(`pool lease sweep freed nothing: ${swept.skipped}`);
      if (swept.released.length > 0) {
        this.book.touched();
        console.log(`pool lease sweep released the workspaces of ${swept.released.length} agent(s) that hold none in the colony`);
        await this.armAlarm(CLEAN_DELAY_MS);
      }
    }
    const raised = Number(this.meta("raised_at") ?? Number.NaN);
    if (!Number.isFinite(raised)) {
      // A pool from before upkeep: its quiet period starts now.
      this.setMeta("raised_at", String(now));
      return;
    }
    this.book.touched();
    const target = this.target();
    const floorMeta = this.meta("floor");
    const floor = floorMeta !== null ? clampTarget(Number(floorMeta)) : Math.min(target, LEGACY_FLOOR);
    const next = shrunkTarget({ target, floor, leased: this.counts().leased, quietSince: raised, now });
    if (next !== null) {
      this.setMeta("target", String(next));
      console.log(`pool target lowered from ${target} to ${next}: no lease found the pool empty for ${QUIET_MS / 60_000} minutes`);
    }
  }

  /** Token chores (SlotBook.maintain), single-flight. Returns how many slots got a clean token. */
  private chores(): Promise<number> {
    if (this.choreJob) return this.choreJob;
    this.choreJob = this.book.maintain(CHORES_PER_ALARM, CHORE_CONCURRENCY).finally(() => {
      this.choreJob = null;
    });
    return this.choreJob;
  }

  /** Make sure the alarm fires within `delayMs`. */
  private async armAlarm(delayMs: number): Promise<void> {
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // -------------------------------------------------------------------------
  // Growth
  // -------------------------------------------------------------------------

  /**
   * Fork batches of up to FORK_BATCH (spread over the four workspace shards) toward the target,
   * within a time budget. Single-flight. Returns slots made ready.
   */
  private grow(budgetMs: number, maxBatches: number): Promise<number> {
    if (this.growJob) return this.growJob;
    // Nothing to fork: leave the seeds alone. Refreshing a seed fetches and pushes every trunk commit
    // since the last refresh through isomorphic-git (seconds of CPU once thousands of landings
    // accumulate), and it used to run on every alarm, stalling leases at full load.
    this.book.touched();
    const c0 = this.counts();
    if (this.target() - (c0.ready + c0.leased + c0.forking) <= 0) return Promise.resolve(0);
    // Only a quiet pool refreshes its seeds: under load new workspaces fork from the seeds as they are
    // (a workspace's prior content never matters; a fresher one only makes an agent's first push smaller).
    const quiet = c0.leased === 0;
    const job = (async () => {
      const t0 = Date.now();
      let made = 0;
      await this.ensureSeeds(quiet);
      for (let batches = 0; batches < maxBatches && Date.now() - t0 < budgetMs; batches++) {
        this.book.touched();
        const c = this.counts();
        const need = this.target() - (c.ready + c.leased + c.forking);
        if (need <= 0) break;
        const retry = this.sql
          .exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE state = 'failed' AND attempts < ? ORDER BY n LIMIT ?`, MAX_SLOT_ATTEMPTS, Math.min(need, FORK_BATCH))
          .toArray();
        const rows = [...retry, ...this.allocate(Math.min(need, FORK_BATCH) - retry.length, null)];
        if (rows.length === 0) break;
        for (const r of rows) this.sql.exec(`UPDATE ft_pool_ws SET state = 'forking' WHERE n = ?`, r.n);
        const ok = await Promise.all(rows.map((r) => this.forkInto(r)));
        const good = ok.filter(Boolean).length;
        made += good;
        if (good === 0) break;
      }
      return made;
    })();
    this.growJob = job.finally(() => {
      this.growJob = null;
    });
    return this.growJob;
  }

  /** Allocate `count` new slots (numbered after the highest), optionally reserved for an agent. */
  private allocate(count: number, agentId: Id | null): SlotRow[] {
    if (count <= 0) return [];
    const st = this.state();
    const next = this.sql.exec<{ next: number }>(`SELECT COALESCE(MAX(n), -1) + 1 AS next FROM ft_pool_ws`).one().next;
    const now = Date.now();
    const rows: SlotRow[] = [];
    for (let i = 0; i < count; i++) {
      const n = next + i;
      const shard = n % WORKSPACE_SHARDS;
      const name = workspaceRepoName(st.colonyId, n);
      this.sql.exec(`INSERT INTO ft_pool_ws (n, shard, name, state, agent_id, created_at) VALUES (?, ?, ?, 'forking', ?, ?)`, n, shard, name, agentId, now);
      rows.push({ n, shard, name, remote: null, state: "forking", agent_id: agentId, token_id: null, leased_at: null, attempts: 0, error: null });
    }
    this.book.touched();
    return rows;
  }

  /** Fork one slot now for an agent with nothing ready; the slot comes back leased. */
  private async forkOnDemand(agentId: Id): Promise<SlotRow | null> {
    await this.ensureSeeds(false);
    const [row] = this.allocate(1, agentId);
    if (!row) return null;
    if (!(await this.forkInto(row))) {
      this.sql.exec(`UPDATE ft_pool_ws SET agent_id = NULL WHERE n = ?`, row.n);
      return null;
    }
    return this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE n = ?`, row.n).toArray()[0] ?? null;
  }

  /** Fork the slot's repo from its shard seed (retrying INTERNAL_ERROR with backoff) and record the result. */
  private async forkInto(row: SlotRow): Promise<boolean> {
    const seed = this.seed(row.shard);
    if (!seed || seed.sha === null) {
      this.sql.exec(`UPDATE ft_pool_ws SET state = 'failed', attempts = attempts + 1, error = ? WHERE n = ?`, `no seed in shard ${row.shard}`, row.n);
      return false;
    }
    const settle = (seed.pushed_at ?? 0) + SEED_SETTLE_MS - Date.now();
    if (settle > 0) await sleep(settle);
    const binding = workspaceBinding(this.env, row.shard);
    try {
      const remote = await forkWithRetry(binding, seed.name, row.name, `FireTrident workspace ${row.n} of ${this.meta("colony_id") ?? ""}`);
      const now = Date.now();
      const agent = this.sql.exec<{ agent_id: string | null }>(`SELECT agent_id FROM ft_pool_ws WHERE n = ?`, row.n).toArray()[0]?.agent_id ?? null;
      this.sql.exec(
        `UPDATE ft_pool_ws SET state = ?, remote = ?, attempts = attempts + 1, error = NULL, leased_at = ? WHERE n = ?`,
        agent === null ? "ready" : "leased",
        remote,
        agent === null ? null : now,
        row.n,
      );
      this.book.touched();
      return true;
    } catch (e) {
      this.sql.exec(`UPDATE ft_pool_ws SET state = 'failed', attempts = attempts + 1, error = ? WHERE n = ?`, errorText(e), row.n);
      this.book.touched();
      return false;
    }
  }

  /**
   * Make sure every shard has a seed holding trunk main. With `refresh`, seeds more than
   * 10 minutes old are re-pushed when trunk has moved. Single-flight.
   */
  private ensureSeeds(refresh: boolean): Promise<void> {
    if (this.seedJob) return this.seedJob;
    const job = (async () => {
      const st = this.state();
      const now = Date.now();
      const seeds = new Map(this.sql.exec<SeedRow>(`SELECT * FROM ft_pool_seeds`).toArray().map((s) => [s.shard, s]));
      let head: Sha | null = null;
      if (refresh && [...seeds.values()].some((s) => now - (s.pushed_at ?? 0) > SEED_REFRESH_MS)) head = await this.trunkHead();
      const todo: number[] = [];
      for (let shard = 0; shard < WORKSPACE_SHARDS; shard++) {
        const s = seeds.get(shard);
        const stale = s !== undefined && s.sha !== null && head !== null && s.sha !== head && now - (s.pushed_at ?? 0) > SEED_REFRESH_MS;
        if (!s || s.sha === null || stale) todo.push(shard);
      }
      if (todo.length === 0) return;

      const g = this.repo();
      await ensureRepo(g, st.trunk.remote);
      const hadMain = (await resolveLocal(g, "refs/heads/main")) !== null;
      const fetchMain = async () => fetchRef(g, { url: st.trunk.remote, token: (await this.trunkReadToken()).token, ref: "refs/heads/main", depth: hadMain ? undefined : 1 });
      let fetched: Sha | null;
      try {
        fetched = await fetchMain();
      } catch (e) {
        if (!isAuthError(e)) throw e;
        this.trunkRead?.invalidate();
        fetched = await fetchMain();
      }
      if (fetched === null) throw new Error(`trunk ${st.trunk.name} has no main branch`);
      await setRef(g, "refs/heads/main", fetched);

      const name = seedRepoName(st.colonyId);
      await Promise.all(
        todo.map(async (shard) => {
          const binding = workspaceBinding(this.env, shard);
          let remote = seeds.get(shard)?.remote;
          if (!remote) {
            remote = await createOrGet(binding, name, `FireTrident seed of ${st.colonyId} (mirrors trunk main)`);
            this.sql.exec(`INSERT OR REPLACE INTO ft_pool_seeds (shard, name, remote, sha, pushed_at) VALUES (?, ?, ?, NULL, NULL)`, shard, name, remote);
          }
          const tok = await mintToken(binding, name, "write", 600);
          const res = await pushRef(g, { url: remote, token: tok.token, localRef: "refs/heads/main", remoteRef: "refs/heads/main", force: true, remote: `seed${shard}` });
          if (!res.ok) throw new Error(`seed push to ${workspaceNamespace(shard)}/${name} failed: ${res.detail}`);
          this.sql.exec(`UPDATE ft_pool_seeds SET sha = ?, pushed_at = ? WHERE shard = ?`, fetched, Date.now(), shard);
        }),
      );
    })();
    this.seedJob = job.finally(() => {
      this.seedJob = null;
    });
    return this.seedJob;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private state(): { colonyId: Id; trunk: RepoRef } {
    const colonyId = this.meta("colony_id");
    const trunk = this.meta("trunk");
    if (colonyId === null || trunk === null) throw new Error("PoolDO is not initialized; call init first");
    return { colonyId, trunk: JSON.parse(trunk) as RepoRef };
  }

  private target(): number {
    return clampTarget(Number(this.meta("target") ?? "0"));
  }

  /** Leases exhausted the pool: grow the target by a quarter (at least 4), up to MAX_TARGET (8,192); the quiet period starts over. */
  private raiseTarget(): void {
    const c = this.counts();
    const total = c.ready + c.leased + c.forking;
    const next = clampTarget(Math.max(this.target(), total + Math.max(4, Math.ceil(total / 4))));
    this.setMeta("target", String(next));
    this.setMeta("raised_at", String(Date.now()));
  }

  private counts(): Record<SlotState, number> {
    return this.book.counts();
  }

  private seed(shard: number): SeedRow | null {
    return this.sql.exec<SeedRow>(`SELECT * FROM ft_pool_seeds WHERE shard = ?`, shard).toArray()[0] ?? null;
  }

  /** Set the alarm `delayMs` from now when the pool is below target (or has retryable failures). */
  private async schedule(delayMs: number): Promise<void> {
    const c = this.counts();
    const retryable = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_pool_ws WHERE state = 'failed' AND attempts < ?`, MAX_SLOT_ATTEMPTS).one().n;
    if (c.ready + c.leased + c.forking >= this.target() && retryable === 0) return;
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private repo(): GitRepo {
    if (!this.gitRepo) this.gitRepo = { fs: durableFs(this.ctx.storage), dir: "/pool", cache: {} };
    return this.gitRepo;
  }

  private trunkBinding(trunk: RepoRef): Artifacts {
    return bindingFor(this.env, trunk.namespace || TRUNK_NAMESPACE) ?? this.env.ARTIFACTS;
  }

  /** Read-only trunk token shared by leases, re-minted with 15 minutes left. */
  private trunkReadToken(): Promise<MintedToken> {
    if (!this.trunkRead) {
      this.trunkRead = new TokenCache(() => {
        const st = this.state();
        return mintToken(this.trunkBinding(st.trunk), st.trunk.name, "read", LEASE_TTL_S);
      }, TRUNK_READ_MARGIN_MS);
    }
    return this.trunkRead.get();
  }

  private async trunkHead(): Promise<Sha | null> {
    const st = this.state();
    try {
      const log = await withRepo(this.trunkBinding(st.trunk), st.trunk.name, (r) => r.log({ ref: "main", limit: 1 }));
      return log[0]?.hash ?? null;
    } catch {
      return null;
    }
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>(`SELECT value FROM ft_pool_meta WHERE key = ?`, key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO ft_pool_meta (key, value) VALUES (?, ?)`, key, value);
  }
}

/** Target clamped to 0..MAX_TARGET (8,192). */
function clampTarget(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_TARGET, Math.floor(n))) : 0;
}

/** Fork `source` to `name` in the same namespace, retrying transient failures; an existing `name` is reused. */
async function forkWithRetry(binding: Artifacts, source: string, name: string, description: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await withRepo(binding, source, (repo) => repo.fork(name, { description, defaultBranchOnly: true }));
      return res.remote;
    } catch (e) {
      const code = artifactsCode(e);
      if (code === "ALREADY_EXISTS") {
        const repo = await getRepoIfExists(binding, name);
        if (repo) {
          try {
            return (await repo.info()).remote;
          } finally {
            dispose(repo);
          }
        }
      }
      const transient = code === "INTERNAL_ERROR" || code === "FORK_IN_PROGRESS" || code === "UPSTREAM_UNAVAILABLE" || code === "ALREADY_EXISTS";
      if (!transient || attempt >= FORK_RETRY_MS.length) throw e;
      await sleep(FORK_RETRY_MS[attempt]! * (0.75 + Math.random() * 0.5));
    }
  }
}

/** Create repo `name` (default branch main), or reuse it when it already exists; returns its remote. */
async function createOrGet(binding: Artifacts, name: string, description: string): Promise<string> {
  try {
    return (await withArtifactsRetry(() => binding.create(name, { description, setDefaultBranch: "main" }))).remote;
  } catch (e) {
    if (artifactsCode(e) !== "ALREADY_EXISTS") throw e;
    const repo = await getRepoIfExists(binding, name);
    if (!repo) throw e;
    try {
      return (await repo.info()).remote;
    } finally {
      dispose(repo);
    }
  }
}
