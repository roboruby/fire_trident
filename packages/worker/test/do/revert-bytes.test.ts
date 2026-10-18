import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Path, RepoRef, Sha } from "@fire_trident/core";
import { blobAt, buildTree, commitTree, ensureRepo, readLocalBlob, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import { env } from "./helpers.ts";
import { FakeRemote, Publisher, landed } from "./publisher.ts";

/**
 * `ft revert` through the real trunk writer (trunk/revert.ts, TrunkDO.systemCommitNow): a file goes back by its blob, so
 * a binary file comes back byte for byte, and a file the landing deleted comes back with the mode it had (an executable
 * stays executable, a symbolic link stays one). Publishing goes to a FakeRemote (publisher.ts).
 */

const TRUNK: RepoRef = { namespace: "ft-trunk", name: "revert--trunk", remote: "https://artifacts.invalid/revert--trunk.git" };
let seq = 0;

/** A trunk writer whose trunk holds `files` with their modes, publishing asynchronously to a FakeRemote. */
async function withTrunk(files: Record<Path, { bytes: Uint8Array; mode: string }>, fn: (w: Publisher, g: GitRepo) => Promise<void>): Promise<void> {
  const colonyId = `col_revert_${++seq}`;
  await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(`revert-bytes-${Date.now()}-${seq}`)), async (_instance: unknown, state: DurableObjectState) => {
    const meta = (key: string, value: string): void => void state.storage.sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", key, value);
    const trunk = new TrunkDO(state, { FT_ASYNC_PUBLISH: "on" } as never);
    meta("colony_id", colonyId);
    meta("trunk", JSON.stringify(TRUNK));
    const g = (trunk as unknown as { repo(): GitRepo }).repo();
    await ensureRepo(g, TRUNK.remote);
    const tree = new Map<Path, { blob: Sha; mode: string }>();
    for (const [path, f] of Object.entries(files)) tree.set(path, { blob: await writeLocalBlob(g, f.bytes), mode: f.mode });
    const head = await writeCommitObject(g, { tree: await buildTree(g, tree), parents: [], message: "init\n", at: Date.now() });
    await setRef(g, "refs/heads/main", head);
    await (trunk as unknown as { rebuildIndex(head: Sha): Promise<void> }).rebuildIndex(head);
    const w = new Publisher(state, { publish: "on" }, colonyId, new FakeRemote(head), head);
    w.adopt(trunk);
    await fn(w, g);
  });
}

const enc = new TextEncoder();

describe("revert through the trunk writer", () => {
  it("puts a binary file back byte for byte, and deleted files back with the mode each had", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
    await withTrunk(
      {
        "assets/logo.png": { bytes: png, mode: "100644" },
        "bin/run.sh": { bytes: enc.encode("#!/bin/sh\necho hi\n"), mode: "100755" },
        "docs/latest": { bytes: enc.encode("v1.md"), mode: "120000" },
        "src/a.ts": { bytes: enc.encode("export const a = 1;\n"), mode: "100644" },
      },
      async (w, g) => {
        const original = await writeLocalBlob(g, png);
        // A landing overwrites the image with other bytes; another deletes the script and the link.
        const p = await w.proposal({ "assets/logo.png": "placeholder" });
        p.writeSet = [{ path: "assets/logo.png", blob: await writeLocalBlob(g, new Uint8Array([0x00, 0x01, 0x02, 0xff])) }];
        const image = landed(await w.land(p));
        const gone = landed(await w.land(await w.proposal({ "bin/run.sh": null, "docs/latest": null })));
        expect(w.rows<{ path: string }>("SELECT path FROM ft_files WHERE path IN ('bin/run.sh', 'docs/latest')")).toEqual([]);

        const back = await w.trunk.revert(gone.id, { by: "matt", reason: "the script is still used" });
        expect(back.ok).toBe(true);
        const undone = await w.trunk.revert(image.id, { by: "matt", reason: "the old logo" });
        expect(undone.ok).toBe(true);
        await w.settle();

        const files = new Map(w.rows<{ path: string; blob: string; mode: string }>("SELECT path, blob, mode FROM ft_files").map((r) => [r.path, r]));
        expect(files.get("assets/logo.png")?.blob).toBe(original);
        expect(await readLocalBlob(g, original)).toEqual(png);
        expect([files.get("bin/run.sh")?.mode, files.get("docs/latest")?.mode]).toEqual(["100755", "120000"]);
        // The revert commit's own tree says the same.
        const tree = (await commitTree(g, back.ok ? back.landing.trunkSha : ""))!;
        expect((await blobAt(g, tree, "bin/run.sh"))?.mode).toBe("100755");
        expect((await blobAt(g, tree, "docs/latest"))?.mode).toBe("120000");
      },
    );
  });
});
