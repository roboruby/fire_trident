import type { Id, Landing, LineageNote, NotesVerification, Sha } from "@fire_trident/core";
import { errorText } from "../artifacts/git.ts";
import { ftError } from "../colony/errors.ts";
import type { PublishedKey } from "./signature.ts";
import { checkLandings, summarize, type LandingRow, type ObjectSource } from "./verify.ts";

/**
 * One landing's lineage note, for the public reads of a single landing: its note check (GET
 * /api/colonies/:id/notes/verify?landing=, the badge on every note in the web app) and the writer's copy of its note
 * (the diff route, api/landing.ts). Read only, from the trunk writer's tables (ft_landings, ft_notes, ft_journal).
 */

/** A landing reference: a landing id (lnd_...) or the trunk commit it produced (40 hex, or a unique prefix of 7+). */
export const LANDING_REF = /^(?:lnd_[A-Za-z0-9_-]{1,64}|[0-9a-f]{7,40})$/;

/** One recorded landing: the columns the trunk writer keys it by, and its record as stored. */
export interface StoredLanding {
  id: Id;
  trunkSha: Sha;
  parentSha: Sha;
  at: number;
  data: string;
}

type Row = { id: string; trunk_sha: string; parent_sha: string; at: number; data: string };

/** The landing `ref` names (see LANDING_REF), or null: no such landing, or a commit prefix that matches more than one. */
export function findLanding(sql: SqlStorage, ref: string): StoredLanding | null {
  if (typeof ref !== "string" || !LANDING_REF.test(ref)) return null;
  const rows = ref.startsWith("lnd_")
    ? sql.exec<Row>(`SELECT id, trunk_sha, parent_sha, at, data FROM ft_landings WHERE id = ?`, ref).toArray()
    : sql.exec<Row>(`SELECT id, trunk_sha, parent_sha, at, data FROM ft_landings WHERE substr(trunk_sha, 1, ?) = ? LIMIT 2`, ref.length, ref).toArray();
  const r = rows.length === 1 ? rows[0] : undefined;
  return r ? { id: r.id, trunkSha: r.trunk_sha, parentSha: r.parent_sha, at: r.at, data: r.data } : null;
}

/** The landing as the API shows it: its record, with the columns it is keyed by (a record missing fields still reads). */
export function landingOf(s: StoredLanding, colonyId: Id): Landing {
  let data: Partial<Landing> = {};
  try {
    const parsed: unknown = JSON.parse(s.data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Partial<Landing>;
  } catch {
    // An unreadable record: the columns alone.
  }
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return {
    ...data,
    id: s.id,
    colonyId: typeof data.colonyId === "string" ? data.colonyId : colonyId,
    trunkSha: s.trunkSha,
    parentSha: s.parentSha,
    proposalIds: list(data.proposalIds),
    intentIds: list(data.intentIds),
    paths: list(data.paths),
    regions: list(data.regions),
    at: s.at,
  };
}

/** The trunk writer's copy of a landing's lineage note (ft_notes), or null when it has none or the copy is not a JSON object. */
export function storedNote(sql: SqlStorage, landingId: Id): LineageNote | null {
  const text = sql.exec<{ note: string }>(`SELECT note FROM ft_notes WHERE landing_id = ?`, landingId).toArray()[0]?.note;
  if (typeof text !== "string") return null;
  try {
    const note: unknown = JSON.parse(text);
    return note && typeof note === "object" && !Array.isArray(note) ? (note as LineageNote) : null;
  } catch {
    return null;
  }
}

/** The landing as the note check reads it (trunk/verify.ts): its commit, the writer's copy of its note, and whether a push of that note is due. */
export function landingRow(sql: SqlStorage, s: StoredLanding): LandingRow {
  const note = sql.exec<{ note: string }>(`SELECT note FROM ft_notes WHERE landing_id = ?`, s.id).toArray()[0]?.note ?? null;
  const waiting = sql.exec<{ x: number }>(`SELECT 1 AS x FROM ft_journal WHERE landing_id = ? LIMIT 1`, s.id).toArray().length > 0;
  return { landingId: s.id, trunkSha: s.trunkSha, at: s.at, note, waiting };
}

/**
 * One landing's note on the trunk repository against its commit's FT-Note trailer, answered as verifyNotes answers for
 * the newest (one check, counted). `tip` reads refs/notes/firetrident on the trunk repository (a failure is a 502, as in
 * verifyNotes); `src` reads git objects; `keys`, where the deployment signs notes, check the commit's signature.
 */
export async function verifyOne(row: LandingRow, p: { colonyId: Id; tip: () => Promise<Sha | null>; src: ObjectSource; keys?: readonly PublishedKey[] }): Promise<NotesVerification> {
  let tip: Sha | null;
  try {
    tip = await p.tip();
  } catch (e) {
    throw ftError(502, `the trunk repository's notes ref could not be read: ${errorText(e)}`);
  }
  const notes = await checkLandings([row], { src: p.src, tip, ...(p.keys ? { keys: p.keys } : {}) });
  return summarize(p.colonyId, tip, notes, Date.now());
}
