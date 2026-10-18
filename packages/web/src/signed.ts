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
    // The full-commit signature (its gpgsig header), over the message, author and committer the note signature leaves out.
    const full = (check as { commitSignature?: unknown }).commitSignature;
    const whole = full && typeof full === "object" ? (full as { status?: unknown; detail?: unknown }) : null;
    if (whole?.status === "bad-signature") {
      const why = text(whole.detail);
      return {
        state: "altered",
        label: "Commit signature does not match",
        detail: `The note matches its commit's FT-Note trailer and its note signature checks out, but the commit's full-commit signature does not${why ? `: ${why}` : ""}. Its message, author or committer was changed after it landed, or FireTrident's key changed.`,
      };
    }
    const scope = whole?.status === "signed" ? "the whole commit (its message, author and committer too) is signed" : "the commit is signed";
    const before = whole?.status === "note-only" ? " It was signed before full-commit signatures, which cover its message, author and committer too." : "";
    return {
      state: "intact",
      label: "Note intact and signed",
      detail: `The note on refs/notes/firetrident hashes to the FT-Note trailer its commit carries, and ${scope} by FireTrident's key${key}, published at /.well-known/firetrident-keys.json: nobody rewrote the note, or the history it sits in, after it landed.${before}`,
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
