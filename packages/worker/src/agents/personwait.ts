import type { ProposalStatus } from "@fire_trident/core";
import type { JournalView } from "./journal.ts";
import type { Job, Journal } from "./loop.ts";
import type { PushedOutcome } from "./outcomes.ts";

/**
 * An in-platform agent whose change waits for a person (FT_PERSON_WAIT, colony/personwait.ts). The colony has cleared
 * the change's claims; the agent stops refreshing them, and when the change is inline (the colony keeps its files, so
 * it needs nothing more of the agent to land) the job ends with outcome `awaiting_person` and the agent takes other
 * work. A change committed to the workspace keeps its agent waiting: the next job would push over its commit. When the
 * person decides, the colony still pushes the outcome to this agent, which records it (recordLeftOutcome).
 */

/** The outcome a job ends with when its inline change is left with a person. */
export const AWAITING_PERSON = "awaiting_person";

/** Proposal states that end a change for good. */
const FINAL: ReadonlySet<string> = new Set<ProposalStatus>(["landed", "returned", "rejected"]);
/** Finished jobs searched for the change an outcome is about. */
const HISTORY_SEARCH = 50;

/** The job's change waits for a person and the job may end there: the flag covers the colony and the change is inline. */
export function leavesToPerson(personWait: boolean | undefined, job: Pick<Job, "inline">, status: ProposalStatus): boolean {
  return personWait === true && status === "escalated" && job.inline === true;
}

/** The job's claims are not refreshed: its change waits for a person (the colony cleared them). */
export function holdsNoFiles(personWait: boolean | undefined, job: Pick<Job, "step" | "lastStatus">): boolean {
  return personWait === true && job.step === "await" && job.lastStatus === "escalated";
}

/**
 * A pushed outcome of a change this agent left with a person: its final state is counted and logged in the journal.
 * False when the outcome is not about such a change, or not final.
 */
export function recordLeftOutcome(journal: Journal & Pick<JournalView, "history">, o: PushedOutcome, now: number): boolean {
  if (!o || typeof o.proposalId !== "string" || !FINAL.has(o.status)) return false;
  const left = journal.history(HISTORY_SEARCH).find((h) => h.proposalId === o.proposalId && h.outcome === AWAITING_PERSON);
  if (!left) return false;
  journal.bump(o.status);
  const reason = typeof o.reason === "string" && o.reason !== "" ? `: ${o.reason.slice(0, 300)}` : "";
  journal.log({ at: now, intentId: left.intentId, step: "outcome", ok: o.status === "landed", ms: 0, detail: `the change left with a person (${o.proposalId}) ${o.status}${reason}` });
  return true;
}
