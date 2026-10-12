import { runInDurableObject } from "cloudflare:test";
import { Workspace } from "@cloudflare/computer";
import git from "isomorphic-git";
import gitHttp from "isomorphic-git/http/web";
import { describe, expect, it } from "vitest";
import { WorkspaceGit, buildIsoFs } from "../../src/agents/gitfs.ts";
import { env } from "./helpers.ts";

/**
 * Network test: WorkspaceGit inside a real Durable Object against a public git remote
 * (no token) whose main branch has an index.js at the root. Opt-in:
 *   VITE_FT_LIVE_GIT_REMOTE=https://host/owner/repo.git npx vitest run --project do test/do/gitfs-live.test.ts
 */
const REMOTE = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_FT_LIVE_GIT_REMOTE ?? "";
const live = /^https:\/\//.test(REMOTE);

describe.skipIf(!live)("WorkspaceGit against a public remote (network)", () => {
  it("fetches shallow, reads with blob ids, and commits by tree surgery", async () => {
    const stub = env.POOL.get(env.POOL.idFromName(`gitfs-live-a-${Date.now()}`));
    await runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
      const g = new WorkspaceGit(state.storage, "/repo");
      const first = await g.ensureBase({ remote: REMOTE, token: "", baseSha: "0".repeat(40) });
      expect(first.fallback).toBe(true);
      expect(await g.ensureBase({ remote: REMOTE, token: "", baseSha: first.baseSha })).toEqual({ baseSha: first.baseSha, fallback: false });
      const f = await g.readFile(first.baseSha, "index.js");
      expect(f).toMatchObject({ mode: "100644" });
      expect(f!.blob).toMatch(/^[0-9a-f]{40}$/);
      const c = await g.commit({
        baseSha: first.baseSha,
        changes: [
          { path: "index.js", content: "x\n" },
          { path: "deep/new/file.ts", content: "y\n" },
        ],
        message: "t\n",
        author: { name: "a", email: "a@b" },
        timestamp: 1,
      });
      expect(c.writeSet.map((w) => w.path)).toEqual(["index.js", "deep/new/file.ts"]);
      expect((await g.readFile(c.headSha, "deep/new/file.ts"))!.blob).toBe(c.writeSet[1]!.blob);
      expect((await g.listFiles(c.headSha)).length).toBe((await g.listFiles(first.baseSha)).length + 1);
    });
  }, 60_000);

  it("recovers a clone poisoned by a fetch that died after recording the shallow boundary", async () => {
    const stub = env.POOL.get(env.POOL.idFromName(`gitfs-live-b-${Date.now()}`));
    await runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
      const fs = buildIsoFs(new Workspace({ storage: state.storage as never }).provider());
      await git.init({ fs, dir: "/repo", defaultBranch: "main" });
      // With no configured remote, fetch downloads the pack, writes .git/shallow, then fails before storing objects.
      await expect(git.fetch({ fs, http: gitHttp, dir: "/repo", url: REMOTE, ref: "main", singleBranch: true, depth: 1 })).rejects.toThrow(/refspec/);
      const shallow = String(await fs.promises.readFile("/repo/.git/shallow", "utf8")).trim();
      expect(shallow).toMatch(/^[0-9a-f]{40}$/);

      const g = new WorkspaceGit(state.storage, "/repo");
      expect(await g.ensureBase({ remote: REMOTE, token: "", baseSha: shallow })).toEqual({ baseSha: shallow, fallback: false });
      expect(await g.readFile(shallow, "index.js")).not.toBeNull();
    });
  }, 60_000);
});
