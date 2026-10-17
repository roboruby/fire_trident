import type { ColonyEvent, PauseScope, PauseState } from "@fire_trident/core";

/**
 * The pause switch on the colony page (packages/worker/src/colony/pause.ts): a person paused the colony's agents, or
 * the deployment's, with a reason. The snapshot carries the pauses in force (`pauses`); `paused` and `resumed` events
 * keep them current, live and in replays. Who paused and why are a person's words: callers render them as text.
 */

const SCOPES: ReadonlySet<string> = new Set<PauseScope>(["colony", "deployment"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Server text on one line, at most `max` characters. */
function line(x: unknown, max: number): string {
  const s = typeof x === "string" ? x.replace(CONTROL, " ").replace(/\s+/g, " ").trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One pause read defensively; null when it is not one. */
export function parsePause(x: unknown): PauseState | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.scope !== "string" || !SCOPES.has(o.scope)) return null;
  const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
  return { scope: o.scope as PauseScope, by: line(o.by, 100) || "someone", reason: line(o.reason, 300) || "no reason given", at };
}

/** The pauses in force from a snapshot's `pauses` (one per scope, the colony's own first); none for anything else. */
export function parsePauses(raw: unknown): PauseState[] {
  const list = (Array.isArray(raw) ? raw : []).map(parsePause).filter((p): p is PauseState => p !== null);
  const colony = list.find((p) => p.scope === "colony");
  const deployment = list.find((p) => p.scope === "deployment");
  return [colony, deployment].filter((p): p is PauseState => p !== undefined);
}

/** The pauses after a `paused` or `resumed` event: a pause replaces the one of its scope, a resume removes it. */
export function applyPauseEvent(list: readonly PauseState[], e: Extract<ColonyEvent, { t: "paused" | "resumed" }>): PauseState[] {
  if (typeof e.scope !== "string" || !SCOPES.has(e.scope)) return [...list];
  const rest = list.filter((p) => p.scope !== e.scope);
  if (e.t === "resumed") return rest;
  const p = parsePause(e);
  return p ? parsePauses([...rest, p]) : rest;
}

/** What the banner says: the headline, what holds and what still works, and the command that resumes. */
export interface PauseBanner {
  headline: string;
  detail: string;
  command: string;
}

/** The colony page's banner for the pauses in force, or null when agents may work. */
export function pauseBanner(pauses: readonly PauseState[], colonyId: string): PauseBanner | null {
  const own = pauses.find((p) => p.scope === "colony");
  const deployment = pauses.find((p) => p.scope === "deployment");
  const first = own ?? deployment;
  if (!first) return null;
  const where = first.scope === "deployment" ? "on this whole deployment" : "in this colony";
  const also = own && deployment ? ` The whole deployment is paused too, by ${deployment.by}: ${deployment.reason}.` : "";
  return {
    headline: `Agents are paused ${where} by ${first.by}: ${first.reason}`,
    detail: `No agent takes work, proposes or starts, and no agent's change lands: changes already in a lane wait there. Reads and every person's action (approve, reject, amend, withdraw, revert) still work.${also}`,
    command: own ? `ft resume ${colonyId}` : "ft resume --deployment",
  };
}

/** One line of the event log for a `paused` or `resumed` event. */
export function pauseEventText(e: Extract<ColonyEvent, { t: "paused" | "resumed" }>): string {
  const where = e.scope === "deployment" ? "the deployment's agents" : "the colony's agents";
  const by = line(e.by, 100) || "someone";
  if (e.t === "paused") return `${by} paused ${where}: ${line(e.reason, 300) || "no reason given"}`;
  const why = line(e.reason, 300);
  return `${by} resumed ${where}${why ? `: ${why}` : ""}`;
}
