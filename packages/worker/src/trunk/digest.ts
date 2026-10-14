import { serializeNote, type LineageNote } from "@fire_trident/core";

/**
 * Tamper-evident lineage notes. Notes live under refs/notes/firetrident, which anyone with write access to the trunk
 * repository could rewrite; a commit cannot be rewritten without changing its id, which main and the trunk writer's
 * records pin. So each landing commit carries its note's digest as its last line, the trailer
 * `FT-Note: sha256:<64 hex>`: the SHA-256 of the note's bytes as the trunk writer writes them to git (serializeNote,
 * masked first), without `certification`, which trunk certification adds after landing. A note is final before its
 * commit is built: it names the landing, never the commit.
 *
 * A note checks out when it is exactly what serializeNote writes for its own content (so no byte of it was rewritten,
 * reordered or duplicated) and its content without `certification` hashes to the trailer. Stock git can do the same
 * (README: a short Node script over `git notes --ref=firetrident show <commit>`).
 */

/** The trailer key. */
export const NOTE_TRAILER = "FT-Note";
const TRAILER_LINE = /^FT-Note: sha256:([0-9a-f]{64})$/;

/** The note as a digest covers it: serializeNote's text without `certification`. */
export function digestedText(note: LineageNote): string {
  if (!note || typeof note !== "object" || !Object.hasOwn(note, "certification")) return serializeNote(note);
  const { certification: _added, ...rest } = note;
  return serializeNote(rest as LineageNote);
}

/** SHA-256 of some bytes, or of a text's UTF-8 bytes, as 64 lowercase hex digits. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A note ready for git and its commit: the text the trunk writer writes, and the digest the commit's trailer carries. */
export async function sealNote(note: LineageNote): Promise<{ text: string; digest: string }> {
  const text = serializeNote(note);
  return { text, digest: await sha256Hex(Object.hasOwn(note, "certification") ? digestedText(note) : text) };
}

/** `message` with the FT-Note trailer for `digest` as its last line. */
export function withNoteDigest(message: string, digest: string): string {
  return `${message.replace(/\s+$/, "")}\n${NOTE_TRAILER}: sha256:${digest}`;
}

/** The digest a commit message's FT-Note trailer carries (it must be the message's last line), or null. */
export function trailerDigest(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const lines = message.replace(/\s+$/, "").split("\n");
  return TRAILER_LINE.exec(lines[lines.length - 1] ?? "")?.[1] ?? null;
}

/**
 * A note's bytes against the digest its commit carries: `intact`, or `altered` with the reason (and the digest of what was
 * found, when it is a note at all). The bytes must be UTF-8 JSON exactly as serializeNote writes it; a note the trunk
 * writer certified later still checks out, since `certification` is left out of the digest.
 */
export async function checkNote(bytes: Uint8Array | string, digest: string): Promise<{ status: "intact" | "altered"; found?: string; detail?: string }> {
  let text: string;
  try {
    // A byte order mark is kept (and so refused below): the trunk writer never writes one.
    text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { status: "altered", detail: "the note is not UTF-8 text" };
  }
  let note: unknown;
  try {
    note = JSON.parse(text);
  } catch {
    return { status: "altered", detail: "the note is not JSON" };
  }
  if (!note || typeof note !== "object" || Array.isArray(note)) return { status: "altered", detail: "the note is not a JSON object" };
  const found = await sha256Hex(digestedText(note as LineageNote));
  if (serializeNote(note as LineageNote) !== text) return { status: "altered", found, detail: "the note is not in the form the trunk writer writes (it was rewritten)" };
  if (found !== digest) return { status: "altered", found, detail: `the note hashes to ${found.slice(0, 12)}, the commit's trailer says ${digest.slice(0, 12)}` };
  return { status: "intact" };
}
