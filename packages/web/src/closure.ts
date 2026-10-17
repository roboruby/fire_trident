import type { AgentKind, ClosureCause, IntentClosure, IntentStatus } from "@fire_trident/core";
import { fmtDuration, timeAgo } from "./format.ts";

/**
 * The closure ledger as the page shows it: why an intent an agent held last closed or reopened (the colony's `closure` on
 * the intent in the snapshot, or the cause fields of a live or replayed intent event), as a small label on its row and a
 * few words on its line in the events log. Landed and withdrawn closures get no label: the intent's status says them.
 */

const CAUSES: readonly ClosureCause[] = ["landed", "released", "escalated", "withdrawn", "gave_up", "reaped_silent", "returned", "stopped"];
const KINDS: readonly AgentKind[] = ["internal", "external", "synthetic"];

/** A closure the colony sent (on an intent, or as an intent event's fields), checked field by field; null otherwise. */
export function closureFrom(raw: unknown, status?: IntentStatus): IntentClosure | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.cause !== "string" || !(CAUSES as readonly string[]).includes(o.cause)) return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  const s = typeof o.status === "string" ? (o.status as IntentStatus) : status;
  if (!s) return null;
  const out: IntentClosure = { cause: o.cause as ClosureCause, at: o.at, status: s };
  if (typeof o.agentId === "string" && o.agentId) out.agentId = o.agentId;
  if (typeof o.agentKind === "string" && (KINDS as readonly string[]).includes(o.agentKind)) out.agentKind = o.agentKind as AgentKind;
  if (typeof o.gapMs === "number" && Number.isFinite(o.gapMs) && o.gapMs >= 0) out.gapMs = o.gapMs;
  return out;
}

/** The small label on an intent's row and its hover sentence; null for landed and withdrawn closures. */
export function closureBadge(c: IntentClosure | null | undefined, agentName: (id: string) => string, now: number): { label: string; title: string } | null {
  if (!c || c.cause === "landed" || c.cause === "withdrawn") return null;
  const who = c.agentId ? agentName(c.agentId) : "its agent";
  const when = timeAgo(c.at, now);
  const ago = when ? ` ${when}` : "";
  switch (c.cause) {
    case "reaped_silent": {
      const silent = c.gapMs !== undefined ? fmtDuration(c.gapMs) : null;
      return {
        label: silent ? `reaped · ${silent} silent` : "reaped",
        title: `Taken back${ago}: ${who} was silent${silent ? ` for ${silent}` : ""}, past the colony's limit, so the colony reopened it with a failure mark for the next taker.`,
      };
    }
    case "released":
      return { label: "given back", title: `${who} gave it back${ago}; it reopened with a failure mark.` };
    case "gave_up":
      return { label: "gave up", title: `${who} gave up on it${ago}; it reopened with a failure mark.` };
    case "escalated":
      return { label: "reported", title: `${who} reported it to a person${ago}; no agent takes it until a person answers.` };
    case "returned":
      return { label: "returned", title: `${who}'s change came back${ago}, so it reopened.` };
    case "stopped":
      return { label: "agent stopped", title: `A person stopped ${who}${ago}, so it reopened with a failure mark.` };
  }
  return null;
}

/** A few words for an intent event's line in the events log: " · reaped after 1 min 37 s silent", or "" without a cause. */
export function closureEventText(c: IntentClosure | null): string {
  if (!c) return "";
  switch (c.cause) {
    case "reaped_silent":
      return c.gapMs !== undefined ? ` · reaped after ${fmtDuration(c.gapMs)} silent` : " · reaped (agent silent)";
    case "released":
      return " · given back";
    case "gave_up":
      return " · agent gave up";
    case "escalated":
      return " · reported to a person";
    case "returned":
      return " · change came back";
    case "stopped":
      return " · agent stopped";
    case "withdrawn":
      return " · withdrawn while held";
    case "landed":
      return "";
  }
  return "";
}
