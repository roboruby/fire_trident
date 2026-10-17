import type { NoteCheck, NoteSignatureStatus } from "@fire_trident/core";
import type { Colors } from "./format.ts";

/**
 * Signed lineage notes in `ft verify` (FT_NOTE_KEY on the server): where the deployment signs notes, each note check
 * says whether its commit is signed by one of the deployment's published keys (/.well-known/firetrident-keys.json: the
 * current key and each retired one, for the commits made while it signed). `ft verify` counts them and lists each bad
 * signature with why; a bad signature fails the command like an altered note.
 */

/** What `ft verify` says per signature status: its mark, its words, and its color. */
const ROWS: ReadonlyArray<{ status: NoteSignatureStatus; mark: string; words: string; color: keyof Colors }> = [
  { status: "signed", mark: "✓", words: "signed", color: "green" },
  { status: "bad-signature", mark: "✗", words: "bad signature", color: "red" },
  { status: "unsigned", mark: "-", words: "unsigned (landed before signing)", color: "dim" },
];
/** Bad signatures listed one by one at most. */
const LISTED = 10;

/** Server text on one terminal line: no control characters. */
function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() : "";
}

/** A check's signature status, or null when the server checked none. */
function statusOf(n: unknown): NoteSignatureStatus | null {
  const s = (n as { signature?: { status?: unknown } } | null)?.signature?.status;
  return s === "signed" || s === "bad-signature" || s === "unsigned" ? s : null;
}

/** Whether a note check's answer holds a commit whose signature is bad (`ft verify` then exits 1). */
export function signatureFailed(res: unknown): boolean {
  const notes = (res as { notes?: unknown } | null)?.notes;
  return Array.isArray(notes) && notes.some((n) => statusOf(n) === "bad-signature");
}

/**
 * The signature rows of `ft verify`: each status counted (signed ones with the key that signed them), then each bad
 * signature with why. None when the server checked no signature (a deployment that does not sign).
 */
export function signatureLines(notes: NoteCheck[], c: Colors, now: number): string[] {
  const checked = notes.filter((n) => statusOf(n) !== null);
  if (checked.length === 0) return [];
  const of = (s: NoteSignatureStatus): NoteCheck[] => checked.filter((n) => statusOf(n) === s);
  const keys = [...new Set(of("signed").map((n) => plain(n.signature?.keyId)).filter(Boolean))];
  const by = keys.length > 0 ? ` by key${keys.length === 1 ? "" : "s"} ${keys.join(", ")}` : "";
  const counts = ROWS.filter((r) => of(r.status).length > 0).map((r) => c[r.color](`${r.mark} ${of(r.status).length.toLocaleString("en-US")} ${r.words}${r.status === "signed" ? by : ""}`));
  const out = [`  ${c.bold("signatures")} ${counts.join(c.dim(" · "))}`];
  const bad = of("bad-signature");
  for (const n of bad.slice(0, LISTED)) {
    const when = typeof n.at === "number" && n.at > 0 ? c.dim(` ${age(n.at, now)}`) : "";
    out.push(`  ${c.red("✗")} ${plain(n.landingId)} ${plain(n.trunkSha).slice(0, 7) || "-"}${when}  bad signature: ${plain(n.signature?.detail) || "it does not verify with the published key"}`);
  }
  if (bad.length > LISTED) out.push(c.dim(`    +${(bad.length - LISTED).toLocaleString("en-US")} more`));
  if (bad.length > 0) out.push(c.dim("  A bad signature means the trunk writer did not sign that commit with a key it publishes for that commit's time: history was rewritten, or its key was replaced without the old one listed as retired."));
  return out;
}

/** Relative age such as "12s ago" or "3h ago" (format.ts's form). */
function age(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
