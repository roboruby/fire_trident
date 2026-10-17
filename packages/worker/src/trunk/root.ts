import type { Id, Millis, Sha, TrunkRoot } from "@fire_trident/core";
import { withArtifactsRetry } from "../artifacts/git.ts";

/**
 * A colony's root commit (GET /api/colonies/:id/root, TrunkDO.rootCommit): the first commit of trunk, first parent from
 * the tip. It pins the colony's history: `scripts/verify_note.mjs --colony <root>` and `ft verify --all --colony <root>`
 * walk a stock clone to its root and fail when it is another, so a clone of another colony, or a history rewritten from
 * its first commit, does not pass for this one.
 *
 * The trunk writer's own repository starts at the import (it fetched depth 1), so the root is read through the
 * Artifacts binding, whose log lists the first-parent chain a page at a time. An imported trunk keeps the newest 200
 * commits of its source (artifacts/colony.ts), so its oldest commit names a parent the repository does not hold: that
 * commit is the root, as a clone of the trunk repository sees it (git stops at a shallow boundary as at a root). The root
 * is kept once read (ft_meta), so a history rewritten on the trunk repository later does not move it. Read only.
 */

/** Commits one log page lists (the binding's cap), and pages read at most (a chain of 200,000 commits). */
export const ROOT_PAGE = 1000;
export const ROOT_PAGES = 200;
/** The ft_meta key the root is kept under. */
export const ROOT_META = "root";
/** How long a failed read is answered from memory before the binding is asked again (ms). */
export const ROOT_RETRY_MS = 60_000;

const SHA = /^[0-9a-f]{40}$/;

/** What the walk reads: the binding's first-parent log and its commits (ArtifactsRepo). */
export interface RootRepo {
  log(opts: { ref: string; limit: number }): Promise<Array<{ hash: string; parents: string[] }>>;
  readCommit(hash: string): Promise<{ hash: string } | null>;
}

/**
 * The root of the first-parent chain ending at `head`: the last commit the log lists, page after page, each page starting
 * at the first parent of the page before's last commit. A last commit whose parent the repository does not hold is a
 * shallow boundary (`shallow`). Throws when the walk cannot tell: a page fails, the log lists nothing for a commit the
 * repository holds, or the chain is longer than ROOT_PAGES pages.
 */
export async function findRoot(repo: RootRepo, head: Sha): Promise<{ sha: Sha; shallow: boolean }> {
  let ref = head;
  let previous: { hash: string } | null = null;
  for (let page = 0; page < ROOT_PAGES; page++) {
    const at = ref;
    const commits = await withArtifactsRetry(() => repo.log({ ref: at, limit: ROOT_PAGE }));
    const last = Array.isArray(commits) ? commits[commits.length - 1] : undefined;
    if (!last) {
      if (!previous) throw new Error(`the trunk repository does not list commit ${head}`);
      // The page before was full and its last commit names `ref` as its parent: a boundary, unless the repository holds it.
      if (!(await held(repo, ref))) return { sha: previous.hash, shallow: true };
      throw new Error(`the trunk repository's log lists nothing from ${ref}, though it holds that commit`);
    }
    if (typeof last.hash !== "string" || !SHA.test(last.hash) || !Array.isArray(last.parents)) throw new Error("the trunk repository's log is not in the form expected");
    const parent = last.parents[0];
    if (parent === undefined) return { sha: last.hash, shallow: false };
    // A short page ends at a boundary when the parent is not held; otherwise the log listed fewer than asked, and the walk goes on.
    if (commits.length < ROOT_PAGE && !(await held(repo, parent))) return { sha: last.hash, shallow: true };
    previous = last;
    ref = parent;
  }
  throw new Error(`trunk is longer than ${(ROOT_PAGE * ROOT_PAGES).toLocaleString("en-US")} commits, too long to walk to its root`);
}

/** Whether the repository holds commit `sha`. */
async function held(repo: RootRepo, sha: string): Promise<boolean> {
  return (await withArtifactsRetry(() => repo.readCommit(sha))) !== null;
}

/** Reads in flight and recent failures, by colony and trunk repository, so concurrent asks share one walk. */
const walking = new Map<string, Promise<TrunkRoot>>();
const failed = new Map<string, { at: number; answer: TrunkRoot }>();

/**
 * GET /api/colonies/:id/root's answer: the kept root, or the root read now (`walk`) and kept (`keep`). A failed read is
 * answered with `rootSha: null` and why, and asked again after ROOT_RETRY_MS. Never throws.
 */
export async function rootAnswer(p: { colonyId: Id; trunk: string; kept: string | null; keep: (value: string) => void; walk: () => Promise<{ sha: Sha; shallow: boolean }>; now: () => Millis }): Promise<TrunkRoot> {
  const kept = parseKept(p.kept);
  if (kept) return { colonyId: p.colonyId, rootSha: kept.sha, shallow: kept.shallow, at: kept.at };
  const key = `${p.colonyId}\n${p.trunk}`;
  const recent = failed.get(key);
  if (recent && p.now() - recent.at < ROOT_RETRY_MS) return recent.answer;
  let run = walking.get(key);
  if (!run) {
    run = (async (): Promise<TrunkRoot> => {
      try {
        const root = await p.walk();
        const at = p.now();
        p.keep(JSON.stringify({ sha: root.sha, shallow: root.shallow, at }));
        failed.delete(key);
        return { colonyId: p.colonyId, rootSha: root.sha, shallow: root.shallow, at };
      } catch (e) {
        const answer: TrunkRoot = { colonyId: p.colonyId, rootSha: null, shallow: false, at: p.now(), detail: `the trunk repository's first commit could not be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` };
        failed.set(key, { at: answer.at, answer });
        return answer;
      }
    })().finally(() => walking.delete(key));
    walking.set(key, run);
  }
  return run;
}

/** A kept root (ft_meta), or null when there is none or it is not one. */
function parseKept(raw: string | null): { sha: Sha; shallow: boolean; at: Millis } | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { sha?: unknown; shallow?: unknown; at?: unknown };
    if (typeof v.sha !== "string" || !SHA.test(v.sha)) return null;
    return { sha: v.sha, shallow: v.shallow === true, at: typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0 };
  } catch {
    return null;
  }
}
