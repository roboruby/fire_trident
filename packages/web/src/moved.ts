import type { ContestedRegion, MovedBy, MovedHunk } from "@fire_trident/core";

/**
 * What beat a returned change (`movedBy`): the landings that moved the files it read or wrote, each with the intent it
 * completed, its agent and model, and its commit. The colony sends it with the proposal event of a return and with the
 * review queue's items; titles and whys are text people and agents wrote, so the UI shows them as text only.
 */

/** Landings shown per return at most. */
const MOVED_SHOWN = 5;
/** Return hunks (FT_RETURN_HUNKS): quoted files per landing, contested regions, and characters of one quote shown at most. */
const HUNKS_SHOWN = 3;
const REGIONS_SHOWN = 12;
const QUOTE_CHARS = 8_000;

/** A landing's quoted diffs as received (movedBy[].hunks), checked; undefined when none is usable. Repository content: shown as text only. */
export function cleanHunks(x: unknown): MovedHunk[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: MovedHunk[] = [];
  for (const raw of x) {
    if (out.length >= HUNKS_SHOWN) break;
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof e.path !== "string" || e.path === "" || typeof e.diff !== "string" || e.diff === "") continue;
    out.push({ path: e.path, diff: e.diff.slice(0, QUOTE_CHARS), truncated: e.truncated === true, ...(typeof e.trunkSha === "string" && e.trunkSha !== "" ? { trunkSha: e.trunkSha } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/** A return's contested regions as received (lastReturn.contested), checked; undefined when none is usable. */
export function cleanContested(x: unknown): ContestedRegion[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const lines = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((l): l is string => typeof l === "string").slice(0, 40) : null);
  const out: ContestedRegion[] = [];
  for (const raw of x) {
    if (out.length >= REGIONS_SHOWN) break;
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const [base, trunk, own] = [lines(e.base), lines(e.trunk), lines(e.own)];
    if (typeof e.path !== "string" || e.path === "" || typeof e.line !== "number" || !Number.isInteger(e.line) || e.line < 1 || !base || !trunk || !own) continue;
    out.push({ path: e.path, line: e.line, base, trunk, own, ...(e.truncated === true ? { truncated: true } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/** A movedBy list as received (an event, a review item), checked entry by entry; undefined when none is usable. */
export function cleanMoved(x: unknown): MovedBy[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: MovedBy[] = [];
  for (const raw of x) {
    if (out.length >= MOVED_SHOWN) break;
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const paths = Array.isArray(e.paths) ? e.paths.filter((p): p is string => typeof p === "string" && p !== "") : [];
    if (typeof e.landingId !== "string" || e.landingId === "" || paths.length === 0) continue;
    const m: MovedBy = { landingId: e.landingId, paths };
    for (const k of ["trunkSha", "intentId", "title", "why", "agentId", "model"] as const) {
      const v = e[k];
      if (typeof v === "string" && v !== "") m[k] = v;
    }
    if (typeof e.at === "number" && Number.isFinite(e.at)) m.at = e.at;
    const hunks = cleanHunks(e.hunks);
    if (hunks) m.hunks = hunks;
    out.push(m);
  }
  return out.length > 0 ? out : undefined;
}

/** The movedBy of a proposal event, checked (older servers send none). */
export function movedByOf(ev: { movedBy?: unknown }): MovedBy[] | undefined {
  return cleanMoved(ev.movedBy);
}

/** A short label for what beat a change: the first landing's intent title (or the landing), and how many more. */
export function movedLabel(moved: readonly MovedBy[]): string {
  const first = moved[0];
  if (!first) return "";
  const name = first.title ? (first.title.length > 40 ? `${first.title.slice(0, 39)}…` : first.title) : first.landingId;
  return moved.length > 1 ? `${name} +${moved.length - 1}` : name;
}

/** One line per landing: what it moved, for which intent, by whom, with which model, in which commit. */
export function movedLines(moved: readonly MovedBy[], agentName: (id: string) => string = (id) => id): string[] {
  return moved.map((m) => {
    const who = [m.agentId ? agentName(m.agentId) : "", m.model ?? ""].filter(Boolean).join(" · ");
    const commit = m.trunkSha ? ` (${m.trunkSha.slice(0, 7)})` : "";
    return `${m.paths.join(", ")} moved by ${m.title ? `"${m.title}"` : `landing ${m.landingId}`}${who ? `, ${who}` : ""}${commit}${m.why ? `: ${m.why}` : ""}`;
  });
}
