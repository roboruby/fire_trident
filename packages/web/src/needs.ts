import type { StuckAction, StuckKind } from "@fire_trident/core";
import { fmtInt, shortSha } from "./format.ts";
import { REPEATED_RETURNS, type ColonyStore, type StuckView } from "./store.ts";

/**
 * What needs a person right now, counted from the store: changes the reflex arc sent to a person,
 * agents' reports that an intent cannot be done as written, a red trunk, intents whose changes
 * keep coming back, and work the colony's stuck-work detector found stopped. Exceptions, not agents:
 * the list stays short at any colony size.
 */

/** One thing that needs a person, and where the side panel shows it. */
export interface Need {
  key: "review" | "reports" | "tests" | "returns" | "stuck";
  /** Shown before the label when above zero. */
  count: number;
  label: string;
  /** Hover text: what it is and what a person can do about it. */
  title: string;
  tab: "review" | "events" | "intents" | "why";
  /** The Events filter chip or the Intents segment to open the tab on. */
  focus?: string;
  /** `stuck`: the items, the kinds most in need of a person first (the strip lists them with what to do). */
  items?: StuckView[];
}

/** What a person can do about a stuck item, as its button says it, and the tab where they do it. */
export const STUCK_DO: Readonly<Record<StuckAction, { label: string; tab: Need["tab"] }>> = {
  agent: { label: "Look at the agent", tab: "why" },
  intent: { label: "Amend or withdraw it", tab: "intents" },
  tests: { label: "Look at the tests", tab: "events" },
  answer: { label: "Answer the report", tab: "review" },
  review: { label: "Review the change", tab: "review" },
};

/** Stuck kinds in the order a person should look at them (the colony's own order). */
const STUCK_ORDER: readonly StuckKind[] = ["red", "report", "review", "claimed", "returns", "agent"];

/**
 * Whether a stuck item is still stuck as far as this page knows. The colony publishes nothing when an
 * item clears, so an item whose intent, change, agent or trunk this page saw move since it learned of
 * it is hidden until the colony's next report says otherwise.
 */
export function stillStuck(store: ColonyStore, s: StuckView): boolean {
  switch (s.kind) {
    case "claimed": {
      const it = s.intentId ? store.intents.get(s.intentId) : undefined;
      return !it || (it.status === "claimed" && it.updatedAt <= s.seenAt);
    }
    case "returns": {
      const it = s.intentId ? store.intents.get(s.intentId) : undefined;
      return !it || it.status === "open" || it.status === "claimed" || it.status === "proposed";
    }
    case "red": {
      const hc = store.headCert();
      return !hc || hc.cert.status === "red";
    }
    case "report":
      return !!s.intentId && store.openEscalations().some((e) => e.intentId === s.intentId);
    case "review": {
      const p = s.proposalId ? store.proposals.get(s.proposalId) : undefined;
      return !p || p.status === "escalated";
    }
    case "agent": {
      const a = s.agentId ? store.agents.get(s.agentId) : undefined;
      if (!a || (a.state !== "working" && a.state !== "proposing") || (a.noteAt ?? 0) > s.since) return false;
      for (const p of store.proposals.values()) if (p.agentId === s.agentId && p.updatedAt > s.seenAt) return false;
      return true;
    }
    default:
      return true;
  }
}

/** The stuck items still stuck, the kinds most in need of a person first, oldest first within a kind. */
export function stuckNow(store: ColonyStore): StuckView[] {
  const rank = (k: StuckKind): number => {
    const i = STUCK_ORDER.indexOf(k);
    return i < 0 ? STUCK_ORDER.length : i;
  };
  return [...store.stuck.values()].filter((s) => stillStuck(store, s)).sort((a, b) => rank(a.kind) - rank(b.kind) || a.since - b.since);
}

/**
 * Where a stuck item's action leads: the Review tab (answer the report, review the change), the
 * Events tab on its tests, the Intents tab where the intent is, or the Why tab on a file the agent
 * holds (it says who is on the file, their state and their last note).
 */
export function stuckTarget(store: ColonyStore, s: StuckView): { tab: Need["tab"]; focus?: string; path?: string } {
  switch (s.action) {
    case "answer":
    case "review":
      return { tab: "review" };
    case "tests":
      return { tab: "events", focus: "certify" };
    case "intent": {
      const status = s.intentId ? store.intents.get(s.intentId)?.status : undefined;
      return { tab: "intents", focus: status === "claimed" || status === "proposed" ? "claimed" : "open" };
    }
    default: {
      const agent = s.agentId ? store.agents.get(s.agentId) : undefined;
      const path = agent?.paths[0] ?? (s.intentId ? store.intents.get(s.intentId)?.footprint[0] : undefined);
      return path ? { tab: "why", path } : { tab: "intents", focus: "claimed" };
    }
  }
}

/** Everything that needs a person now, in the order to look at it; empty when nothing does. */
export function needsYou(store: ColonyStore): Need[] {
  const out: Need[] = [];
  const review = store.reviewQueue();
  if (review > 0) {
    out.push({
      key: "review",
      count: review,
      label: review === 1 ? "change to review" : "changes to review",
      title: "Changes the reflex arc could not settle. Each card shows the change itself, danger lines first: approve, return or reject it.",
      tab: "review",
    });
  }
  const reports = store.openEscalations().length;
  if (reports > 0) {
    out.push({
      key: "reports",
      count: reports,
      label: reports === 1 ? "agent report" : "agent reports",
      title: "Agents reported that an intent cannot be done as written. No agent takes it until a person amends it, withdraws it or dismisses the report.",
      tab: "review",
    });
  }
  const hc = store.headCert();
  if (hc && hc.cert.status === "red") {
    const k = hc.cert.counts;
    const failing = k ? k.fail + k.cancelled : (hc.cert.failing?.length ?? 0);
    out.push({
      key: "tests",
      count: failing,
      label: failing > 0 ? `failing on ${shortSha(hc.cert.trunkSha)}` : `tests red on ${shortSha(hc.cert.trunkSha)}`,
      title: `The project's own tests fail on trunk${hc.onHead ? "" : " (the newest head is still waiting for its run)"}. A failing trunk becomes a repair intent, and certified stays on the last commit whose tests passed.`,
      tab: "events",
      focus: "certify",
    });
  }
  const returned = store.repeatedReturns().length;
  if (returned > 0) {
    out.push({
      key: "returns",
      count: returned,
      label: `${returned === 1 ? "intent" : "intents"} returned ${fmtInt(REPEATED_RETURNS)}+ times`,
      title: `Changes for ${returned === 1 ? "this intent" : "these intents"} came back ${fmtInt(REPEATED_RETURNS)} or more times while you watched. Amending or withdrawing may help more than another attempt.`,
      tab: "intents",
      focus: "returned",
    });
  }
  const stuck = stuckNow(store);
  if (stuck.length > 0) {
    const first = stuck[0];
    out.push({
      key: "stuck",
      count: stuck.length + store.stuckMore,
      label: "stuck",
      title:
        "Work that stopped moving: an intent claimed for 10 minutes with no change, changes that came back 3 or more times, a trunk red for 15 minutes, a report or a change waiting 10 minutes for a person, an agent alive but not moving for 10 minutes. Click for each one and what to do.",
      tab: first ? STUCK_DO[first.action].tab : "review",
      items: stuck,
    });
  }
  return out;
}
