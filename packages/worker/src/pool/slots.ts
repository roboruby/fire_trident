import type { Id } from "@fire_trident/core";

/**
 * The lease book of a workspace pool: which slot each agent holds, and the write token of every
 * slot. Leasing is the hot path of every take, so it is pure SQL here; the Artifacts calls a lease
 * used to make (mint a token on every lease, revoke it on every release: two control-plane calls
 * per take) run in the background instead.
 *
 * Every slot keeps one write token (two hours). A released slot keeps its lessee's token, so when
 * the same agent leases it again (affinity: agents go back to the workspace their clone knows) the
 * token is handed back with no call at all. A slot idle for CLEAN_AFTER_MS gets its token revoked
 * and a fresh one minted for nobody ("clean"), so the next agent gets it without waiting either.
 * A token is never handed to an agent other than the one it was given to: a dirty slot leased by
 * another agent has its token revoked and replaced first (the slow path, only when no clean or
 * affine slot is ready).
 */

/** Write token lifetime (seconds). Leases always get one with at least TOKEN_MIN_LIFE_MS left. */
export const TOKEN_TTL_S = 2 * 3600;
export const TOKEN_MIN_LIFE_MS = 30 * 60_000;
/** A released slot's token is revoked and replaced by a clean one after this long without its agent. */
export const CLEAN_AFTER_MS = 60_000;
/** Slot counts are recomputed at most this often (they only steer growth). */
const COUNTS_TTL_MS = 1_000;

export type SlotState = "forking" | "ready" | "leased" | "failed";

/** One workspace slot as the book stores it. */
export type SlotRow = {
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
  last_agent?: string | null;
  released_at?: number | null;
  token?: string | null;
  token_exp?: number | null;
  /** The agent the current token was handed to; null when no agent ever saw it (clean). */
  token_for?: string | null;
};

/** A minted token. */
export interface SlotToken {
  id: string;
  token: string;
  expiresAt: number;
}

/** The Artifacts calls the book needs, injected (PoolDO passes the bindings; tests pass fakes). */
export interface TokenOps {
  mint(slot: { shard: number; name: string }): Promise<SlotToken>;
  revoke(slot: { shard: number; name: string }, tokenId: string): Promise<void>;
}

/** What `arm` reports: the token, and whether the lease needed an Artifacts call. */
export interface Armed {
  token: SlotToken;
  minted: boolean;
}

/** Add a column to ft_pool_ws when a pool created before it lacks it. */
function ensureColumn(sql: SqlStorage, name: string, type: string): void {
  if (!sql.exec<{ name: string }>(`PRAGMA table_info(ft_pool_ws)`).toArray().some((c) => c.name === name)) {
    sql.exec(`ALTER TABLE ft_pool_ws ADD COLUMN ${name} ${type}`);
  }
}

/** The slot table, its token columns and the indexes the lease path uses (idempotent). */
export function ensureSlotSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ft_pool_ws (n INTEGER PRIMARY KEY, shard INTEGER NOT NULL, name TEXT NOT NULL, remote TEXT, state TEXT NOT NULL, agent_id TEXT, token_id TEXT, leased_at INTEGER, released_at INTEGER, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT)`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS ft_pool_ws_state ON ft_pool_ws (state)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ft_pool_ws_agent ON ft_pool_ws (agent_id)`);
  ensureColumn(sql, "last_agent", "TEXT");
  ensureColumn(sql, "token", "TEXT");
  ensureColumn(sql, "token_exp", "INTEGER");
  ensureColumn(sql, "token_for", "TEXT");
  sql.exec(`CREATE INDEX IF NOT EXISTS ft_pool_ws_affinity ON ft_pool_ws (state, last_agent)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ft_pool_ws_clean ON ft_pool_ws (state, token_for, token_exp)`);
  // Longest idle first (a never-released slot, released_at NULL, sorts first).
  sql.exec(`CREATE INDEX IF NOT EXISTS ft_pool_ws_idle ON ft_pool_ws (state, released_at, n)`);
}

/** Can `row`'s current token go to `agentId` without an Artifacts call? */
export function reusable(row: Pick<SlotRow, "token" | "token_exp" | "token_for">, agentId: Id, now: number): boolean {
  return !!row.token && typeof row.token_exp === "number" && row.token_exp - now >= TOKEN_MIN_LIFE_MS && (row.token_for === null || row.token_for === undefined || row.token_for === agentId);
}

/** The lease book over a PoolDO's SQLite. See the module comment. */
export class SlotBook {
  private countsCache: { at: number; counts: Record<SlotState, number> } | null = null;

  constructor(
    private readonly sql: SqlStorage,
    private readonly ops: TokenOps,
    private readonly now: () => number = Date.now,
  ) {
    ensureSlotSchema(sql);
  }

  /**
   * Pick a slot for `agentId` and mark it leased (no I/O): the one it already holds, else the
   * ready one it last held, else a ready one with a clean token, else a never-used one, else the
   * longest idle. Null when nothing is ready.
   */
  take(agentId: Id): SlotRow | null {
    const held = this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE agent_id = ? AND state = 'leased' LIMIT 1`, agentId).toArray()[0];
    if (held) return held;
    const now = this.now();
    const row =
      this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE state = 'ready' AND last_agent = ? LIMIT 1`, agentId).toArray()[0] ??
      this.sql
        .exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE state = 'ready' AND token_for IS NULL AND token_exp >= ? LIMIT 1`, now + TOKEN_MIN_LIFE_MS)
        .toArray()[0] ??
      this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE state = 'ready' AND last_agent IS NULL LIMIT 1`).toArray()[0] ??
      this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE state = 'ready' ORDER BY released_at, n LIMIT 1`).toArray()[0];
    if (!row) return null;
    this.sql.exec(`UPDATE ft_pool_ws SET state = 'leased', agent_id = ?, leased_at = ? WHERE n = ?`, agentId, now, row.n);
    return { ...row, state: "leased", agent_id: agentId, leased_at: now };
  }

  /**
   * Give a leased slot a token `agentId` may use: its own or a clean one is handed back as is;
   * anything else (none yet, too little life left, or another agent's) is replaced, revoking
   * another agent's token first. Throws when minting fails (the caller puts the slot back).
   */
  async arm(row: SlotRow, agentId: Id): Promise<Armed> {
    const now = this.now();
    if (reusable(row, agentId, now)) {
      if (row.token_for !== agentId) this.sql.exec(`UPDATE ft_pool_ws SET token_for = ? WHERE n = ?`, agentId, row.n);
      return { token: { id: row.token_id ?? "", token: row.token!, expiresAt: row.token_exp! }, minted: false };
    }
    if (row.token_id && row.token_for && row.token_for !== agentId) await this.ops.revoke(row, row.token_id);
    const t = await this.ops.mint(row);
    this.sql.exec(`UPDATE ft_pool_ws SET token_id = ?, token = ?, token_exp = ?, token_for = ? WHERE n = ?`, t.id, t.token, t.expiresAt, agentId, row.n);
    return { token: t, minted: true };
  }

  /** Return `agentId`'s slot to the ready set. Its token stays valid for it (affinity) until cleaned. */
  release(agentId: Id): number {
    const now = this.now();
    const n = this.sql
      .exec(`UPDATE ft_pool_ws SET state = 'ready', agent_id = NULL, last_agent = ?, leased_at = NULL, released_at = ? WHERE agent_id = ? AND state = 'leased' RETURNING n`, agentId, now, agentId)
      .toArray().length;
    return n;
  }

  /** Put a slot back after its lease failed (the token is left as it was). */
  unlease(n: number, agentId: Id): void {
    this.sql.exec(`UPDATE ft_pool_ws SET state = 'ready', agent_id = NULL, leased_at = NULL WHERE n = ? AND agent_id = ?`, n, agentId);
  }

  /** The WHERE clause (and its two time bounds) of ready slots whose token needs background work. */
  private choreFilter(now: number): [string, number, number] {
    return [
      `state = 'ready' AND ((token_for IS NOT NULL AND COALESCE(released_at, 0) <= ?) OR token IS NULL OR token_exp IS NULL OR token_exp < ?)`,
      now - CLEAN_AFTER_MS,
      now + TOKEN_MIN_LIFE_MS + 5 * 60_000,
    ];
  }

  /** Ready slots whose token needs background work: an agent's left idle too long, missing, or expiring. */
  chores(limit: number): SlotRow[] {
    const [where, idle, expiring] = this.choreFilter(this.now());
    return this.sql.exec<SlotRow>(`SELECT * FROM ft_pool_ws WHERE ${where} ORDER BY released_at, n LIMIT ?`, idle, expiring, limit).toArray();
  }

  /**
   * Background token work for up to `limit` ready slots, `concurrency` at a time: take the token
   * out of circulation, revoke it if an agent ever held it, and mint a clean one. A slot leased
   * meanwhile keeps what its lease gave it (the clean token is then revoked). A revoke that fails
   * leaves the slot without a usable token, so its next lease by another agent revokes again
   * before minting. Returns how many slots got a clean token.
   */
  async maintain(limit: number, concurrency = 8): Promise<number> {
    const rows = this.chores(limit);
    let done = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < rows.length) {
        const row = rows[next++]!;
        // Out of circulation first: a lease from now on mints its own token instead of one being revoked.
        const mine = this.sql
          .exec(`UPDATE ft_pool_ws SET token = NULL, token_exp = NULL WHERE n = ? AND state = 'ready' AND COALESCE(token_id, '') = ? RETURNING n`, row.n, row.token_id ?? "")
          .toArray().length;
        if (mine === 0) continue;
        try {
          if (row.token_id && row.token_for) await this.ops.revoke(row, row.token_id);
          const t = await this.ops.mint(row);
          const ok = this.sql
            .exec(
              `UPDATE ft_pool_ws SET token_id = ?, token = ?, token_exp = ?, token_for = NULL WHERE n = ? AND state = 'ready' AND COALESCE(token_id, '') = ? RETURNING n`,
              t.id,
              t.token,
              t.expiresAt,
              row.n,
              row.token_id ?? "",
            )
            .toArray().length;
          if (ok > 0) done++;
          else await this.ops.revoke(row, t.id).catch(() => undefined);
        } catch (e) {
          console.warn(`pool: token chore for ${row.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    return done;
  }

  /** Slots by state (recomputed at most once a second: they only steer growth; call touched() for an exact count). */
  counts(): Record<SlotState, number> {
    const now = this.now();
    if (this.countsCache && now - this.countsCache.at < COUNTS_TTL_MS) return this.countsCache.counts;
    const out: Record<SlotState, number> = { forking: 0, ready: 0, leased: 0, failed: 0 };
    for (const r of this.sql.exec<{ state: SlotState; n: number }>(`SELECT state, COUNT(*) AS n FROM ft_pool_ws GROUP BY state`).toArray()) out[r.state] = r.n;
    this.countsCache = { at: now, counts: out };
    return out;
  }

  /** Forget cached counts (after slot changes made outside the book). */
  touched(): void {
    this.countsCache = null;
  }

  /**
   * When the next ready slot becomes a chore (a released token due for cleaning, or a token due
   * for replacement), or null when no ready slot holds a token.
   */
  nextChoreAt(): number | null {
    const r = this.sql
      .exec<{ dirty: number | null; expiring: number | null }>(
        `SELECT MIN(CASE WHEN token_for IS NOT NULL THEN COALESCE(released_at, 0) END) AS dirty, MIN(token_exp) AS expiring FROM ft_pool_ws WHERE state = 'ready'`,
      )
      .toArray()[0];
    const at: number[] = [];
    if (r?.dirty !== null && r?.dirty !== undefined) at.push(r.dirty + CLEAN_AFTER_MS);
    if (r?.expiring !== null && r?.expiring !== undefined) at.push(r.expiring - TOKEN_MIN_LIFE_MS - 5 * 60_000);
    return at.length > 0 ? Math.min(...at) : null;
  }

  /** Ready slots with a clean token (lease-ready without an Artifacts call), and the token chores waiting. */
  readiness(): { clean: number; chores: number } {
    const now = this.now();
    const clean = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_pool_ws WHERE state = 'ready' AND token_for IS NULL AND token_exp >= ?`, now + TOKEN_MIN_LIFE_MS).one().n;
    const [where, idle, expiring] = this.choreFilter(now);
    const chores = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_pool_ws WHERE ${where}`, idle, expiring).one().n;
    return { clean, chores };
  }
}
