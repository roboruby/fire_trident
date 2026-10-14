/**
 * The decide stage's goal-conflict check (FT_GOAL_CONFLICT). Before any model is asked, it finds a change that would
 * undo lines a recent landing wrote for another intent, so the change waits for a person (gate rule P4) instead of
 * silently overwriting another goal: the last landing would otherwise win and nobody would be told. The lines a change
 * removes come from its own diff (core removedLines), who wrote them from the trunk writer's trace
 * (decide/undone.ts, TrunkDO.removedLineOwners), and the rule from core/goalconflict.ts.
 *
 * Only text files the change modifies or deletes are checked (a new file undoes nothing), at most
 * GOAL_CONFLICT_MAX_FILES of them and GOAL_CONFLICT_MAX_REMOVED removed lines, and none larger than 512 KB. The check
 * never holds a change on its own failure: an error, or a trunk writer that does not answer in time, lets the change
 * go on (logged), and its evidence says it was not checked.
 */
import type { CheckResult, Id, Intent, IntentFacts, IntentSource, Proposal } from "@fire_trident/core";
import {
  GOAL_CONFLICT_LANDINGS,
  GOAL_CONFLICT_MAX_FILES,
  GOAL_CONFLICT_MAX_REMOVED,
  GOAL_CONFLICT_WINDOW_MS,
  findGoalConflict,
  goalConflictEnabled,
  goalConflictExempt,
  removedLines,
  type GoalConflict,
} from "@fire_trident/core";
import type { Env } from "../env.ts";
import { errorText } from "../colony/errors.ts";
import type { InnateFile } from "../colony/innate.ts";
import type { RemovedLinesAnswer, RemovedLinesFile, RemovedLinesQuery } from "./undone.ts";

/** How long the check waits for the trunk writer's trace (ms) before it lets the change go on unchecked. */
const TRUNK_WAIT_MS = 8_000;
/** Paths a check's detail names at most. */
const NAMED_PATHS = 5;
/** Why the check passes over an exempt intent, by its source (core goalConflictExempt). */
const EXEMPT_WHY: Partial<Record<IntentSource, string>> = {
  certify: "a repair of trunk certification may change any line",
  rule: "an intent a rule declared brings code into line with that rule",
  system: "the colony's own intent (a megafile split) moves lines other intents wrote",
};

/** The trunk writer's trace of removed lines (TrunkDO.removedLineOwners). */
export type RemovedLineOwners = (q: RemovedLinesQuery) => Promise<RemovedLinesAnswer>;

/** What the check reads from the decide stage's host (DecideHost has all of it). */
export interface GoalConflictHost {
  env: Env;
  colony(): { id: Id };
  intent(id: Id): Intent | null;
  trunk(): { removedLineOwners?: RemovedLineOwners };
}

/** The decide policy's goal-conflict window (decide/policy.ts); absent fields take the core defaults. */
export interface GoalConflictWindow {
  goalConflictMinutes?: number;
  goalConflictLandings?: number;
}

/** What the check found: the conflict, if any, and the check the evidence records (null when the flag is off for the colony). */
export interface GoalConflictCheck {
  conflict: GoalConflict | null;
  check: CheckResult | null;
}

/** "1 file", "3 lines". */
function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** What the rule reads of an intent. */
function facts(i: Intent | null): IntentFacts | null {
  return i ? { title: i.title, why: i.why, source: i.source, ...(i.parentId ? { parentId: i.parentId } : {}) } : null;
}

/** `p`, or a rejection once `ms` have passed. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the trunk writer did not answer within ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The files of a change the trace asks about: each text file it modifies or deletes and removes lines from, with its
 * blob at the change's base and the removed lines, within the check's limits; `left` names the files the limits left out.
 */
export function traceFiles(files: readonly InnateFile[]): { files: RemovedLinesFile[]; left: string[] } {
  const out: RemovedLinesFile[] = [];
  const left: string[] = [];
  let room = GOAL_CONFLICT_MAX_REMOVED;
  for (const f of files) {
    // A new file undoes nothing; binary content, a file over 512 KB (its text is not read) or an unreadable one cannot be compared.
    if (f.beforeBlob === null || f.before === null || f.binary || f.unreadable) continue;
    if (f.afterBlob !== null && f.after === null) continue;
    if (out.length >= GOAL_CONFLICT_MAX_FILES || room <= 0) {
      left.push(f.path);
      continue;
    }
    const removed = removedLines(f.before, f.afterBlob === null ? null : f.after);
    if (removed.length === 0) continue;
    out.push({ path: f.path, blob: f.beforeBlob, removed: removed.slice(0, room) });
    room -= Math.min(room, removed.length);
  }
  return { files: out, left };
}

/** Paths in words, at most NAMED_PATHS of them. */
function named(paths: readonly string[]): string {
  return `${paths.slice(0, NAMED_PATHS).join(", ")}${paths.length > NAMED_PATHS ? ` and ${paths.length - NAMED_PATHS} more` : ""}`;
}

/**
 * Check one change (see the module comment) when FT_GOAL_CONFLICT covers its colony; otherwise do nothing. A repair
 * intent of trunk certification is not checked. Never throws.
 */
export async function checkGoalConflict(
  host: GoalConflictHost,
  p: Pick<Proposal, "id" | "intentId">,
  files: readonly InnateFile[],
  policy: GoalConflictWindow = {},
  now = Date.now(),
): Promise<GoalConflictCheck> {
  let colonyId = "";
  try {
    colonyId = host.colony().id;
    if (!goalConflictEnabled(host.env?.FT_GOAL_CONFLICT, colonyId)) return { conflict: null, check: null };
  } catch {
    return { conflict: null, check: null };
  }
  const t0 = Date.now();
  const result = (detail: string, conflict: GoalConflict | null = null): GoalConflictCheck => ({
    conflict,
    check: { name: "goal conflict", ok: conflict === null, ms: Date.now() - t0, detail: detail.slice(0, 1_000) },
  });
  const cannotTrace = "not checked: the trunk writer cannot trace lines yet";
  try {
    const source = host.intent(p.intentId)?.source;
    if (source && goalConflictExempt(source)) return result(`not checked: ${EXEMPT_WHY[source] ?? "its intent is exempt"}`);
    const { files: traced, left } = traceFiles(files);
    const unchecked = left.length > 0 ? `; over the check's limits, not checked: ${named(left)}` : "";
    if (traced.length === 0) return result(`no line of an existing text file removed${unchecked}`);
    const minutes = policy.goalConflictMinutes;
    const windowMs = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : GOAL_CONFLICT_WINDOW_MS;
    const landings = typeof policy.goalConflictLandings === "number" && policy.goalConflictLandings >= 1 ? Math.floor(policy.goalConflictLandings) : GOAL_CONFLICT_LANDINGS;
    // One call, never a separate look at the method: a trunk writer on older code refuses it ("does not implement",
    // caught below), and a stand-in without it answers nothing.
    const asked = host.trunk().removedLineOwners?.({ files: traced, since: now - windowMs, landings });
    if (asked === undefined) return result(`${cannotTrace}${unchecked}`);
    const answer = await within(asked, TRUNK_WAIT_MS);
    const owners = Array.isArray(answer?.owners) ? answer.owners : [];
    const conflict = findGoalConflict({ intentId: p.intentId, owners, intent: (id) => facts(host.intent(id)), now, windowMs, landings });
    if (conflict) return result(conflict.reason, conflict);
    const skipped = Array.isArray(answer?.skipped) ? answer.skipped.filter((s) => s && typeof s.path === "string") : [];
    const removed = traced.reduce((n, f) => n + f.removed.length, 0);
    const notes = skipped.length > 0 ? `; ${named(skipped.map((s) => `${s.path} (${s.why})`))}` : "";
    return result(`no recent landing of another intent undone: ${count(traced.length, "file")} and ${count(removed, "removed line")} traced${notes}${unchecked}`);
  } catch (err) {
    const text = errorText(err);
    console.warn(`goal-conflict check of ${p.id} in ${colonyId} failed; the change goes on unchecked: ${text}`);
    return result(/does not implement/i.test(text) ? cannotTrace : `not checked: ${text}`);
  }
}
