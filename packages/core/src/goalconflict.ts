import { revalidationEnabled } from "./occ.ts";
import { oneLine, truncate } from "./text.ts";
import { lineDiff } from "./textmerge.ts";
import type { Id, IntentSource, Millis, Path, UndoneLines } from "./types.ts";

/**
 * Goal conflicts: a change that would undo what a recent landing did for another intent. Two intents that want
 * opposite things (move the backend to Rust; move it to Go) otherwise overwrite each other in turn: the last landing
 * wins and nobody is told. No merge settles a disagreement between goals, so such a change waits for a person, who
 * decides which goal stands (the decide stage's rule P4).
 *
 * The rule: a change P undoes a landing L when, in a text file P modifies or deletes, P removes lines that L wrote and
 * that are still in the version at P's base; L is recent (within GOAL_CONFLICT_WINDOW_MS and among the colony's newest
 * GOAL_CONFLICT_LANDINGS landings); L wrote them for a different intent that is neither an ancestor nor a descendant
 * of P's intent (the parent chain); and P removes at least max(GOAL_CONFLICT_MIN_LINES, half of L's lines in that
 * version). Repair intents of trunk certification and intents that enforce a rule people declared, on either side, and
 * FireTrident's own commits (reverts, antibodies) never conflict.
 *
 * Lines are compared with their whitespace collapsed (re-indenting a line does not undo it), and blank lines do not
 * count. Who wrote each line is traced back through the landings that changed the file, newest first (LineTrace): the
 * trunk writer runs the trace over its landing log (worker decide/undone.ts) and the decide stage applies the rule
 * (findGoalConflict). Pure and synchronous.
 */

/** A landing is recent for this long after it landed (ms); the decide policy's goalConflictMinutes overrides it. */
export const GOAL_CONFLICT_WINDOW_MS = 60 * 60_000;
/** A landing is recent only while it is among the colony's newest this many landings (the policy's goalConflictLandings). */
export const GOAL_CONFLICT_LANDINGS = 200;
/** Fewer undone lines than this are never a conflict: fixing a line or two is not a change of goal. */
export const GOAL_CONFLICT_MIN_LINES = 3;
/** Files of one change the check traces at most. */
export const GOAL_CONFLICT_MAX_FILES = 20;
/** Removed lines of one change the check traces at most, over all its files. */
export const GOAL_CONFLICT_MAX_REMOVED = 2_000;
/** The largest version of a file the check reads (bytes); a larger file is not checked. */
export const GOAL_CONFLICT_MAX_BYTES = 512 * 1024;
/** Characters of the undone intent's why a reason quotes at most. */
export const GOAL_CONFLICT_WHY_CHARS = 160;
/** Characters of the undone intent's title a reason quotes at most. */
const TITLE_CHARS = 200;
/** Edits a line alignment searches for at most before it matches equal lines in order instead (alignLines). */
const ALIGN_MAX_EDITS = 1_000;
/** Parent links followed at most when two intents are compared (a longer chain, or a cycle, ends the walk). */
const CHAIN_MAX = 64;

/**
 * Is the goal-conflict check on for this colony? `setting` is FT_GOAL_CONFLICT, read like FT_REVALIDATE: "on" (every
 * colony), a comma-separated list of colony ids, or absent / empty / "off" (no colony).
 */
export function goalConflictEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * Whether an intent from this source is never checked and never protected: trunk certification's repairs, and the
 * intents a rule declares (they bring code into line with a rule people wrote, which is no competing goal).
 */
export function goalConflictExempt(source: IntentSource | undefined): boolean {
  return source === "certify" || source === "rule";
}

/**
 * The lines of a text as the check compares them: split at "\n" (a final newline ends the last line rather than
 * starting an empty one), each with its whitespace runs collapsed to one space and trimmed, so a blank line is "".
 */
export function lineKeys(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.replace(/\s+/g, " ").trim());
}

/** Line keys as numbers, equal keys getting equal numbers across every version numbered with one table. */
class LineIds {
  private readonly ids = new Map<string, number>();

  of(keys: readonly string[]): Int32Array {
    const out = new Int32Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      let id = this.ids.get(key);
      if (id === undefined) {
        id = this.ids.size;
        this.ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  }
}

/**
 * For each line of `b`, the line of `a` it was kept from, or -1 when `b` added it: a shortest edit script (lineDiff).
 * When that needs more than `maxEdits` edits, each line of `b` is matched instead with the first unmatched equal line
 * of `a`, so a large rewrite still keeps the lines it did not change.
 */
export function alignLines(a: ArrayLike<number>, b: ArrayLike<number>, maxEdits = ALIGN_MAX_EDITS): Int32Array {
  const out = new Int32Array(b.length).fill(-1);
  const hunks = lineDiff(a, b, maxEdits);
  if (hunks !== null) {
    let ai = 0;
    let bi = 0;
    for (const h of hunks) {
      while (bi < h.b0) out[bi++] = ai++;
      ai = h.a1;
      bi = h.b1;
    }
    while (bi < b.length) out[bi++] = ai++;
    return out;
  }
  const positions = new Map<number, number[]>();
  for (let i = 0; i < a.length; i++) {
    const list = positions.get(a[i]!);
    if (list) list.push(i);
    else positions.set(a[i]!, [i]);
  }
  const used = new Map<number, number>();
  for (let j = 0; j < b.length; j++) {
    const list = positions.get(b[j]!);
    const k = used.get(b[j]!) ?? 0;
    if (!list || k >= list.length) continue;
    out[j] = list[k]!;
    used.set(b[j]!, k + 1);
  }
  return out;
}

/**
 * The lines of `before` (0-based, as lineKeys splits it) that `after` removes, blank lines left out: every line when
 * `after` is null (the file is deleted). A line whose only change is its whitespace is not removed.
 */
export function removedLines(before: string, after: string | null): number[] {
  const ids = new LineIds();
  const keys = lineKeys(before);
  const kept = new Uint8Array(keys.length);
  if (after !== null) {
    for (const i of alignLines(ids.of(keys), ids.of(lineKeys(after)))) if (i >= 0) kept[i] = 1;
  }
  const out: number[] = [];
  for (let i = 0; i < keys.length; i++) if (keys[i] !== "" && kept[i] === 0) out.push(i);
  return out;
}

/** One landing a trace went back through that wrote removed lines: its step, the removed lines it wrote, and all the lines of the traced version it wrote. */
export interface TracedOwner {
  step: number;
  removed: number;
  lines: number;
}

/**
 * Who wrote the lines of one version of a file, followed back landing by landing through the file's history, newest
 * first, for the lines a change removes. Each step is one landing that changed the file, given as the version before it
 * (null when it created the file) and, only when the version the trace has reached is not the one it produced, that
 * version. A line the landing added is its line; every other line is followed into the version before it. The trace
 * is done once every removed line has its landing; lines left over were written before the steps given (by an older
 * landing, or before the colony's first landing). Blank lines are never counted.
 */
export class LineTrace {
  private readonly ids = new LineIds();
  /** Per line of the traced version: 1 when it counts (not blank). */
  private readonly counted: Uint8Array;
  /** Per line: 1 when the change removes it. */
  private readonly removed: Uint8Array;
  /** Per line: where it is in the version the trace has reached, or -1 once its landing is known or it cannot be followed. */
  private readonly at: Int32Array;
  /** Per line: the step whose landing wrote it, or -1 while unknown. */
  private readonly owner: Int32Array;
  /** Line ids of the version the trace has reached. */
  private current: Int32Array;
  /** Removed lines still followed. */
  private open = 0;
  private steps = 0;
  /** Lines read so far (every version given), for a caller's budget. */
  work = 0;

  constructor(text: string, removed: Iterable<number>) {
    const keys = lineKeys(text);
    const n = keys.length;
    this.current = this.ids.of(keys);
    this.counted = new Uint8Array(n);
    this.removed = new Uint8Array(n);
    this.at = new Int32Array(n);
    this.owner = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      this.at[i] = i;
      if (keys[i] !== "") this.counted[i] = 1;
    }
    for (const i of removed) {
      if (!Number.isInteger(i) || i < 0 || i >= n || this.counted[i] === 0 || this.removed[i] === 1) continue;
      this.removed[i] = 1;
      this.open++;
    }
    this.work = n;
  }

  /** True once every removed line has its landing or can no longer be followed. */
  get done(): boolean {
    return this.open === 0;
  }

  /**
   * Go back through one landing: `before` is the file before it (null: the landing created the file), `produced` the
   * version it produced when that is not the version the trace has reached. Returns the step's number (0, 1, ...).
   */
  step(before: string | null, produced?: string): number {
    const step = this.steps++;
    if (produced !== undefined) {
      const ids = this.ids.of(lineKeys(produced));
      this.work += ids.length;
      // A line not in the version this landing produced cannot be followed through it.
      this.move(alignLines(ids, this.current), -1);
      this.current = ids;
    }
    if (before === null) {
      this.move(new Int32Array(this.current.length).fill(-1), step);
      this.current = new Int32Array(0);
      return step;
    }
    const ids = this.ids.of(lineKeys(before));
    this.work += ids.length;
    this.move(alignLines(ids, this.current), step);
    this.current = ids;
    return step;
  }

  /** The landings (steps) that wrote removed lines, in step order. */
  owners(): TracedOwner[] {
    const removed = new Map<number, number>();
    const lines = new Map<number, number>();
    for (let i = 0; i < this.owner.length; i++) {
      const o = this.owner[i]!;
      if (o < 0 || this.counted[i] === 0) continue;
      lines.set(o, (lines.get(o) ?? 0) + 1);
      if (this.removed[i] === 1) removed.set(o, (removed.get(o) ?? 0) + 1);
    }
    return [...removed]
      .map(([step, n]) => ({ step, removed: n, lines: lines.get(step) ?? n }))
      .sort((x, y) => x.step - y.step);
  }

  /** Follow every open line through `map` (its place in the version the trace reached → its place in the next one); a line with no place is `step`'s, or lost when step is -1. */
  private move(map: Int32Array, step: number): void {
    for (let i = 0; i < this.at.length; i++) {
      const c = this.at[i]!;
      if (c < 0) continue;
      const next = map[c] ?? -1;
      if (next >= 0) {
        this.at[i] = next;
        continue;
      }
      this.at[i] = -1;
      if (step >= 0) this.owner[i] = step;
      if (this.removed[i] === 1) this.open--;
    }
  }
}

/** One landing that wrote lines a change removes, in one file, as the trunk writer traced them (worker decide/undone.ts). */
export interface RemovedOwner {
  landingId: Id;
  /** When it landed. */
  at: Millis;
  /** How many of the colony's landings are newer (0: the newest). */
  rank: number;
  path: Path;
  /** Lines of the file at the change's base that the landing wrote and that the change removes. */
  removed: number;
  /** Lines of the file at the change's base that the landing wrote. */
  lines: number;
  /** The intent of the proposal that wrote the file in that landing, and the proposal; absent when no proposal did. */
  intentId?: Id;
  proposalId?: Id;
  /** FireTrident's own commit (a revert or an antibody): never a conflict. */
  system?: boolean;
}

/** What the rule reads of an intent. */
export interface IntentFacts {
  title: string;
  why: string;
  source?: IntentSource;
  parentId?: Id;
}

/** The goal-conflict rule's input. */
export interface GoalConflictInput {
  /** The intent of the change being decided. */
  intentId: Id;
  /** The landings that wrote the lines it removes, per file (the trunk writer's trace). */
  owners: readonly RemovedOwner[];
  /** An intent by id, or null when the colony does not know it. */
  intent: (id: Id) => IntentFacts | null;
  now: Millis;
  /** Recent means landed within this long (default GOAL_CONFLICT_WINDOW_MS)... */
  windowMs?: number;
  /** ...and among the colony's newest this many landings (default GOAL_CONFLICT_LANDINGS). */
  landings?: number;
}

/** One landing a change would undo, with the intent it wrote the lines for. */
export interface UndoneLanding {
  landingId: Id;
  intentId: Id;
  title: string;
  why: string;
  at: Millis;
  /** Its lines the change removes, over `paths`. */
  lines: number;
  paths: Path[];
}

/** A goal conflict: the landings a change would undo (most lines first), the record its lineage note keeps, and the reason a person reads. */
export interface GoalConflict {
  landings: UndoneLanding[];
  undoes: UndoneLines[];
  reason: string;
}

/** Whether `ancestor` is on `id`'s parent chain. */
function descends(id: Id, ancestor: Id, intent: (id: Id) => IntentFacts | null): boolean {
  const seen = new Set<Id>([id]);
  let next = intent(id)?.parentId;
  for (let i = 0; i < CHAIN_MAX && typeof next === "string" && next !== "" && !seen.has(next); i++) {
    if (next === ancestor) return true;
    seen.add(next);
    next = intent(next)?.parentId;
  }
  return false;
}

/** Whether one intent is an ancestor or a descendant of the other (the parent chain): their goals are one line of work, not two. */
export function relatedIntents(a: Id, b: Id, intent: (id: Id) => IntentFacts | null): boolean {
  return a === b || descends(a, b, intent) || descends(b, a, intent);
}

/** Whether a change removing `removed` of a landing's `lines` lines in one file undoes it: at least max(GOAL_CONFLICT_MIN_LINES, half of them). */
export function undoesEnough(removed: number, lines: number): boolean {
  return removed >= GOAL_CONFLICT_MIN_LINES && 2 * removed >= lines;
}

/** A positive whole number, or the fallback. */
function whole(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/**
 * Whether the change of `intentId` would undo a recent landing of another intent (see the module comment), and if so
 * which ones: each conflicting file is one `undoes` record, and the landings, most undone lines first, give the reason.
 * Null when there is no conflict, or when the change's own intent is a repair of trunk certification.
 */
export function findGoalConflict(input: GoalConflictInput): GoalConflict | null {
  if (goalConflictExempt(input.intent(input.intentId)?.source)) return null;
  const windowMs = whole(input.windowMs, GOAL_CONFLICT_WINDOW_MS);
  const newest = whole(input.landings, GOAL_CONFLICT_LANDINGS);
  const facts = new Map<Id, IntentFacts | null>();
  const lookup = (id: Id): IntentFacts | null => {
    if (!facts.has(id)) facts.set(id, input.intent(id));
    return facts.get(id) ?? null;
  };
  const undoes: UndoneLines[] = [];
  const byLanding = new Map<Id, UndoneLanding>();
  for (const o of input.owners) {
    if (o.system === true || typeof o.intentId !== "string" || o.intentId === "" || o.intentId === input.intentId) continue;
    if (!Number.isFinite(o.at) || input.now - o.at > windowMs) continue;
    if (!Number.isFinite(o.rank) || o.rank < 0 || o.rank >= newest) continue;
    if (!undoesEnough(o.removed, o.lines)) continue;
    const theirs = lookup(o.intentId);
    if (!theirs || goalConflictExempt(theirs.source)) continue;
    if (relatedIntents(input.intentId, o.intentId, lookup)) continue;
    undoes.push({ landingId: o.landingId, intentId: o.intentId, path: o.path, lines: o.removed });
    const entry = byLanding.get(o.landingId) ?? { landingId: o.landingId, intentId: o.intentId, title: theirs.title, why: theirs.why, at: o.at, lines: 0, paths: [] };
    entry.lines += o.removed;
    if (!entry.paths.includes(o.path)) entry.paths.push(o.path);
    byLanding.set(o.landingId, entry);
  }
  if (undoes.length === 0) return null;
  const landings = [...byLanding.values()].sort((x, y) => y.lines - x.lines || y.at - x.at || (x.landingId < y.landingId ? -1 : 1));
  return { landings, undoes, reason: goalConflictReason(landings, input.now) };
}

/** "1 line", "5 lines". */
function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** How long ago, in words: "40 seconds", "12 minutes", "2 hours 5 minutes". */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (s < 60) return count(s, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return count(m, "minute");
  const h = Math.floor(m / 60);
  return m % 60 > 0 && h < 10 ? `${count(h, "hour")} ${count(m % 60, "minute")}` : count(h, "hour");
}

/** The files of an undone landing, in words: "src/a.ts", "src/a.ts and src/b.ts", "4 files". */
function places(paths: readonly Path[]): string {
  if (paths.length <= 1) return paths[0] ?? "a file";
  if (paths.length <= 3) return `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
  return count(paths.length, "file");
}

/**
 * The reason a change waits for a person, naming the landing it would undo most of: "would undo 5 lines in
 * src/backend.ts that landing lnd_1 wrote 3 minutes ago for intent "Move the backend to Rust" (its why, first 160
 * characters), a different intent; a person decides which goal stands". Other landings it would undo are counted.
 */
export function goalConflictReason(landings: readonly UndoneLanding[], now: Millis): string {
  const top = landings[0];
  if (!top) return "";
  const title = truncate(oneLine(top.title), TITLE_CHARS) || top.intentId;
  const why = truncate(oneLine(top.why), GOAL_CONFLICT_WHY_CHARS);
  const head = `would undo ${count(top.lines, "line")} in ${places(top.paths)} that landing ${top.landingId} wrote ${ageText(now - top.at)} ago for intent "${title}"${why ? ` (${why})` : ""}, a different intent`;
  const rest = landings.slice(1);
  const more =
    rest.length === 0
      ? ""
      : `, and ${count(
          rest.reduce((n, l) => n + l.lines, 0),
          "line",
        )} that ${rest.length === 1 ? "1 more recent landing" : `${rest.length} more recent landings`} wrote for other intents (${rest
          .slice(0, 5)
          .map((l) => l.landingId)
          .join(", ")}${rest.length > 5 ? " and others" : ""})`;
  return `${head}${more}; a person decides which goal stands`;
}
