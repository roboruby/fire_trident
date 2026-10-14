import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { LineageNote, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import { buildTree, ensureRepo, readLocalBlob, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import { env } from "./helpers.ts";
import { Writer, landed } from "./writer.ts";

/**
 * Text merge's insertion rule (FT_MERGE_INSERTIONS) in the real trunk writer: two changes from the same trunk that each
 * append a line at the end of one file both land, the second as the union of the two appends, with `rule: "insertions"`
 * in its landing's merged entry and its lineage note, and the cycle counts it. Without the rule the second goes back
 * naming the hunk. Only the network steps are stood in for (as in writer.ts).
 */

interface Internals {
  pullBlobs(p: Proposal): Promise<Map<Path, number>>;
  pushChain(chain: unknown): Promise<{ ok: true }>;
  notesSoon(): Promise<void>;
  rebuildIndex(head: Sha): Promise<void>;
  repo(): GitRepo;
}

const F = "src/values.ts";
const SEED = Array.from({ length: 12 }, (_, i) => `export const v${i + 1} = ${i + 1};\n`).join("");
const TRUNK: RepoRef = { namespace: "ft-trunk", name: "insertions--trunk", remote: "https://artifacts.invalid/insertions--trunk.git" };
let seq = 0;

/** A trunk writer whose trunk holds F at SEED, with `vars` as its settings; the metric events it publishes are kept. */
async function withWriter(
  vars: Record<string, string | undefined>,
  fn: (w: Writer, read: { blob(path: Path): Sha; text(path: Path): Promise<string>; note(landingId: string): LineageNote; metrics: Array<{ name: string; value: number }> }) => Promise<void>,
): Promise<void> {
  const name = `merge-insertions-${Date.now()}-${++seq}`;
  const colonyId = `col_insertions_${seq}`;
  const metrics: Array<{ name: string; value: number }> = [];
  // The colony the cycle's metrics go to.
  const COLONY = { idFromName: () => "colony", get: () => ({ emit: async (events: Array<{ name: string; value: number }>) => void metrics.push(...events) }) };
  await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(name)), async (_instance: unknown, state: DurableObjectState) => {
    const writer = new TrunkDO(state, { ...vars, COLONY } as never);
    const t = writer as unknown as Internals;
    const meta = (key: string, value: string): void => void state.storage.sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", key, value);
    meta("colony_id", colonyId);
    meta("trunk", JSON.stringify(TRUNK));
    const g = t.repo();
    await ensureRepo(g, TRUNK.remote);
    const tree = new Map<Path, { blob: Sha; mode: string }>([[F, { blob: await writeLocalBlob(g, new TextEncoder().encode(SEED)), mode: "100644" }]]);
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
    const blob = (path: Path): Sha => state.storage.sql.exec<{ blob: string }>("SELECT blob FROM ft_files WHERE path = ?", path).one().blob;
    await fn(new Writer(writer, g, state, colonyId), {
      blob,
      text: async (path) => new TextDecoder().decode(await readLocalBlob(g, blob(path))),
      note: (landingId) => JSON.parse(state.storage.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", landingId).one().note) as LineageNote,
      metrics,
    });
  });
}

/** Wait for the cycle's metrics, which the writer publishes in the background. */
async function settled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

describe("the insertion rule in the trunk writer (FT_MERGE_INSERTIONS)", () => {
  it("lands both appends from one trunk, the second as their union, recording the rule and counting it", async () => {
    await withWriter({ FT_TEXT_MERGE: "on", FT_MERGE_INSERTIONS: "on" }, async (w, r) => {
      const base = r.blob(F);
      const a = await w.proposal({ [F]: `${SEED}export const a = "a";\n` });
      const b = await w.proposal({ [F]: `${SEED}export const b = "b";\n` });
      const la = landed(await w.land(a));
      const A = r.blob(F);
      const lb = landed(await w.land(b));
      const text = `${SEED}export const a = "a";\nexport const b = "b";\n`;
      const merged = blobId(text);
      expect(await r.text(F)).toBe(text);
      expect(lb.parentSha).toBe(la.trunkSha);
      expect(lb.merged).toEqual([{ proposalId: b.id, path: F, blob: merged, rule: "insertions" }]);
      expect(r.note(lb.id).proposals[0]!.merged).toEqual([{ path: F, base, trunk: A, theirs: b.writeSet[0]!.blob, result: merged, rule: "insertions" }]);
      const cycles = await w.cycles();
      expect(cycles.map((c) => [c.merged, c.insertions])).toEqual([
        [undefined, undefined],
        [1, 1],
      ]);
      await settled();
      expect(r.metrics.filter((m) => m.name === "trunk.mergedInsertions")).toEqual([expect.objectContaining({ value: 1 })]);
      expect(r.metrics.filter((m) => m.name === "trunk.merged")).toEqual([expect.objectContaining({ value: 1 })]);
    });
  });

  it("off, or on for another colony only: the second append goes back naming the hunk, as before", async () => {
    for (const setting of [undefined, "off", "col_other"]) {
      await withWriter({ FT_TEXT_MERGE: "on", FT_MERGE_INSERTIONS: setting }, async (w, r) => {
        const base = r.blob(F);
        const a = await w.proposal({ [F]: `${SEED}export const a = "a";\n` });
        const b = await w.proposal({ [F]: `${SEED}export const b = "b";\n` });
        landed(await w.land(a));
        const A = r.blob(F);
        expect(await w.land(b)).toEqual({ returned: [{ proposalId: b.id, reason: `stale: ${F} (expected ${base}, trunk has ${A}); text merge of ${F}: 1 conflicting hunk, at line 13 of its base` }] });
        expect(r.blob(F)).toBe(A);
        await settled();
        expect(r.metrics.some((m) => m.name === "trunk.mergedInsertions")).toBe(false);
      });
    }
  });

  it("on: a change that also edits a line trunk edited goes back, naming both hunks", async () => {
    await withWriter({ FT_TEXT_MERGE: "on", FT_MERGE_INSERTIONS: "on" }, async (w, r) => {
      const a = await w.proposal({ [F]: `${SEED.replace("v1 = 1", "v1 = 10")}export const a = "a";\n` });
      const b = await w.proposal({ [F]: `${SEED.replace("v1 = 1", "v1 = 11")}export const b = "b";\n` });
      landed(await w.land(a));
      const A = r.blob(F);
      const back = await w.land(b);
      expect(back.landing).toBeUndefined();
      expect(back.returned[0]!.reason).toMatch(/; text merge of src\/values\.ts: 2 conflicting hunks, at lines 1 and 13 of its base$/);
      expect(r.blob(F)).toBe(A);
    });
  });

  it("does nothing without text merge itself", async () => {
    await withWriter({ FT_MERGE_INSERTIONS: "on" }, async (w, r) => {
      const base = r.blob(F);
      const a = await w.proposal({ [F]: `${SEED}export const a = "a";\n` });
      const b = await w.proposal({ [F]: `${SEED}export const b = "b";\n` });
      landed(await w.land(a));
      const A = r.blob(F);
      expect(await w.land(b)).toEqual({ returned: [{ proposalId: b.id, reason: `stale: ${F} (expected ${base}, trunk has ${A})` }] });
    });
  });
});
