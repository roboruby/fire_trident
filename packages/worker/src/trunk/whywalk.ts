/**
 * `why` per line, and whether each landing still holds (TrunkDO.why; roadmap 3.9). The lineage of a path is the landings
 * that changed it, newest first, from the landing log (ft_landing_paths, with the path's blob before and after each) and
 * the lineage notes. For a line, the walk follows it back through each landing's diff (trunk/blame.ts mapLine) to the
 * landing that wrote its meaning, which comes first:
 *
 * - A landing that only reformatted the line (core/reformat.ts: whitespace, quote style, trailing commas and semicolons,
 *   line wrapping of the same tokens) is skipped, and the walk goes on from the line it came from.
 * - When the landing that wrote the line moved a block from another file (at least three lines, the same tokens removed
 *   from that file in the same landing), the walk follows it there and goes on through that file's landings.
 *
 * Bounded: WHY_WALK_STEPS landings stepped through, WHY_WALK_MOVES moves, WHY_WALK_MS of time, versions up to
 * WHY_WALK_MAX_BYTES and WALK_READ_BYTES read in all. Past a bound it fails open with what it found: the oldest landing
 * it found that changed the line, and why it stopped. Each landing shown says whether it still holds: the file asked
 * about against the blob it wrote, and the other files its changes wrote or read against today's trunk.
 *
 * Read only: the landing log, the notes, the trunk index (ft_files) and blobs.
 */
import type { Id, Landing, LineageNote, Path, Sha, WhyHolds, WhySince, WhyWalk } from "@fire_trident/core";
import { movedFrom, reformattedFrom, type MoveSource } from "@fire_trident/core";
import { mapLine } from "./blame.ts";

/** Landings one walk steps through at most, over every file it follows. */
export const WHY_WALK_STEPS = 200;
/** Moves one walk follows at most. */
export const WHY_WALK_MOVES = 3;
/** Time one walk spends at most (ms). */
export const WHY_WALK_MS = 2_000;
/** The largest file version the walk reads (bytes). */
export const WHY_WALK_MAX_BYTES = 512 * 1024;
/** Bytes one walk reads at most. */
const WALK_READ_BYTES = 16 * 1024 * 1024;
/** Landings read from the log at once. */
const PAGE = 50;
/** Other files of one landing a new line is compared with, looking for a move. */
const MOVE_SOURCES = 20;
/** Other files one landing's holds compares at most. */
const HOLDS_FILES = 40;
/** Changed files one landing's holds names at most. */
const HOLDS_NAMED = 5;

/** One landing that changed a path, with its note, as a why answer lists it. */
export interface WhyRow {
  seq: number;
  landing: Landing;
  note: LineageNote;
  /** The path's blob before and after the landing. */
  before: Sha | null;
  after: Sha | null;
}

/** One step of the walk: a landing that changed the path, and the path's blob before and after it. */
export interface WhyStep {
  seq: number;
  landingId: Id;
  before: Sha | null;
  after: Sha | null;
}

/** What `why` reads from the trunk writer: its landing log, notes, index and blobs. */
export interface WhySource {
  /** The landings that changed `path` that have a note, newest first, at most `limit`. */
  history(path: Path, limit: number): WhyRow[];
  /** The landings that changed `path` before log position `before`, newest first, at most `limit`. */
  steps(path: Path, before: number, limit: number): WhyStep[];
  /** The landing at log position `seq` with its note and its blobs of `path`; null when it has no note or did not change the path. */
  row(seq: number, path: Path): WhyRow | null;
  /** The paths the landing at `seq` changed, with their blobs before and after it. */
  paths(seq: number): Array<{ path: Path; before: Sha | null; after: Sha | null }>;
  /** Today's trunk blob of a path, or null when trunk has no such file. */
  current(path: Path): Sha | null;
  /** The newest landing after log position `seq` that changed `path`, and how many did; null when none did. */
  since(path: Path, seq: number): { by: Id; landings: number } | null;
  /** A blob's bytes, or null when it cannot be read. */
  read(blob: Sha): Promise<Uint8Array | null>;
  /** The time (ms), for the time bound. */
  now(): number;
}

/** One landing of a why answer: the landing and its note, whether it still holds, and on the first one the walk for a line. */
export interface WhyLineage {
  landing: Landing;
  note: LineageNote;
  holds?: WhyHolds;
  walk?: WhyWalk;
}

/**
 * The lineage of `path` (see the module comment): its landings with notes, newest first, at most `limit`; with `line`
 * (1-based, in today's file), the landing that wrote the line's meaning first (fetched when it changed another file or
 * is older than the listing) and the walk on the first entry. Every entry says whether it still holds.
 */
export async function whyLineage(src: WhySource, path: Path, line: number | undefined, limit: number): Promise<WhyLineage[]> {
  const rows = src.history(path, limit);
  if (rows.length === 0) return [];
  let walk: WhyWalk | undefined;
  let owner: { row: WhyRow; path: Path } | null = null;
  if (line !== undefined && Number.isFinite(line) && line >= 1) {
    const found = await walkLine(src, path, Math.floor(line)).catch(() => null);
    if (found) {
      walk = found.walk;
      const at = found.seq;
      if (walk.landingId && at !== undefined) {
        const row = (walk.path === path ? rows.find((r) => r.seq === at) : undefined) ?? src.row(at, walk.path);
        if (row) owner = { row, path: walk.path };
      }
    }
  }
  const listed = rows.filter((r) => r.landing.id !== owner?.row.landing.id).map((row) => ({ row, path }));
  const entries = owner ? [owner, ...listed] : listed;
  const out: WhyLineage[] = entries.map(({ row, path: p }) => {
    const e: WhyLineage = { landing: row.landing, note: row.note };
    try {
      e.holds = holdsOf(src, row, p);
    } catch {
      // A landing whose holds cannot be read is shown without them.
    }
    return e;
  });
  if (walk && out.length > 0) out[0]!.walk = walk;
  return out;
}

/** The walk stopped at a bound; its message says which, as a clause. */
class Bounded extends Error {}

/** A landing the walk found that changed the line, and where it wrote it (0-based line). */
interface Mark {
  seq: number;
  landingId: Id;
  path: Path;
  idx: number;
}

/**
 * Walk line `line` (1-based) of today's `path` back to the landing that wrote its meaning (see the module comment). The
 * answer's `seq` is that landing's log position; without one the line came with the files before any landing, or the
 * walk stopped first. Null when trunk has no such file or line.
 */
export async function walkLine(src: WhySource, path: Path, line: number): Promise<{ walk: WhyWalk; seq?: number } | null> {
  const deadline = src.now() + WHY_WALK_MS;
  let room = WALK_READ_BYTES;
  const texts = new Map<Sha, string>();
  const text = async (blob: Sha, p: Path): Promise<string> => {
    const kept = texts.get(blob);
    if (kept !== undefined) return kept;
    const bytes = await src.read(blob);
    if (!bytes) throw new Bounded(`a version of ${p} could not be read`);
    if (bytes.length > WHY_WALK_MAX_BYTES) throw new Bounded(`a version of ${p} is larger than the walk reads (${WHY_WALK_MAX_BYTES / 1024} KiB)`);
    room -= bytes.length;
    if (room < 0) throw new Bounded(`it read ${WALK_READ_BYTES / (1024 * 1024)} MiB of file versions`);
    const t = new TextDecoder().decode(bytes);
    texts.set(blob, t);
    return t;
  };
  const skipped: WhyWalk["skipped"] = [];
  const moved: WhyWalk["moved"] = [];
  let last: Mark | null = null;
  let p = path;
  let blob = src.current(p);
  if (blob === null) return null;
  if (line > (await text(blob, p)).split("\n").length) return null;
  let idx = line - 1;
  const done = (owner: Mark | null, bounded?: string): { walk: WhyWalk; seq?: number } => {
    const walk: WhyWalk = owner ? { landingId: owner.landingId, path: owner.path, line: owner.idx + 1, skipped, moved } : { path, line, skipped, moved };
    if (bounded) walk.bounded = bounded;
    return owner ? { walk, seq: owner.seq } : { walk };
  };
  // Past a bound: the oldest landing found that changed the line, out of the skipped ones when it is one of them.
  const failOpen = (why: string): { walk: WhyWalk; seq?: number } => {
    if (last && skipped[skipped.length - 1]?.landingId === last.landingId) skipped.pop();
    return done(last, why);
  };
  let steps = 0;
  let before = Number.MAX_SAFE_INTEGER;
  try {
    for (;;) {
      const page = src.steps(p, before, PAGE);
      let next: { path: Path; blob: Sha; idx: number } | null = null;
      for (const h of page) {
        if (++steps > WHY_WALK_STEPS) return failOpen(`it stepped through ${WHY_WALK_STEPS} landings`);
        if (src.now() > deadline) return failOpen(`it ran for ${WHY_WALK_MS / 1000} s`);
        before = h.seq;
        // The file was deleted here and came back outside the landings: the line is not theirs.
        if (h.after === null) return done(null);
        if (blob !== h.after) {
          // Trunk changed outside the landings since: follow the line across, or stop when it was added there.
          const m = mapLine(await text(h.after, p), await text(blob, p), idx);
          if (m === null) return done(null);
          idx = m;
          blob = h.after;
        }
        if (h.before !== null) {
          const older = await text(h.before, p);
          const newer = await text(h.after, p);
          const kept = mapLine(older, newer, idx);
          if (kept !== null) {
            idx = kept;
            blob = h.before;
            continue;
          }
          const from = reformattedFrom(p, older, newer, idx);
          if (from !== null) {
            skipped.push({ landingId: h.landingId, path: p });
            last = { seq: h.seq, landingId: h.landingId, path: p, idx };
            idx = from;
            blob = h.before;
            continue;
          }
        }
        // This landing wrote the line's meaning, unless it moved it here from another file.
        const mark: Mark = { seq: h.seq, landingId: h.landingId, path: p, idx };
        if (moved.length < WHY_WALK_MOVES) {
          const mv = await moveOf(src, h, p, idx, text);
          if (mv) {
            moved.push({ landingId: h.landingId, from: mv.path, to: p, line: mv.idx + 1 });
            last = mark;
            next = mv;
            break;
          }
        }
        return done(mark);
      }
      if (next) {
        p = next.path;
        blob = next.blob;
        idx = next.idx;
        continue;
      }
      // Every landing on the file was walked: the line came with the files.
      if (page.length < PAGE) return done(null);
    }
  } catch (e) {
    return failOpen(e instanceof Bounded ? e.message : "a version of a file could not be read");
  }
}

/** Where a landing moved line `idx` of `path` from: the other file, its blob before the landing, and the line there; null when it did not. */
async function moveOf(
  src: WhySource,
  h: WhyStep,
  path: Path,
  idx: number,
  text: (blob: Sha, p: Path) => Promise<string>,
): Promise<{ path: Path; blob: Sha; idx: number } | null> {
  const others = src
    .paths(h.seq)
    .filter((o): o is { path: Path; before: Sha; after: Sha | null } => o.path !== path && o.before !== null)
    .slice(0, MOVE_SOURCES);
  if (others.length === 0 || h.after === null) return null;
  const sources: MoveSource[] = [];
  for (const o of others) {
    try {
      sources.push({ path: o.path, before: await text(o.before, o.path), after: o.after === null ? null : await text(o.after, o.path) });
    } catch (e) {
      // A source too large or unreadable is not compared; a spent budget stops the walk.
      if (e instanceof Bounded && /MiB/.test(e.message)) throw e;
    }
  }
  if (sources.length === 0) return null;
  const found = movedFrom(path, h.before === null ? null : await text(h.before, path), await text(h.after, path), idx, sources);
  if (!found) return null;
  const from = others.find((o) => o.path === found.path);
  return from ? { path: found.path, blob: from.before, idx: found.line } : null;
}

/** A file a landing wrote or read (`blob`), against today's trunk. */
function sinceOf(src: WhySource, path: Path, blob: Sha | null, seq: number): WhySince {
  const now = src.current(path);
  if (now === blob) return { path, state: "same" };
  const out: WhySince = { path, state: now === null ? "deleted" : "changed" };
  const later = src.since(path, seq);
  if (later) {
    out.by = later.by;
    out.landings = later.landings;
  }
  return out;
}

/**
 * Whether a landing still holds: `path` against the blob it wrote there, then the other files its changes that wrote
 * `path` (all of them when none did) wrote or read, written ones first, at most HOLDS_FILES, each against the blob it
 * wrote or read. A file the landing wrote is not compared as a read.
 */
export function holdsOf(src: WhySource, row: WhyRow, path: Path): WhyHolds {
  const proposals = Array.isArray(row.note?.proposals) ? row.note.proposals : [];
  const wrotePath = proposals.filter((p) => Array.isArray(p?.writeSet) && p.writeSet.some((w) => w?.path === path));
  const shown = wrotePath.length > 0 ? wrotePath : proposals;
  const written = new Set<Path>([path, ...(Array.isArray(row.landing.paths) ? row.landing.paths : [])]);
  for (const p of proposals) for (const w of Array.isArray(p?.writeSet) ? p.writeSet : []) if (typeof w?.path === "string") written.add(w.path);
  const files = new Map<Path, Sha | null>();
  for (const p of shown) {
    for (const w of Array.isArray(p?.writeSet) ? p.writeSet : []) if (typeof w?.path === "string" && w.path !== path && !files.has(w.path)) files.set(w.path, w.blob ?? null);
  }
  for (const p of shown) {
    for (const r of Array.isArray(p?.readSet) ? p.readSet : []) if (typeof r?.path === "string" && !written.has(r.path) && !files.has(r.path)) files.set(r.path, r.blob ?? null);
  }
  const list: WhySince[] = [];
  let compared = 0;
  let changed = 0;
  for (const [p, blob] of files) {
    if (compared >= HOLDS_FILES) break;
    compared++;
    const s = sinceOf(src, p, blob, row.seq);
    if (s.state === "same") continue;
    changed++;
    if (list.length < HOLDS_NAMED) list.push(s);
  }
  return { wrote: sinceOf(src, path, row.after, row.seq), others: { files: compared, changed, list } };
}

/** Parse a stored JSON column, or null. */
function parsed<T>(text: string | null | undefined): T | null {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The source over the trunk writer's tables (ft_landings, ft_landing_paths, ft_notes, ft_files) and its blobs (`read`). */
export function sqlWhySource(sql: SqlStorage, read: (blob: Sha) => Promise<Uint8Array | null>, now: () => number = Date.now): WhySource {
  type Joined = { seq: number; landing: string; note: string | null; before_blob: string | null; after_blob: string | null };
  const rowOf = (r: Joined): WhyRow | null => {
    const landing = parsed<Landing>(r.landing);
    const note = parsed<LineageNote>(r.note);
    return landing && note ? { seq: r.seq, landing, note, before: r.before_blob, after: r.after_blob } : null;
  };
  const select = `SELECT lp.seq AS seq, l.data AS landing, n.note AS note, lp.before_blob AS before_blob, lp.after_blob AS after_blob FROM ft_landing_paths lp
       JOIN ft_landings l ON l.seq = lp.seq
       LEFT JOIN ft_notes n ON n.landing_id = lp.landing_id`;
  return {
    history: (path, limit) =>
      sql
        .exec<Joined>(`${select} WHERE lp.path = ? ORDER BY lp.seq DESC LIMIT ?`, path, Math.max(1, limit))
        .toArray()
        .map(rowOf)
        .filter((r): r is WhyRow => r !== null),
    steps: (path, before, limit) =>
      sql
        .exec<{ seq: number; landing_id: string; before_blob: string | null; after_blob: string | null }>(
          `SELECT seq, landing_id, before_blob, after_blob FROM ft_landing_paths WHERE path = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
          path,
          before,
          Math.max(1, limit),
        )
        .toArray()
        .map((r) => ({ seq: r.seq, landingId: r.landing_id, before: r.before_blob, after: r.after_blob })),
    row: (seq, path) => {
      const r = sql.exec<Joined>(`${select} WHERE lp.path = ? AND lp.seq = ?`, path, seq).toArray()[0];
      return r ? rowOf(r) : null;
    },
    paths: (seq) => {
      const landing = parsed<Landing>(sql.exec<{ data: string }>(`SELECT data FROM ft_landings WHERE seq = ?`, seq).toArray()[0]?.data);
      const out: Array<{ path: Path; before: Sha | null; after: Sha | null }> = [];
      for (const path of Array.isArray(landing?.paths) ? landing.paths : []) {
        const r = sql.exec<{ before_blob: string | null; after_blob: string | null }>(`SELECT before_blob, after_blob FROM ft_landing_paths WHERE path = ? AND seq = ?`, path, seq).toArray()[0];
        if (r) out.push({ path, before: r.before_blob, after: r.after_blob });
      }
      return out;
    },
    current: (path) => sql.exec<{ blob: string }>(`SELECT blob FROM ft_files WHERE path = ?`, path).toArray()[0]?.blob ?? null,
    since: (path, seq) => {
      const n = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_landing_paths WHERE path = ? AND seq > ?`, path, seq).one().n;
      if (n === 0) return null;
      const by = sql.exec<{ landing_id: string }>(`SELECT landing_id FROM ft_landing_paths WHERE path = ? AND seq > ? ORDER BY seq DESC LIMIT 1`, path, seq).one().landing_id;
      return { by, landings: n };
    },
    read,
    now,
  };
}
