import type { Id, Sha } from "@fire_trident/core";

/**
 * Journal recovery (TrunkDO.recoverJournal): what becomes of each landing whose push outcome was never recorded (the
 * object was evicted mid-push, or the push's answer was lost). A landing is recorded only when its commit is on main,
 * dropped only when it is surely not, and kept for the next recovery pass while that cannot be told. Pure.
 *
 * Where main is comes from the trunk repository's git ref advertisement, the same server a push updates. The binding's
 * log of main can lag a push, so it only adds what it shows: a commit it lists is on main, and once its newest entry is
 * the advertised head, a commit it does not list is not.
 */

/** One journal row still `pushing`: its landing, its commit, and the commit that commit was built on. */
export interface PushingRow {
  landingId: Id;
  commit: Sha;
  parent: Sha;
}

/**
 * What recovery read of the trunk repository: `head`, where its ref advertisement says main is (null when that read
 * failed or named no main), and `log`, main's recent commits as the binding lists them, newest first (null when that read
 * failed).
 */
export interface MainView {
  head: Sha | null;
  log: readonly Sha[] | null;
}

/** A row's outcome: `landed` (its commit is on main: record it), `dropped` (it is not: nothing landed), `kept` (not known yet). */
export type RowFate = "landed" | "dropped" | "kept";

/**
 * The outcome of each pushing row, by landing id. Landed: main is at its commit, or at a commit of the journal built on
 * it (through the rows' parent links), or the binding's log lists it. Dropped: main is at a commit it was built on (its
 * push never moved main), or the binding's log has caught up with the advertised head and does not list it. Kept:
 * anything else (the advertisement could not be read, or the binding's log lags it).
 */
export function journalFates(rows: readonly PushingRow[], view: MainView): Map<Id, RowFate> {
  const byCommit = new Map(rows.map((r) => [r.commit, r]));
  const onMain = new Set<Sha>();
  for (let at = view.head; at !== null && !onMain.has(at); ) {
    const row = byCommit.get(at);
    if (!row) break;
    onMain.add(at);
    at = row.parent;
  }
  const logged = new Set(view.log ?? []);
  const caughtUp = view.head !== null && view.log !== null && view.log[0] === view.head;
  const out = new Map<Id, RowFate>();
  for (const r of rows) {
    let fate: RowFate;
    if (onMain.has(r.commit)) fate = "landed";
    else if (view.head !== null && buildsOn(r, view.head, byCommit)) fate = "dropped";
    else if (logged.has(r.commit)) fate = "landed";
    else fate = caughtUp ? "dropped" : "kept";
    out.set(r.landingId, fate);
  }
  return out;
}

/** Whether `row`'s commit was built on `sha`: its parent, or, through journal rows, any commit its parent was built on. */
function buildsOn(row: PushingRow, sha: Sha, byCommit: ReadonlyMap<Sha, PushingRow>): boolean {
  const seen = new Set<Sha>();
  for (let at: Sha | undefined = row.parent; at !== undefined && !seen.has(at); at = byCommit.get(at)?.parent) {
    if (at === sha) return true;
    seen.add(at);
  }
  return false;
}
