import type { Id, RepoRef, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import {
  LANDING_IDENTITY,
  NEW_FILE_MODE,
  artifactsCode,
  buildTree,
  dispose,
  ensureRepo,
  getRepoIfExists,
  listRemoteRefs,
  memoryFs,
  pushRef,
  setRef,
  withArtifactsRetry,
  writeCommitObject,
  writeLocalBlob,
  type GitRepo,
} from "./git.ts";
import { TRUNK_NAMESPACE, trunkRepoName } from "./shards.ts";
import type { ColonyStorage } from "./storage.ts";

/** Commits of source history kept on import. */
const IMPORT_DEPTH = 200;

/**
 * Create the colony's trunk repo in Artifacts (`<colony>--trunk` in ft-trunk) and return it
 * with the sha of `main`. With `source`, the trunk is imported from that public git URL
 * (`depth` 200); otherwise it is created empty and given an initial commit with a README.
 * Idempotent: an existing trunk is reused, and a trunk whose default branch is not `main`
 * gets a `main` branch at the same commit. With `storage` (artifacts/storage.ts) the trunk is made
 * there instead of in env.ARTIFACTS, and the RepoRef names its owner.
 */
export async function provisionTrunk(env: Env, colonyId: Id, source?: { url: string; branch?: string }, storage?: ColonyStorage): Promise<{ trunk: RepoRef; trunkSha: Sha }> {
  const name = trunkRepoName(colonyId);
  const ns = storage ? storage.trunk : env.ARTIFACTS;
  const description = `FireTrident trunk of ${colonyId}`;
  const existing = await getRepoIfExists(ns, name);
  dispose(existing);
  if (existing === null) {
    try {
      if (source) {
        await withArtifactsRetry(
          () => ns.import({ source: { url: source.url, branch: source.branch || undefined, depth: IMPORT_DEPTH }, target: { name, opts: { description } } }),
          { delaysMs: [1_000, 3_000] },
        );
      } else {
        const created = await withArtifactsRetry(() => ns.create(name, { description, setDefaultBranch: "main" }));
        await pushInitialCommit(created.remote, created.token, colonyId);
      }
    } catch (e) {
      if (artifactsCode(e) !== "ALREADY_EXISTS") throw e;
    }
  }

  const repo = await getRepoIfExists(ns, name, 120_000);
  if (repo === null) throw new Error(`trunk ${name} was not created`);
  try {
    const info = await repo.info();
    let head = await mainHead(repo);
    if (head === null) {
      // An import of a repo whose default branch is not main, or an empty repo. info().defaultBranch
      // reports "main" even then, so read the branch HEAD really points at from the git advertisement.
      const tok = await repo.createToken("write", 600);
      const other = pickBranchHead(await listRemoteRefs(info.remote, tok.plaintext), source?.branch);
      if (other !== null) await pointMainAt(info.remote, tok.plaintext, other);
      else await pushInitialCommit(info.remote, tok.plaintext, colonyId);
      head = await mainHead(repo);
    }
    if (head === null) throw new Error(`trunk ${name} has no main branch`);
    const owner = storage?.owner ?? null;
    return { trunk: { namespace: TRUNK_NAMESPACE, name, remote: info.remote, ...(owner !== null ? { owner } : {}) }, trunkSha: head };
  } finally {
    dispose(repo);
  }
}

/** Delete the colony's trunk repo (colony teardown), from `storage` when given. True when a repo was deleted. */
export async function deprovisionTrunk(env: Env, colonyId: Id, storage?: ColonyStorage): Promise<boolean> {
  const ns = storage ? storage.trunk : env.ARTIFACTS;
  return withArtifactsRetry(() => ns.delete(trunkRepoName(colonyId)));
}

/** Head of `main` through the binding, or null when the branch does not exist yet. */
async function mainHead(repo: ArtifactsRepo): Promise<Sha | null> {
  try {
    return (await repo.log({ ref: "main", limit: 1 }))[0]?.hash ?? null;
  } catch {
    return null;
  }
}

/**
 * The commit `main` should start from when it is missing: the branch HEAD points at, then the
 * requested branch, then master, then any branch. Null when the repo has no branches.
 */
export function pickBranchHead(refs: Array<{ ref: string; oid: string; target?: string }>, requested?: string): Sha | null {
  const branches = new Map(refs.filter((r) => r.ref.startsWith("refs/heads/") && r.ref !== "refs/heads/main").map((r) => [r.ref, r.oid]));
  const head = refs.find((r) => r.ref === "HEAD")?.target;
  for (const ref of [head, requested ? `refs/heads/${requested}` : undefined, "refs/heads/master"]) {
    if (ref !== undefined && branches.has(ref)) return branches.get(ref)!;
  }
  return branches.values().next().value ?? null;
}

/** A scratch repo in memory pointed at `remote`. */
async function scratchRepo(remote: string): Promise<GitRepo> {
  const repo: GitRepo = { fs: memoryFs(), dir: "/scratch", cache: {} };
  await ensureRepo(repo, remote);
  return repo;
}

/** Push a root commit with a README to `main` of an empty repo. */
async function pushInitialCommit(remote: string, token: string, colonyId: Id): Promise<void> {
  const repo = await scratchRepo(remote);
  const readme = new TextEncoder().encode(`# ${colonyId}\n\nThis repository is a FireTrident colony trunk.\n`);
  const blob = await writeLocalBlob(repo, readme);
  const tree = await buildTree(repo, new Map([["README.md", { blob, mode: NEW_FILE_MODE }]]));
  const commit = await writeCommitObject(repo, { tree, parents: [], message: "Initial commit", at: Date.now(), identity: LANDING_IDENTITY });
  await setRef(repo, "refs/heads/main", commit);
  const res = await pushRef(repo, { url: remote, token, localRef: "refs/heads/main", remoteRef: "refs/heads/main", expectedOld: null });
  if (!res.ok) throw new Error(`initial commit push failed: ${res.detail}`);
}

/** Create `main` at `sha`, a commit the remote already has (no objects travel). */
async function pointMainAt(remote: string, token: string, sha: Sha): Promise<void> {
  const repo = await scratchRepo(remote);
  const res = await pushRef(repo, { url: remote, token, localRef: sha, remoteRef: "refs/heads/main", expectedOld: null });
  if (!res.ok) throw new Error(`creating main at ${sha} failed: ${res.detail}`);
}
