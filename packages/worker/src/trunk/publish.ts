/**
 * Asynchronous trunk publishing (FT_ASYNC_PUBLISH), the pure part.
 *
 * Why: a landing cycle used to push the chain it built to the trunk repository before it answered its
 * lanes, so every cycle held a push (about a second at 5,000 agents). With publishing on, a landing
 * counts once the cycle records it in the trunk writer's own storage: the commit and its objects in the
 * local repository, the trunk index, the lineage tables, and a journal row in state `recorded`. A publish
 * loop beside the cycles pushes the recorded commits to the trunk repository with compare-and-swap on the
 * last published commit, every commit recorded since the last push in one push, never two pushes at once.
 * A published row moves to `pending_note`, so the lineage notes follow the published head.
 *
 * Everything that needs a commit in the trunk repository uses the published head (a lease's base,
 * `certified`, the notes); lanes validate and plan against the recorded head, and the writer's own reads
 * answer for unpublished commits from its local store. A hard bound (PUBLISH_BOUND) makes cycles wait for
 * publishing when it falls behind.
 */
import { revalidationEnabled } from "@fire_trident/core";
import type { Id, Sha } from "@fire_trident/core";
import type { TreeEntry } from "isomorphic-git";
import type { GitRepo } from "../artifacts/git.ts";
import { readTreeCached } from "./surgery.ts";

/** Whether asynchronous publishing is on for a colony: "on", or a comma-separated list of colony ids; absent or "off" is off. */
export function asyncPublishEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * How far the recorded head may run ahead of the published one: landings recorded and not published, and how
 * long the oldest of them has waited. Past either, a cycle waits for publishing, at most `waitMs`, then fails
 * (its lanes send the batches again).
 */
export interface PublishBound {
  landings: number;
  ageMs: number;
  waitMs: number;
}

export const PUBLISH_BOUND: PublishBound = { landings: 2_000, ageMs: 60_000, waitMs: 30_000 };

/** The longest pause between two publish attempts after failures. */
export const PUBLISH_BACKOFF_MAX_MS = 30_000;

/** A recorded commit waiting to be published (a journal row in state `recorded`). */
export interface RecordedCommit {
  landingId: Id;
  commit: Sha;
  parent: Sha;
  /** When it was recorded (its landing time). */
  at: number;
}

/** Whether a cycle may go on: nothing waits, or fewer landings than the bound and the oldest younger than it. */
export function withinBound(lag: { unpublished: number; oldestAt: number | null }, now: number, bound: PublishBound = PUBLISH_BOUND): boolean {
  if (lag.unpublished <= 0) return true;
  return lag.unpublished < bound.landings && (lag.oldestAt === null || now - lag.oldestAt < bound.ageMs);
}

/** The pause after the n-th failed publish attempt in a row: 1 s, 2 s, 4 s, ... +-25%, at most PUBLISH_BACKOFF_MAX_MS. */
export function publishBackoffMs(failures: number, rand: () => number = Math.random): number {
  const base = Math.min(PUBLISH_BACKOFF_MAX_MS, 1_000 * 2 ** Math.max(0, Math.min(failures, 16) - 1));
  return Math.min(PUBLISH_BACKOFF_MAX_MS, Math.round(base * (0.75 + rand() * 0.5)));
}

/**
 * The commits one publish pushes: the recorded ones that chain from the published head `base`, in chain
 * order (each one's parent is the commit before it). Only the trunk writer records commits, each on top of
 * the last, so every row chains on; a row that does not is returned as `broken` and never published.
 */
export function publishChain(base: Sha, rows: readonly RecordedCommit[]): { chain: RecordedCommit[]; broken: RecordedCommit | null } {
  const byParent = new Map<Sha, RecordedCommit>();
  for (const r of rows) if (!byParent.has(r.parent)) byParent.set(r.parent, r);
  const chain: RecordedCommit[] = [];
  const seen = new Set<Sha>();
  for (let r = byParent.get(base); r && !seen.has(r.commit); r = byParent.get(r.commit)) {
    seen.add(r.commit);
    chain.push(r);
  }
  return { chain, broken: rows.find((r) => !seen.has(r.commit)) ?? null };
}

/** What a remote main says about a publish of `chain` on top of `base`. */
export type PublishSettle =
  /** Main is still at the published head: nothing was published. */
  | { kind: "none" }
  /** Main holds the chain up to and including `index` (a push landed and its answer was lost). */
  | { kind: "upTo"; index: number }
  /** Main is at a commit this writer did not record (or absent): something else wrote trunk. */
  | { kind: "foreign" };

/** Where a publish stands once the remote main is known (after a refused, stale or unanswered push). */
export function settlePublish(base: Sha, chain: readonly RecordedCommit[], remote: Sha | null): PublishSettle {
  if (remote !== null && remote === base) return { kind: "none" };
  const index = remote === null ? -1 : chain.findIndex((c) => c.commit === remote);
  return index >= 0 ? { kind: "upTo", index } : { kind: "foreign" };
}

/**
 * Add to `out` tree `after` and every tree and blob under it that is not at the same path in tree `before`
 * (null: nothing): the objects a commit with root `after` adds to its parent with root `before`, so a push of
 * a chain carries exactly its new objects. Submodule entries are left out (their commits live elsewhere).
 */
export async function addedObjects(repo: GitRepo, trees: Map<string, TreeEntry[]>, before: string | null, after: string, out: Set<string>): Promise<void> {
  if (before === after) return;
  out.add(after);
  const old = new Map<string, TreeEntry>();
  if (before !== null) for (const e of await readTreeCached(repo, trees, before)) old.set(e.path, e);
  for (const e of await readTreeCached(repo, trees, after)) {
    const o = old.get(e.path);
    if (o && o.oid === e.oid && o.type === e.type) continue;
    if (e.type === "tree") await addedObjects(repo, trees, o?.type === "tree" ? o.oid : null, e.oid, out);
    else if (e.type === "blob") out.add(e.oid);
  }
}
