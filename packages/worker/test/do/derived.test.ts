import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Intent, Landing, Path } from "@fire_trident/core";
import type { LandedWhy } from "../../src/agents/landed.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, colony, newColony, proposal, proposeEdit, take, tick, trunk } from "./helpers.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * Derived indexes (trunk/derived.ts) in the real objects: the trunk writer's (the import index, path history, the
 * co-change map) through whole landing cycles (writer.ts), and the colony's landing path index behind why-context.
 */

const FILES: Record<Path, string> = {
  "src/lib/fresh.ts": "export const fresh = 1;\n",
  "src/app/main.ts": "console.log(1);\n",
  "README.md": "# derived\n",
};

/** The trunk writer's storage, which writer.ts keeps private. */
function storageOf(w: { trunk: TrunkDO }): DurableObjectState {
  return (w as unknown as { state: DurableObjectState }).state;
}

describe("derived indexes in the trunk writer", () => {
  it("applies the import index in the landing hook, answers path history when read, and resumes both after a restart", async () => {
    await withWriter(FILES, undefined, async (w) => {
      const one = await w.proposal({ "src/app/main.ts": "console.log(2);\n", "src/lib/fresh.ts": "export const fresh = 2;\n" });
      const l1 = landed(await w.land(one));
      const two = await w.proposal({ "src/app/main.ts": "console.log(3);\n" });
      const l2 = landed(await w.land(two));
      expect(await w.trunk.derivedStats()).toEqual([
        { name: "imports", mode: "eager", version: 1, stored: 1, seq: 2, head: 2, behind: 0 },
        { name: "path-history", mode: "lazy", version: 1, stored: null, seq: 0, head: 2, behind: 2 },
        { name: "cochange", mode: "lazy", version: 1, stored: null, seq: 0, head: 2, behind: 2 },
      ]);
      // The import index was never read (its weight and the deletion guard are off): nothing was built for it.
      expect(w.indexed()).toBe(false);

      const history = await w.trunk.pathHistory("src/app/main.ts");
      expect(history).toEqual({
        behind: 0,
        entries: [
          { landingId: l2.id, trunkSha: l2.trunkSha, at: l2.at, blob: two.writeSet[0]!.blob, proposalId: two.id, intentId: two.intentId, agentId: "agt_test", title: two.id },
          { landingId: l1.id, trunkSha: l1.trunkSha, at: l1.at, blob: one.writeSet[0]!.blob, proposalId: one.id, intentId: one.intentId, agentId: "agt_test", title: one.id },
        ],
      });

      // A new object over the same storage resumes every cursor: it applies only the landing after them.
      const state = storageOf(w);
      const again = new TrunkDO(state, {} as never);
      const three = await w.proposal({ "src/app/main.ts": "console.log(4);\n" });
      const l3 = landed(await w.land(three));
      expect((await again.derivedStats()).map((s) => [s.name, s.seq, s.behind])).toEqual([
        ["imports", 3, 0],
        ["path-history", 2, 1],
        ["cochange", 0, 3],
      ]);
      expect((await again.pathHistory("src/app/main.ts", 1)).entries.map((e) => e.landingId)).toEqual([l3.id]);
      const rows = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ft_path_history").one().n;
      expect(rows).toBe(4);
    });
  });

  it("learns landings into the co-change map on read once mining is settled, and rebuilds path history on a version change", async () => {
    await withWriter(FILES, undefined, async (w) => {
      const pair = await w.proposal({ "src/app/main.ts": "console.log(2);\n", "src/lib/fresh.ts": "export const fresh = 2;\n" });
      landed(await w.land(pair));
      const t = w.trunk as unknown as { mining: Promise<void> | null };
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        // The first read starts mining history (no Artifacts here, so it fails and is recorded); landings wait for it.
        expect(await w.trunk.neighbors(["src/app/main.ts"])).toEqual({});
        await t.mining;
      } finally {
        error.mockRestore();
      }
      expect((await w.trunk.neighbors(["src/app/main.ts"]))["src/app/main.ts"]!.map((n) => n.path)).toEqual(["src/lib/fresh.ts"]);
      expect(await w.trunk.cochangeStats()).toMatchObject({ landingSeq: 1, proposalsLearned: 1, mined: { state: expect.stringMatching(/^failed/) } });

      // A new version of path history: the next read forgets it and builds it again from the whole log.
      const state = storageOf(w);
      await w.trunk.pathHistory("src/app/main.ts");
      state.storage.sql.exec("UPDATE ft_derived SET version = 0 WHERE name = 'path-history'");
      state.storage.sql.exec("INSERT INTO ft_path_history (path, seq, proposal_id, intent_id, agent_id, title) VALUES ('src/app/main.ts', 1, 'prp_stale', NULL, NULL, 'stale')");
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        expect(await w.trunk.pathHistory("src/app/main.ts")).toMatchObject({ behind: 0, entries: [{ proposalId: pair.id }] });
      } finally {
        log.mockRestore();
      }
      expect((await w.trunk.derivedStats()).find((s) => s.name === "path-history")).toMatchObject({ stored: 1, seq: 1, behind: 0 });
    });
  });

  it("forgets every derived index with a replaced trunk, and keeps working after the object is erased", async () => {
    await withWriter(FILES, undefined, async (w) => {
      landed(await w.land(await w.proposal({ "src/app/main.ts": "console.log(2);\n" })));
      expect((await w.trunk.pathHistory("src/app/main.ts")).entries).toHaveLength(1);
      const state = storageOf(w);
      const count = (table: string): number => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
      expect(count("ft_cc_meta")).toBe(0);
      (w.trunk as unknown as { cochange(): { markMined(state: string, at: number): void } }).cochange().markMined("skipped", Date.now());
      (w.trunk as unknown as { reset(): void }).reset();
      expect([count("ft_path_history"), count("ft_cc_meta"), count("ft_landings")]).toEqual([0, 0, 0]);
      expect((await w.trunk.derivedStats()).map((s) => [s.name, s.stored, s.seq, s.behind])).toEqual([
        ["imports", 1, 0, 0],
        ["path-history", 1, 0, 0],
        ["cochange", 1, 0, 0],
      ]);
      await w.trunk.destroy();
      expect((await w.trunk.derivedStats()).map((s) => [s.name, s.stored, s.seq])).toEqual([
        ["imports", null, 0],
        ["path-history", null, 0],
        ["cochange", null, 0],
      ]);
    });
  });
});

type Taken = Assignment & { context?: LandedWhy[] };

/** Take the intent, propose new content for its footprint and land it through the src lane. */
async function landChange(colonyId: string, intent: Intent, agentId: string): Promise<Landing> {
  const got = await take(colonyId, agentId);
  expect(got.intent.id).toBe(intent.id);
  const p = await proposeEdit(colonyId, got, agentId);
  await tick(colonyId, "src");
  expect((await proposal(colonyId, p.id)).status).toBe("landed");
  const landings = (await trunk(colonyId).state()).landings;
  return landings[landings.length - 1]!;
}

/** Run SQL in the colony's storage. */
async function colonySql<T>(colonyId: string, query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(colony(colonyId), (_i, state: DurableObjectState) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
}

/** Make the colony read its path index's cursor again at the next take, as after a restart. */
async function forgetReady(colonyId: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    (instance as unknown as { landedIndexReady: boolean }).landedIndexReady = false;
  });
}

/** Two landings on src/lib/util.ts, and a third intent on it to take. */
async function twoLandings(between?: (colonyId: string) => Promise<void>) {
  const c = await newColony();
  const a = await addAgent(c.id, "a");
  const i1 = await addIntent(c.id, ["src/lib/util.ts"], { title: "First", why: "one" });
  const l1 = await landChange(c.id, i1, a.id);
  if (between) await between(c.id);
  const i2 = await addIntent(c.id, ["src/lib/util.ts"], { title: "Second", why: "two" });
  const l2 = await landChange(c.id, i2, a.id);
  await addIntent(c.id, ["src/lib/util.ts"], { title: "Third" });
  return { c, a, l1, l2 };
}

describe("the colony's landing path index as a derived index", () => {
  it("is applied as each landing arrives, with its cursor at the newest landing", async () => {
    const { c, a, l1, l2 } = await twoLandings();
    expect(await colonySql(c.id, "SELECT name, version, seq FROM ft_derived")).toEqual([{ name: "landing-paths", version: 1, seq: 2 }]);
    const got = (await take(c.id, a.id)) as Taken;
    expect(got.context!.map((e) => [e.landingId, e.title])).toEqual([
      [l2.id, "Second"],
      [l1.id, "First"],
    ]);
  });

  it("adopts an index kept before cursors existed at the next landing, and applies that landing", async () => {
    const { c, a, l1, l2 } = await twoLandings(async (id) => {
      await colonySql(id, "DELETE FROM ft_derived");
    });
    expect(await colonySql(c.id, "SELECT name, seq FROM ft_derived")).toEqual([{ name: "landing-paths", seq: 2 }]);
    expect(((await take(c.id, a.id)) as Taken).context!.map((e) => e.landingId)).toEqual([l2.id, l1.id]);
  });

  it("leaves a landing to the next take when it finds the index behind, which applies the log in order", async () => {
    const { c, a, l1, l2 } = await twoLandings(async (id) => {
      // As if applying the first landing had failed: its cursor never moved.
      await colonySql(id, "UPDATE ft_derived SET seq = 0");
    });
    expect(await colonySql(c.id, "SELECT landing_id FROM landing_paths")).toEqual([{ landing_id: l1.id }]);
    const got = (await take(c.id, a.id)) as Taken;
    expect(got.context!.map((e) => e.landingId)).toEqual([l2.id, l1.id]);
    expect(await colonySql(c.id, "SELECT seq FROM ft_derived")).toEqual([{ seq: 2 }]);
    expect(await colonySql(c.id, "SELECT COUNT(*) AS n FROM landing_paths")).toEqual([{ n: 2 }]);
  });

  it("rebuilds the index from the landing log when its version changes", async () => {
    const { c, a, l1, l2 } = await twoLandings();
    await colonySql(c.id, "UPDATE ft_derived SET version = 0");
    await colonySql(c.id, "INSERT INTO landing_paths (path, at, landing_id, intent_id) VALUES ('src/lib/util.ts', ?, 'lnd_stale', NULL)", Date.now() + 60_000);
    await forgetReady(c.id);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let got: Taken;
    try {
      got = (await take(c.id, a.id)) as Taken;
    } finally {
      log.mockRestore();
    }
    expect(got.context!.map((e) => e.landingId)).toEqual([l2.id, l1.id]);
    expect(await colonySql(c.id, "SELECT version, seq FROM ft_derived")).toEqual([{ version: 1, seq: 2 }]);
  });
});
