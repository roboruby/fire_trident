import { tokensEqual } from "../api/token.ts";
import { hasWorkersAi, missingScopes, STATE_TTL_MS, type ConnectConfig } from "./config.ts";
import { exchangeCode, grantedScopes, listAccounts, OAuthRefusal, refreshTokens, revokeToken, type HttpFetch, type TokenSet } from "./oauth.ts";
import { seal, unseal } from "./seal.ts";
import type { AccountId, CloudflareAccount, CloudflareGrant, ConnectResult, GrantStatus } from "./types.ts";

/**
 * One FireTrident account's Cloudflare connection, kept in a Durable Object's SQLite (cloudflare/GrantDO.ts holds one
 * per account; unit tests run it on node:sqlite). Two tables:
 * - cf_pending: a started connection, the SHA-256 of its state and its PKCE verifier (sealed), for STATE_TTL_MS;
 * - cf_grants: the connection, its access and refresh tokens sealed together (cloudflare/seal.ts, bound to the
 *   account), their expiry, the scopes granted, the chosen Cloudflare account (or the accounts to choose from), and the
 *   sentence that says why it broke, when it did.
 * Tokens never leave except as the access token grant() hands to this Worker's own callers.
 */

/** The SQL this store runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** Renew an access token this long before it expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** What a connection broke on, as the account page says it. */
export const BROKEN = {
  refused: "Cloudflare refused to renew this connection (it may have been revoked on Cloudflare). Connect Cloudflare again on the account page.",
  noRefresh: "This connection expired and cannot renew itself (Cloudflare issued no refresh token). Connect Cloudflare again on the account page.",
  unreadable: "The stored connection could not be read (the deployment's key changed, or the record was altered). Connect Cloudflare again on the account page.",
} as const;

/** Why a connecting step stopped. */
export const REFUSED = {
  unavailable: "Connecting Cloudflare is not set up on this deployment.",
  expired: "This Cloudflare connection did not start here, or took longer than 10 minutes. Connect again.",
  unreachable: "Cloudflare did not answer. Try connecting again in a minute.",
  noAccounts: "This connection reaches no Cloudflare account. Connect again and choose an account on Cloudflare's page.",
  accountsFailed: "Cloudflare did not list the accounts this connection reaches. Connect again.",
  choice: "That account is not one this connection reaches. Choose one from the list.",
  notChoosing: "There is no account to choose: connect Cloudflare first.",
} as const;

/** The sentence for a code exchange Cloudflare refused. */
export function refusedSentence(code: string): string {
  return `Cloudflare refused the connection (${code}). Connect again.`;
}

/** The sentence for a grant without every required scope. */
export function scopesSentence(missing: readonly string[]): string {
  return `Cloudflare did not grant ${missing.join(", ")}, which FireTrident needs to know who you are, list your accounts and keep your colonies' repositories in your Artifacts. Connect again and allow them.`;
}

interface GrantRow {
  account: string;
  tokens: string;
  expires_at: number;
  scopes: string;
  cf_account: string | null;
  cf_account_name: string | null;
  choices: string | null;
  broken: string | null;
  connected_at: number;
}

interface PendingRow {
  state_hash: string;
  verifier: string;
  expires_at: number;
}

/** The sealed token pair. */
interface TokenPair {
  a: string;
  r: string | null;
}

function parseList<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** What GrantService needs: its SQL, the OAuth client (null: connecting is not set up), fetch and a clock. */
export interface GrantServiceDeps {
  sql: SqlRunner;
  config: ConnectConfig | null;
  fetch: HttpFetch;
  now?: () => number;
}

/** One account's connection: start, finish, choose an account, hand out a fresh access token, disconnect. */
export class GrantService {
  private readonly now: () => number;
  /** Refreshes in flight, one per account, so concurrent callers never spend the same refresh token twice. */
  private readonly refreshing = new Map<AccountId, Promise<CloudflareGrant | null>>();

  constructor(private readonly deps: GrantServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Create the tables (additive, safe to run on every start). */
  migrate(): void {
    this.deps.sql.exec(
      "CREATE TABLE IF NOT EXISTS cf_grants (account TEXT PRIMARY KEY, tokens TEXT NOT NULL, expires_at INTEGER NOT NULL, scopes TEXT NOT NULL, cf_account TEXT, cf_account_name TEXT, choices TEXT, broken TEXT, connected_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    this.deps.sql.exec("CREATE TABLE IF NOT EXISTS cf_pending (account TEXT PRIMARY KEY, state_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  }

  private row(account: AccountId): GrantRow | null {
    return (this.deps.sql.exec("SELECT * FROM cf_grants WHERE account = ?", account).toArray()[0] as GrantRow | undefined) ?? null;
  }

  private tokensContext(account: AccountId): string {
    return `cloudflare-grant:${account}`;
  }

  /** Remember a started connection: the state's hash and the PKCE verifier (sealed), replacing any earlier one. */
  async begin(account: AccountId, stateHash: string, verifier: string): Promise<void> {
    const cfg = this.deps.config;
    if (!cfg) throw new Error(REFUSED.unavailable);
    const sealed = await seal(cfg.grantKey, `cloudflare-pkce:${account}`, verifier);
    this.deps.sql.exec("INSERT OR REPLACE INTO cf_pending (account, state_hash, verifier, expires_at) VALUES (?, ?, ?, ?)", account, stateHash, sealed, this.now() + STATE_TTL_MS);
  }

  /**
   * Finish a connection: the state must be the one begin() stored for this account, within STATE_TTL_MS, and is used
   * once. The code is exchanged with the stored verifier, the required scopes are checked, and the accounts the token
   * reaches are listed: with one (or the one chosen before, on a reconnect) the connection is ready, with several the
   * person chooses. A grant that fails a check is revoked at Cloudflare and nothing is kept.
   */
  async complete(account: AccountId, stateHash: string, code: string): Promise<ConnectResult> {
    const cfg = this.deps.config;
    if (!cfg) return { ok: false, code: "unavailable", message: REFUSED.unavailable };
    const pending = (this.deps.sql.exec("SELECT state_hash, verifier, expires_at FROM cf_pending WHERE account = ?", account).toArray()[0] as PendingRow | undefined) ?? null;
    // Single use: the started connection is gone whatever happens next.
    this.deps.sql.exec("DELETE FROM cf_pending WHERE account = ?", account);
    if (!pending || pending.expires_at < this.now() || !(await tokensEqual(pending.state_hash, stateHash))) return { ok: false, code: "expired", message: REFUSED.expired };
    let verifier: string;
    try {
      verifier = await unseal(cfg.grantKey, `cloudflare-pkce:${account}`, pending.verifier);
    } catch {
      return { ok: false, code: "expired", message: REFUSED.expired };
    }
    let tokens: TokenSet;
    try {
      tokens = await exchangeCode(cfg, code, verifier, this.deps.fetch, this.now());
    } catch (e) {
      const r = e instanceof OAuthRefusal ? e : new OAuthRefusal("unavailable", false);
      return r.definitive ? { ok: false, code: "refused", message: refusedSentence(r.code) } : { ok: false, code: "unavailable", message: REFUSED.unreachable };
    }
    const scopes = grantedScopes(tokens);
    const missing = missingScopes(scopes);
    if (missing.length > 0) {
      await this.revoke(tokens);
      return { ok: false, code: "scopes", message: scopesSentence(missing) };
    }
    let accounts: CloudflareAccount[];
    try {
      accounts = await listAccounts(tokens.accessToken, this.deps.fetch);
    } catch {
      await this.revoke(tokens);
      return { ok: false, code: "accounts", message: REFUSED.accountsFailed };
    }
    if (accounts.length === 0) {
      await this.revoke(tokens);
      return { ok: false, code: "accounts", message: REFUSED.noAccounts };
    }
    const before = this.row(account);
    const previous = before ? await this.openTokens(account, before) : null;
    // A reconnect keeps the account chosen before when the new grant still reaches it (its colonies live there).
    const kept = before?.cf_account ? accounts.find((a) => a.id === before.cf_account) : undefined;
    const chosen = kept ?? (accounts.length === 1 ? accounts[0] : undefined);
    const now = this.now();
    const sealed = await seal(cfg.grantKey, this.tokensContext(account), JSON.stringify({ a: tokens.accessToken, r: tokens.refreshToken } satisfies TokenPair));
    this.deps.sql.exec(
      "INSERT OR REPLACE INTO cf_grants (account, tokens, expires_at, scopes, cf_account, cf_account_name, choices, broken, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      account,
      sealed,
      tokens.expiresAt,
      JSON.stringify(scopes),
      chosen?.id ?? null,
      chosen?.name ?? null,
      chosen ? null : JSON.stringify(accounts),
      now,
      now,
    );
    // The replaced grant is revoked at Cloudflare (best effort): nothing here can use it any more.
    if (previous) await this.revoke(previous);
    return { ok: true, status: this.status(account) };
  }

  /** The connection as the account page shows it (never a token). */
  status(account: AccountId): GrantStatus {
    const r = this.row(account);
    if (!r) return { state: "none", scopes: [], workersAi: false };
    const scopes = parseList<string[]>(r.scopes, []);
    const base = { scopes, workersAi: hasWorkersAi(scopes), connectedAt: r.connected_at };
    const chosen = r.cf_account ? { account: { id: r.cf_account, name: r.cf_account_name ?? r.cf_account } } : {};
    if (r.broken) return { state: "broken", ...chosen, ...base, reason: r.broken };
    if (!r.cf_account) return { state: "choose", accounts: parseList<CloudflareAccount[]>(r.choices, []), ...base };
    return { state: "connected", ...chosen, ...base };
  }

  /** Choose the Cloudflare account among the ones the connection reaches (only while it waits for a choice). */
  choose(account: AccountId, cfAccountId: string): ConnectResult {
    const r = this.row(account);
    if (!r || r.broken || r.cf_account) return { ok: false, code: "choice", message: REFUSED.notChoosing };
    const pick = parseList<CloudflareAccount[]>(r.choices, []).find((a) => a.id === cfAccountId);
    if (!pick) return { ok: false, code: "choice", message: REFUSED.choice };
    this.deps.sql.exec("UPDATE cf_grants SET cf_account = ?, cf_account_name = ?, choices = NULL, updated_at = ? WHERE account = ?", pick.id, pick.name, this.now(), account);
    return { ok: true, status: this.status(account) };
  }

  /**
   * A current access token for the chosen account, renewed when it is within REFRESH_MARGIN_MS of expiring. Null when
   * not connected, still choosing, broken, or the renewal failed. A refusal from Cloudflare (or a record that does not
   * decrypt, or an expired token with no refresh token) marks the connection broken with a sentence; Cloudflare not
   * answering does not, and the current token is handed out while it is still valid.
   */
  async grant(account: AccountId): Promise<CloudflareGrant | null> {
    const cfg = this.deps.config;
    const r = this.row(account);
    if (!cfg || !r || r.broken || !r.cf_account) return null;
    const pair = await this.openTokens(account, r);
    if (!pair) {
      this.markBroken(account, BROKEN.unreadable);
      return null;
    }
    const scopes = parseList<string[]>(r.scopes, []);
    if (r.expires_at - this.now() > REFRESH_MARGIN_MS) return { accountId: r.cf_account, accessToken: pair.a, scopes };
    const inFlight = this.refreshing.get(account);
    if (inFlight) return inFlight;
    const p = this.refresh(cfg, account, r, pair).finally(() => this.refreshing.delete(account));
    this.refreshing.set(account, p);
    return p;
  }

  private async refresh(cfg: ConnectConfig, account: AccountId, r: GrantRow, pair: TokenPair): Promise<CloudflareGrant | null> {
    const cfAccount = r.cf_account as string;
    const scopes = parseList<string[]>(r.scopes, []);
    const stillValid = r.expires_at > this.now();
    if (!pair.r) {
      if (stillValid) return { accountId: cfAccount, accessToken: pair.a, scopes };
      this.markBroken(account, BROKEN.noRefresh);
      return null;
    }
    let tokens: TokenSet;
    try {
      tokens = await refreshTokens(cfg, pair.r, this.deps.fetch, this.now());
    } catch (e) {
      if (e instanceof OAuthRefusal && e.definitive) {
        this.markBroken(account, BROKEN.refused);
        return null;
      }
      return stillValid ? { accountId: cfAccount, accessToken: pair.a, scopes } : null;
    }
    // Cloudflare may rotate the refresh token; keep the old one only when it sent none. Scopes stay as granted unless it names them.
    const next: TokenPair = { a: tokens.accessToken, r: tokens.refreshToken ?? pair.r };
    const nextScopes = tokens.scopes ?? scopes;
    const sealed = await seal(cfg.grantKey, this.tokensContext(account), JSON.stringify(next));
    this.deps.sql.exec("UPDATE cf_grants SET tokens = ?, expires_at = ?, scopes = ?, updated_at = ? WHERE account = ?", sealed, tokens.expiresAt, JSON.stringify(nextScopes), this.now(), account);
    return { accountId: cfAccount, accessToken: next.a, scopes: nextScopes };
  }

  /** Disconnect: revoke the tokens at Cloudflare (best effort) and forget the connection and any started one. */
  async disconnect(account: AccountId): Promise<{ disconnected: boolean; revoked: boolean }> {
    const r = this.row(account);
    this.deps.sql.exec("DELETE FROM cf_pending WHERE account = ?", account);
    if (!r) return { disconnected: false, revoked: false };
    const pair = await this.openTokens(account, r);
    this.deps.sql.exec("DELETE FROM cf_grants WHERE account = ?", account);
    const revoked = pair ? await this.revoke({ accessToken: pair.a, refreshToken: pair.r }) : false;
    return { disconnected: true, revoked };
  }

  private markBroken(account: AccountId, sentence: string): void {
    this.deps.sql.exec("UPDATE cf_grants SET broken = ?, updated_at = ? WHERE account = ?", sentence, this.now(), account);
  }

  private async openTokens(account: AccountId, r: GrantRow): Promise<TokenPair | null> {
    const cfg = this.deps.config;
    if (!cfg) return null;
    try {
      const pair = JSON.parse(await unseal(cfg.grantKey, this.tokensContext(account), r.tokens)) as TokenPair;
      return typeof pair.a === "string" ? { a: pair.a, r: typeof pair.r === "string" ? pair.r : null } : null;
    } catch {
      return null;
    }
  }

  /** Revoke a grant at Cloudflare: its refresh token (which ends its access tokens too) and its access token. */
  private async revoke(t: { accessToken: string; refreshToken: string | null } | TokenPair): Promise<boolean> {
    const cfg = this.deps.config;
    if (!cfg) return false;
    const access = "a" in t ? t.a : t.accessToken;
    const refresh = "a" in t ? t.r : t.refreshToken;
    const results = await Promise.all([refresh ? revokeToken(cfg, refresh, "refresh_token", this.deps.fetch) : Promise.resolve(false), revokeToken(cfg, access, "access_token", this.deps.fetch)]);
    return refresh ? results[0] : results[1];
  }
}
