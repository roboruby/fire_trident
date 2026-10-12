import { describe, expect, it } from "vitest";
import { addAgent, addIntent, newColony, take, trunk } from "./helpers.ts";

/**
 * Co-change repulsion in ColonyDO.take: a claim on a file also repels work on the files that
 * change with it (TrunkDO.neighbors), weighted by coupling and COCHANGE_WEIGHT (2). Self-assignment
 * is deterministic in these tests (the best candidate is always accepted).
 */
describe("co-change repulsion", () => {
  it("steers a take away from the neighbors of a claimed file", async () => {
    const c = await newColony();
    await trunk(c.id).setNeighbors({
      "src/app/main.ts": [{ path: "src/lib/util.ts", weight: 0.9 }],
      "src/lib/util.ts": [{ path: "src/app/main.ts", weight: 0.9 }],
    });
    const util = await addIntent(c.id, ["src/lib/util.ts"], { priority: 5 });
    await addIntent(c.id, ["src/app/main.ts"], { priority: 3 });
    const docs = await addIntent(c.id, ["docs/guide.md"], { priority: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(util.id);
    // main.ts changes with the claimed util.ts: 3 - 2 * 0.9 * claim < 2, so docs wins.
    expect((await take(c.id, b.id)).intent.id).toBe(docs.id);
  });

  it("takes the coupled intent when the map has no neighbors", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"], { priority: 5 });
    const main = await addIntent(c.id, ["src/app/main.ts"], { priority: 3 });
    await addIntent(c.id, ["docs/guide.md"], { priority: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    await take(c.id, a.id);
    expect((await take(c.id, b.id)).intent.id).toBe(main.id);
  });

  it("reads neighbor claims in other regions", async () => {
    const c = await newColony();
    await trunk(c.id).setNeighbors({ "src/app/main.ts": [{ path: "docs/guide.md", weight: 0.8 }] });
    const docs = await addIntent(c.id, ["docs/guide.md"], { priority: 5 });
    await addIntent(c.id, ["src/app/main.ts"], { priority: 3 });
    const readme = await addIntent(c.id, ["README.md"], { priority: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(docs.id);
    expect((await take(c.id, b.id)).intent.id).toBe(readme.id);
  });

  it("fails open when the trunk cannot answer", async () => {
    const c = await newColony();
    await trunk(c.id).setNeighbors("fail");
    await addIntent(c.id, ["src/lib/util.ts"], { priority: 5 });
    const main = await addIntent(c.id, ["src/app/main.ts"], { priority: 3 });
    await addIntent(c.id, ["docs/guide.md"], { priority: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    await take(c.id, a.id);
    const t0 = Date.now();
    expect((await take(c.id, b.id)).intent.id).toBe(main.id);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("caches neighbors between takes", async () => {
    const c = await newColony();
    await trunk(c.id).setNeighbors({ "src/app/main.ts": [{ path: "src/lib/util.ts", weight: 0.9 }] });
    await addIntent(c.id, ["src/lib/util.ts"], { priority: 5 });
    await addIntent(c.id, ["src/app/main.ts"], { priority: 3 });
    await addIntent(c.id, ["docs/guide.md"], { priority: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    await take(c.id, a.id);
    await take(c.id, b.id);
    expect((await trunk(c.id).state()).neighborCalls).toBe(1);
  });
});
