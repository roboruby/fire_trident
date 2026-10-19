import { DurableObject } from "cloudflare:workers";
import type { Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { AccountsStore, type RedeemResult, type TokenCheck } from "./store.ts";
import type { Account, AccountId, GithubIdentity, InviteView, OwnedColony, TokenRole, TokenView } from "./types.ts";

/**
 * AccountsDO: the deployment's accounts, in one instance (by name, ACCOUNTS_OBJECT): accounts, sessions, invite codes,
 * colony ownership, scoped tokens and the MCP sessions those tokens opened, in its SQLite storage (accounts/store.ts).
 * Only hashes of secrets reach it. Every method is a thin call into the store; the caller passes the time.
 */
export class AccountsDO extends DurableObject<Env> {
  private readonly store: AccountsStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new AccountsStore(ctx.storage.sql, { transaction: (fn) => ctx.storage.transactionSync(fn) });
  }

  /** The account a GitHub user id signs in to, or null. */
  async accountFor(githubId: number): Promise<Account | null> {
    return this.store.accountFor(githubId);
  }

  /** Sign an existing account in and start a session (by its hash); null when the GitHub user has no account. */
  async signIn(who: GithubIdentity, sessionHash: string, expiresAt: number, now: number): Promise<Account | null> {
    return this.store.signIn(who, sessionHash, expiresAt, now);
  }

  /** Open an account with an invite code (by its hash) and start its session. */
  async redeemInvite(codeHash: string, who: GithubIdentity, sessionHash: string, expiresAt: number, now: number): Promise<RedeemResult> {
    return this.store.redeemInvite(codeHash, who, sessionHash, expiresAt, now);
  }

  /** The account of a live session (by its hash), or null. */
  async sessionAccount(sessionHash: string, now: number): Promise<Account | null> {
    return this.store.sessionAccount(sessionHash, now);
  }

  /** End a session (by its hash). */
  async endSession(sessionHash: string, now: number): Promise<void> {
    this.store.endSession(sessionHash, now);
  }

  /** Record a new invite code by its hash. */
  async mintInvite(p: { id: Id; hash: string; uses: number; expiresAt: number; note: string }, now: number): Promise<InviteView> {
    return this.store.mintInvite(p, now);
  }

  /** Every invite code, without its hash. */
  async listInvites(now: number): Promise<InviteView[]> {
    return this.store.listInvites(now);
  }

  /** End an invite code now. */
  async revokeInvite(id: Id, now: number): Promise<InviteView | null> {
    return this.store.revokeInvite(id, now);
  }

  /** Reserve a colony id for an account before creating it (quota and uniqueness checked). */
  async reserveColony(accountId: AccountId, colonyId: Id, now: number): Promise<{ ok: true } | { ok: false; why: "taken" | "quota"; owned: number }> {
    return this.store.reserveColony(accountId, colonyId, now);
  }

  /** Mark a reserved colony created. */
  async confirmColony(colonyId: Id, accountId: AccountId): Promise<void> {
    this.store.confirmColony(colonyId, accountId);
  }

  /** A colony is no longer owned: its row goes and its tokens are revoked. True when it was owned. */
  async releaseColony(colonyId: Id, now: number): Promise<boolean> {
    return this.store.releaseColony(colonyId, now);
  }

  /** The account that owns a colony, or null for an operator colony. */
  async ownerOf(colonyId: Id): Promise<AccountId | null> {
    return this.store.ownerOf(colonyId);
  }

  /** The colonies an account owns. */
  async coloniesOf(accountId: AccountId): Promise<OwnedColony[]> {
    return this.store.coloniesOf(accountId);
  }

  /** Record a scoped token (by its hash) for one colony. */
  async mintToken(
    p: { id: Id; hash: string; colonyId: Id; accountId: AccountId; role: TokenRole; label: string; expiresAt: number },
    now: number,
  ): Promise<{ ok: true; token: TokenView } | { ok: false; why: "not-owner" | "quota"; live: number }> {
    return this.store.mintToken(p, now);
  }

  /** A colony's tokens, without secrets. */
  async listTokens(colonyId: Id, now: number): Promise<TokenView[]> {
    return this.store.listTokens(colonyId, now);
  }

  /** Revoke one of a colony's tokens. */
  async revokeToken(colonyId: Id, tokenId: Id, now: number): Promise<TokenView | null> {
    return this.store.revokeToken(colonyId, tokenId, now);
  }

  /** A presented token (by its hash), its account and its colony's owner now. */
  async checkToken(hash: string, now: number): Promise<TokenCheck | null> {
    return this.store.checkToken(hash, now);
  }

  /** Bind an MCP session (by its hash) to the token that opened it. */
  async bindMcpSession(sessionHash: string, tokenId: Id, expiresAt: number, now: number): Promise<void> {
    this.store.bindMcpSession(sessionHash, tokenId, expiresAt, now);
  }

  /** The token an MCP session (by its hash) was opened with, or null. */
  async mcpSessionToken(sessionHash: string, now: number): Promise<Id | null> {
    return this.store.mcpSessionToken(sessionHash, now);
  }
}
