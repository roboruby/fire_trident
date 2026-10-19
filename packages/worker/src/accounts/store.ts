import type { Id } from "@fire_trident/core";
import { newId } from "../ids.ts";
import { MAX_COLONIES_PER_ACCOUNT, MAX_LIVE_TOKENS_PER_COLONY, TOKEN_TOUCH_MS } from "./limits.ts";
import { TOKEN_ROLES } from "./types.ts";
import type { Account, AccountId, GithubIdentity, InviteView, OwnedColony, TokenRole, TokenView } from "./types.ts";

/**
 * The accounts store: accounts, sessions, invite codes, colony ownership, scoped tokens and the MCP sessions those tokens
 * opened, in SQLite. AccountsDO runs it on its Durable Object storage (one instance for the deployment); the tests run
 * it on an in-memory database. Every secret arrives here already hashed (SHA-256, hex): the store never sees a session
 * id, an invite code or a token. Every method is synchronous, so each runs whole inside the object's one thread, and the
 * ones that write more than one row run in a transaction.
 */

/** A bound value: what both SQLite drivers take. */
export type SqlValue = string | number | null;

/** The part of SQLite the store uses: Durable Object storage's `sql.exec`, or an adapter over another driver. */
export interface SqlLike {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

/** Additive schema: tables are only ever created, never changed in place. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    github_id INTEGER NOT NULL UNIQUE,
    login TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL,
    signed_in_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS sessions_by_account ON sessions (account_id)",
  `CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    uses INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invite_uses (
    invite_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (invite_id, account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS colonies (
    colony_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS colonies_by_account ON colonies (account_id)",
  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    colony_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    role TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS tokens_by_colony ON tokens (colony_id)",
  `CREATE TABLE IF NOT EXISTS mcp_sessions (
    hash TEXT PRIMARY KEY,
    token_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS mcp_sessions_by_token ON mcp_sessions (token_id)",
];

/** Why an invite code did not open an account. */
export type InviteRefusal = "invalid" | "used" | "expired";

/** What redeeming an invite code did. `created` false: the account existed already (signed in, no use spent). */
export type RedeemResult = { ok: true; account: Account; created: boolean } | { ok: false; why: InviteRefusal };

/** A presented token, found by its hash: the token, its account, and who owns its colony now (null: nobody). */
export interface TokenCheck {
  token: TokenView;
  accountId: AccountId;
  owner: AccountId | null;
}

type AccountRow = { id: string; github_id: number; login: string; name: string | null; created_at: number; signed_in_at: number };
type TokenRow = {
  id: string;
  hash: string;
  colony_id: string;
  account_id: string;
  role: string;
  label: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
};
type InviteRow = { id: string; hash: string; uses: number; used: number; note: string; created_at: number; expires_at: number };

const SESSION_GRACE_MS = 24 * 60 * 60_000;

function account(row: AccountRow): Account {
  return { id: row.id, github: { id: Number(row.github_id), login: row.login, ...(row.name ? { name: row.name } : {}) }, createdAt: Number(row.created_at) };
}

function roleOf(raw: string): TokenRole {
  return (TOKEN_ROLES as readonly string[]).includes(raw) ? (raw as TokenRole) : "agent";
}

function tokenView(row: TokenRow, now: number): TokenView {
  const revokedAt = row.revoked_at === null ? null : Number(row.revoked_at);
  const expiresAt = Number(row.expires_at);
  return {
    id: row.id,
    colonyId: row.colony_id,
    role: roleOf(row.role),
    label: row.label,
    createdAt: Number(row.created_at),
    expiresAt,
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    revokedAt,
    live: revokedAt === null && now < expiresAt,
  };
}

function inviteView(row: InviteRow, now: number): InviteView {
  const uses = Number(row.uses);
  const used = Number(row.used);
  const expiresAt = Number(row.expires_at);
  return { id: row.id, uses, used, createdAt: Number(row.created_at), expiresAt, note: row.note, live: used < uses && now < expiresAt };
}

/** The accounts store over one SQLite database. */
export class AccountsStore {
  private readonly tx: <T>(fn: () => T) => T;
  private readonly accountId: () => AccountId;

  constructor(
    private readonly sql: SqlLike,
    opts: { transaction?: <T>(fn: () => T) => T; accountId?: () => AccountId } = {},
  ) {
    this.tx = opts.transaction ?? ((fn) => fn());
    this.accountId = opts.accountId ?? (() => newId("acc_"));
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  private rows<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[] {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }

  private accountByGithub(githubId: number): AccountRow | undefined {
    return this.rows<AccountRow>("SELECT * FROM accounts WHERE github_id = ?", githubId)[0];
  }

  private startSession(accountId: AccountId, sessionHash: string, expiresAt: number, now: number): void {
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now - SESSION_GRACE_MS);
    this.sql.exec("INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)", sessionHash, accountId, now, expiresAt);
  }

  private refresh(row: AccountRow, who: GithubIdentity, now: number): Account {
    this.sql.exec("UPDATE accounts SET login = ?, name = ?, signed_in_at = ? WHERE id = ?", who.login, who.name ?? null, now, row.id);
    return account({ ...row, login: who.login, name: who.name ?? null, signed_in_at: now });
  }

  /** The account a GitHub user id signs in to, or null when it has none yet (a new person needs an invite code). */
  accountFor(githubId: number): Account | null {
    const row = this.accountByGithub(githubId);
    return row ? account(row) : null;
  }

  /**
   * Sign an existing account in: its GitHub login and name are refreshed and a session (by its hash) starts. Null when
   * the GitHub user has no account.
   */
  signIn(who: GithubIdentity, sessionHash: string, expiresAt: number, now: number): Account | null {
    return this.tx(() => {
      const row = this.accountByGithub(who.id);
      if (!row) return null;
      const acc = this.refresh(row, who, now);
      this.startSession(acc.id, sessionHash, expiresAt, now);
      return acc;
    });
  }

  /**
   * Open an account with an invite code (by its hash) and start its session. The code must exist, be unexpired and have
   * a use left; the use is spent with the account's creation, in one transaction. A GitHub user who has an account
   * already is signed in and spends no use.
   */
  redeemInvite(codeHash: string, who: GithubIdentity, sessionHash: string, expiresAt: number, now: number): RedeemResult {
    return this.tx((): RedeemResult => {
      const existing = this.accountByGithub(who.id);
      if (existing) {
        const acc = this.refresh(existing, who, now);
        this.startSession(acc.id, sessionHash, expiresAt, now);
        return { ok: true, account: acc, created: false };
      }
      const invite = this.rows<InviteRow>("SELECT * FROM invites WHERE hash = ?", codeHash)[0];
      if (!invite) return { ok: false, why: "invalid" };
      if (Number(invite.expires_at) <= now) return { ok: false, why: "expired" };
      const spent = this.rows<{ used: number }>("UPDATE invites SET used = used + 1 WHERE id = ? AND used < uses RETURNING used", invite.id);
      if (spent.length === 0) return { ok: false, why: "used" };
      const id = this.accountId();
      this.sql.exec("INSERT INTO accounts (id, github_id, login, name, created_at, signed_in_at) VALUES (?, ?, ?, ?, ?, ?)", id, who.id, who.login, who.name ?? null, now, now);
      this.sql.exec("INSERT INTO invite_uses (invite_id, account_id, at) VALUES (?, ?, ?)", invite.id, id, now);
      this.startSession(id, sessionHash, expiresAt, now);
      return { ok: true, account: { id, github: { ...who }, createdAt: now }, created: true };
    });
  }

  /** The account of a live session (by its hash): not revoked, not expired. */
  sessionAccount(sessionHash: string, now: number): Account | null {
    const row = this.rows<AccountRow>(
      "SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?",
      sessionHash,
      now,
    )[0];
    return row ? account(row) : null;
  }

  /** End a session (sign out). Ending one that does not exist does nothing. */
  endSession(sessionHash: string, now: number): void {
    this.sql.exec("UPDATE sessions SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL", now, sessionHash);
  }

  /** Record a new invite code by its hash, with its number of uses and its expiry. */
  mintInvite(p: { id: Id; hash: string; uses: number; expiresAt: number; note: string }, now: number): InviteView {
    this.sql.exec("INSERT INTO invites (id, hash, uses, used, note, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?, ?)", p.id, p.hash, p.uses, p.note, now, p.expiresAt);
    return inviteView({ id: p.id, hash: p.hash, uses: p.uses, used: 0, note: p.note, created_at: now, expires_at: p.expiresAt }, now);
  }

  /** Every invite code, newest first, without its hash. */
  listInvites(now: number): InviteView[] {
    return this.rows<InviteRow>("SELECT * FROM invites ORDER BY created_at DESC LIMIT 500").map((r) => inviteView(r, now));
  }

  /** End an invite code now (its unspent uses lapse). Null when there is no such code. */
  revokeInvite(id: Id, now: number): InviteView | null {
    this.sql.exec("UPDATE invites SET expires_at = ? WHERE id = ? AND expires_at > ?", now, id, now);
    const row = this.rows<InviteRow>("SELECT * FROM invites WHERE id = ?", id)[0];
    return row ? inviteView(row, now) : null;
  }

  /**
   * Reserve a colony id for an account before the colony is created, so the colony's objects find their owner from the
   * start. Refused when the id is owned already, or when the account owns MAX_COLONIES_PER_ACCOUNT (pending ones count).
   */
  reserveColony(accountId: AccountId, colonyId: Id, now: number): { ok: true } | { ok: false; why: "taken" | "quota"; owned: number } {
    return this.tx(() => {
      const owned = Number(this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM colonies WHERE account_id = ?", accountId)[0]?.n ?? 0);
      if (this.rows("SELECT 1 AS x FROM colonies WHERE colony_id = ?", colonyId).length > 0) return { ok: false as const, why: "taken" as const, owned };
      if (owned >= MAX_COLONIES_PER_ACCOUNT) return { ok: false as const, why: "quota" as const, owned };
      this.sql.exec("INSERT INTO colonies (colony_id, account_id, state, created_at) VALUES (?, ?, 'pending', ?)", colonyId, accountId, now);
      return { ok: true as const };
    });
  }

  /** Mark a reserved colony created. */
  confirmColony(colonyId: Id, accountId: AccountId): void {
    this.sql.exec("UPDATE colonies SET state = 'active' WHERE colony_id = ? AND account_id = ?", colonyId, accountId);
  }

  /**
   * A colony is no longer owned (its creation failed, or it was deleted): the ownership row goes, its tokens are revoked
   * and the MCP sessions they opened are forgotten. True when it was owned.
   */
  releaseColony(colonyId: Id, now: number): boolean {
    return this.tx(() => {
      const owned = this.rows("SELECT 1 AS x FROM colonies WHERE colony_id = ?", colonyId).length > 0;
      this.sql.exec("DELETE FROM colonies WHERE colony_id = ?", colonyId);
      this.sql.exec("DELETE FROM mcp_sessions WHERE token_id IN (SELECT id FROM tokens WHERE colony_id = ?)", colonyId);
      this.sql.exec("UPDATE tokens SET revoked_at = ? WHERE colony_id = ? AND revoked_at IS NULL", now, colonyId);
      return owned;
    });
  }

  /** The account that owns a colony (pending or created), or null: an operator colony. */
  ownerOf(colonyId: Id): AccountId | null {
    return this.rows<{ account_id: string }>("SELECT account_id FROM colonies WHERE colony_id = ?", colonyId)[0]?.account_id ?? null;
  }

  /** The colonies an account owns, oldest first. */
  coloniesOf(accountId: AccountId): OwnedColony[] {
    return this.rows<{ colony_id: string; state: string; created_at: number }>("SELECT colony_id, state, created_at FROM colonies WHERE account_id = ? ORDER BY created_at, colony_id", accountId).map((r) => ({
      colonyId: r.colony_id,
      state: r.state === "pending" ? "pending" : "active",
      createdAt: Number(r.created_at),
    }));
  }

  /**
   * Record a scoped token (by its hash) for one colony. Refused when the account does not own the colony, or when the
   * colony has MAX_LIVE_TOKENS_PER_COLONY live tokens.
   */
  mintToken(
    p: { id: Id; hash: string; colonyId: Id; accountId: AccountId; role: TokenRole; label: string; expiresAt: number },
    now: number,
  ): { ok: true; token: TokenView } | { ok: false; why: "not-owner" | "quota"; live: number } {
    return this.tx(() => {
      const live = Number(this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM tokens WHERE colony_id = ? AND revoked_at IS NULL AND expires_at > ?", p.colonyId, now)[0]?.n ?? 0);
      if (this.ownerOf(p.colonyId) !== p.accountId) return { ok: false as const, why: "not-owner" as const, live };
      if (live >= MAX_LIVE_TOKENS_PER_COLONY) return { ok: false as const, why: "quota" as const, live };
      this.sql.exec(
        "INSERT INTO tokens (id, hash, colony_id, account_id, role, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        p.id,
        p.hash,
        p.colonyId,
        p.accountId,
        p.role,
        p.label,
        now,
        p.expiresAt,
      );
      const row = this.rows<TokenRow>("SELECT * FROM tokens WHERE id = ?", p.id)[0] as TokenRow;
      return { ok: true as const, token: tokenView(row, now) };
    });
  }

  /** A colony's tokens, newest first, without secrets or hashes (the 100 newest). */
  listTokens(colonyId: Id, now: number): TokenView[] {
    return this.rows<TokenRow>("SELECT * FROM tokens WHERE colony_id = ? ORDER BY created_at DESC, id DESC LIMIT 100", colonyId).map((r) => tokenView(r, now));
  }

  /** Revoke one of a colony's tokens, and forget the MCP sessions it opened. Null when the colony has no such token. */
  revokeToken(colonyId: Id, tokenId: Id, now: number): TokenView | null {
    return this.tx(() => {
      this.sql.exec("UPDATE tokens SET revoked_at = ? WHERE id = ? AND colony_id = ? AND revoked_at IS NULL", now, tokenId, colonyId);
      this.sql.exec("DELETE FROM mcp_sessions WHERE token_id = ?", tokenId);
      const row = this.rows<TokenRow>("SELECT * FROM tokens WHERE id = ? AND colony_id = ?", tokenId, colonyId)[0];
      return row ? tokenView(row, now) : null;
    });
  }

  /**
   * A presented token (by its hash) with its account and its colony's owner now, or null when no token has that hash. A
   * live token's last use is written at most once a minute.
   */
  checkToken(hash: string, now: number): TokenCheck | null {
    const row = this.rows<TokenRow>("SELECT * FROM tokens WHERE hash = ?", hash)[0];
    if (!row) return null;
    const token = tokenView(row, now);
    if (token.live && (token.lastUsedAt === null || now - token.lastUsedAt >= TOKEN_TOUCH_MS)) {
      this.sql.exec("UPDATE tokens SET last_used_at = ? WHERE id = ?", now, row.id);
      token.lastUsedAt = now;
    }
    return { token, accountId: row.account_id, owner: this.ownerOf(row.colony_id) };
  }

  /** Bind an MCP session (by its hash) to the token that opened it, until the token expires. */
  bindMcpSession(sessionHash: string, tokenId: Id, expiresAt: number, now: number): void {
    this.sql.exec("DELETE FROM mcp_sessions WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO mcp_sessions (hash, token_id, expires_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING", sessionHash, tokenId, expiresAt);
  }

  /** The token an MCP session (by its hash) was opened with, or null when it was opened with none or has lapsed. */
  mcpSessionToken(sessionHash: string, now: number): Id | null {
    return this.rows<{ token_id: string }>("SELECT token_id FROM mcp_sessions WHERE hash = ? AND expires_at > ?", sessionHash, now)[0]?.token_id ?? null;
  }
}
