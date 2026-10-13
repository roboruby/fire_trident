import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addAgent, addIntent, colony, newColony, take, trunk } from "./helpers.ts";

/**
 * Import repulsion in ColonyDO.take: with FT_IMPORT_WEIGHT set, a claim on a file that a
 * candidate's files import, or on a file that imports them, repels the candidate (TrunkDO.importLinks,
 * each such file at weight 1 times FT_IMPORT_WEIGHT). Off, it never asks the trunk. Self-assignment
 * is deterministic in these tests (the best candidate is always accepted).
 */

/** Set FT_IMPORT_WEIGHT on one colony's object, as a deployment variable would. */
async function importWeight(colonyId: string, value: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const self = instance as unknown as { env: object };
    self.env = new Proxy(self.env, { get: (t, k) => (k === "FT_IMPORT_WEIGHT" ? value : Reflect.get(t, k)) });
  });
}

/** src/app/main.ts imports src/lib/util.ts, as TrunkDO's import index answers it. */
const LINKS = {
  "src/app/main.ts": { imports: ["src/lib/util.ts"], importers: [] },
  "src/lib/util.ts": { imports: [], importers: ["src/app/main.ts"] },
};

/** A colony with util (priority 5), main (3) and docs (`docs`), and two agents. */
async function setup(weight: string | null, docs = 2.5) {
  const c = await newColony();
  if (weight !== null) await importWeight(c.id, weight);
  await trunk(c.id).setImports(LINKS);
  const util = await addIntent(c.id, ["src/lib/util.ts"], { priority: 5 });
  const main = await addIntent(c.id, ["src/app/main.ts"], { priority: 3 });
  const guide = await addIntent(c.id, ["docs/guide.md"], { priority: docs });
  const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
  return { c, util, main, guide, a, b };
}

describe("import repulsion", () => {
  it("is off without FT_IMPORT_WEIGHT and never asks the trunk", async () => {
    const { c, util, main, a, b } = await setup(null);
    expect((await take(c.id, a.id)).intent.id).toBe(util.id);
    expect((await take(c.id, b.id)).intent.id).toBe(main.id);
    expect((await trunk(c.id).state()).importCalls ?? 0).toBe(0);
  });

  it("is off at weight 0, or at anything that is not a positive number, and never asks the trunk", async () => {
    for (const weight of ["0", "off", "-1"]) {
      const { c, util, main, a, b } = await setup(weight);
      expect((await take(c.id, a.id)).intent.id).toBe(util.id);
      expect((await take(c.id, b.id)).intent.id).toBe(main.id);
      expect((await trunk(c.id).state()).importCalls ?? 0, `weight ${weight}`).toBe(0);
    }
  });

  it("at weight 1, steers a take away from an intent whose file imports a claimed file", async () => {
    const { c, util, guide, a, b } = await setup("1");
    expect((await take(c.id, a.id)).intent.id).toBe(util.id);
    // main.ts imports the claimed util.ts: 3 - 1 * claim < 2.5, so docs wins.
    expect((await take(c.id, b.id)).intent.id).toBe(guide.id);
  });

  it("at weight 1, steers a take away from an intent whose file a claimed file imports", async () => {
    const c = await newColony();
    await importWeight(c.id, "1");
    await trunk(c.id).setImports(LINKS);
    const main = await addIntent(c.id, ["src/app/main.ts"], { priority: 5 });
    await addIntent(c.id, ["src/lib/util.ts"], { priority: 3 });
    const guide = await addIntent(c.id, ["docs/guide.md"], { priority: 2.5 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(main.id);
    // Landing util.ts would make the reads of the agent working on main.ts stale.
    expect((await take(c.id, b.id)).intent.id).toBe(guide.id);
  });

  it("scales with the weight", async () => {
    const one = await setup("1", 1.5);
    await take(one.c.id, one.a.id);
    expect((await take(one.c.id, one.b.id)).intent.id).toBe(one.main.id);
    const two = await setup("2", 1.5);
    await take(two.c.id, two.a.id);
    expect((await take(two.c.id, two.b.id)).intent.id).toBe(two.guide.id);
  });

  it("reads the claims of importers in other regions", async () => {
    const c = await newColony();
    await importWeight(c.id, "1");
    await trunk(c.id).setImports({
      "docs/example.ts": { imports: ["src/lib/util.ts"], importers: [] },
      "src/lib/util.ts": { imports: [], importers: ["docs/example.ts"] },
    });
    const example = await addIntent(c.id, ["docs/example.ts"], { priority: 5 });
    await addIntent(c.id, ["src/lib/util.ts"], { priority: 3 });
    const readme = await addIntent(c.id, ["README.md"], { priority: 2.5 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(example.id);
    expect((await take(c.id, b.id)).intent.id).toBe(readme.id);
  });

  it("only repels: an intent whose import is claimed is still taken when nothing else is open", async () => {
    const c = await newColony();
    await importWeight(c.id, "1");
    await trunk(c.id).setImports(LINKS);
    const util = await addIntent(c.id, ["src/lib/util.ts"], { priority: 5 });
    const main = await addIntent(c.id, ["src/app/main.ts"], { priority: 3 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(util.id);
    expect((await take(c.id, b.id)).intent.id).toBe(main.id);
  });

  it("fails open when the trunk cannot answer", async () => {
    const c = await newColony();
    await importWeight(c.id, "1");
    await trunk(c.id).setImports("fail");
    await addIntent(c.id, ["src/lib/util.ts"], { priority: 5 });
    const main = await addIntent(c.id, ["src/app/main.ts"], { priority: 3 });
    await addIntent(c.id, ["docs/guide.md"], { priority: 2.5 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    await take(c.id, a.id);
    const t0 = Date.now();
    expect((await take(c.id, b.id)).intent.id).toBe(main.id);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("asks the trunk once per batch of files and caches the links between takes", async () => {
    const { c, a, b } = await setup("1");
    await take(c.id, a.id);
    await take(c.id, b.id);
    expect((await trunk(c.id).state()).importCalls).toBe(1);
  });
});
