import type { PauseState } from "@fire_trident/core";
import { needsYou, type Need } from "./needs.ts";
import type { ColonyStore } from "./store.ts";

/**
 * The exceptions strip on the colony's first screen (components/FirstScreen.tsx): the needs-you line (needs.ts:
 * changes to review, agents' reports, a red trunk, intents that keep coming back, stuck work), the held merges among
 * the changes to review, and the pause in force. Exceptions, not agents: it stays short at any colony size.
 */

/** A held merge's reason as the trunk writer words it (worker trunk/mergelock.ts holdReason): it waits for a person, not its agent. */
const HOLD = /^(?:A person approved this change|This change has a danger pattern a person must see and was decided|This change writes a protected path and was decided) against an older trunk; trunk has since changed /;

/** Whether a proposal's reason is a held merge (a change decided against an older trunk whose merge waits for a person). */
export function isHeldMerge(reason: string | undefined): boolean {
  return typeof reason === "string" && HOLD.test(reason);
}

/** Changes waiting for a person whose reason is a held merge, as far as this page saw them. */
export function heldMerges(store: ColonyStore): number {
  let n = 0;
  for (const p of store.proposals.values()) if (p.status === "escalated" && isHeldMerge(p.reason)) n++;
  return n;
}

/** What the strip shows: the needs (the review one naming its held merges) and the pause in force, if any. */
export interface Exceptions {
  needs: Need[];
  held: number;
  /** The colony's own pause first, else the deployment's. */
  pause: PauseState | null;
}

/** The exceptions now; nothing in `needs` and no pause means nothing needs a person. */
export function exceptionsOf(store: ColonyStore): Exceptions {
  const held = heldMerges(store);
  const needs = needsYou(store).map((n) =>
    n.key === "review" && held > 0
      ? {
          ...n,
          label: `${n.label} (${held} held ${held === 1 ? "merge" : "merges"})`,
          title: `${n.title} A held merge was decided against an older trunk: approving it lands exactly the merge shown, returning it sends it to its agent to redo.`,
        }
      : n,
  );
  return { needs, held, pause: store.pauses[0] ?? null };
}
