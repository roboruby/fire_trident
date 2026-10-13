import type { Path } from "@fire_trident/core";
import { dangerLabel, looksLikeSecret, PRIVATE_KEY_BEGIN, PRIVATE_KEY_END, type DangerHit } from "./danger.ts";
import { fileDiff } from "./diff.ts";
import { sensitiveReason } from "./signals.ts";

/**
 * What a person sees of an escalated proposal: the change itself (unified hunks in FileDiff's
 * format), the danger patterns it carries and its writes outside the footprint. The decide engine
 * stores one per escalation (decide_review). The review queue is public, so every line that could
 * hold a secret is masked before the view is built: lines carrying a secret danger hit, lines any
 * secret pattern matches, whole private-key blocks, and the whole content of secrets files.
 * Pure: no I/O.
 */

/** The review view of one escalated proposal (the contract with the review queue). */
export interface ReviewView {
  files: Array<{ path: string; status: string; added: number; removed: number; hunks: string; truncated: boolean }>;
  filesChanged: number;
  danger: Array<{ path: string; line: number; cls: string; pattern: string; label: string }>;
  residual: string[];
}

/** One changed file as the view is built from it (old and new text; null when absent). */
export interface ReviewFile {
  path: Path;
  before: string | null;
  after: string | null;
  binary?: boolean;
  unreadable?: boolean;
}

/** Hunk characters kept per file and in all. */
export const REVIEW_FILE_CHARS = 8_000;
export const REVIEW_TOTAL_CHARS = 60_000;
/** Files, danger entries and residual paths kept at most. */
const MAX_FILES = 200;
const MAX_DANGER = 200;
const MAX_RESIDUAL = 200;
/** Hunk text a file is rendered to before masking and cutting (a 512 KiB file fits). */
const RENDER_CHARS = 2_000_000;
const CUT = "\n… (truncated)";
const MASKED = "… (masked: this line may hold a secret)";
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** `text` cut to at most `max` characters, on a line boundary when one is near, with the cut marked. */
function clipTo(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const room = max - CUT.length;
  if (room <= 0) return { text: "", truncated: true };
  const nl = text.lastIndexOf("\n", room);
  return { text: `${text.slice(0, nl > room / 2 ? nl : room)}${CUT}`, truncated: true };
}

/**
 * Hunks with every line that could hold a secret replaced by a marker (its +/-/space prefix
 * kept): new-text lines in `secretLines`, lines a secret pattern matches, private-key blocks, and
 * every line of a secrets file.
 */
export function maskHunks(path: Path, hunks: string, secretLines: ReadonlySet<number> = new Set()): string {
  if (hunks === "") return hunks;
  const whole = sensitiveReason(path) === "secrets file";
  let line = 0;
  let inKey = false;
  return hunks
    .split("\n")
    .map((l) => {
      const h = HUNK.exec(l);
      if (h) {
        line = Number(h[1]);
        return l;
      }
      const kind = l.slice(0, 1);
      const body = l.slice(1);
      const at = kind === "-" ? 0 : line;
      if (kind === " " || kind === "+") line++;
      if (PRIVATE_KEY_BEGIN.test(body)) inKey = true;
      const masked = whole || inKey || (at > 0 && secretLines.has(at)) || looksLikeSecret(body);
      if (PRIVATE_KEY_END.test(body)) inKey = false;
      return masked ? `${kind}${MASKED}` : l;
    })
    .join("\n");
}

/**
 * The review view of a change: each file's hunks rendered whole, masked, then cut to 8,000
 * characters a file and 60,000 in all (`truncated` set where cut); danger hits with their labels
 * (a secret hit's excerpt masked); writes outside the footprint.
 */
export function buildReviewView(x: { files: readonly ReviewFile[]; danger: readonly DangerHit[]; residual: readonly Path[] }): ReviewView {
  const secret = new Map<Path, Set<number>>();
  for (const h of x.danger) {
    if (h.cls !== "secret" || h.line <= 0) continue;
    const lines = secret.get(h.path) ?? new Set<number>();
    lines.add(h.line);
    secret.set(h.path, lines);
  }
  let budget = REVIEW_TOTAL_CHARS;
  const files = x.files.slice(0, MAX_FILES).map((f) => {
    const d = fileDiff(f.path, f.before, f.after, { binary: f.binary ?? false, unreadable: f.unreadable ?? false, maxChars: RENDER_CHARS });
    const masked = maskHunks(f.path, d.hunks, secret.get(f.path));
    const own = clipTo(masked, REVIEW_FILE_CHARS);
    const all = clipTo(own.text, budget);
    budget = Math.max(0, budget - all.text.length);
    return { path: f.path, status: d.status, added: d.added, removed: d.removed, hunks: all.text, truncated: d.truncated || own.truncated || all.truncated };
  });
  const danger = x.danger.slice(0, MAX_DANGER).map((h) => ({
    path: h.path,
    line: h.line,
    cls: h.cls,
    pattern: h.pattern,
    label: dangerLabel(h.cls === "secret" || looksLikeSecret(h.excerpt) ? { ...h, excerpt: "(masked)" } : h),
  }));
  return { files, filesChanged: x.files.length, danger, residual: x.residual.slice(0, MAX_RESIDUAL) };
}

/** A stored view read back; null when it is missing or not a view (old or damaged data never throws). */
export function parseReviewView(text: string | null | undefined): ReviewView | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const v = raw as Partial<ReviewView> | null;
  if (!v || typeof v !== "object" || !Array.isArray(v.files) || !Array.isArray(v.danger) || !Array.isArray(v.residual) || typeof v.filesChanged !== "number") return null;
  const str = (s: unknown): string => (typeof s === "string" ? s : "");
  const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
  return {
    files: v.files
      .filter((f): f is ReviewView["files"][number] => !!f && typeof f === "object")
      .map((f) => ({ path: str(f.path), status: str(f.status), added: num(f.added), removed: num(f.removed), hunks: str(f.hunks), truncated: f.truncated === true })),
    filesChanged: num(v.filesChanged),
    danger: v.danger
      .filter((h): h is ReviewView["danger"][number] => !!h && typeof h === "object")
      .map((h) => ({ path: str(h.path), line: num(h.line), cls: str(h.cls), pattern: str(h.pattern), label: str(h.label) })),
    residual: v.residual.filter((p): p is string => typeof p === "string"),
  };
}
