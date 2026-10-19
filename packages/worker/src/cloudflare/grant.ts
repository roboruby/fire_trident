import { accountsOn, connectConfig, type ConnectEnv } from "./config.ts";
import type { AccountId, CloudflareGrant, ConnectResult, GrantStatus } from "./types.ts";

/**
 * The Worker's way to an account's Cloudflare connection: the CF_GRANTS object named by the account id. Every caller
 * outside this module goes through cloudflareGrantFor.
 */

/** What callers use of one account's connection object (CloudflareGrantDO's methods; a fake in tests). */
export interface GrantObject {
  begin(account: AccountId, stateHash: string, verifier: string): Promise<void>;
  complete(account: AccountId, stateHash: string, code: string): Promise<ConnectResult>;
  status(account: AccountId): GrantStatus | Promise<GrantStatus>;
  choose(account: AccountId, cfAccountId: string): ConnectResult | Promise<ConnectResult>;
  grant(account: AccountId): Promise<CloudflareGrant | null>;
  disconnect(account: AccountId): Promise<{ disconnected: boolean; revoked: boolean }>;
}

/** The connection object of one account, or null without the CF_GRANTS binding. */
export function grantObject(env: Pick<ConnectEnv, "CF_GRANTS">, account: AccountId): GrantObject | null {
  const ns = env.CF_GRANTS;
  if (!ns) return null;
  return ns.get(ns.idFromName(account)) as unknown as GrantObject;
}

/**
 * The account's working Cloudflare connection: the chosen Cloudflare account, a current access token (renewed when it
 * is about to expire) and the scopes granted. Null when FT_ACCOUNTS is off, connecting is not set up, the account has
 * not connected or not chosen an account, or the connection is broken (a failed renewal marks it so, with a sentence
 * for the account page).
 */
export async function cloudflareGrantFor(env: ConnectEnv, account: AccountId): Promise<CloudflareGrant | null> {
  if (!accountsOn(env) || !connectConfig(env) || typeof account !== "string" || account === "") return null;
  const obj = grantObject(env, account);
  return obj ? obj.grant(account) : null;
}
