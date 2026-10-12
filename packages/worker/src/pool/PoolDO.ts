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

/** Most workspaces one colony may hold. */
const MAX_TARGET = 256;
/** Forks issued in parallel. */
const FORK_BATCH = 8;
/** Lease token lifetimes (seconds). */
const LEASE_TTL_S = 3600;
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

type SlotState = "forking" | "ready" | "leased" | "failed";

type SlotRow = {
  n: number;
  shard: number;
  name: string;
  remote: string | null;
  state: SlotState;
  agent_id: string | null;
  token_id: string | null;
  leased_at: number | null;
  attempts: number;
  error: string | null;
};

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ft_pool_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ft_pool_ws (n INTEGER PRIMARY KEY, shard INTEGER NOT NULL, name TEXT NOT NULL, remote TEXT, state TEXT NOT NULL, agent_id TEXT, token_id TEXT, leased_at INTEGER, released_at INTEGER, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT)`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS ft_pool_ws_state ON ft_pool_ws (state)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS ft_pool_ws_agent ON ft_pool_ws (agent_id)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ft_pool_seeds (shard INTEGER PRIMARY KEY, name TEXT NOT NULL, remote TEXT NOT NULL, sha TEXT, pushed_at INTEGER)`);
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  /**
   * Configure the pool and start filling it: create the four shard seeds from trunk main,
   * fork the first batch (up to 8) before returning, and grow the rest toward `target`
   * (at most 256) on the alarm. Calling it again updates the target.
   */
  async init(p: { colonyId: Id; trunk: RepoRef; target: number }): Promise<void> {
    const prev = this.meta("trunk");
    if (prev !== null && (JSON.parse(prev) as RepoRef).name !== p.trunk.name) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM ft_pool_ws`);
        this.sql.exec(`DELETE FROM ft_pool_seeds`);
      });
      this.trunkRead = null;
    }
    this.setMeta("colony_id", p.colonyId);
    this.setMeta("trunk", JSON.stringify(p.trunk));
    this.setMeta("target", String(clampTarget(p.target)));
    await this.ensureSeeds(false);
    await this.grow(GROW_BUDGET_MS, 1);
    await this.schedule(500);
  }

  /**
   * Lease a ready workspace to `agentId` (the same one again if it already holds a lease)
   * with a fresh workspace write token and a read-only trunk token, both valid for an hour.
   * Forks one on demand when none is ready and raises the target; null if that fails.
   */
  async lease(agentId: Id, trunkSha: Sha): Promise<WorkspaceLease | null> {
    const st = this.state();
    for (let attempt = 0; attempt < 3; attempt++) {
      let row: SlotRow | null | undefined = this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE agent_id = ? AND state = 'leased' LIMIT 1`, agentId).toArray()[0];
      if (!row) {
        const now = Date.now();
        row = this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE state = 'ready' ORDER BY COALESCE(released_at, 0), n LIMIT 1`).toArray()[0];
        if (row) {
          this.sql.exec(`UPDATE ft_pool_ws SET state = 'leased', agent_id = ?, leased_at = ? WHERE n = ?`, agentId, now, row.n);
          row = { ...row, state: "leased", agent_id: agentId, leased_at: now };
        }
      }
      if (!row) {
        this.raiseTarget();
        row = await this.forkOnDemand(agentId);
        if (!row) {
          await this.schedule(1_000);
          return null;
        }
      }
      let ws: MintedToken;
      let trunkTok: MintedToken;
      try {
        [ws, trunkTok] = await Promise.all([mintToken(workspaceBinding(this.env, row.shard), row.name, "write", LEASE_TTL_S), this.trunkReadToken()]);
      } catch (e) {
        if (artifactsCode(e) === "NOT_FOUND") {
          this.sql.exec(`UPDATE ft_pool_ws SET state = 'failed', agent_id = NULL, error = ? WHERE n = ?`, `workspace vanished: ${errorText(e)}`, row.n);
          continue;
        }
        this.sql.exec(`UPDATE ft_pool_ws SET state = 'ready', agent_id = NULL, leased_at = NULL WHERE n = ? AND agent_id = ?`, row.n, agentId);
        throw e;
      }
      this.sql.exec(`UPDATE ft_pool_ws SET token_id = ? WHERE n = ?`, ws.id, row.n);
      if (this.counts().ready < Math.ceil(this.target() / 4)) await this.schedule(250);
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

  /** Return `agentId`'s workspace to the pool and revoke its lease token. */
  async release(agentId: Id): Promise<void> {
    const rows = this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE agent_id = ? AND state = 'leased'`, agentId).toArray();
    const now = Date.now();
    for (const r of rows) {
      this.sql.exec(`UPDATE ft_pool_ws SET state = 'ready', agent_id = NULL, token_id = NULL, leased_at = NULL, released_at = ? WHERE n = ?`, now, r.n);
    }
    await Promise.all(
      rows
        .filter((r) => r.token_id !== null)
        .map((r) => withRepo(workspaceBinding(this.env, r.shard), r.name, (repo) => repo.revokeToken(r.token_id!)).catch(() => false)),
    );
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
  }> {
    return {
      target: this.target(),
      counts: this.counts(),
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
    return { deleted, errors };
  }

  /** Keep growing toward the target; back off when every fork fails. */
  async alarm(): Promise<void> {
    if (this.meta("trunk") === null) return;
    let made = 0;
    try {
      made = await this.grow(GROW_BUDGET_MS, Infinity);
    } catch (e) {
      console.error(`pool grow failed: ${errorText(e)}`);
    }
    await this.schedule(made > 0 ? 250 : 30_000);
  }

  // -------------------------------------------------------------------------
  // Growth
  // -------------------------------------------------------------------------

  /** Fork batches of up to 8 toward the target, within a time budget. Single-flight. Returns slots made ready. */
  private grow(budgetMs: number, maxBatches: number): Promise<number> {
    if (this.growJob) return this.growJob;
    const job = (async () => {
      const t0 = Date.now();
      let made = 0;
      await this.ensureSeeds(true);
      for (let batches = 0; batches < maxBatches && Date.now() - t0 < budgetMs; batches++) {
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
      return true;
    } catch (e) {
      this.sql.exec(`UPDATE ft_pool_ws SET state = 'failed', attempts = attempts + 1, error = ? WHERE n = ?`, errorText(e), row.n);
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

  /** Leases exhausted the pool: grow the target by a quarter (at least 4), up to 256. */
  private raiseTarget(): void {
    const c = this.counts();
    const total = c.ready + c.leased + c.forking;
    const next = clampTarget(Math.max(this.target(), total + Math.max(4, Math.ceil(total / 4))));
    this.setMeta("target", String(next));
  }

  private counts(): Record<SlotState, number> {
    const out: Record<SlotState, number> = { forking: 0, ready: 0, leased: 0, failed: 0 };
    for (const r of this.sql.exec<{ state: SlotState; n: number }>(`SELECT state, COUNT(*) AS n FROM ft_pool_ws GROUP BY state`).toArray()) out[r.state] = r.n;
    return out;
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

/** Target clamped to 0..256. */
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
