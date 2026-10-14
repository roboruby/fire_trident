import type { AgentKind, Id, MovedBy, Path, Proposal } from "@fire_trident/core";
import { oneLine } from "../agents/change.ts";
import { shortTitle, shortWhy } from "../agents/landed.ts";
import { noteProvenance } from "../trunk/provenance.ts";

/**
 * What beat a returned change (`movedBy`). When a change goes back because trunk moved files it read or wrote (the lane
 * found it stale, or the trunk writer did, or its text merge conflicted), the colony names each landing after the
 * change's base that moved those files: the intent it completed with its title and why, the agent whose proposal wrote
 * them, the model that landing's lineage note names for that proposal (computed from the colony's record of the agent,
 * as the trunk writer computes it, trunk/provenance.ts), and the trunk commit. All of it comes from the colony's own
 * tables: the per-path landing index the why-context reads (`landing_paths`), the landing log, intents, proposals and
 * agents; trunk is never asked. The return's reason then ends by naming those landings, with one instruction: keep what
 * they did unless your intent says otherwise, and escalate if both cannot hold.
 *
 * Best effort: a path no known landing moved after the base (a revert or another system commit, or a landing the colony
 * has not heard of yet) is not named, and nothing is added when none is.
 */

/** Landings named per returned change at most, paths listed per landing, and paths of one change looked up. */
export const MOVED_LANDINGS = 5;
export const MOVED_PATHS = 10;
export const MOVED_LOOKUPS = 64;
/** Review cards (the first of the queue) that carry what beat their intent's last change. */
export const REVIEW_MOVED = 50;

/** A return caused by trunk moving: the lane's and the trunk writer's stale and conflict reasons start so. */
const COLLISION = /^(stale\b|conflicts? )/i;
const ID = /^[\w-]{1,100}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Latest time a Date can show (ms since the epoch). */
const MAX_DATE_MS = 8.64e15;
/** Longest model name an entry keeps. */
const MODEL_CHARS = 200;

/** The SQL movedBy runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** One path a change was found stale on (the lane's or the trunk writer's structured return); only `path` is read. */
export interface StalePath {
  path: Path;
}

function first<T>(sql: SqlRunner, query: string, ...bindings: unknown[]): T | undefined {
  return sql.exec(query, ...bindings).toArray()[0] as T | undefined;
}

/** "a", "a and b", "a, b and c"; past `max` items, the first `max` and "N more". */
function listText(items: readonly string[], max: number): string {
  const parts = items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : [...items];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The evidence checks a proposal row keeps, as JSON text, read for the model they name; [] when unreadable. */
function checksOf(text: unknown): unknown[] {
  if (typeof text !== "string") return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * The landings that moved a returned change's files, newest first (at most MOVED_LANDINGS, each with at most MOVED_PATHS
 * paths): for each path, the newest landing in the per-path index after the landing that made the change's base (any
 * landing when the base is not one the colony recorded), grouped by landing and intent. `stale`: the paths it was found
 * stale on; without them, every path it wrote, read or relies on (its assumptions).
 */
export function movedBy(sql: SqlRunner, p: Pick<Proposal, "baseSha" | "writeSet" | "readSet" | "assumptions">, stale?: readonly StalePath[] | null): MovedBy[] {
  const named = Array.isArray(stale) ? stale.map((s) => s?.path) : [];
  const wanted = named.length > 0 ? named : [...(p.writeSet ?? []).map((w) => w?.path), ...(p.readSet ?? []).map((r) => r?.path), ...(Array.isArray(p.assumptions) ? p.assumptions : [])];
  const paths = [...new Set(wanted.filter((x): x is Path => typeof x === "string" && x !== ""))].slice(0, MOVED_LOOKUPS);
  if (paths.length === 0) return [];
  const base = first<{ id: string; at: number }>(sql, "SELECT id, at FROM landings WHERE trunk_sha = ? LIMIT 1", p.baseSha ?? "");
  const groups = new Map<string, { landingId: Id; at: number; intentId: Id | null; paths: Path[] }>();
  for (const path of paths) {
    const hit = first<{ at: number; landing_id: string; intent_id: string | null }>(
      sql,
      "SELECT at, landing_id, intent_id FROM landing_paths WHERE path = ? AND at >= ? AND landing_id != ? ORDER BY at DESC LIMIT 1",
      path,
      base?.at ?? 0,
      base?.id ?? "",
    );
    if (!hit) continue;
    const key = `${hit.landing_id}\u0000${hit.intent_id ?? ""}`;
    const g = groups.get(key) ?? { landingId: hit.landing_id, at: hit.at, intentId: hit.intent_id, paths: [] };
    g.paths.push(path);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.at - a.at || (a.landingId < b.landingId ? 1 : a.landingId > b.landingId ? -1 : 0))
    .slice(0, MOVED_LANDINGS)
    .map((g) => describeLanding(sql, g));
}

/** One landing of movedBy with what the colony knows of it: its commit, its intent, and the agent and model that wrote the paths. */
function describeLanding(sql: SqlRunner, g: { landingId: Id; at: number; intentId: Id | null; paths: Path[] }): MovedBy {
  const out: MovedBy = { landingId: g.landingId, paths: [...g.paths].sort().slice(0, MOVED_PATHS), at: g.at };
  const landing = first<{ trunk_sha: string | null; ids: string | null }>(sql, "SELECT trunk_sha, json_extract(data, '$.proposalIds') AS ids FROM landings WHERE id = ?", g.landingId);
  if (landing?.trunk_sha) out.trunkSha = landing.trunk_sha;
  if (!g.intentId) return out;
  out.intentId = g.intentId;
  const intent = first<{ title: string; why: string }>(sql, "SELECT title, why FROM intents WHERE id = ?", g.intentId);
  const title = shortTitle(intent?.title);
  const why = shortWhy(intent?.why);
  if (title) out.title = title;
  if (why) out.why = why;
  // The landing's proposal for that intent wrote the paths: its agent, and the model its lineage note names.
  const writer = landing
    ? first<{ agent_id: string; checks: string | null }>(
        sql,
        "SELECT agent_id, json_extract(data, '$.evidence.checks') AS checks FROM proposals WHERE intent_id = ? AND id IN (SELECT value FROM json_each(?)) LIMIT 1",
        g.intentId,
        landing.ids ?? "[]",
      )
    : undefined;
  if (!writer) return out;
  out.agentId = writer.agent_id;
  const agent = first<{ kind: string; model: string | null }>(sql, "SELECT kind, model FROM agents WHERE id = ?", writer.agent_id);
  const model = agent ? noteProvenance({ kind: agent.kind as AgentKind, ...(agent.model ? { model: agent.model } : {}) }, { checks: checksOf(writer.checks) } as Proposal["evidence"])?.model?.name : undefined;
  if (model) out.model = model;
  return out;
}

/**
 * The sentence a returned change's reason ends with: the landings that moved its files (landing, commit, intent and agent
 * ids), then the one instruction. Ids only: titles, whys and model names are free text, and reasons are matched by
 * pattern elsewhere (a reason that names a file counts toward that file's megafile alarm, so no path is added either);
 * movedBy carries them all.
 */
export function movedSentence(moved: readonly MovedBy[]): string {
  const named = moved.map((m) => {
    const facts = [m.trunkSha ? `commit ${m.trunkSha.slice(0, 7)}` : "", m.intentId ? `intent ${m.intentId}` : "", m.agentId ? `agent ${m.agentId}` : ""].filter(Boolean).join(", ");
    return `${m.landingId}${facts ? ` (${facts})` : ""}`;
  });
  const files = new Set(moved.flatMap((m) => m.paths)).size === 1 ? "it" : "them";
  const keep =
    moved.length === 1
      ? "Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold."
      : "Keep what those landings did unless your intent says otherwise, and escalate if they cannot all hold.";
  return `${moved.length === 1 ? "Landing" : "Landings"} ${listText(named, MOVED_LANDINGS)} moved ${files}. ${keep}`;
}

/** Whether a change went back because trunk moved files it read or wrote: a stale or conflict return (not review, a change of direction, a hold or a failed landing). */
export function movedCollision(p: Pick<Proposal, "status" | "reason">): boolean {
  return p.status === "returned" && typeof p.reason === "string" && COLLISION.test(p.reason.trim());
}

/**
 * What a change going back gains when trunk moved its files: `movedBy`, and its reason ending with movedSentence. Null
 * for any other return (movedCollision) and when no landing is known to have moved them.
 */
export function movedReturn(sql: SqlRunner, p: Proposal, stale?: readonly StalePath[] | null): { movedBy: MovedBy[]; reason: string } | null {
  if (!movedCollision(p) || typeof p.reason !== "string") return null;
  const moved = movedBy(sql, p, stale);
  if (moved.length === 0) return null;
  return { movedBy: moved, reason: `${p.reason.trimEnd()}. ${movedSentence(moved)}` };
}

/**
 * movedBy as received from another object or read back from storage, checked field by field and capped; undefined when
 * nothing usable is left (older data has none).
 */
export function cleanMovedBy(x: unknown): MovedBy[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: MovedBy[] = [];
  for (const raw of x) {
    if (out.length >= MOVED_LANDINGS) break;
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.landingId !== "string" || !ID.test(e.landingId)) continue;
    const paths = (Array.isArray(e.paths) ? e.paths : []).filter((p): p is string => typeof p === "string" && p !== "" && p.length <= 1_000).slice(0, MOVED_PATHS);
    if (paths.length === 0) continue;
    const m: MovedBy = { landingId: e.landingId, paths };
    if (typeof e.trunkSha === "string" && SHA.test(e.trunkSha)) m.trunkSha = e.trunkSha;
    if (typeof e.at === "number" && Number.isFinite(e.at) && e.at >= 0 && e.at <= MAX_DATE_MS) m.at = e.at;
    if (typeof e.intentId === "string" && ID.test(e.intentId)) m.intentId = e.intentId;
    const title = typeof e.title === "string" ? shortTitle(e.title) : "";
    if (title) m.title = title;
    const why = typeof e.why === "string" ? shortWhy(e.why) : "";
    if (why) m.why = why;
    if (typeof e.agentId === "string" && ID.test(e.agentId)) m.agentId = e.agentId;
    const model = typeof e.model === "string" ? oneLine(e.model).slice(0, MODEL_CHARS) : "";
    if (model) m.model = model;
    out.push(m);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * One landing of movedBy as a prompt line: the landing, its commit and time, the files it moved, its intent's title and
 * why, and the agent and model. Repository data: prompts fence it with the rest of the return.
 */
export function movedLine(m: MovedBy): string {
  const commit = typeof m.trunkSha === "string" ? ` ${m.trunkSha.slice(0, 7)}` : "";
  const when = typeof m.at === "number" && Number.isFinite(m.at) && Math.abs(m.at) <= MAX_DATE_MS ? ` at ${new Date(m.at).toISOString().slice(0, 16).replace("T", " ")}` : "";
  const title = oneLine(m.title ?? "");
  const why = oneLine(m.why ?? "");
  const who = [m.agentId ? `agent ${m.agentId}` : "", m.model ? `model ${oneLine(m.model)}` : ""].filter(Boolean).join(", ");
  return `moved by landing ${m.landingId}${commit}${when}: ${m.paths.join(", ")}${title ? ` for "${title}"` : ""}${why ? `: ${why}` : ""}${who ? ` (${who})` : ""}`;
}

/** movedBy as an external agent sees it over MCP: the same fields, the time in ISO form. */
export function movedView(moved: readonly MovedBy[] | undefined): Array<Record<string, unknown>> | undefined {
  const list = cleanMovedBy(moved);
  return list?.map((m) => ({ ...m, ...(typeof m.at === "number" ? { at: new Date(m.at).toISOString() } : {}) }));
}
