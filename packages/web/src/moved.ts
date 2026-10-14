import type { MovedBy } from "@fire_trident/core";

/**
 * What beat a returned change (`movedBy`): the landings that moved the files it read or wrote, each with the intent it
 * completed, its agent and model, and its commit. The colony sends it with the proposal event of a return and with the
 * review queue's items; titles and whys are text people and agents wrote, so the UI shows them as text only.
 */

/** Landings shown per return at most. */
const MOVED_SHOWN = 5;

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
