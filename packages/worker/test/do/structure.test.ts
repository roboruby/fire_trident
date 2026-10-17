import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import { buildTree, commitTree, ensureRepo, readLocalBlob, readTreeEntries, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import { env } from "./helpers.ts";
import { Writer, landed } from "./writer.ts";

/**
 * The real trunk writer refuses a symbolic link retargeted and a second spelling of a trunk file (trunk/structure.ts),
 * through whole landing cycles: TrunkDO over a Durable Object's storage, with only the network steps stood in for, as
 * writer.ts does, here with a trunk that holds a symbolic link.
 */

interface Internals {
  pullBlobs(p: Proposal): Promise<Map<Path, number>>;
  pushChain(chain: unknown): Promise<{ ok: true }>;
  notesSoon(): Promise<void>;
  rebuildIndex(head: Sha): Promise<void>;
  repo(): GitRepo;
}

const TRUNK: RepoRef = { namespace: "ft-trunk", name: "structure--trunk", remote: "https://artifacts.invalid/structure--trunk.git" };
let seq = 0;

/** A trunk writer whose trunk holds `files` (text and mode) and `gitlinks` (submodules: path to commit id). */
async function withTrunk(
  files: Record<Path, { text: string; mode?: string }>,
  fn: (w: Writer, mode: (path: Path) => string | null, g: GitRepo) => Promise<void>,
  gitlinks: Record<Path, Sha> = {},
): Promise<void> {
  const name = `structure-${Date.now()}-${++seq}`;
  const colonyId = `col_structure_${seq}`;
  await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(name)), async (_instance: unknown, state: DurableObjectState) => {
    const trunk = new TrunkDO(state, {} as never);
    const t = trunk as unknown as Internals;
    const meta = (key: string, value: string): void => void state.storage.sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", key, value);
    meta("colony_id", colonyId);
    meta("trunk", JSON.stringify(TRUNK));
    const g = t.repo();
    await ensureRepo(g, TRUNK.remote);
    const tree = new Map<Path, { blob: Sha; mode: string }>();
    for (const [path, f] of Object.entries(files)) tree.set(path, { blob: await writeLocalBlob(g, new TextEncoder().encode(f.text)), mode: f.mode ?? "100644" });
    for (const [path, commit] of Object.entries(gitlinks)) tree.set(path, { blob: commit, mode: "160000" });
    const head = await writeCommitObject(g, { tree: await buildTree(g, tree), parents: [], message: "init\n", at: Date.now() });
    await setRef(g, "refs/heads/main", head);
    await t.rebuildIndex(head);
    t.pullBlobs = async (p) => {
      const sizes = new Map<Path, number>();
      for (const w of p.writeSet) if (w.blob !== null) sizes.set(w.path, (await readLocalBlob(g, w.blob)).length);
      return sizes;
    };
    t.pushChain = async () => ({ ok: true });
    t.notesSoon = async () => undefined;
    const mode = (path: Path): string | null => state.storage.sql.exec<{ mode: string }>("SELECT mode FROM ft_files WHERE path = ?", path).toArray()[0]?.mode ?? null;
    await fn(new Writer(trunk, g, state, colonyId), mode, g);
  });
}

/** The tree entry at `path` in commit `sha`, submodules included (trunk's index lists none). */
async function entryAt(g: GitRepo, sha: Sha, path: Path): Promise<{ oid: string; mode: string } | null> {
  let oid = await commitTree(g, sha);
  const parts = path.split("/");
  for (let i = 0; oid !== null && i < parts.length; i++) {
    const e = (await readTreeEntries(g, oid)).find((x) => x.path === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return { oid: e.oid, mode: e.mode };
    oid = e.type === "tree" ? e.oid : null;
  }
  return null;
}

const FILES = {
  "config/current": { text: "production.json", mode: "120000" },
  "config/production.json": { text: "{}\n" },
  "README.md": { text: "# structure\n" },
};

describe("the trunk writer and symbolic links", () => {
  it("returns a change that would retarget a trunk link, and trunk keeps the link as it was", async () => {
    await withTrunk(FILES, async (w, mode) => {
      expect(mode("config/current")).toBe("120000");
      const head = w.head();
      const retarget = await w.proposal({ "config/current": "../../.ssh/id_ed25519" });
      const r = await w.land(retarget);
      expect(r.returned).toEqual([{ proposalId: retarget.id, reason: expect.stringContaining("config/current is a symbolic link in trunk, and a change cannot change where it points") }]);
      expect(w.head()).toBe(head);
      // Deleting the link lands; a regular file written there later is a regular file.
      landed(await w.land(await w.proposal({ "config/current": null })));
      landed(await w.land(await w.proposal({ "config/current": "production\n" })));
      expect(mode("config/current")).toBe("100644");
    });
  });

  it("returns the write in a cycle where another change deletes the link first, rather than making its text a link", async () => {
    await withTrunk(FILES, async (w, mode) => {
      const drop = await w.proposal({ "config/current": null });
      const write = await w.proposal({ "config/current": "/etc/passwd" });
      const r = await w.land(drop, write);
      expect(r.returned.map((x) => x.proposalId)).toEqual([write.id]);
      expect(mode("config/current")).toBeNull();
    });
  });
});

describe("the trunk writer and second spellings of one file", () => {
  it("returns a new path that is a trunk file on a case-insensitive file system, and lands a rename by case", async () => {
    await withTrunk(FILES, async (w) => {
      const twin = await w.proposal({ "readme.md": "# twin\n" });
      expect((await w.land(twin)).returned).toEqual([{ proposalId: twin.id, reason: expect.stringContaining("readme.md differs from the trunk file README.md only in letter case") }]);
      expect(w.has("readme.md")).toBe(false);
      landed(await w.land(await w.proposal({ "README.md": null, "Readme.md": "# structure\n" })));
      expect(w.has("Readme.md")).toBe(true);
      expect(w.has("README.md")).toBe(false);
    });
  });

  it("of two changes in one cycle adding one file under two spellings, the first lands and the later is refused next cycle", async () => {
    await withTrunk(FILES, async (w) => {
      const first = await w.proposal({ "docs/Notes.md": "a\n" });
      const later = await w.proposal({ "docs/NOTES.md": "b\n" });
      const r = await w.land(first, later);
      expect(r.landing?.proposalIds).toEqual([first.id]);
      expect(r.deferred).toEqual([{ proposalId: later.id, reason: expect.stringContaining("docs/NOTES.md differs only in letter case or Unicode form from docs/Notes.md") }]);
      const again = await w.land(later);
      expect(again.returned).toEqual([{ proposalId: later.id, reason: expect.stringContaining("differs from the trunk file docs/Notes.md") }]);
      expect(w.has("docs/NOTES.md")).toBe(false);
    });
  });

  it("refuses a .git path in any spelling at its shape check", async () => {
    await withTrunk(FILES, async (w) => {
      const hidden = await w.proposal({ "vendor/.G\u200Bit/config": "[core]\n" });
      expect((await w.land(hidden)).returned).toEqual([{ proposalId: hidden.id, reason: expect.stringContaining("touches .git") }]);
    });
  });
});

describe("the trunk writer and submodules", () => {
  const SUB = "c".repeat(40);
  const TREE = { "vendor/README.md": { text: "# vendor\n" }, "src/a.ts": { text: "export const a = 1;\n" } };
  const NOT = "FireTrident does not change submodules. Leave it out of the change.";

  it("returns a write to a submodule, a write inside one and a deletion of one, and trunk keeps the submodule", async () => {
    await withTrunk(
      TREE,
      async (w, _mode, g) => {
        const head = w.head();
        const file = await w.proposal({ "vendor/lib": "now a file\n" });
        const inside = await w.proposal({ "vendor/lib/src/x.ts": "export const x = 1;\n" });
        const gone = await w.proposal({ "vendor/lib": null });
        const r = await w.land(file, inside, gone);
        expect(r.returned).toEqual([
          { proposalId: file.id, reason: `This change writes vendor/lib, which is a submodule in trunk; ${NOT}` },
          { proposalId: inside.id, reason: `This change writes vendor/lib/src/x.ts, which is inside the submodule vendor/lib in trunk; ${NOT}` },
          { proposalId: gone.id, reason: `This change deletes vendor/lib, which is a submodule in trunk; ${NOT}` },
        ]);
        expect(r.landing).toBeUndefined();
        expect(w.head()).toBe(head);
        expect(await entryAt(g, w.head(), "vendor/lib")).toEqual({ oid: SUB, mode: "160000" });
      },
      { "vendor/lib": SUB },
    );
  });

  it("lands ordinary files beside a submodule, which stays as it was", async () => {
    await withTrunk(
      TREE,
      async (w, _mode, g) => {
        const beside = landed(await w.land(await w.proposal({ "vendor/README.md": "# vendored code\n", "vendor/libs.md": "lib\n", "src/a.ts": "export const a = 2;\n" })));
        expect(beside.paths).toEqual(["src/a.ts", "vendor/README.md", "vendor/libs.md"]);
        expect(await entryAt(g, w.head(), "vendor/lib")).toEqual({ oid: SUB, mode: "160000" });
        expect(w.has("vendor/libs.md")).toBe(true);
      },
      { "vendor/lib": SUB },
    );
  });
});
