/**
 * The shapes "Connect Cloudflare" shares with the rest of the Worker (the accounts round's contract). A FireTrident
 * account connects one Cloudflare account; its colonies keep their repositories in that account's Artifacts and run
 * their models on its Workers AI.
 */

/** A FireTrident account id ("acc_..."). The accounts module owns accounts; this module only keys connections by it. */
export type AccountId = string;

/** A working Cloudflare connection, as callers use it: the Cloudflare account, a current access token and the granted scopes. */
export interface CloudflareGrant {
  /** The Cloudflare account the person chose (32 hex characters). */
  accountId: string;
  accessToken: string;
  scopes: string[];
}

/** A Cloudflare account a connection can reach. Its name is the person's own text: data, escaped wherever it is shown. */
export interface CloudflareAccount {
  id: string;
  name: string;
}

/**
 * What the account page shows about a connection (never a token):
 * - "none": not connected;
 * - "choose": connected, but the connection reaches several accounts and the person has not chosen one yet;
 * - "connected": connected to `account`;
 * - "broken": the stored connection stopped working (`reason` says why and what to do).
 */
export interface GrantStatus {
  state: "none" | "choose" | "connected" | "broken";
  /** The chosen account ("connected", and "broken" when one was chosen). */
  account?: CloudflareAccount;
  /** The accounts to choose from ("choose"). */
  accounts?: CloudflareAccount[];
  /** The scopes Cloudflare granted (empty for "none"). */
  scopes: string[];
  /** Whether the grant lets colonies run models on the account's Workers AI (ai.read or ai.write granted). */
  workersAi: boolean;
  /** Why the connection is broken, a plain sentence ("broken" only). */
  reason?: string;
  /** When the person connected (ms since the epoch). */
  connectedAt?: number;
}

/** Why a step of connecting stopped, as the callback's redirect names it for the account page. */
export type ConnectCode = "expired" | "denied" | "refused" | "scopes" | "accounts" | "choice" | "unavailable" | "signin" | "error";

/** The answer of a connecting step: the new status, or a code and a plain sentence. Plain data, so it crosses Durable Object RPC. */
export type ConnectResult = { ok: true; status: GrantStatus } | { ok: false; code: ConnectCode; message: string };
