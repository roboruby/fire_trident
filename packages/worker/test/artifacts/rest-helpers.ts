import { LANDING_IDENTITY, NEW_FILE_MODE, buildTree, ensureRepo, memoryFs, pushRef, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";

/** Push a root commit holding README.md to `main` of an empty remote (git goes through the global fetch); returns it. */
export async function pushReadme(remote: string, token: string, text: string): Promise<string> {
  const g: GitRepo = { fs: memoryFs(), dir: "/push", cache: {} };
  await ensureRepo(g, remote);
  const blob = await writeLocalBlob(g, new TextEncoder().encode(text));
  const tree = await buildTree(g, new Map([["README.md", { blob, mode: NEW_FILE_MODE }]]));
  const commit = await writeCommitObject(g, { tree, parents: [], message: "Initial commit", at: Date.now(), identity: LANDING_IDENTITY });
  await setRef(g, "refs/heads/main", commit);
  const res = await pushRef(g, { url: remote, token, localRef: "refs/heads/main", remoteRef: "refs/heads/main", expectedOld: null });
  if (!res.ok) throw new Error(`push failed: ${res.detail}`);
  return commit;
}
