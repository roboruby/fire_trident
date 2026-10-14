import type { NoteSeal } from "./verified.ts";

/**
 * The integrity badge of an intact lineage note whose commit's signature the server checked (FT_NOTE_KEY on the
 * deployment, GET /api/colonies/:id/notes/verify): signed by the key FireTrident publishes at
 * /.well-known/firetrident-keys.json, or a bad signature, which the note's digest alone cannot show. Read defensively:
 * anything else leaves the badge as the note check alone reads it.
 */

/** Where a deployment publishes the keys that sign its lineage notes (trunk/signature.ts). */
export const KEYS_PATH = "/.well-known/firetrident-keys.json";

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** The id of the key an intact note's commit is signed by (16 hex digits), or null for any other check or answer. */
export function signedKeyOf(check: unknown): string | null {
  if (!check || typeof check !== "object" || Array.isArray(check)) return null;
  const c = check as { status?: unknown; signature?: unknown };
  const sig = c.signature && typeof c.signature === "object" ? (c.signature as { status?: unknown; keyId?: unknown }) : null;
  const id = text(sig?.keyId);
  return c.status === "intact" && sig?.status === "signed" && /^[0-9a-f]{16}$/.test(id) ? id : null;
}

/** The badge of an intact note whose commit is signed or has a bad signature; null for every other check. */
export function signedSeal(check: unknown): NoteSeal | null {
  if (!check || typeof check !== "object" || Array.isArray(check)) return null;
  const c = check as { status?: unknown; signature?: unknown };
  const sig = c.signature && typeof c.signature === "object" ? (c.signature as { status?: unknown; keyId?: unknown; detail?: unknown }) : null;
  if (c.status !== "intact" || !sig) return null;
  const key = /^[0-9a-f]{16}$/.test(text(sig.keyId)) ? ` ${text(sig.keyId)}` : "";
  if (sig.status === "signed") {
    return {
      state: "intact",
      label: "Note intact and signed",
      detail: `The note on refs/notes/firetrident hashes to the FT-Note trailer its commit carries, and the commit is signed by FireTrident's key${key}, published at /.well-known/firetrident-keys.json: nobody rewrote the note, or the history it sits in, after it landed.`,
    };
  }
  if (sig.status === "bad-signature") {
    const why = text(sig.detail);
    return {
      state: "altered",
      label: "Signature does not match",
      detail: `The note matches its commit's FT-Note trailer, but the commit's signature does not check out against the key FireTrident publishes${why ? `: ${why}` : ""}. The history around this note was rewritten, or FireTrident's key changed.`,
    };
  }
  return null;
}
