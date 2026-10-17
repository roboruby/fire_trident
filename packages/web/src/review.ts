import type { Proposal } from "@fire_trident/core";

/**
 * The change behind an escalated proposal, as the review queue sends it (`review` on each item):
 * the diff per file, the danger lines and the paths changed outside the declared footprint, with
 * secret lines masked by the server. Proposals escalated before the server kept these carry none,
 * so everything here is read defensively.
 */

/** One changed file: its unified hunks (cut when `truncated`) and how many lines it adds and removes. */
export interface ReviewFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  hunks: string;
  truncated: boolean;
}

/** One danger-pattern hit: the file, its 1-based line in the new text (0 for the whole file), the class, the pattern and a readable label. */
export interface ReviewDanger {
  path: string;
  line: number;
  cls: string;
  pattern: string;
  label: string;
}

/** What a person deciding an escalated proposal sees of its change. `filesChanged` counts files the view left out too. */
export interface ReviewView {
  files: ReviewFile[];
  filesChanged: number;
  danger: ReviewDanger[];
  residual: string[];
}

/** One line of a rendered diff: a hunk header, an added, removed or unchanged line, or a note such as the cut marker. */
export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  text: string;
  /** Line number in the old text (removed and unchanged lines). */
  old?: number;
  /** Line number in the new text (added and unchanged lines). */
  new?: number;
}

/** A place to look first: one line of one file, what the danger patterns found there, and the diff around it. */
export interface DangerSpot {
  path: string;
  /** 1-based line in the new text; 0 for a hit on the whole file (a governance file, a deleted test). */
  line: number;
  /** What was found, one entry per pattern, without the location the spot already shows. */
  what: string[];
  /** The labels as the server wrote them. */
  labels: string[];
  /** A class that sends a change to a person (governance, handoff, secret, auth, capability) is among them. */
  severe: boolean;
  /** The line with a little context, from the kept diff; empty when the diff does not show it. */
  lines: DiffLine[];
}

/** A file changed outside the declared footprint, with its diff when the view kept one. */
export interface ResidualSpot {
  path: string;
  file: ReviewFile | null;
}

/** Danger classes that send a change to a person: their lines are listed first. */
const SEVERE: ReadonlySet<string> = new Set(["governance", "handoff", "secret", "auth", "capability"]);

/** Notes a danger label can end with ("[allowed by policy]", "[asked for by the intent]"). */
const NOTES = /(?:\s\[(?:allowed by [^\]]*|asked for by the intent)\])+$/;

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const objects = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];

/** The view a review queue item carries, checked field by field; null when it carries none worth showing. */
export function reviewOf(item: Proposal): ReviewView | null {
  const v = (item as Proposal & { review?: unknown }).review;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const files = objects(o.files)
    .filter((f) => typeof f.path === "string" && f.path !== "")
    .map((f) => ({ path: f.path as string, status: text(f.status), added: count(f.added), removed: count(f.removed), hunks: text(f.hunks), truncated: f.truncated === true }));
  const danger = objects(o.danger)
    .filter((d) => typeof d.path === "string" && d.path !== "" && typeof d.cls === "string" && d.cls !== "")
    .map((d) => ({ path: d.path as string, line: count(d.line), cls: d.cls as string, pattern: text(d.pattern), label: text(d.label) }));
  const residual = Array.isArray(o.residual) ? o.residual.filter((p): p is string => typeof p === "string" && p !== "") : [];
  if (files.length === 0 && danger.length === 0 && residual.length === 0) return null;
  return { files, filesChanged: Math.max(count(o.filesChanged), files.length), danger, residual };
}

/** Unified hunks ("@@ -a,b +c,d @@", then lines marked " ", "-" or "+") as lines numbered in the old and the new text. */
export function parseHunks(hunks: string): DiffLine[] {
  const out: DiffLine[] = [];
  let a = 0;
  let b = 0;
  let inHunk = false;
  for (const raw of hunks.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      inHunk = true;
      out.push({ kind: "hunk", text: raw });
    } else if (inHunk && raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), new: b++ });
    else if (inHunk && raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), old: a++ });
    else if (inHunk && raw.startsWith(" ")) out.push({ kind: "ctx", text: raw.slice(1), old: a++, new: b++ });
    else if (raw !== "") out.push({ kind: "note", text: raw });
  }
  return out;
}

/**
 * A danger label without the location its spot already shows: "auth (bearer-scheme) at a.ts:3: x"
 * reads "auth (bearer-scheme)" when line 3 itself is shown, and "auth (bearer-scheme): x" when it is
 * not. A label of another shape is kept whole.
 */
export function dangerWhat(d: ReviewDanger, lineShown: boolean): string {
  if (!d.label) return d.pattern ? `${d.cls} (${d.pattern.slice(d.pattern.indexOf(":") + 1)})` : d.cls;
  const at = ` at ${d.line > 0 ? `${d.path}:${d.line}` : d.path}`;
  const i = d.label.indexOf(at);
  if (i < 0) return d.label;
  const head = d.label.slice(0, i);
  const rest = d.label.slice(i + at.length);
  return lineShown ? `${head}${NOTES.exec(rest)?.[0] ?? ""}` : `${head}${rest}`;
}

/** The new-text line `n` with up to `context` code lines on each side, within its hunk; empty when the diff does not show it. */
function around(lines: readonly DiffLine[], n: number, context: number): DiffLine[] {
  const i = lines.findIndex((l) => l.new === n && (l.kind === "add" || l.kind === "ctx"));
  if (i < 0) return [];
  const code = (l: DiffLine | undefined): boolean => l !== undefined && (l.kind === "add" || l.kind === "del" || l.kind === "ctx");
  let from = i;
  while (i - from < context && code(lines[from - 1])) from--;
  let to = i;
  while (to - i < context && code(lines[to + 1])) to++;
  return lines.slice(from, to + 1);
}

/**
 * Where a person should start reading: one spot per danger line (classes that send a change to a
 * person first, then the order the server gave), each with the line and a little context from the
 * kept diff, then every file changed outside the declared footprint.
 */
export function lookHereFirst(view: ReviewView, context = 2): { danger: DangerSpot[]; residual: ResidualSpot[] } {
  const parsed = new Map<string, DiffLine[]>();
  const linesOf = (path: string): DiffLine[] => {
    let lines = parsed.get(path);
    if (!lines) {
      const f = view.files.find((x) => x.path === path);
      lines = f ? parseHunks(f.hunks) : [];
      parsed.set(path, lines);
    }
    return lines;
  };
  const rows = new Map<string, { path: string; line: number; hits: ReviewDanger[] }>();
  const ordered = [...view.danger].sort((x, y) => Number(!SEVERE.has(x.cls)) - Number(!SEVERE.has(y.cls)));
  for (const d of ordered) {
    const key = `${d.path}\n${d.line}`;
    const row = rows.get(key) ?? { path: d.path, line: d.line, hits: [] };
    row.hits.push(d);
    rows.set(key, row);
  }
  const danger = [...rows.values()].map((r): DangerSpot => {
    const lines = r.line > 0 ? around(linesOf(r.path), r.line, context) : [];
    return {
      path: r.path,
      line: r.line,
      what: [...new Set(r.hits.map((h) => dangerWhat(h, lines.length > 0)))],
      labels: [...new Set(r.hits.map((h) => h.label).filter(Boolean))],
      severe: r.hits.some((h) => SEVERE.has(h.cls)),
      lines,
    };
  });
  const residual = view.residual.map((path) => ({ path, file: view.files.find((f) => f.path === path) ?? null }));
  return { danger, residual };
}

/** Characters a screen acts on instead of showing: control characters and bidirectional overrides. */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * Text with each character a screen would act on instead of showing drawn as an escape such as
 * \u{202e}: control characters can rewrite a terminal line, and bidirectional overrides can make
 * code read differently from what it does. A reviewer sees what the line holds.
 */
export function visible(text: string): string {
  return text.replace(HIDDEN, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
}

/** Lines added and removed across the files the view kept. */
export function changeSize(view: ReviewView): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of view.files) {
    added += f.added;
    removed += f.removed;
  }
  return { added, removed };
}

/** The danger lines of each file (new-text line numbers), to mark them in the full diff. */
export function dangerLines(view: ReviewView): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const d of view.danger) {
    if (d.line <= 0) continue;
    const set = out.get(d.path) ?? new Set<number>();
    set.add(d.line);
    out.set(d.path, set);
  }
  return out;
}
