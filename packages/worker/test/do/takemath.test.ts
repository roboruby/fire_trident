import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TakeResult } from "../../src/colony/ColonyDO.ts";
import { addAgent, addIntent, api, colony, newColony, region, take } from "./helpers.ts";

/**
 * The review's two fixes to take(), each behind its flag (colony/takemath.ts): FT_INHIBIT_STRONGEST makes lateral
 * inhibition read the strongest single file's claim instead of the sum, and FT_AGE_CAP stops the age multiplier at core
 * AGE_FACTOR_CAP. Off (absent), take() behaves as before. Self-assignment is deterministic in these tests.
 */
const MIN = 60_000;
const INHIBITED = "every open intent's files are claimed by another agent";
const FILES = ["src/app/s1.ts", "src/app/s2.ts", "src/app/s3.ts"];

async function tryTake(colonyId: string, agentId: string): Promise<TakeResult> {
  const res = await api<TakeResult>("POST", `/colonies/${colonyId}/agents/${agentId}/take`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Set one of the colony's env variables (only this colony's object sees it). */
async function setVar(colonyId: string, name: string, value: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const self = instance as unknown as { env: object };
    self.env = new Proxy(self.env, { get: (t, k) => (k === name ? value : Reflect.get(t, k)) });
  });
}

async function sql(colonyId: string, query: string, ...args: unknown[]): Promise<void> {
  await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState) => void state.storage.sql.exec(query, ...args).toArray());
}

/** A silent agent's claims on `paths`, last refreshed `ageMs` ago. */
async function ghostClaims(colonyId: string, agentId: string, paths: string[], ageMs: number): Promise<void> {
  const at = Date.now() - ageMs;
  await region(colonyId, "src").deposit(paths.map((path) => ({ kind: "claim" as const, path, strength: 1, at, agentId, intentId: `int_${agentId}` })));
}

describe("FT_INHIBIT_STRONGEST", () => {
  it("off: a silent agent's decayed claims on three files still inhibit together (0.41 each, 1.22 summed)", async () => {
    const c = await newColony();
    await addIntent(c.id, FILES, { priority: 4 });
    const b = await addAgent(c.id, "b");
    await ghostClaims(c.id, "agt_ghost", FILES, 4.5 * MIN);
    expect(await tryTake(c.id, b.id)).toMatchObject({ wait: true, reason: INHIBITED });
  });

  it("on: the same claims inhibit no longer than one file's claim would, so the intent is taken", async () => {
    const c = await newColony();
    await setVar(c.id, "FT_INHIBIT_STRONGEST", c.id);
    const y = await addIntent(c.id, FILES, { priority: 4 });
    const b = await addAgent(c.id, "b");
    await ghostClaims(c.id, "agt_ghost", FILES, 4.5 * MIN);
    expect((await take(c.id, b.id)).intent.id).toBe(y.id);
  });

  it("on: claims of several agents on one file still add up on that file", async () => {
    const c = await newColony();
    await setVar(c.id, "FT_INHIBIT_STRONGEST", "on");
    await addIntent(c.id, FILES, { priority: 4 });
    const b = await addAgent(c.id, "b");
    await ghostClaims(c.id, "agt_ghost1", [FILES[0]!], 4.5 * MIN);
    await ghostClaims(c.id, "agt_ghost2", [FILES[0]!], 4.5 * MIN);
    expect(await tryTake(c.id, b.id)).toMatchObject({ wait: true, reason: INHIBITED });
  });

  it("on: a fresh claim on one of the files still inhibits", async () => {
    const c = await newColony();
    await setVar(c.id, "FT_INHIBIT_STRONGEST", "on");
    const x = await addIntent(c.id, [FILES[0]!, "src/app/a.ts"], { priority: 5 });
    await addIntent(c.id, [FILES[0]!, "src/app/b.ts"], { priority: 4 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(x.id);
    expect(await tryTake(c.id, b.id)).toMatchObject({ wait: true, reason: INHIBITED });
  });
});

describe("FT_AGE_CAP", () => {
  /** A takes a directory intent (its claim repels everything under src/app/ by 1), then an old and a fresh intent open. */
  async function setup(flag: string | null): Promise<{ colonyId: string; old: string; fresh: string; b: string }> {
    const c = await newColony();
    if (flag !== null) await setVar(c.id, "FT_AGE_CAP", flag);
    const dir = await addIntent(c.id, ["src/app/"], { priority: 9 });
    const a = await addAgent(c.id, "a");
    expect((await take(c.id, a.id)).intent.id).toBe(dir.id);
    const old = await addIntent(c.id, ["src/app/old.ts"], { priority: 1 });
    await sql(c.id, "UPDATE intents SET created_at = ? WHERE id = ?", Date.now() - 600 * MIN, old.id);
    const fresh = await addIntent(c.id, ["docs/fresh.md"], { priority: 4 });
    const b = await addAgent(c.id, "b");
    return { colonyId: c.id, old: old.id, fresh: fresh.id, b: b.id };
  }

  it("off: ten hours of age outweigh the repulsion (1 * 61 - 1 = 60 against 4)", async () => {
    const s = await setup(null);
    expect((await take(s.colonyId, s.b)).intent.id).toBe(s.old);
  });

  it("on: the multiplier stops at the cap, so the repelled old intent ranks under a fresh one (4 - 1 = 3 against 4)", async () => {
    const s = await setup("on");
    expect((await take(s.colonyId, s.b)).intent.id).toBe(s.fresh);
  });
});
