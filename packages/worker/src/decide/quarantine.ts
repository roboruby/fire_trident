import type { Id, Path, RepoRef, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import {
  LANDING_IDENTITY,
  NEW_FILE_MODE,
  buildTree,
  dispose,
  ensureRepo,
  getRepoIfExists,
  memoryFs,
  mintToken,
  pushRef,
  setRef,
  withArtifactsRetry,
  writeCommitObject,
  writeLocalBlob,
  type GitRepo,
} from "../artifacts/git.ts";
import { SESSIONS_NAMESPACE, colonySlug } from "../artifacts/shards.ts";

/**
 * The quarantine repo holds sealed vaccine content: `<colony>--vaccine` in the sessions
 * namespace. Each vaccine is one commit whose tree holds only its changed files, so its blobs are
 * readable through the binding exactly like an agent's workspace. Nothing here ever reaches trunk.
 */

/** Quarantine repo name of a colony. */
export function quarantineRepoName(colonyId: Id): string {
  return `${colonySlug(colonyId)}--vaccine`;
}

/** One vaccine's files as committed. */
export interface QuarantineCommit {
  head: Sha;
  blobs: Record<Path, Sha>;
}

/**
 * Commit each change (files → content) as its own commit, chained so one push carries all of
 * them, and force-push the chain to `main` of the quarantine repo (created on first use).
 */
export async function pushQuarantine(env: Env, colonyId: Id, changes: Array<{ files: Array<{ path: Path; content: string }>; message: string }>): Promise<{ repo: RepoRef; commits: QuarantineCommit[] }> {
  const binding = env.SESSIONS;
  if (!binding) throw new Error("no SESSIONS binding for the quarantine repo");
  const name = quarantineRepoName(colonyId);
  let remote: string;
  let token: string;
  const existing = await getRepoIfExists(binding, name, 30_000);
  if (existing === null) {
    const created = await withArtifactsRetry(() => binding.create(name, { description: `FireTrident vaccine quarantine of ${colonyId} (never lands)`, setDefaultBranch: "main" }));
    remote = created.remote;
    token = created.token;
  } else {
    try {
      remote = (await existing.info()).remote;
    } finally {
      dispose(existing);
    }
    token = (await mintToken(binding, name, "write", 600)).token;
  }
  const g: GitRepo = { fs: memoryFs(), dir: "/quarantine", cache: {} };
  await ensureRepo(g, remote);
  const enc = new TextEncoder();
  const commits: QuarantineCommit[] = [];
  let parent: Sha | null = null;
  const at = Date.now();
  for (const [i, change] of changes.entries()) {
    const files = new Map<string, { blob: string; mode: string }>();
    const blobs: Record<Path, Sha> = {};
    for (const f of change.files) {
      const blob = await writeLocalBlob(g, enc.encode(f.content));
      files.set(f.path, { blob, mode: NEW_FILE_MODE });
      blobs[f.path] = blob;
    }
    const tree = await buildTree(g, files);
    const head: Sha = await writeCommitObject(g, { tree, parents: parent ? [parent] : [], message: change.message, at: at + i * 1000, identity: LANDING_IDENTITY });
    commits.push({ head, blobs });
    parent = head;
  }
  if (parent === null) return { repo: { namespace: SESSIONS_NAMESPACE, name, remote }, commits };
  await setRef(g, "refs/heads/main", parent);
  const res = await pushRef(g, { url: remote, token, localRef: "refs/heads/main", remoteRef: "refs/heads/main", force: true });
  if (!res.ok) throw new Error(`quarantine push failed: ${res.detail}`);
  return { repo: { namespace: SESSIONS_NAMESPACE, name, remote }, commits };
}
