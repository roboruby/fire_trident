import type { Id, Millis, Path } from "./types.ts";

/**
 * Megafile hotness. A file that many agents each add a little to keeps growing until it is slow to read, diff and
 * merge, and changes to it collide. Text merge lands disjoint additions to such a file cleanly, so collisions alone
 * no longer show it: growth does. This module says, from what the colony saw land and come back in a sliding
 * window, whether one file is hot. The alarm that acts on it (a split intent and a hold on the file) is the
 * worker's colony/megafile.ts (FT_MEGAFILE). Pure: the caller passes the time.
 */

/** The thresholds of the megafile alarm. */
export interface HotnessThresholds {
  /** The sliding window every signal is counted in, in milliseconds. */
  windowMs: number;
  /** Growth signal: the file has at least this many lines... */
  minLines: number;
  /** ...grew within the window by at least this fraction of its length when the window opened... */
  minGrowth: number;
  /** ...and changes from at least this many distinct agents to it landed within the window. */
  minAgents: number;
  /** Collision signal: at least this many changes to the file went back within the window because they collided on it. */
  minReturns: number;
}

/** The thresholds in one place (the alarm uses these unless a caller passes others). */
export const HOTNESS: Readonly<HotnessThresholds> = {
  /** Half an hour: long enough for a swarm's additions to add up, short enough that old history does not count. */
  windowMs: 30 * 60_000,
  /** Shorter files are cheap to read and diff whatever happens to them. */
  minLines: 600,
  /** A quarter longer in half an hour is growth no single change explains. */
  minGrowth: 0.25,
  /** Several writers: one agent growing its own file is not a shared hot spot. */
  minAgents: 4,
  /** Six collisions in half an hour: agents keep redoing work on this file. */
  minReturns: 6,
};

/** One landing that changed a path: when, the file's length after it in lines (null when not known), and the agents whose changes wrote it. */
export interface PathWrite {
  at: Millis;
  lines: number | null;
  agents: readonly Id[];
}

/** One change to the path that went back because it collided on it. */
export interface PathReturn {
  at: Millis;
}

/** The signal that made a path hot: its growth among many writers, or changes colliding on it. */
export type HotSignal = "growth" | "returns";

/** One path's hotness over the window that ends at `at`. */
export interface Hotness {
  path: Path;
  at: Millis;
  windowMs: number;
  hot: boolean;
  /** The signal that fired (growth first when both did), or null. */
  signal: HotSignal | null;
  /** The file's length in lines, as the newest landing that said it (null when none did). */
  lines: number | null;
  /** Its length when the window opened: the newest known at or before then, else the earliest known within it. */
  baseline: number | null;
  /** (lines - baseline) / baseline; null when either is unknown or the baseline is 0. */
  growth: number | null;
  /** Distinct agents whose changes to the file landed within the window. */
  agents: number;
  /** Landings that changed it within the window. */
  landings: number;
  /** Changes that went back naming it within the window. */
  returns: number;
}

/** Lines in a text: line breaks (\n, \r\n or \r), plus one for a last line without a break. 0 for "". */
export function lineCount(text: string): number {
  if (text === "") return 0;
  // One pass, no allocation: the colony counts the text of every landed change to a watched file.
  let breaks = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) breaks++;
    else if (ch === 13) {
      breaks++;
      if (text.charCodeAt(i + 1) === 10) i++;
    }
  }
  const last = text.charCodeAt(text.length - 1);
  return last === 10 || last === 13 ? breaks : breaks + 1;
}

/** A line count as given, or null when it is not a whole number of lines (stored data may be old or odd). */
function count(n: unknown): number | null {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Is this path hot at `at`? A file is hot when (growth) it has at least `minLines` lines, grew by at least
 * `minGrowth` of its length within the window, and changes from at least `minAgents` distinct agents to it landed
 * within the window; or (returns) at least `minReturns` changes that named it went back within the window. `writes`
 * may hold landings from before the window: the newest of them with a known length gives the baseline, and none of
 * them counts otherwise. Entries that are not well formed count as unknown.
 */
export function hotness(path: Path, writes: readonly PathWrite[], returns: readonly PathReturn[], at: Millis, t: Readonly<HotnessThresholds> = HOTNESS): Hotness {
  const start = at - t.windowMs;
  const valid = writes.filter((w) => w && typeof w.at === "number" && Number.isFinite(w.at) && w.at <= at).sort((a, b) => a.at - b.at);
  const inside = valid.filter((w) => w.at > start);
  const before = valid.filter((w) => w.at <= start && count(w.lines) !== null);
  const known = inside.filter((w) => count(w.lines) !== null);
  const newest = known[known.length - 1] ?? before[before.length - 1];
  const lines = newest ? count(newest.lines) : null;
  const opening = before[before.length - 1] ?? known[0];
  const baseline = opening ? count(opening.lines) : null;
  const growth = lines !== null && baseline !== null && baseline > 0 ? (lines - baseline) / baseline : null;
  const agents = new Set(inside.flatMap((w) => (Array.isArray(w.agents) ? w.agents.filter((a) => typeof a === "string" && a !== "") : []))).size;
  const back = returns.filter((r) => r && typeof r.at === "number" && r.at > start && r.at <= at).length;
  // A file that was empty when the window opened grew without bound: any length counts as growth.
  const grew = lines !== null && baseline !== null && (baseline === 0 ? lines > 0 : (growth ?? 0) >= t.minGrowth);
  const byGrowth = grew && lines !== null && lines >= t.minLines && agents >= t.minAgents;
  const byReturns = back >= t.minReturns;
  return {
    path,
    at,
    windowMs: t.windowMs,
    hot: byGrowth || byReturns,
    signal: byGrowth ? "growth" : byReturns ? "returns" : null,
    lines,
    baseline,
    growth,
    agents,
    landings: inside.length,
    returns: back,
  };
}
