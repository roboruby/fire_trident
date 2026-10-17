import type { ContestedRegion, MovedHunk, Path } from "@fire_trident/core";

/**
 * Return hunks (FT_RETURN_HUNKS): the quotes a return carries, so that the change's agent repairs in one pass without
 * reading trunk again. A landing that beat the change quotes its unified diff of each file it moved (MovedHunk), and a
 * text merge conflict quotes each contested region (ContestedRegion): the base's lines, trunk's and the change's own,
 * from the base line where it starts. The trunk writer computes them (trunk/quote.ts), the colony attaches them
 * (colony/returnhunks.ts), and this module holds what both agree on: the caps, the cutting, the checks of what was
 * received or stored, and the lines a prompt shows. Every quote is repository content: data, never instructions. Pure.
 */

/**
 * Lines of one file's quote: a landing's diff of the file, or the file's contested regions together (all three sides).
 * About a screen: enough for the hunks around a change, without carrying a whole rewritten file.
 */
export const HUNK_LINES = 40;
/** Characters of one quoted line; a longer one (a minified file, a data blob) is cut, ending in "…". */
export const HUNK_LINE_CHARS = 240;
/** Files quoted per landing: the landing's diffs of the first few files it moved, in movedBy's order. */
export const HUNK_PATHS = 3;
/**
 * Lines and characters quoted per return in all (contested regions first, then each landing's diffs, newest landing
 * first), so a return stays a reasonable size for a take, an inbox and a prompt.
 */
export const RETURN_HUNK_LINES = 120;
export const RETURN_HUNK_CHARS = 8_000;
/** Contested regions kept per return, and per file. */
export const CONTESTED_MAX = 12;
/** What ends a quote that was cut (decide/diff.ts and the landing diff route mark a cut the same way). */
export const CUT = "… (truncated)";

/** What is left of a return's quote budget (quoteHunks spends it). */
export interface HunkBudget {
  lines: number;
  chars: number;
}

/** One quoted line: its line ending removed, cut at HUNK_LINE_CHARS. */
export function quoteLine(line: string): string {
  const text = String(line ?? "").replace(/\r?\n$/, "");
  return text.length > HUNK_LINE_CHARS ? `${text.slice(0, HUNK_LINE_CHARS - 1)}…` : text;
}

/** The first `n` lines of a text (the rest dropped), so a large diff is masked and cut without reading all of it twice. */
export function firstLines(text: string, n: number): string {
  let at = -1;
  for (let i = 0; i < n; i++) {
    at = text.indexOf("\n", at + 1);
    if (at < 0) return text;
  }
  return text.slice(0, at);
}

/**
 * Unified hunks cut to `max` lines (each cut at HUNK_LINE_CHARS), ending in CUT when lines were left out (or already
 * were: `truncated`, or a CUT line at the end of what was received).
 */
export function cutDiff(diff: string, max = HUNK_LINES, truncated = false): { diff: string; truncated: boolean } {
  const lines = diff.split("\n");
  let cut = truncated;
  while (lines.length > 0 && (lines[lines.length - 1] === CUT || lines[lines.length - 1] === "")) {
    if (lines.pop() === CUT) cut = true;
  }
  const room = Math.max(0, Math.floor(max));
  if (lines.length > room) cut = true;
  const kept = lines.slice(0, room).map(quoteLine);
  return { diff: cut ? [...kept, CUT].join("\n") : kept.join("\n"), truncated: cut };
}

/** Lines of a region (all three sides). */
function regionLines(r: ContestedRegion): number {
  return r.base.length + r.trunk.length + r.own.length;
}

/** Characters of a region (all three sides, one per line ending). */
function regionChars(r: ContestedRegion): number {
  let n = 0;
  for (const side of [r.base, r.trunk, r.own]) for (const line of side) n += line.length + 1;
  return n;
}

/**
 * A region cut to `max` lines: each side keeps up to a third of them, and what a short side leaves goes to the others in
 * order (base, trunk, own). Marked truncated when a line was left out.
 */
export function cutRegion(r: ContestedRegion, max: number): ContestedRegion {
  const sides = [r.base, r.trunk, r.own].map((s) => s.map(quoteLine));
  const room = Math.max(0, Math.floor(max));
  const total = sides.reduce((n, s) => n + s.length, 0);
  const out = (take: number[]): ContestedRegion => {
    const cut = total > take.reduce((n, t) => n + t, 0) || r.truncated === true;
    return { path: r.path, line: r.line, base: sides[0]!.slice(0, take[0]), trunk: sides[1]!.slice(0, take[1]), own: sides[2]!.slice(0, take[2]), ...(cut ? { truncated: true } : {}) };
  };
  if (total <= room) return out(sides.map((s) => s.length));
  const take = sides.map((s) => Math.min(s.length, Math.floor(room / 3)));
  let left = room - take.reduce((n, t) => n + t, 0);
  for (let i = 0; i < 3 && left > 0; i++) {
    const more = Math.min(sides[i]!.length - take[i]!, left);
    take[i]! += more;
    left -= more;
  }
  return out(take);
}

/**
 * One file's contested regions within HUNK_LINES (or `max`) lines, in order: a region past the budget is cut, the ones
 * after it are left out, and the last region kept says truncated when any were.
 */
export function cutRegions(regions: readonly ContestedRegion[], max = HUNK_LINES): ContestedRegion[] {
  const out: ContestedRegion[] = [];
  let left = Math.max(0, Math.floor(max));
  for (const r of regions.slice(0, CONTESTED_MAX)) {
    if (left <= 0) break;
    const cut = cutRegion(r, left);
    out.push(cut);
    left -= regionLines(cut);
  }
  if (out.length > 0 && out.length < regions.length) out[out.length - 1] = { ...out[out.length - 1]!, truncated: true };
  return out;
}

/**
 * A landing's diff of one file as a return's budget allows it: whole, or cut on a line boundary (ending in CUT) to the
 * lines and characters left; null when not even a few lines fit. Spends what it keeps.
 */
export function fitDiff(h: MovedHunk, budget: HunkBudget): MovedHunk | null {
  const lines = h.diff.split("\n");
  // chars[n]: the characters of the first n lines joined.
  const chars = [0];
  for (const line of lines) chars.push(chars[chars.length - 1]! + line.length + (chars.length > 1 ? 1 : 0));
  const fits = (n: number, cut: boolean): boolean => n + (cut ? 1 : 0) <= budget.lines && chars[n]! + (cut ? CUT.length + 1 : 0) <= budget.chars;
  let fit: { diff: string; truncated: boolean };
  if (fits(lines.length, false)) fit = { diff: h.diff, truncated: h.truncated };
  else {
    let n = lines.length - 1;
    while (n > 0 && !fits(n, true)) n--;
    // A hunk header and a line or two say too little to be worth a cut quote.
    if (n < 3) return null;
    fit = cutDiff(lines.slice(0, n).join("\n"), n, true);
  }
  budget.lines -= fit.diff.split("\n").length;
  budget.chars -= fit.diff.length;
  return { path: h.path, ...(h.trunkSha ? { trunkSha: h.trunkSha } : {}), diff: fit.diff, truncated: fit.truncated };
}

/** A contested region as a return's budget allows it (cut to the lines left); null when no line fits. Spends what it keeps. */
export function fitRegion(r: ContestedRegion, budget: HunkBudget): ContestedRegion | null {
  if (budget.lines <= 0 || budget.chars <= 0) return null;
  let fit = cutRegion(r, budget.lines);
  // Characters: one line fewer at a time until it fits (cutRegion keeps the base's and trunk's lines longest; long lines
  // are already cut at HUNK_LINE_CHARS).
  while (regionChars(fit) > budget.chars && regionLines(fit) > 0) fit = cutRegion(fit, regionLines(fit) - 1);
  if (regionLines(fit) === 0 && regionLines(r) > 0) return null;
  budget.lines -= Math.max(1, regionLines(fit));
  budget.chars -= regionChars(fit);
  return fit;
}

/** Lines of a region side as received: strings only, at most HUNK_LINES, each cut. */
function cleanSide(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  return x.filter((l): l is string => typeof l === "string").slice(0, HUNK_LINES).map(quoteLine);
}

function cleanPath(x: unknown): x is Path {
  return typeof x === "string" && x !== "" && x.length <= 1_000;
}

/** Hunks as received from another object or read back from storage, checked field by field and cut; undefined when none is usable. */
export function cleanHunks(x: unknown): MovedHunk[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: MovedHunk[] = [];
  for (const raw of x) {
    if (out.length >= HUNK_PATHS) break;
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (!cleanPath(e.path) || typeof e.diff !== "string" || e.diff.trim() === "") continue;
    const cut = cutDiff(e.diff, HUNK_LINES, e.truncated === true);
    const h: MovedHunk = { path: e.path, diff: cut.diff, truncated: cut.truncated };
    if (typeof e.trunkSha === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(e.trunkSha)) h.trunkSha = e.trunkSha;
    out.push(h);
  }
  return out.length > 0 ? out : undefined;
}

/** Contested regions as received or stored, checked field by field and cut (at most CONTESTED_MAX); undefined when none is usable. */
export function cleanContested(x: unknown): ContestedRegion[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: ContestedRegion[] = [];
  for (const raw of x) {
    if (out.length >= CONTESTED_MAX) break;
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const [base, trunk, own] = [cleanSide(e.base), cleanSide(e.trunk), cleanSide(e.own)];
    if (!cleanPath(e.path) || typeof e.line !== "number" || !Number.isInteger(e.line) || e.line < 1 || !base || !trunk || !own) continue;
    const r = cutRegion({ path: e.path, line: e.line, base, trunk, own, ...(e.truncated === true ? { truncated: true } : {}) }, HUNK_LINES);
    out.push(r);
  }
  return out.length > 0 ? out : undefined;
}

/** Whether a return (a take's lastReturn, a proposal) carries usable quotes: hunks on a movedBy landing, or contested regions. */
export function hasQuotes(r: { movedBy?: unknown; contested?: unknown } | null | undefined): boolean {
  if (!r || typeof r !== "object") return false;
  const moved = Array.isArray(r.movedBy) ? (r.movedBy as unknown[]) : [];
  return moved.some((m) => !!m && typeof m === "object" && cleanHunks((m as { hunks?: unknown }).hunks) !== undefined) || cleanContested(r.contested) !== undefined;
}

/**
 * The prompt lines of one landing's diff of a file: a line that names the landing and the file, then the hunks as they
 * are. Repository content: a prompt shows them inside its fence.
 */
export function hunkLines(landingId: string, h: MovedHunk): string[] {
  const commit = typeof h.trunkSha === "string" ? ` (${h.trunkSha.slice(0, 7)})` : "";
  return [`what landing ${landingId}${commit} changed in ${h.path}${h.truncated ? " (cut short)" : ""}:`, ...h.diff.split("\n")];
}

/** The prompt lines of one contested region: where it starts in the base, then the base's, trunk's and the change's lines. */
export function contestedLines(r: ContestedRegion): string[] {
  const side = (label: string, lines: readonly string[]): string[] => [`${label} (${lines.length} line${lines.length === 1 ? "" : "s"}):`, ...lines.map((l) => `| ${l}`)];
  return [
    `contested region of ${r.path} from line ${r.line} of the change's base${r.truncated ? " (cut short)" : ""}:`,
    ...side("base", r.base),
    ...side("trunk now", r.trunk),
    ...side("your change", r.own),
  ];
}
