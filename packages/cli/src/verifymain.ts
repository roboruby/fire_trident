import type { CommitSignatureStatus, NoteCheck, NoteMainStatus } from "@fire_trident/core";
import type { Colors } from "./format.ts";

/**
 * The rows `ft verify <colony>` adds below the note checks (the server's GET /notes/verify): whether each landing's
 * commit is still on main as the trunk repository advertises it (a landing main no longer reaches is listed with the
 * notes, as "no longer on main", and fails the command), each signed commit's full-commit signature (its gpgsig header,
 * over the message, author and committer the note signature leaves out; a bad one fails the command), and a signing key
 * the deployment has set and cannot use (fails the command). A server that does not check them sends none, and nothing
 * is added.
 */

/** What `ft verify` says per full-commit signature status: its mark, its words, and its color. */
const FULL: ReadonlyArray<{ status: CommitSignatureStatus; mark: string; words: string; color: keyof Colors }> = [
  { status: "signed", mark: "✓", words: "signed", color: "green" },
  { status: "bad-signature", mark: "✗", words: "bad", color: "red" },
  { status: "note-only", mark: "-", words: "signed before full-commit signatures", color: "dim" },
  { status: "unsigned", mark: "-", words: "unsigned (landed before signing)", color: "dim" },
];
/** What `ft verify` says per main status. */
const MAIN: ReadonlyArray<{ status: NoteMainStatus; mark: string; words: string; color: keyof Colors }> = [
  { status: "on-main", mark: "✓", words: "on main", color: "green" },
  { status: "dropped", mark: "✗", words: "no longer on main", color: "red" },
  { status: "pending", mark: "…", words: "not published yet", color: "dim" },
  { status: "unchecked", mark: "?", words: "not checked", color: "yellow" },
];
/** Checks listed one by one per kind at most. */
const LISTED = 10;

/** Server text on one terminal line: no control characters. */
function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() : "";
}

function notesOf(res: unknown): NoteCheck[] {
  const notes = (res as { notes?: unknown } | null)?.notes;
  return Array.isArray(notes) ? notes.filter((n): n is NoteCheck => !!n && typeof n === "object" && typeof (n as NoteCheck).landingId === "string") : [];
}

const fullOf = (n: NoteCheck): CommitSignatureStatus | null => {
  const s = (n as { commitSignature?: { status?: unknown } }).commitSignature?.status;
  return FULL.some((r) => r.status === s) ? (s as CommitSignatureStatus) : null;
};
const mainOf = (n: NoteCheck): NoteMainStatus | null => {
  const s = (n as { main?: { status?: unknown } }).main?.status;
  return MAIN.some((r) => r.status === s) ? (s as NoteMainStatus) : null;
};

/** Whether the answer holds a landing main no longer reaches, a bad full-commit signature, or a key that cannot sign (`ft verify` then exits 1). */
export function mainChecksFailed(res: unknown): boolean {
  const problem = (res as { signingProblem?: unknown } | null)?.signingProblem;
  return plain(problem) !== "" || notesOf(res).some((n) => n.status === "dropped" || mainOf(n) === "dropped" || fullOf(n) === "bad-signature");
}

/**
 * The rows of `ft verify` for the full-commit signatures, main and the signing key: each kind counted, then each bad
 * signature and each landing main could not be checked against with why. None when the server checked neither.
 */
export function mainCheckLines(res: unknown, c: Colors, now: number): string[] {
  const notes = notesOf(res);
  const out: string[] = [];
  const when = (n: NoteCheck): string => (typeof n.at === "number" && n.at > 0 ? c.dim(` ${age(n.at, now)}`) : "");
  const row = (n: NoteCheck): string => `${plain(n.landingId)} ${plain(n.trunkSha).slice(0, 7) || "-"}${when(n)}`;

  const full = notes.filter((n) => fullOf(n) !== null);
  if (full.length > 0) {
    const of = (s: CommitSignatureStatus): NoteCheck[] => full.filter((n) => fullOf(n) === s);
    const keys = [...new Set(of("signed").map((n) => plain(n.commitSignature?.keyId)).filter(Boolean))];
    const by = keys.length > 0 ? ` by key${keys.length === 1 ? "" : "s"} ${keys.join(", ")}` : "";
    const counts = FULL.filter((r) => of(r.status).length > 0).map((r) => c[r.color](`${r.mark} ${of(r.status).length.toLocaleString("en-US")} ${r.words}${r.status === "signed" ? by : ""}`));
    out.push(`  ${c.bold("full-commit signatures")} ${counts.join(c.dim(" · "))}`);
    const bad = of("bad-signature");
    for (const n of bad.slice(0, LISTED)) out.push(`  ${c.red("✗")} ${row(n)}  bad full-commit signature: ${plain(n.commitSignature?.detail) || "it does not verify with the published key"}`);
    if (bad.length > LISTED) out.push(c.dim(`    +${(bad.length - LISTED).toLocaleString("en-US")} more`));
    if (bad.length > 0) out.push(c.dim("  A bad full-commit signature means the commit is not what the trunk writer signed: its message, author or committer changed, or its key was replaced without the old one listed as retired."));
  }

  const placed = notes.filter((n) => mainOf(n) !== null);
  if (placed.length > 0) {
    const of = (s: NoteMainStatus): NoteCheck[] => placed.filter((n) => mainOf(n) === s);
    const tip = plain((res as { mainTip?: unknown } | null)?.mainTip);
    const counts = MAIN.filter((r) => of(r.status).length > 0).map((r) => c[r.color](`${r.mark} ${of(r.status).length.toLocaleString("en-US")} ${r.words}`));
    out.push(`  ${c.bold("main")} ${counts.join(c.dim(" · "))}${tip ? c.dim(` (main at ${tip.slice(0, 7)})`) : ""}`);
    const unchecked = of("unchecked");
    for (const n of unchecked.slice(0, LISTED)) out.push(`  ${c.yellow("?")} ${row(n)}  ${plain(n.main?.detail) || "main could not be read"}`);
    if (unchecked.length > LISTED) out.push(c.dim(`    +${(unchecked.length - LISTED).toLocaleString("en-US")} more`));
    if (of("dropped").length > 0) out.push(c.dim("  Main no longer reaches a commit FireTrident landed: someone with write access to the trunk repository rewrote or reset main after it landed."));
  }

  const problem = plain((res as { signingProblem?: unknown } | null)?.signingProblem);
  if (problem) out.push(`  ${c.red("✗")} ${problem}`);
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
