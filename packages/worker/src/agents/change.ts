import { blobId, changesetId, checkFile, footprintCovers, inlineProblem } from "@fire_trident/core";
import type { FileVersion, Id, Intent, Path, Rule, Sha, Violation } from "@fire_trident/core";

/** Commit subject length cap (characters). */
const SUBJECT_MAX = 72;
const GLOB_CHARS = /[*?{]/;

/** The deterministic fix a forbid-pattern rule declares in `spec.replacement`, or null. */
export function ruleReplacement(rule: Rule | null | undefined): string | null {
  if (!rule || rule.kind !== "forbid-pattern") return null;
  const r = rule.spec?.replacement;
  return typeof r === "string" ? r : null;
}

/**
 * Apply a forbid-pattern rule's `spec.replacement` to every match, line by line:
 * RegExp(pattern, flags + "g") with "g"/"y" deduplicated, applied to each line
 * separately so anchors mean what they mean in `checkFile` (which tests per line).
 * Line terminators (\n, \r\n, \r) are preserved exactly. Returns the content
 * unchanged when the rule has no replacement.
 */
export function applyReplacement(rule: Rule, content: string): string {
  const replacement = ruleReplacement(rule);
  if (replacement === null) return content;
  const flags = typeof rule.spec.flags === "string" ? rule.spec.flags.replace(/[gy]/g, "") : "";
  const re = new RegExp(String(rule.spec.pattern), `${[...new Set(flags)].join("")}g`);
  const parts = content.split(/(\r\n|\r|\n)/);
  for (let i = 0; i < parts.length; i += 2) parts[i] = parts[i]!.replace(re, replacement);
  return parts.join("");
}

/** Result of checking a file again after an edit. */
export interface Recheck {
  /** True when no violation of the rule remains. */
  ok: boolean;
  before: number;
  after: number;
  /** Violations still present after the edit (excerpts are repository content). */
  remaining: Violation[];
}

/**
 * Re-check one file against the rule that produced its intent: the change is
 * acceptable only when no violation remains, which also means none were added.
 */
export function recheck(rule: Rule, path: Path, before: string, after: string): Recheck {
  const b = checkFile(rule, path, before);
  const a = checkFile(rule, path, after);
  return { ok: a.length === 0, before: b.length, after: a.length, remaining: a };
}

/** Collapse whitespace so user text cannot add lines (and forge trailers). */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Commit message for an agent's change: the intent title as the subject (one
 * line, at most 72 characters), then the FT-Intent and FT-Agent trailers.
 */
export function commitMessage(intent: Pick<Intent, "id" | "title">, agentId: Id): string {
  let subject = oneLine(intent.title) || oneLine(intent.id);
  if (subject.length > SUBJECT_MAX) subject = `${subject.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
  return `${subject}\n\nFT-Intent: ${oneLine(intent.id)}\nFT-Agent: ${oneLine(agentId)}\n`;
}

/** Git identity of an in-platform agent. */
export function agentIdentity(agentId: Id): { name: string; email: string } {
  const local = oneLine(agentId).replace(/[^A-Za-z0-9._+-]/g, "-") || "agent";
  return { name: "FireTrident agent", email: `${local}@agents.firetrident.dev` };
}

/** A change in its inline form: the write set, its changeset id (the proposal's headSha) and the text of each new blob. */
export type InlineChange = { ok: true; writeSet: FileVersion[]; headSha: Sha; contents: Record<Sha, string> } | { ok: false; reason: string };

/**
 * The inline form of the files a change writes on `baseSha` (core/changeset.ts): each file's git blob id, the
 * changeset id the proposal carries as its head, and the contents keyed by blob id. Not ok, with the reason, when
 * the content check or INLINE_LIMITS refuse it (binary content, too many or too large files): such a change is
 * committed and pushed to the workspace instead.
 */
export function inlineChange(baseSha: Sha, changes: ReadonlyArray<{ path: Path; content: string }>): InlineChange {
  const writeSet: FileVersion[] = [];
  const contents: Record<Sha, string> = {};
  for (const c of changes) {
    const blob = blobId(c.content);
    writeSet.push({ path: c.path, blob });
    contents[blob] = c.content;
  }
  const problem = inlineProblem(writeSet, contents);
  if (problem !== null) return { ok: false, reason: problem };
  return { ok: true, writeSet, headSha: changesetId(baseSha, writeSet), contents };
}

/** Normalize a repository path (forward slashes, no leading "./" or "/"). Returns "" for unsafe paths. */
export function cleanPath(p: string): Path {
  let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  if (s.split("/").some((seg) => seg === ".." || seg === ".git")) return "";
  return s;
}

/** Is a footprint entry one concrete file path (not a glob, not a directory)? */
export function isLiteralPath(entry: string): boolean {
  const p = cleanPath(entry);
  return p !== "" && !p.endsWith("/") && !GLOB_CHARS.test(p);
}

/**
 * Concrete files a footprint names. Literal entries are kept as is (they may not
 * exist yet); directory and glob entries are matched against `files` (the base
 * tree's file list, or null when it was not listed). At most `limit` paths, in
 * footprint order, deduplicated.
 */
export function expandFootprint(footprint: string[], files: Path[] | null, limit = 50): Path[] {
  const out: Path[] = [];
  const seen = new Set<Path>();
  const add = (p: Path): void => {
    if (p === "" || seen.has(p) || out.length >= limit) return;
    seen.add(p);
    out.push(p);
  };
  for (const entry of footprint) {
    if (isLiteralPath(entry)) {
      add(cleanPath(entry));
      continue;
    }
    if (!files) continue;
    for (const f of files) {
      if (out.length >= limit) break;
      if (footprintCovers(entry, f)) add(f);
    }
  }
  return out;
}

/** Heuristic text check: no NUL byte in the first 8 KiB and valid UTF-8. */
export function decodeText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return null;
  try {
    // ignoreBOM keeps a leading BOM in the text, so re-encoding an edit preserves it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Placeholder lines models write instead of reproducing code. */
const ELISION = /^\s*(?:\/\/|#|\/\*|<!--|--|;)?\s*(?:\.\.\.|…)\s*(?:rest|remaining|existing|unchanged|other)\b/i;

/**
 * Does an edited file look like the model elided part of it? True when a large
 * file shrank below half its size, or when a placeholder line such as
 * "// ... rest of the file unchanged" appears that the original did not have.
 */
export function looksTruncated(original: string, updated: string): boolean {
  if (original.length > 2000 && updated.length < original.length / 2) return true;
  const had = new Set(original.split(/\r\n|\r|\n/).filter((l) => ELISION.test(l)));
  return updated.split(/\r\n|\r|\n/).some((l) => ELISION.test(l) && !had.has(l));
}

/** Human summary of a change set for the proposal's declared summary. */
export function changeSummary(intent: Pick<Intent, "title">, paths: Path[], how: string): string {
  const shown = paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");
  return `${oneLine(intent.title)}: ${how} in ${shown}`;
}
