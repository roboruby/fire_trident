import type { Id, Path, Sha } from "@fire_trident/core";
import { personName } from "@fire_trident/core";

/**
 * The trunk writer's half of a landing's test row (certify/landingtests.ts): where commits sit on trunk's chain, and who
 * changed each test file. Trunk is one chain of commits, each recorded in ft_landings with its sequence number (landings
 * and FireTrident's own commits alike), so a commit's place is its sequence number; the commit the oldest recorded one
 * was made on (the import) is 0. A test file's lineage is its rows in ft_landing_paths (every landing that changed it, with
 * the blob it had before) read with each landing's lineage note: a change a person approved, a person's revert, an
 * agent's change no person approved (with its model), or FireTrident's own commit. Read only, bounded, indexed lookups.
 */

/** Commits placed at most per call. */
export const ORDER_SHAS = 1_000;
/** Test files whose lineage one call reads at most. */
export const LINEAGE_FILES = 400;
/** Changes read per test file at most, newest first (`more` says when there are older ones). */
export const LINEAGE_PER_FILE = 8;
/** Lineage notes one call parses at most; a change whose note is past it reads as unknown. */
export const LINEAGE_NOTES = 400;

/** Who made one change to a test file: an agent (no person approved it), a person (approved it, or reverted to it), FireTrident, or unknown. */
export interface TestFileChange {
  landingId: Id;
  by: "agent" | "person" | "system" | "unknown";
  /** The agent's model, or the person, when the note names one. */
  name?: string;
  /** The change added the file (it was not on trunk before). */
  added?: true;
}

/** One test file's changes up to a commit, newest first, and whether older ones were left out. */
export interface TestFileLineage {
  changes: TestFileChange[];
  more: boolean;
}

/** What testLineage answers for: the test files, and the commit their lineage stops at (inclusive). */
export interface TestLineageQuery {
  paths: Path[];
  upTo: Sha;
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

/** Each asked commit's place on trunk's chain (its newest sequence number; 0 for the commit the log starts from); unknown commits are left out. */
export function commitOrder(sql: SqlStorage, shas: readonly Sha[]): Record<Sha, number> {
  const want = [...new Set((Array.isArray(shas) ? shas : []).filter((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)))].slice(0, ORDER_SHAS);
  const out: Record<Sha, number> = {};
  if (want.length === 0) return out;
  for (const r of sql
    .exec<{ trunk_sha: string; seq: number }>("SELECT trunk_sha, MAX(seq) AS seq FROM ft_landings WHERE trunk_sha IN (SELECT value FROM json_each(?)) GROUP BY trunk_sha", JSON.stringify(want))
    .toArray()) {
    Object.defineProperty(out, r.trunk_sha, { value: r.seq, enumerable: true, writable: true, configurable: true });
  }
  const root = sql.exec<{ parent_sha: string }>("SELECT parent_sha FROM ft_landings ORDER BY seq ASC LIMIT 1").toArray()[0]?.parent_sha;
  if (root && want.includes(root) && !(root in out)) Object.defineProperty(out, root, { value: 0, enumerable: true, writable: true, configurable: true });
  return out;
}

/** Who made a note's change to `path` (see TestFileChange); a note that cannot be read is unknown. */
export function changeBy(note: unknown, path: Path): Pick<TestFileChange, "by" | "name"> {
  if (!isObj(note)) return { by: "unknown" };
  if (isObj(note.revert)) {
    const name = personName(note.revert.by);
    return name ? { by: "person", name } : { by: "person" };
  }
  if (isObj(note.system)) return { by: "system" };
  const writers = (Array.isArray(note.proposals) ? note.proposals : []).filter((p): p is Json => isObj(p) && Array.isArray(p.writeSet) && p.writeSet.some((w: unknown) => isObj(w) && w.path === path));
  if (writers.length === 0) return { by: "unknown" };
  const approver = (p: Json): string | null | undefined => {
    const d = (Array.isArray(p.decisions) ? p.decisions : []).filter(isObj).findLast((x) => x.layer === "human" && x.action === "approve");
    return d ? personName(d.by) : undefined;
  };
  // An agent's change no person approved counts first: one is enough to make the file the agents'.
  const agent = writers.find((p) => approver(p) === undefined);
  if (agent) return typeof agent.model === "string" && agent.model.trim() !== "" ? { by: "agent", name: agent.model.trim() } : { by: "agent" };
  const name = approver(writers[0]!);
  return name ? { by: "person", name } : { by: "person" };
}

/** Each test file's changes on trunk up to commit `upTo` (see the module comment); paths past LINEAGE_FILES are left out. */
export function testLineage(sql: SqlStorage, q: TestLineageQuery): Record<Path, TestFileLineage> {
  const out: Record<Path, TestFileLineage> = {};
  const paths = [...new Set((Array.isArray(q?.paths) ? q.paths : []).filter((p) => typeof p === "string" && p !== ""))].slice(0, LINEAGE_FILES);
  if (paths.length === 0) return out;
  const upTo = typeof q.upTo === "string" ? (commitOrder(sql, [q.upTo])[q.upTo] ?? null) : null;
  const notes = new Map<Id, unknown>();
  const noteOf = (landingId: Id): unknown => {
    if (notes.has(landingId)) return notes.get(landingId);
    if (notes.size >= LINEAGE_NOTES) return null;
    const raw = sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", landingId).toArray()[0]?.note;
    let parsed: unknown = null;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsed = null;
    }
    notes.set(landingId, parsed);
    return parsed;
  };
  for (const path of paths) {
    // A commit the log does not hold (the import): no landing it knows of changed the file by then.
    const rows =
      upTo === null || upTo <= 0
        ? []
        : sql
            .exec<{ seq: number; landing_id: string; before_blob: string | null }>(
              "SELECT seq, landing_id, before_blob FROM ft_landing_paths WHERE path = ? AND seq <= ? ORDER BY seq DESC LIMIT ?",
              path,
              upTo,
              LINEAGE_PER_FILE + 1,
            )
            .toArray();
    const changes = rows.slice(0, LINEAGE_PER_FILE).map((r): TestFileChange => ({ landingId: r.landing_id, ...changeBy(noteOf(r.landing_id), path), ...(r.before_blob === null ? { added: true as const } : {}) }));
    Object.defineProperty(out, path, { value: { changes, more: rows.length > LINEAGE_PER_FILE }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
