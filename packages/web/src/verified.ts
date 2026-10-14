import type { LandingDiff, NoteCheck } from "@fire_trident/core";
import { signedSeal } from "./signed.ts";

/**
 * A lineage note's integrity badge and a landing's change, as the web app reads them: the note check of one landing
 * (GET /api/colonies/:id/notes/verify?landing=, its note on the trunk repository against its commit's FT-Note trailer)
 * and the change it made to one file (GET /api/colonies/:id/landings/:ref/diff?path=, public colonies only). Answers are
 * read defensively. Settled answers are kept for the page's life (a check only once it can no longer change), and at
 * most four checks are asked at once, so a long lineage does not flood the colony.
 */

/** What a badge says: sealed and intact, altered, landed before notes were sealed, missing, not pushed yet, being checked, or not checked. */
export type SealState = "intact" | "altered" | "unsealed" | "missing" | "pending" | "checking" | "unchecked";

/** How a note's integrity badge reads: its state, a short label, and a sentence for its tooltip. */
export interface NoteSeal {
  state: SealState;
  label: string;
  detail: string;
}

/** The badge while the check is on its way. */
export const CHECKING_SEAL: NoteSeal = {
  state: "checking",
  label: "Checking the note",
  detail: "Comparing the note on the trunk repository with the FT-Note trailer its commit carries.",
};

/** The badge of a note that could not be checked, with the reason as a sentence. */
export function uncheckedSeal(reason: string): NoteSeal {
  return { state: "unchecked", label: "Note not checked", detail: sentence(reason) || "The note could not be checked." };
}

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** A clause as a sentence: a capital first letter and a final stop. */
function sentence(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const capital = `${t[0]!.toUpperCase()}${t.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** The badge for one landing's note check, read defensively: a status this page does not know reads as not checked. */
export function sealOf(check: unknown): NoteSeal {
  if (!check || typeof check !== "object" || Array.isArray(check)) return uncheckedSeal("No note check came back for this landing");
  const c = check as { status?: unknown; detail?: unknown; ownCopy?: unknown };
  const detail = text(c.detail);
  const own = c.ownCopy === true ? " FireTrident's own copy still matches the trailer, so it can be put back." : "";
  switch (c.status) {
    case "intact":
      // Signed lineage notes (signed.ts): where the server checked the commit's signature, the badge says so.
      return signedSeal(check) ?? { state: "intact", label: "Note intact", detail: "The note on refs/notes/firetrident hashes to the FT-Note trailer its commit carries: nobody rewrote it after it landed." };
    case "altered":
      return { state: "altered", label: "Note altered", detail: `${sentence(`the note on the trunk repository does not match its commit's FT-Note trailer${detail ? `: ${detail}` : ""}`)}${own}` };
    case "no-trailer":
      return {
        state: "unsealed",
        label: "Landed before notes were sealed",
        detail: "This commit carries no FT-Note trailer: it landed before FireTrident sealed each note into its commit, so there is nothing to check the note against.",
      };
    case "missing":
      return { state: "missing", label: "Note missing", detail: `The trunk repository has no note for this commit.${own}` };
    case "pending":
      return { state: "pending", label: "Note not pushed yet", detail: "The note is not on the trunk repository yet: its push is due, and it is checked again in a few seconds." };
    case "unreadable":
      return uncheckedSeal(`the commit or its note could not be read${detail ? `: ${detail}` : ""}`);
    default:
      return uncheckedSeal("this page does not know the note check's answer");
  }
}

/** The check of `landingId` in a note check's answer (NotesVerification), or null when the answer holds none for it. */
export function checkFor(answer: unknown, landingId: string): NoteCheck | null {
  const notes = answer && typeof answer === "object" ? (answer as { notes?: unknown }).notes : undefined;
  if (!Array.isArray(notes)) return null;
  const hit = notes.find((n): n is NoteCheck => !!n && typeof n === "object" && (n as { landingId?: unknown }).landingId === landingId && typeof (n as { status?: unknown }).status === "string");
  return hit ?? null;
}

/** The checks in a note check's answer, newest first, each with a landing, a commit and a status; empty when there are none. */
export function checksOf(answer: unknown): NoteCheck[] {
  const notes = answer && typeof answer === "object" ? (answer as { notes?: unknown }).notes : undefined;
  if (!Array.isArray(notes)) return [];
  return notes.filter(
    (n): n is NoteCheck =>
      !!n && typeof n === "object" && typeof (n as NoteCheck).landingId === "string" && typeof (n as NoteCheck).trunkSha === "string" && typeof (n as NoteCheck).status === "string",
  );
}

const STATUSES: ReadonlySet<string> = new Set(["added", "deleted", "modified", "unchanged", "binary", "too-large", "unreadable"]);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const blob = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A landing's change as the diff route answers it, read defensively; null when the answer is not one. */
export function landingDiffOf(raw: unknown): LandingDiff | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.path !== "string" || typeof d.status !== "string" || !STATUSES.has(d.status)) return null;
  return {
    colonyId: text(d.colonyId),
    landingId: text(d.landingId),
    trunkSha: text(d.trunkSha),
    parentSha: text(d.parentSha),
    path: d.path,
    before: blob(d.before),
    after: blob(d.after),
    status: d.status as LandingDiff["status"],
    added: count(d.added),
    removed: count(d.removed),
    hunks: typeof d.hunks === "string" ? d.hunks : "",
    truncated: d.truncated === true,
    ...(typeof d.detail === "string" && d.detail.trim() ? { detail: d.detail.trim() } : {}),
  };
}

/** A read of a landing that failed: the HTTP status (0 when the network failed) and the server's sentence. */
export class ReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The sentence a failed answer gives: the server's own `error` when it sent one, else the status line. */
async function failure(res: Response): Promise<ReadError> {
  let message = `The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`;
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (body && typeof body.error === "string" && body.error.trim()) message = sentence(body.error.trim().slice(0, 400));
  } catch {
    // Not JSON: the status line says enough.
  }
  return new ReadError(res.status, message);
}

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new ReadError(0, `The colony API could not be reached (${e instanceof Error ? e.message : "network error"}).`);
  }
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** Checks asked at once, from the whole page. */
const CHECKS_AT_ONCE = 4;
let running = 0;
const waiting: Array<() => void> = [];

/** Run `fn` once fewer than CHECKS_AT_ONCE checks are running (a finished check hands its place to the next in line). */
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running < CHECKS_AT_ONCE) running++;
  else await new Promise<void>((go) => waiting.push(go));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** Statuses that can no longer change: their checks are kept. A note not pushed yet, missing or unreadable is asked again. */
const SETTLED: ReadonlySet<string> = new Set(["intact", "altered", "no-trailer"]);
const checks = new Map<string, Promise<NoteCheck | null>>();
const diffs = new Map<string, Promise<LandingDiff>>();

const colonyUrl = (colonyId: string): string => `/api/colonies/${encodeURIComponent(colonyId)}`;

/** One landing's note check (GET /notes/verify?landing=): null when the answer holds none for it; throws a ReadError when the read fails. */
export function fetchNoteCheck(colonyId: string, landingId: string): Promise<NoteCheck | null> {
  const key = `${colonyId}\n${landingId}`;
  const kept = checks.get(key);
  if (kept) return kept;
  const asked = limited(() => getJson(`${colonyUrl(colonyId)}/notes/verify?landing=${encodeURIComponent(landingId)}`)).then((answer) => checkFor(answer, landingId));
  checks.set(key, asked);
  asked.then(
    (check) => {
      if (!check || !SETTLED.has(check.status)) checks.delete(key);
    },
    () => checks.delete(key),
  );
  return asked;
}

/** The change a landing made to one file (GET /landings/:ref/diff?path=); throws a ReadError with the server's sentence when the read fails. */
export function fetchLandingDiff(colonyId: string, landingId: string, path: string): Promise<LandingDiff> {
  const key = `${colonyId}\n${landingId}\n${path}`;
  const kept = diffs.get(key);
  if (kept) return kept;
  const asked = getJson(`${colonyUrl(colonyId)}/landings/${encodeURIComponent(landingId)}/diff?path=${encodeURIComponent(path)}`).then((raw) => {
    const d = landingDiffOf(raw);
    if (!d) throw new ReadError(200, "The server's answer was not a change this page can show.");
    return d;
  });
  diffs.set(key, asked);
  asked.catch(() => diffs.delete(key));
  return asked;
}
