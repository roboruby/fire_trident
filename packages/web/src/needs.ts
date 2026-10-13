import { fmtInt, shortSha } from "./format.ts";
import { REPEATED_RETURNS, type ColonyStore } from "./store.ts";

/**
 * What needs a person right now, counted from the store: changes the reflex arc sent to a person,
 * agents' reports that an intent cannot be done as written, a red trunk, and intents whose changes
 * keep coming back. Exceptions, not agents: the list stays short at any colony size.
 */

/** One thing that needs a person, and where the side panel shows it. */
export interface Need {
  key: "review" | "reports" | "tests" | "returns";
  /** Shown before the label when above zero. */
  count: number;
  label: string;
  /** Hover text: what it is and what a person can do about it. */
  title: string;
  tab: "review" | "events" | "intents";
  /** The Events filter chip or the Intents segment to open the tab on. */
  focus?: string;
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
  return out;
}
