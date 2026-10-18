import type { EscalationKind, Id, IntentEscalation } from "@fire_trident/core";
import { parseEscalation } from "../colony/direction.ts";
import { escalateReceipt } from "./instructions.ts";

/**
 * An escalate retried after its reply was lost. The first call reported the intent to a person, and the colony took the
 * agent's claim and lease back, so a retry used to fail: the session no longer held an intent ("you hold no intent"), or
 * the colony refused a second report on the same intent (409). Now a repeat for the same agent and intent gets the first
 * answer back and nothing new is reported, at both ends:
 * - the session remembers its reports for ESCALATE_REPLAY_MS (Session.escalated, the newest MAX_ESCALATED): a repeat
 *   naming that intent, or naming none while the session holds no intent, is answered from there, marked `replayed`;
 * - the colony (ColonyDO.escalate, repeatedReport) answers a report on an intent whose open report this agent filed with
 *   that report as it stands, writing nothing: for a retry whose first answer never reached the session, and for an
 *   in-platform agent's retry.
 * A session that holds the intent again (a person dismissed the report and it was taken again) reports anew.
 */

/** How long a session answers a repeat of its report from memory. */
export const ESCALATE_REPLAY_MS = 10 * 60_000;
/** Reports a session remembers (the newest). */
export const MAX_ESCALATED = 20;

/** The retry contract, as the escalate tool's description and docs/agents state it. */
export const ESCALATE_RETRY =
  "After a timeout, send the report again in this session (for the same intent): you get the first answer back with replayed: true, and nothing new is reported.";

/** What a replayed escalate says next to the answer. */
export const ESCALATE_REPLAY_NOTE = "You reported this intent already and the answer did not reach you: this is that answer, and nothing new was reported.";

/** A report a session remembers: the intent, its title and the kind as the colony recorded them, who reported it, and when. */
export interface EscalatedIntent {
  intentId: Id;
  title: string;
  kind: EscalationKind;
  agentId: Id;
  at: number;
}

/** The part of a session this module reads and writes. */
export interface EscalateSession {
  agentId?: Id;
  intent?: { id: Id } | undefined;
  escalated?: EscalatedIntent[];
}

/** A session's reports still inside the replay window, oldest first; malformed entries (older or foreign data) are dropped. */
export function recentReports(list: unknown, now: number): EscalatedIntent[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is EscalatedIntent =>
      !!e && typeof e === "object" && typeof e.intentId === "string" && e.intentId !== "" && typeof e.agentId === "string" && typeof e.at === "number" && now - e.at < ESCALATE_REPLAY_MS && now >= e.at,
  );
}

/**
 * The report a repeat of `a` replays, or null (the call goes on as a new report). It names the intent, or names none
 * while the session holds no intent (the first call gave it up); the session's own agent filed it; and the session does
 * not hold that intent again.
 */
export function replayedReport(s: EscalateSession, a: { intentId?: string | undefined }, now: number): EscalatedIntent | null {
  if (!s.agentId) return null;
  const named = typeof a.intentId === "string" ? a.intentId.trim() : "";
  const mine = recentReports(s.escalated, now).filter((e) => e.agentId === s.agentId);
  const hit = named !== "" ? mine.filter((e) => e.intentId === named).at(-1) : s.intent ? undefined : mine.at(-1);
  if (!hit || s.intent?.id === hit.intentId) return null;
  return hit;
}

/** Remember a report in the session (the newest MAX_ESCALATED inside the window). */
export function rememberReport(s: EscalateSession, e: EscalatedIntent, now: number): void {
  s.escalated = [...recentReports(s.escalated, now).filter((x) => !(x.intentId === e.intentId && x.agentId === e.agentId)), e].slice(-MAX_ESCALATED);
}

/** The escalate answer, first or replayed. */
export function escalateAnswer(e: Pick<EscalatedIntent, "intentId" | "title" | "kind">, replayed = false): Record<string, unknown> {
  return {
    escalated: { intentId: e.intentId, title: e.title, kind: e.kind },
    receipt: escalateReceipt(e.intentId),
    ...(replayed ? { replayed: true, note: ESCALATE_REPLAY_NOTE } : {}),
    next: "Call take for other work.",
  };
}

/**
 * The colony's side (ColonyDO.escalate): the open report this agent filed on the intent row, when there is one, so a
 * repeat gets it back and writes nothing; null otherwise (the call goes on as before).
 */
export function repeatedReport(row: { escalation?: string | null; escalation_open?: number | null } | null | undefined, agentId: Id): IntentEscalation | null {
  if (!row || row.escalation_open !== 1) return null;
  const open = parseEscalation(row.escalation ?? null);
  // The colony's own chain hold (colony/chain.ts) is kept as a report too, but no agent filed it.
  return open && !open.resolved && open.kind !== "chain" && open.by === agentId ? open : null;
}
