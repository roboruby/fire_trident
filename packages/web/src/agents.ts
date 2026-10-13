import type { AgentState } from "@fire_trident/core";
import type { AgentView, ColonyStore, ProposalView } from "./store.ts";

/** Who is on a file and why an agent waits: what the map's hover card says about agents. */

const ORDER: Readonly<Record<AgentState, number>> = { working: 0, proposing: 1, waiting: 2, idle: 3, dead: 4 };
const IN_FLIGHT: ReadonlySet<string> = new Set(["pending", "checking", "ready", "escalated"]);

/**
 * Agents holding a file (it is in the footprint of the intent they hold), busiest and most recently
 * heard from first: at most `limit`, with how many there are in all.
 */
export function agentsOn(store: ColonyStore, path: string, limit = 3): { list: AgentView[]; total: number } {
  const all: AgentView[] = [];
  for (const a of store.agents.values()) if (a.intentId && a.paths.includes(path)) all.push(a);
  all.sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || (b.noteAt ?? 0) - (a.noteAt ?? 0) || a.name.localeCompare(b.name));
  return { list: all.slice(0, Math.max(0, limit)), total: all.length };
}

/** The proposal this agent made most recently, if the page has seen one. */
function latestProposal(store: ColonyStore, agentId: string): ProposalView | null {
  let best: ProposalView | null = null;
  for (const p of store.proposals.values()) if (p.agentId === agentId && (!best || p.updatedAt >= best.updatedAt)) best = p;
  return best;
}

/**
 * What an agent is waiting for, in one sentence, or null when it is not waiting on anything: a
 * person (its change is in the review queue, or it reported its intent), a lane (its change is being
 * checked), or work it can take. The colony's own reason wins when the `agent` event carried one.
 */
export function waitingWhy(store: ColonyStore, a: AgentView): string | null {
  const esc = a.intentId ? store.escalations.get(a.intentId) : undefined;
  if (esc && !esc.resolved && esc.agentId === a.id) return "It reported that its intent can't be done as written. A person answers in the Review tab.";
  if (a.state !== "proposing" && a.state !== "waiting") return null;
  const p = latestProposal(store, a.id);
  const pending = p && IN_FLIGHT.has(p.status) && (!a.intentId || p.intentId === a.intentId);
  if (pending && p.status === "escalated") return "Its change waits for a person in the Review tab.";
  if (pending || a.state === "proposing") return "Its change is being checked and waits for its lane to land it.";
  if (a.waitReason) return `Waiting: ${a.waitReason}.`.replace(/\.\.$/, ".");
  if (store.intentsByStatus.open === 0) return "Nothing is open to take right now. It checks again on its own.";
  return "Nothing it can take yet: other agents hold the open work's files, or its region is briefly closed to new agents. It retries on its own.";
}
