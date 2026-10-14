import type { Id, Path, Sha } from "@fire_trident/core";

/**
 * The first red search's view of the trunk writer's landing log (TrunkDO.landingRange): the commits after the last
 * green certification's commit up to the red one, oldest first. Trunk is one chain of commits, each recorded in
 * ft_landings with its parent (landings and FireTrident's own commits alike), so the range is read backwards from the
 * red commit by sequence number and kept only while each commit's parent is the one before it. A chain that breaks
 * (a commit FireTrident did not record) or does not reach the green commit within the bound names no range.
 */

/** Landings one range holds at most: past this the search could only narrow it, and the answer says so. */
export const RANGE_MAX = 512;
/** Paths of a landing tried for its witness. */
const WITNESS_TRIES = 3;

/** What the search asks for: the green commit, the red commit, and the red commit's landing when known (an indexed lookup). */
export interface RangeQuery {
  from: Sha;
  to: Sha;
  toLanding?: Id | null;
  max?: number;
}

/**
 * One commit of the range. `witness` is a file the landing wrote (path and blob): reading it back at the commit shows
 * the commit was read, so a commit that cannot be read is never taken for one on which the tests do not exist.
 */
export interface RangeLanding {
  landingId: Id;
  trunkSha: Sha;
  at: number;
  witness?: { path: Path; blob: Sha };
}

/** The range, oldest first (the last is the red commit), or why there is none. */
export type LandingRange = { ok: true; landings: RangeLanding[] } | { ok: false; reason: string };

type Row = {
  seq: number;
  id: string;
  trunk_sha: string;
  parent_sha: string;
  at: number;
  p0: string | null;
  p1: string | null;
  p2: string | null;
};

const COLUMNS = "seq, id, trunk_sha, parent_sha, at, json_extract(data, '$.paths[0]') AS p0, json_extract(data, '$.paths[1]') AS p1, json_extract(data, '$.paths[2]') AS p2";

/** The landings after commit `from` up to commit `to`, oldest first, from the landing log (`sql` holds ft_landings and ft_landing_paths). Read only. */
export function landingRange(sql: SqlStorage, q: RangeQuery): LandingRange {
  const from = typeof q?.from === "string" ? q.from : "";
  const to = typeof q?.to === "string" ? q.to : "";
  const max = Math.max(1, Math.min(RANGE_MAX, Math.floor(Number(q?.max) || RANGE_MAX)));
  if (!from || !to) return { ok: false, reason: "No green commit and red commit to search between." };
  if (from === to) return { ok: false, reason: "The red commit is the last green one." };
  let top: Row | undefined;
  if (typeof q.toLanding === "string" && q.toLanding) top = sql.exec<Row>(`SELECT ${COLUMNS} FROM ft_landings WHERE id = ?`, q.toLanding).toArray()[0];
  if (!top || top.trunk_sha !== to) top = sql.exec<Row>(`SELECT ${COLUMNS} FROM ft_landings WHERE trunk_sha = ? ORDER BY seq DESC LIMIT 1`, to).toArray()[0];
  if (!top) return { ok: false, reason: `The red commit ${to.slice(0, 7)} is not in the trunk writer's landing log.` };
  const rows = sql.exec<Row>(`SELECT ${COLUMNS} FROM ft_landings WHERE seq <= ? ORDER BY seq DESC LIMIT ?`, top.seq, max + 1).toArray();
  const chain: Row[] = [];
  let expect = to;
  for (const r of rows) {
    if (r.trunk_sha !== expect) return { ok: false, reason: `The landing log does not link the red commit ${to.slice(0, 7)} back to the last green commit ${from.slice(0, 7)} (trunk moved outside FireTrident).` };
    if (chain.length >= max) return { ok: false, reason: `More than ${max} landings since the last green commit ${from.slice(0, 7)}: too many to search.` };
    chain.push(r);
    if (r.parent_sha === from) return { ok: true, landings: chain.reverse().map((row) => withWitness(sql, row)) };
    expect = r.parent_sha;
  }
  return { ok: false, reason: `The landing log does not reach the last green commit ${from.slice(0, 7)} from the red commit ${to.slice(0, 7)}.` };
}

/** A range entry with its witness: the first of the landing's first paths it left a file at (an indexed lookup each). */
function withWitness(sql: SqlStorage, r: Row): RangeLanding {
  const out: RangeLanding = { landingId: r.id, trunkSha: r.trunk_sha, at: r.at };
  for (const path of [r.p0, r.p1, r.p2].slice(0, WITNESS_TRIES)) {
    if (typeof path !== "string" || path === "") continue;
    const blob = sql.exec<{ after_blob: string | null }>("SELECT after_blob FROM ft_landing_paths WHERE path = ? AND seq = ?", path, r.seq).toArray()[0]?.after_blob;
    if (typeof blob === "string" && blob !== "") {
      out.witness = { path, blob };
      break;
    }
  }
  return out;
}
