import { revalidationEnabled } from "@fire_trident/core";
import type { CheckResult, Id } from "@fire_trident/core";
import { returnsSinceCourse, type ReturnedProposal } from "./stuck.ts";

/**
 * Model step-up (FT_MODEL_STEPUP: "on", or a comma-separated list of colony ids; off when absent). When an intent's
 * changes have come back twice since it last changed course (a landing, or a substantive amendment: the count the
 * stuck detector keeps, colony/stuck.ts), its next take asks for the stronger model class, "default", and says why
 * (TakeResult.model). An in-platform agent writes the intent's files with that model (agents/loop.ts), so the change's
 * lineage note names it as the observed model and its evidence says why the model changed; an outside agent gets the
 * hint as advice only (mcp/tools.ts). A third return still reaches the needs-you strip, as the stuck detector reports it.
 */

/** Returns since the intent last changed course from which its next attempt asks for the stronger model class. */
export const STEPUP_RETURNS = 2;
/** The stronger model class: "default" names the server's default model (FT_DEFAULT_MODEL), as a spec intent may ask for it. */
export const STEPUP_MODEL = "default";
/** The evidence check an in-platform agent records when it wrote a change with the model a take asked for. */
export const STEPUP_CHECK = "model step-up";
/** Proposals of the intent read at most, newest first (as the stuck detector's returns check reads them). */
const LOOKBACK = 20;
/** Longest reason a hint carries. */
const REASON_CHARS = 300;

/** What a take says about the model for this attempt at its intent (TakeResult.model). */
export interface ModelHint {
  /** The model class to write the change with. */
  model: typeof STEPUP_MODEL;
  /** Changes for the intent that came back since it last changed course. */
  returns: number;
  /** Why, in one sentence. */
  reason: string;
}

/** Whether FT_MODEL_STEPUP covers the colony: "on", or a comma-separated list that names it; off when absent. */
export function stepupEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** The hint for an intent whose changes came back `returns` times since it last changed course, or undefined below STEPUP_RETURNS. */
export function stepupHint(returns: number): ModelHint | undefined {
  if (!Number.isInteger(returns) || returns < STEPUP_RETURNS) return undefined;
  return {
    model: STEPUP_MODEL,
    returns,
    reason: `Changes for this intent came back ${returns} times since it last changed course, so this attempt asks for the stronger model class (${STEPUP_MODEL}).`,
  };
}

/**
 * The model hint for an intent's next take, from the colony's tables: its newest proposals that came back or landed
 * (by proposals_by_intent where the colony has it) and its latest substantive amendment, counted as the stuck detector
 * counts them (returnsSinceCourse). Undefined below STEPUP_RETURNS.
 */
export function modelHintFor(sql: SqlStorage, intentId: Id): ModelHint | undefined {
  const proposals: ReturnedProposal[] = sql
    .exec<{ status: string; created_at: number; updated_at: number; reason: string | number | null; superseded_by: string | number | null }>(
      `SELECT status, created_at, updated_at, json_extract(data, '$.reason') AS reason, json_extract(data, '$.supersededBy') AS superseded_by
         FROM proposals WHERE intent_id = ? AND status IN ('returned', 'rejected', 'landed') ORDER BY created_at DESC LIMIT ?`,
      intentId,
      LOOKBACK,
    )
    .toArray()
    .map((p) => ({
      status: p.status,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      reason: typeof p.reason === "string" ? p.reason : null,
      supersededBy: typeof p.superseded_by === "string" && p.superseded_by !== "" ? p.superseded_by : null,
    }));
  // Two returns are needed before any amendment matters.
  if (proposals.filter((p) => p.status !== "landed").length < STEPUP_RETURNS) return undefined;
  const revisedAt = sql.exec<{ at: number | null }>("SELECT MAX(at) AS at FROM intent_revisions WHERE intent_id = ? AND substantive = 1", intentId).one().at;
  return stepupHint(returnsSinceCourse({ proposals, revisedAt: typeof revisedAt === "number" ? revisedAt : null }).length);
}

/**
 * A take's model hint as received, checked field by field (a colony with the step-up off, or on the previous version,
 * sends none); undefined when it is not usable.
 */
export function cleanModelHint(x: unknown): ModelHint | undefined {
  if (!x || typeof x !== "object") return undefined;
  const h = x as Record<string, unknown>;
  if (h.model !== STEPUP_MODEL) return undefined;
  if (typeof h.returns !== "number" || !Number.isInteger(h.returns) || h.returns < STEPUP_RETURNS || h.returns > 10_000) return undefined;
  const reason = typeof h.reason === "string" ? h.reason.replace(/\s+/g, " ").trim() : "";
  if (reason === "") return undefined;
  return { model: STEPUP_MODEL, returns: h.returns, reason: reason.length > REASON_CHARS ? `${reason.slice(0, REASON_CHARS - 1)}…` : reason };
}

/**
 * The evidence check of a change written with the model its take asked for: why, and the model that wrote it against
 * the agent's own. It goes into the lineage note with the change's other checks.
 */
export function stepupCheck(hint: ModelHint, used: string, own: string): CheckResult {
  const how = used === own ? `written with ${used}, which is already the agent's own model` : `written with ${used} instead of the agent's own ${own}`;
  return { name: STEPUP_CHECK, ok: true, ms: 0, detail: `${hint.reason} The change was ${how}.` };
}

/**
 * The hint as an outside agent sees it (MCP take and checkout): advice only, since the platform does not run its model.
 */
export function stepupAdvice(hint: ModelHint): { class: string; returns: number; reason: string; advice: string } {
  return {
    class: hint.model,
    returns: hint.returns,
    reason: hint.reason,
    advice:
      "FireTrident's own agents write this attempt with their stronger model class. If you can choose the model you run on, use a stronger one for this change. This is advice only: nothing checks which model you use.",
  };
}
