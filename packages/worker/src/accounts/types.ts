import type { Id } from "@fire_trident/core";

/**
 * Accounts (FT_ACCOUNTS): a person signs in with GitHub and owns colonies. These are the shapes the accounts module and
 * the code wired to it share. A colony with no owner is an operator colony and behaves as it always has.
 */

/** A FireTrident account id, "acc_" and a time-sortable id (ids.ts newId). */
export type AccountId = string;

/** The GitHub identity an account signs in with: the numeric user id is the key, login and name are kept for display. */
export interface GithubIdentity {
  id: number;
  login: string;
  name?: string;
}

/** A signed-in person, as currentAccount answers. */
export interface CurrentAccount {
  id: AccountId;
  github: GithubIdentity;
}

/** An account as the accounts store keeps it. */
export interface Account extends CurrentAccount {
  createdAt: number;
}

/**
 * A person's connection to their own Cloudflare account, as the Cloudflare connection module hands it out. The accounts
 * module only asks whether one exists (a person without one cannot create a colony); it never reads the token.
 */
export interface CloudflareGrant {
  /** The Cloudflare account id. */
  accountId: string;
  accessToken: string;
  scopes: string[];
}

/** What a scoped token may do on its one colony: an agent's work, review decisions, or both plus settings and tokens. */
export type TokenRole = "agent" | "reviewer" | "owner";

/** The token roles, in the order the account page offers them. */
export const TOKEN_ROLES: readonly TokenRole[] = ["agent", "reviewer", "owner"];

/** What a route needs from a scoped token: an agent's work, a review decision, or the owner's settings. */
export type Capability = "agent" | "review" | "owner";

/** A scoped token as the account page and the API show it: never its secret or its hash. */
export interface TokenView {
  id: Id;
  colonyId: Id;
  role: TokenRole;
  label: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** Neither revoked nor expired. */
  live: boolean;
}

/** An invite code as the operator's list shows it: never the code or its hash. */
export interface InviteView {
  id: Id;
  uses: number;
  used: number;
  createdAt: number;
  expiresAt: number;
  note: string;
  /** Uses left and not expired. */
  live: boolean;
}

/** A colony an account owns. `pending` while its creation runs (it counts toward the quota and is owned already). */
export interface OwnedColony {
  colonyId: Id;
  state: "pending" | "active";
  createdAt: number;
}
