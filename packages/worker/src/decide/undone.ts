/**
 * The goal-conflict check's input, computed by the trunk writer (TrunkDO.removedLineOwners): for each file a change
 * modifies or deletes, the recent landings that wrote the lines it removes from the version at its base, how many of
 * each landing's lines that version holds, and the intent each wrote them for. Like `why` per line (TrunkDO.lineOwner),
 * it follows lines back through the landings that changed the file (ft_landing_paths, newest first, with the file's
 * blob before and after each), but for every removed line at once and only through recent landings
 * (core/goalconflict.ts, LineTrace); who wrote the file in a landing comes from that landing's lineage note.
 *
 * Read only and bounded: at most GOAL_CONFLICT_MAX_FILES files and GOAL_CONFLICT_MAX_REMOVED removed lines a query,
 * versions up to GOAL_CONFLICT_MAX_BYTES, and a budget of landings walked, bytes read, lines compared and time. A file
 * it cannot follow to the end is named in `skipped`; the landings it found until then are still right, since a landing
 * owns only the lines it added.
 */
import type { Id, Path, RemovedOwner, Sha, UndoneLines } from "@fire_trident/core";
import { GOAL_CONFLICT_LANDINGS, GOAL_CONFLICT_MAX_BYTES, GOAL_CONFLICT_MAX_FILES, GOAL_CONFLICT_MAX_REMOVED, LineTrace } from "@fire_trident/core";

/** Landings one query walks back through at most, over all its files. */
const MAX_STEPS = 400;
/** Bytes of file versions one query reads at most. */
const MAX_READ_BYTES = 16 * 1024 * 1024;
/** Lines one query compares at most (every version it reads, line by line). */
const MAX_LINES = 2_000_000;
/** Time one query spends at most (ms); the decide stage gives up waiting sooner. */
const MAX_MS = 4_000;
/** The largest landing window a query may ask for. */
const MAX_LANDINGS = 10_000;
const SHA = /^[0-9a-f]{40}$/;

/** One file of a change: its blob at the change's base, and the lines (0-based, as core lineKeys splits it) the change removes there. */
export interface RemovedLinesFile {
  path: Path;
  blob: Sha;
  removed: number[];
}

/** What the decide stage asks the trunk writer. */
export interface RemovedLinesQuery {
  files: RemovedLinesFile[];
  /** Landings that landed before this time (ms) are not recent. */
  since: number;
  /** Only the colony's newest this many landings are recent. */
  landings: number;
}

/** The answer: each recent landing that wrote removed lines, per file, and the files not followed to the end, each with why. */
export interface RemovedLinesAnswer {
  owners: RemovedOwner[];
  skipped: Array<{ path: Path; why: string }>;
}

/** One landing that changed a path: its place in the landing log, when it landed, and the path's blobs before and after it. */
export interface PathChange {
  seq: number;
  landingId: Id;
  at: number;
  before: Sha | null;
  after: Sha | null;
}

/** Who wrote a path in one landing, from its lineage note: the proposal and its intent, or FireTrident's own commit. */
export interface PathWriter {
  proposalId?: Id;
  intentId?: Id;
  system?: boolean;
}

/** What the trace reads from the trunk writer: its landing log, lineage notes and blobs. */
export interface LineageSource {
  /** The seq of the oldest of the colony's newest `n` landings (0 when it has fewer). */
  oldestRecent(n: number): number;
  /** The landings that changed `path`, newest first: seq at least `from`, landed at or after `since`, at most `limit`. */
  changes(path: Path, from: number, since: number, limit: number): PathChange[];
  /** How many landings are newer than the one at `seq`. */
  newer(seq: number): number;
  /** Who wrote `path` in a landing (its lineage note); null when the note does not say. */
  writer(landingId: Id, path: Path): PathWriter | null;
  /** A blob's bytes, or null when it cannot be read. */
  read(blob: Sha): Promise<Uint8Array | null>;
  /** The time (ms), for the time budget. */
  now(): number;
}

/** The files of a query as the trace takes them: well formed, each path once, at most GOAL_CONFLICT_MAX_FILES files and GOAL_CONFLICT_MAX_REMOVED removed lines in all. */
function cleanFiles(raw: unknown): RemovedLinesFile[] {
  const out: RemovedLinesFile[] = [];
  let room = GOAL_CONFLICT_MAX_REMOVED;
  for (const f of Array.isArray(raw) ? raw : []) {
    if (out.length >= GOAL_CONFLICT_MAX_FILES || room <= 0) break;
    if (!f || typeof f !== "object") continue;
    const { path, blob, removed } = f as Partial<RemovedLinesFile>;
    if (typeof path !== "string" || path === "" || path.length > 4_096 || typeof blob !== "string" || !SHA.test(blob)) continue;
    if (out.some((x) => x.path === path)) continue;
    const lines = [...new Set((Array.isArray(removed) ? removed : []).filter((i): i is number => Number.isInteger(i) && i >= 0))].slice(0, room);
    if (lines.length === 0) continue;
    room -= lines.length;
    out.push({ path, blob, removed: lines });
  }
  return out;
}

/**
 * For each file of the query, the recent landings that wrote the lines the change removes (see the module comment).
 * A file whose version at the change's base no recent landing produced has none: everything in it is older.
 */
export async function removedLineOwners(src: LineageSource, q: RemovedLinesQuery): Promise<RemovedLinesAnswer> {
  const owners: RemovedOwner[] = [];
  const skipped: RemovedLinesAnswer["skipped"] = [];
  const files = cleanFiles(q?.files);
  if (files.length === 0) return { owners, skipped };
  const recent = typeof q.landings === "number" && Number.isFinite(q.landings) && q.landings >= 1 ? Math.min(MAX_LANDINGS, Math.floor(q.landings)) : GOAL_CONFLICT_LANDINGS;
  const since = typeof q.since === "number" && Number.isFinite(q.since) ? q.since : 0;
  const from = src.oldestRecent(recent);
  const deadline = src.now() + MAX_MS;
  let steps = MAX_STEPS;
  let bytes = MAX_READ_BYTES;
  let lines = 0;
  const texts = new Map<Sha, string | null>();
  // A version's text: null when it cannot be read, is larger than the check reads, or the byte budget is spent.
  const text = async (blob: Sha): Promise<string | null> => {
    if (texts.has(blob)) return texts.get(blob) ?? null;
    let out: string | null = null;
    if (bytes > 0) {
      const data = await src.read(blob).catch(() => null);
      if (data) {
        bytes -= data.length;
        if (data.length <= GOAL_CONFLICT_MAX_BYTES) out = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(data);
      }
    }
    texts.set(blob, out);
    return out;
  };

  for (const f of files) {
    if (steps <= 0 || bytes <= 0 || lines >= MAX_LINES || src.now() > deadline) {
      skipped.push({ path: f.path, why: "not traced: the check's budget was spent" });
      continue;
    }
    const changes = src.changes(f.path, from, since, recent);
    const start = changes.findIndex((c) => c.after === f.blob);
    if (start < 0) continue;
    const base = await text(f.blob);
    if (base === null) {
      skipped.push({ path: f.path, why: "not traced: its version at the change's base could not be read (or is too large)" });
      continue;
    }
    const trace = new LineTrace(base, f.removed);
    const walked: PathChange[] = [];
    let current: Sha | null = f.blob;
    let cut = "";
    for (let i = start; i < changes.length && !trace.done; i++) {
      if (steps <= 0 || bytes <= 0 || lines + trace.work >= MAX_LINES || src.now() > deadline) {
        cut = "partly traced: the check's budget was spent";
        break;
      }
      const c = changes[i]!;
      // A landing that deleted the file cannot have produced the version reached: the history is not one chain here.
      if (c.after === null) {
        cut = "partly traced: its history is broken by a deletion";
        break;
      }
      const produced = c.after === current ? undefined : await text(c.after);
      const before = c.before === null ? null : await text(c.before);
      if (produced === null || (c.before !== null && before === null)) {
        cut = "partly traced: a version could not be read (or is too large)";
        break;
      }
      steps--;
      trace.step(before, produced);
      walked.push(c);
      current = c.before;
    }
    lines += trace.work;
    if (cut) skipped.push({ path: f.path, why: cut });
    for (const o of trace.owners()) {
      const c = walked[o.step];
      if (!c) continue;
      const w = src.writer(c.landingId, f.path);
      owners.push({
        landingId: c.landingId,
        at: c.at,
        rank: src.newer(c.seq),
        path: f.path,
        removed: o.removed,
        lines: o.lines,
        ...(w?.intentId ? { intentId: w.intentId } : {}),
        ...(w?.proposalId ? { proposalId: w.proposalId } : {}),
        ...(w?.system ? { system: true } : {}),
      });
    }
  }
  return { owners, skipped };
}

/** Records of a note's `undoes` at most. */
const NOTE_UNDOES_MAX = 50;

/**
 * The `undoes` field of a proposal's lineage note entry (the goal conflict a person approved it over), from what the
 * proposal recorded: well formed records only, at most NOTE_UNDOES_MAX; no field when there are none.
 */
export function noteUndoes(raw: unknown): { undoes?: UndoneLines[] } {
  if (!Array.isArray(raw)) return {};
  const out: UndoneLines[] = [];
  for (const u of raw) {
    if (out.length >= NOTE_UNDOES_MAX) break;
    if (!u || typeof u !== "object") continue;
    const { landingId, intentId, path, lines } = u as Partial<UndoneLines>;
    if (typeof landingId !== "string" || landingId === "" || typeof intentId !== "string" || intentId === "" || typeof path !== "string" || path === "") continue;
    if (typeof lines !== "number" || !Number.isFinite(lines) || lines < 0) continue;
    out.push({ landingId, intentId, path, lines: Math.floor(lines) });
  }
  return out.length > 0 ? { undoes: out } : {};
}

/** Who wrote `path` according to a parsed lineage note: FireTrident's own commit (a revert or an antibody), or the first proposal whose write set has it. */
export function noteWriter(note: unknown, path: Path): PathWriter | null {
  if (!note || typeof note !== "object") return null;
  const n = note as { proposals?: unknown; revert?: unknown; system?: unknown };
  if ((n.revert && typeof n.revert === "object") || (n.system && typeof n.system === "object")) return { system: true };
  for (const raw of Array.isArray(n.proposals) ? n.proposals : []) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as { id?: unknown; intent?: { id?: unknown }; writeSet?: unknown };
    const writes = Array.isArray(p.writeSet) && p.writeSet.some((w) => !!w && typeof w === "object" && (w as { path?: unknown }).path === path);
    if (!writes) continue;
    const intentId = p.intent && typeof p.intent === "object" && typeof p.intent.id === "string" && p.intent.id !== "" ? p.intent.id : undefined;
    return { ...(typeof p.id === "string" && p.id !== "" ? { proposalId: p.id } : {}), ...(intentId ? { intentId } : {}) };
  }
  return null;
}

/**
 * The trace's source over the trunk writer's tables (ft_landings, ft_landing_paths, ft_notes) and its blobs (`read`:
 * the local repository first, then the trunk repository). Each landing's note is parsed once per source.
 */
export function sqlLineageSource(sql: SqlStorage, read: (blob: Sha) => Promise<Uint8Array | null>, now: () => number = Date.now): LineageSource {
  const notes = new Map<Id, unknown>();
  return {
    oldestRecent: (n) => sql.exec<{ seq: number }>("SELECT seq FROM ft_landings ORDER BY seq DESC LIMIT 1 OFFSET ?", Math.max(0, n - 1)).toArray()[0]?.seq ?? 0,
    changes: (path, from, since, limit) =>
      sql
        .exec<{ seq: number; landing_id: string; at: number; before_blob: string | null; after_blob: string | null }>(
          `SELECT lp.seq AS seq, lp.landing_id AS landing_id, l.at AS at, lp.before_blob AS before_blob, lp.after_blob AS after_blob
             FROM ft_landing_paths lp JOIN ft_landings l ON l.seq = lp.seq
            WHERE lp.path = ? AND lp.seq >= ? AND l.at >= ? ORDER BY lp.seq DESC LIMIT ?`,
          path,
          from,
          since,
          Math.max(1, limit),
        )
        .toArray()
        .map((r) => ({ seq: r.seq, landingId: r.landing_id, at: r.at, before: r.before_blob, after: r.after_blob })),
    newer: (seq) => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ft_landings WHERE seq > ?", seq).one().n,
    writer: (landingId, path) => {
      if (!notes.has(landingId)) {
        const text = sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", landingId).toArray()[0]?.note;
        let parsed: unknown = null;
        try {
          parsed = typeof text === "string" ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        notes.set(landingId, parsed);
      }
      return noteWriter(notes.get(landingId), path);
    },
    read,
    now,
  };
}
