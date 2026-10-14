import { revalidationEnabled } from "@fire_trident/core";
import type { Id, Intent, IntentStatus } from "@fire_trident/core";
// Direct import until packages/core/src/index.ts re-exports twins.ts (orchestrator-owned).
import { TWINS, findTwins, type TwinCandidate, type TwinMatch } from "@fire_trident/core";
import type { SqlRunner } from "./inline.ts";
import { normalizePaths } from "./logic.ts";

/**
 * Twin intents caught at declare (FT_TWINS: "on", or a comma-separated list of colony ids; off when absent). When a
 * person or an agent declares an intent through POST /intents or the MCP declare tool (ColonyDO.declareIntent), it is
 * compared with the colony's intents still open, claimed or proposed and those landed in the last 30 minutes: the
 * normalized title words and the footprint must both match (core/twins.ts). On a match nothing is created: the answer
 * is the existing intent with `duplicateOf`, `similar` (every match with its score, best first) and a note that says
 * what to do next, and the same declare with `force: true` creates it anyway. Rule intents, certification repairs and
 * the colony's own intents never come through this check, and `ft new` declares a spec's intents with force. The check
 * fails open: its own failure declares the intent as before.
 */

/** Open, claimed and proposed intents compared, newest first. */
export const LIVE_CANDIDATES = 500;
/** Intents landed within the window compared, newest first. */
export const LANDED_CANDIDATES = 200;
/** Parents walked up from a declaration's parent: its ancestors are the work it is part of, never its twins. */
const ANCESTRY = 32;
/** Longest title a note quotes. */
const NOTE_TITLE_CHARS = 120;

/** What the MCP declare tool and docs/agents/README.md say happens on a twin, in one sentence. */
export const TWIN_DESCRIPTION =
  "Where the colony catches twin intents, a declare whose title words and footprint match an intent that is open, in progress or landed in the last 30 minutes creates nothing and returns that intent with duplicateOf and similar (each match with its score): take that one, or declare again with force: true.";

/** The MCP declare tool's force argument. */
export const FORCE_ARGUMENT = "Declare it even when it looks like an intent the colony already has (a twin, named by duplicateOf)";

/** What a declare answers when it found a twin: the existing intent, its id, every match with its score, best first, and what to do. */
export interface TwinAnswer {
  intent: Intent;
  duplicateOf: Id;
  similar: TwinMatch[];
  note: string;
}

/** What ColonyDO.declareIntent answers: the intent it created, or the twin it found instead. */
export type DeclareAnswer = { intent: Intent } | TwinAnswer;

/** Whether FT_TWINS covers the colony: "on", or a comma-separated list that names it; off when absent. */
export function twinsEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** Whether FT_TWINS covers some colony: the MCP declare tool then takes `force` and says what a twin answers. */
export function twinsOffered(setting: string | undefined): boolean {
  const s = typeof setting === "string" ? setting.trim() : "";
  if (s === "" || s.toLowerCase() === "off") return false;
  return s.toLowerCase() === "on" || s.split(",").some((id) => id.trim() !== "");
}

/**
 * Whether a declaration is checked: a person's or an agent's (any source the colony keeps as one), never a rule
 * intent (source "rule" or a rule id), a certification repair or the colony's own.
 */
export function twinChecked(i: { source?: unknown; ruleId?: unknown }): boolean {
  if (i.source === "rule" || i.source === "certify" || i.source === "system") return false;
  return typeof i.ruleId !== "string" || i.ruleId === "";
}

/** Whether a declare's answer is a twin: nothing was created, and `intent` is the one it duplicates. */
export function isTwinAnswer(a: unknown): a is TwinAnswer {
  if (!a || typeof a !== "object") return false;
  const d = (a as { duplicateOf?: unknown }).duplicateOf;
  return typeof d === "string" && d !== "";
}

/** One line, at most `max` characters, ending in "…" when cut. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The sentence a twin answer carries: which intent the declaration looks like, its status, and what to do next.
 * `waiting`: an agent reported the intent cannot be done as written and a person has not answered yet, so no agent is
 * offered it meanwhile.
 */
export function twinNote(match: Pick<TwinMatch, "id" | "title" | "status">, waiting = false): string {
  const next = waiting
    ? "an agent reported it cannot be done as written, so wait for a person's answer"
    : match.status === "open"
      ? "take that one"
      : match.status === "landed"
        ? "it landed in the last 30 minutes, so read trunk first"
        : "an agent is already on it, so leave it to them";
  const status = waiting ? `${match.status}, waiting for a person` : match.status;
  return `This looks like ${match.id} ${JSON.stringify(clip(match.title, NOTE_TITLE_CHARS))} (${status}): ${next}, or declare again with force: true if yours is different work.`;
}

/** A footprint as the intents table keeps it (JSON); anything else is empty, which overlaps nothing. */
function footprintOf(raw: unknown): string[] {
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** The intents table columns the check reads. */
interface CandidateRow {
  id: string;
  title: string;
  status: string;
  footprint: string;
  updated_at: number;
}

/**
 * The intents a declaration is compared with: the newest LIVE_CANDIDATES open, claimed or proposed, then the newest
 * LANDED_CANDIDATES landed since `now` minus the window (a landed intent's updated_at is when it landed), never a
 * vaccine's (sealed: nobody can take it) nor one in `exclude`. Each group is listed oldest first, so among equal
 * matches the answer names the intent declared first: the original, not a later copy.
 */
export function twinCandidates(sql: SqlRunner, now: number, exclude: ReadonlySet<Id> = new Set()): TwinCandidate[] {
  const live = sql
    .exec(
      `SELECT id, title, status, footprint, updated_at FROM intents
        WHERE status IN ('open', 'claimed', 'proposed') AND created_by != 'vaccine' ORDER BY created_at DESC LIMIT ?`,
      LIVE_CANDIDATES,
    )
    .toArray() as CandidateRow[];
  const landed = sql
    .exec(
      `SELECT id, title, status, footprint, updated_at FROM intents
        WHERE status = 'landed' AND updated_at >= ? AND created_by != 'vaccine' ORDER BY updated_at DESC LIMIT ?`,
      now - TWINS.landedMs,
      LANDED_CANDIDATES,
    )
    .toArray() as CandidateRow[];
  const out: TwinCandidate[] = [];
  for (const r of [...live.reverse(), ...landed.reverse()]) {
    if (exclude.has(r.id)) continue;
    const candidate: TwinCandidate = { id: r.id, title: String(r.title ?? ""), status: r.status as IntentStatus, footprint: footprintOf(r.footprint) };
    if (r.status === "landed") candidate.landedAt = Number(r.updated_at);
    out.push(candidate);
  }
  return out;
}

/** An intent's parent and the parent's ancestors, at most ANCESTRY of them (a cycle in old data ends the walk). */
export function ancestry(sql: SqlRunner, parentId: Id | null | undefined): Set<Id> {
  const out = new Set<Id>();
  let id = typeof parentId === "string" && parentId !== "" ? parentId : null;
  while (id !== null && !out.has(id) && out.size < ANCESTRY) {
    out.add(id);
    const row = sql.exec("SELECT parent_id FROM intents WHERE id = ?", id).toArray()[0] as { parent_id?: unknown } | undefined;
    id = typeof row?.parent_id === "string" && row.parent_id !== "" ? row.parent_id : null;
  }
  return out;
}

/**
 * The twin a declaration would duplicate, from the colony's tables, or null: the best match of core's findTwins among
 * twinCandidates (the declaration's own ancestors left out), as the colony has it now (`load` reads an intent by id),
 * with every match and the note. The title is compared trimmed and the footprint as the colony would keep it.
 */
export function findTwin(sql: SqlRunner, i: { title: string; footprint: readonly string[]; parentId?: Id | null }, now: number, load: (id: Id) => Intent | null): TwinAnswer | null {
  const title = typeof i.title === "string" ? i.title.trim() : "";
  const footprint = normalizePaths(Array.isArray(i.footprint) ? i.footprint.map(String) : []);
  if (title === "" || footprint.length === 0) return null;
  const similar = findTwins({ title, footprint }, twinCandidates(sql, now, ancestry(sql, i.parentId)), now);
  const best = similar[0];
  const intent = best ? load(best.id) : null;
  if (!best || !intent) return null;
  const waiting = intent.escalation !== undefined && intent.escalation.resolved === undefined;
  return { intent, duplicateOf: intent.id, similar, note: twinNote({ id: intent.id, title: intent.title, status: intent.status }, waiting) };
}
