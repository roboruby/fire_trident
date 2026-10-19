import type { Id } from "@fire_trident/core";
import type { Env } from "../env.ts";
import type { RedeemResult, TokenCheck } from "./store.ts";
import type { Account, AccountId, GithubIdentity, InviteView, OwnedColony, TokenRole, TokenView } from "./types.ts";

/** The name of the deployment's one accounts object. */
export const ACCOUNTS_OBJECT = "accounts";

/** What the accounts object answers (AccountsDO's methods), as every caller in the Worker sees them. */
export interface AccountsRpc {
  accountFor(githubId: number): Promise<Account | null>;
  signIn(who: GithubIdentity, sessionHash: string, expiresAt: number, now: number): Promise<Account | null>;
  redeemInvite(codeHash: string, who: GithubIdentity, sessionHash: string, expiresAt: number, now: number): Promise<RedeemResult>;
  sessionAccount(sessionHash: string, now: number): Promise<Account | null>;
  endSession(sessionHash: string, now: number): Promise<void>;
  mintInvite(p: { id: Id; hash: string; uses: number; expiresAt: number; note: string }, now: number): Promise<InviteView>;
  listInvites(now: number): Promise<InviteView[]>;
  revokeInvite(id: Id, now: number): Promise<InviteView | null>;
  reserveColony(accountId: AccountId, colonyId: Id, now: number): Promise<{ ok: true } | { ok: false; why: "taken" | "quota"; owned: number }>;
  confirmColony(colonyId: Id, accountId: AccountId): Promise<void>;
  releaseColony(colonyId: Id, now: number): Promise<boolean>;
  ownerOf(colonyId: Id): Promise<AccountId | null>;
  coloniesOf(accountId: AccountId): Promise<OwnedColony[]>;
  mintToken(
    p: { id: Id; hash: string; colonyId: Id; accountId: AccountId; role: TokenRole; label: string; expiresAt: number },
    now: number,
  ): Promise<{ ok: true; token: TokenView } | { ok: false; why: "not-owner" | "quota"; live: number }>;
  listTokens(colonyId: Id, now: number): Promise<TokenView[]>;
  revokeToken(colonyId: Id, tokenId: Id, now: number): Promise<TokenView | null>;
  checkToken(hash: string, now: number): Promise<TokenCheck | null>;
  bindMcpSession(sessionHash: string, tokenId: Id, expiresAt: number, now: number): Promise<void>;
  mcpSessionToken(sessionHash: string, now: number): Promise<Id | null>;
}

/** The deployment's accounts object, or null when the ACCOUNTS binding is missing (an older configuration). */
export function accountsStub(env: Partial<Pick<Env, "ACCOUNTS">>): AccountsRpc | null {
  const ns = env.ACCOUNTS;
  if (!ns) return null;
  return ns.get(ns.idFromName(ACCOUNTS_OBJECT)) as unknown as AccountsRpc;
}
