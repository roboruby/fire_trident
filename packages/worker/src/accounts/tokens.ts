import { newSecret } from "./crypto.ts";
import type { Capability, TokenRole } from "./types.ts";

/**
 * Scoped tokens and invite codes: their shapes and what each token role may do. A scoped token is `ftt_` and 32 base32
 * characters (160 random bits); an invite code is `ft-inv-` and 26 (128 bits). Both are shown once, when minted, and
 * kept only as their SHA-256.
 */

export const TOKEN_PREFIX = "ftt_";
export const INVITE_PREFIX = "ft-inv-";

const TOKEN = /^ftt_[a-z2-7]{32}$/;
const INVITE = /^ft-inv-[a-z2-7]{26}$/;

/** A new scoped token. */
export function newScopedToken(): string {
  return newSecret(TOKEN_PREFIX, 20);
}

/** A new invite code. */
export function newInviteCode(): string {
  return newSecret(INVITE_PREFIX, 16);
}

/** Whether a presented bearer looks like a scoped token (only these are looked up). */
export function isScopedToken(bearer: string): boolean {
  return TOKEN.test(bearer);
}

/** An invite code as typed: spaces out, lowercased. Null when it cannot be a code. */
export function normalizedInvite(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, "").toLowerCase();
  return INVITE.test(s) ? s : null;
}

/** Whether a token of `role` may do what a route needs: agent work, a review decision, or the owner's settings. */
export function roleAllows(role: TokenRole, need: Capability): boolean {
  if (role === "owner") return true;
  return (role === "agent" && need === "agent") || (role === "reviewer" && need === "review");
}

/** What each role lets its holder do, in the words the account page and refusals use. */
export const ROLE_WORDS: Readonly<Record<TokenRole, string>> = {
  agent: "an agent's work: join the colony, take work, read files and propose changes",
  reviewer: "a reviewer's decisions on changes that wait for a person",
  owner: "everything an agent and a reviewer do, plus the colony's settings and its tokens",
};

/** What each capability is, for refusals: "<role> tokens cannot <this>". */
const NEED_WORDS: Readonly<Record<Capability, string>> = {
  agent: "do an agent's work",
  review: "decide reviews",
  owner: "change the colony's settings",
};

/** The sentence a token of `role` gets on a route that needs `need`. */
export function roleRefusal(role: TokenRole, need: Capability): string {
  return `This is ${role === "agent" ? "an agent" : `a ${role}`} token: it allows ${ROLE_WORDS[role]}, so it cannot ${NEED_WORDS[need]}. Mint a token with the role you need on your account page.`;
}
