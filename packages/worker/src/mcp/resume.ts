import { tokensEqual } from "../api/app.ts";

/**
 * Resume keys for external agents. `join` registers a new external agent with a random key and
 * returns it once; the colony stores only the key's SHA-256 digest. Acting as that agent again from
 * another MCP session takes the agent id and the key: agent ids are public (the colony lists its
 * agents), so an id alone must never hand over an agent and its workspace lease.
 */

/** Shortest and longest key the colony accepts (a new key is 43 characters). */
export const MIN_RESUME_KEY = 32;
export const MAX_RESUME_KEY = 200;

/** A new resume key: 32 random bytes, base64url without padding. */
export function newResumeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The SHA-256 digest of a resume key, as lowercase hex: what the colony stores. */
export async function resumeDigest(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether `key` is the key behind a stored digest, compared in constant time. */
export async function resumeKeyMatches(key: string, digest: string): Promise<boolean> {
  return tokensEqual(await resumeDigest(key), digest);
}
