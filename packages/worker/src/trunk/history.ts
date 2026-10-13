/**
 * Path history: for each trunk path, the landings that changed it, newest first, each with the
 * proposal that wrote it, that proposal's intent and agent, and the intent's title (a commit no
 * proposal wrote, a revert or an antibody, carries a label instead). TrunkDO already records each
 * landing's paths with their blobs (ft_landing_paths, which `why` reads), but not which proposal or
 * intent wrote each path: that took parsing each landing's whole lineage note. Path history answers
 * "who changed this file, and for what" from one indexed read, which is what a person or a repair
 * needs to pick the proposal to undo (`ft revert <colony> <prp>`) when a file's tests go red.
 *
 * A lazy derived index of the trunk writer's landing log (trunk/derived.ts): the landing path pays
 * nothing for it, and a read first learns the landings since its cursor from their notes.
 */
import type { Id, Path, Sha } from "@fire_trident/core";
import type { Derived, TrunkLanding } from "./derived.ts";

/** Path history's name among the trunk's derived indexes. */
export const PATH_HISTORY = "path-history";
/** Entries one read returns by default and at most, paths of one landing indexed at most, and characters of a title. */
export const HISTORY_LIMIT = 20;
export const HISTORY_MAX = 200;
const PATHS_PER_LANDING = 2_000;
const TITLE_CHARS = 200;

/** Its table (ft_ prefix: TrunkDO.destroy replays ft_ DDL). proposal_id is "" on rows no proposal wrote. */
export const HISTORY_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ft_path_history (path TEXT NOT NULL, seq INTEGER NOT NULL, proposal_id TEXT NOT NULL, intent_id TEXT, agent_id TEXT, title TEXT NOT NULL, PRIMARY KEY (path, seq, proposal_id))",
];

/** One landing that changed a path, as path history answers it. */
export interface PathHistoryEntry {
  landingId: Id;
  trunkSha: Sha;
  at: number;
  /** The path's blob after the landing (null: the landing deleted it). */
  blob: Sha | null;
  /** The proposal that wrote the path, its intent and its agent; absent on a commit no proposal wrote. */
  proposalId?: Id;
  intentId?: Id;
  agentId?: Id;
  /** The intent's title, or the label of a commit no proposal wrote ("" when it has none). */
  title: string;
}

/** Who wrote what in one landing, from its lineage note. */
interface NoteWriters {
  byPath: Map<Path, Array<{ proposalId: Id; intentId: Id | null; agentId: Id | null; title: string }>>;
  /** A revert's or an antibody's label, for the paths no proposal wrote. */
  label: string;
}

/**
 * Path history as a derived index: lazy, applied from each landing's paths and its lineage note, one
 * row per path and proposal (a path no proposal of the landing wrote gets one row with no proposal).
 * Idempotent per landing (rows keyed by path, landing and proposal). A rebuild applies the whole log
 * again. Creates its table.
 */
export function pathHistoryDerived(sql: SqlStorage): Derived<TrunkLanding> {
  for (const stmt of HISTORY_SCHEMA) sql.exec(stmt);
  return {
    name: PATH_HISTORY,
    version: 1,
    mode: "lazy",
    apply: (e) => {
      const paths = e.landing.landing.paths.slice(0, PATHS_PER_LANDING);
      if (paths.length === 0) return 0;
      const writers = noteWriters(e.landing.note);
      let rows = 0;
      for (const path of paths) {
        for (const w of writers.byPath.get(path) ?? [{ proposalId: "", intentId: null, agentId: null, title: writers.label }]) {
          sql.exec(
            "INSERT OR IGNORE INTO ft_path_history (path, seq, proposal_id, intent_id, agent_id, title) VALUES (?, ?, ?, ?, ?, ?)",
            path,
            e.seq,
            w.proposalId,
            w.intentId,
            w.agentId,
            w.title,
          );
          rows++;
        }
      }
      return rows;
    },
    reset: () => {
      sql.exec("DELETE FROM ft_path_history");
      return 0;
    },
  };
}

/**
 * The landings that changed `path`, newest first, at most `limit` (at most HISTORY_MAX), as path
 * history holds them (catch it up first for the newest).
 */
export function pathHistory(sql: SqlStorage, path: Path, limit = HISTORY_LIMIT): PathHistoryEntry[] {
  const n = Math.max(1, Math.min(HISTORY_MAX, Math.floor(Number.isFinite(limit) ? limit : HISTORY_LIMIT)));
  return sql
    .exec<{ proposal_id: string; intent_id: string | null; agent_id: string | null; title: string; landing_id: string; trunk_sha: string; at: number; blob: string | null }>(
      `SELECT h.proposal_id AS proposal_id, h.intent_id AS intent_id, h.agent_id AS agent_id, h.title AS title,
              l.id AS landing_id, l.trunk_sha AS trunk_sha, l.at AS at, lp.after_blob AS blob
         FROM ft_path_history h
         JOIN ft_landings l ON l.seq = h.seq
         LEFT JOIN ft_landing_paths lp ON lp.path = h.path AND lp.seq = h.seq
        WHERE h.path = ? ORDER BY h.seq DESC, h.proposal_id LIMIT ?`,
      path,
      n,
    )
    .toArray()
    .map((r) => ({
      landingId: r.landing_id,
      trunkSha: r.trunk_sha,
      at: r.at,
      blob: r.blob,
      ...(r.proposal_id ? { proposalId: r.proposal_id } : {}),
      ...(r.intent_id ? { intentId: r.intent_id } : {}),
      ...(r.agent_id ? { agentId: r.agent_id } : {}),
      title: r.title,
    }));
}

/** Each proposal's written paths in a lineage note, and the label of a commit no proposal wrote. Malformed parts are ignored. */
function noteWriters(note: string | null): NoteWriters {
  const out: NoteWriters = { byPath: new Map(), label: "" };
  let parsed: unknown;
  try {
    parsed = note === null ? null : JSON.parse(note);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object") return out;
  const n = parsed as { proposals?: unknown; revert?: { of?: unknown; reason?: unknown }; system?: { kind?: unknown; antibody?: unknown } };
  if (n.revert && typeof n.revert === "object") {
    out.label = short(`Revert of ${String(n.revert.of ?? "")}${typeof n.revert.reason === "string" && n.revert.reason ? `: ${n.revert.reason}` : ""}`);
  } else if (n.system && typeof n.system === "object" && n.system.kind === "antibody") {
    out.label = short(`Antibody ${String(n.system.antibody ?? "")}`);
  }
  for (const raw of Array.isArray(n.proposals) ? (n.proposals as unknown[]) : []) {
    if (raw === null || typeof raw !== "object") continue;
    const p = raw as { id?: unknown; agentId?: unknown; intent?: { id?: unknown; title?: unknown }; writeSet?: unknown };
    if (typeof p.id !== "string" || p.id === "" || !Array.isArray(p.writeSet)) continue;
    const intent = p.intent && typeof p.intent === "object" ? p.intent : {};
    const w = {
      proposalId: p.id,
      intentId: typeof intent.id === "string" && intent.id !== "" ? intent.id : null,
      agentId: typeof p.agentId === "string" && p.agentId !== "" ? p.agentId : null,
      title: short(typeof intent.title === "string" ? intent.title : ""),
    };
    for (const f of p.writeSet as unknown[]) {
      const path = f !== null && typeof f === "object" ? (f as { path?: unknown }).path : undefined;
      if (typeof path !== "string" || path === "") continue;
      const list = out.byPath.get(path);
      if (!list) out.byPath.set(path, [w]);
      else if (!list.some((x) => x.proposalId === w.proposalId)) list.push(w);
    }
  }
  return out;
}

/** One line, cut to TITLE_CHARS. */
function short(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1)}…` : t;
}
