import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot, Id } from "@fire_trident/core";
import type { ModelHint } from "../../src/colony/stepup.ts";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, api, colony, newColony, take } from "./helpers.ts";

/**
 * Model step-up through the real ColonyDO (FT_MODEL_STEPUP): when an intent's changes came back twice since it last
 * changed course, its next take asks for the stronger model class and says why; a landing or a substantive amendment
 * starts the count again, changes of direction do not count, and a third return still reaches the needs-you strip.
 */

/** Set FT_MODEL_STEPUP on one colony's object, as a deployment variable would. */
async function stepup(colonyId: string, value: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const self = instance as unknown as { env: object };
    self.env = new Proxy(self.env, { get: (t, k) => (k === "FT_MODEL_STEPUP" ? value : Reflect.get(t, k)) });
  });
}

/** Store a past outcome of a change for the intent, as the colony keeps it. */
async function past(colonyId: string, intentId: Id, id: string, status: string, at: number, reason?: string): Promise<void> {
  const data = { id, colonyId, intentId, agentId: "agt_past", status, createdAt: at, writeSet: [{ path: "src/lib/util.ts", blob: "1".repeat(40) }], readSet: [], declared: { footprint: ["src/lib/util.ts"], summary: "past" }, evidence: { checks: [] }, ...(reason ? { reason } : {}) };
  await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState) => {
    state.storage.sql.exec(
      "INSERT INTO proposals (id, intent_id, agent_id, status, region, priority, created_at, updated_at, data) VALUES (?, ?, 'agt_past', ?, 'src', 1, ?, ?, ?)",
      id,
      intentId,
      status,
      at,
      at + 500,
      JSON.stringify(data),
    );
  });
}

const hintOf = (a: Assignment): ModelHint | undefined => (a as Assignment & { model?: ModelHint }).model;

/** A colony with the step-up set to `setting` (none when null) and an intent whose changes came back `returns` times. */
async function setup(setting: string | null | ((colonyId: string) => string), returns: number) {
  const c = await newColony();
  if (setting !== null) await stepup(c.id, typeof setting === "function" ? setting(c.id) : setting);
  const i = await addIntent(c.id, ["src/lib/util.ts"]);
  for (let n = 0; n < returns; n++) await past(c.id, i.id, `prp_back${n}`, "returned", 1_000 + n * 1_000, "stale: 1 path changed on trunk since read: src/lib/util.ts");
  return { c, i };
}

describe("model step-up at take", () => {
  it("asks for the stronger model class once the intent's changes came back twice, and says why", async () => {
    const one = await setup("on", 1);
    expect(hintOf(await take(one.c.id, (await addAgent(one.c.id)).id))).toBeUndefined();
    const two = await setup("on", 2);
    const got = await take(two.c.id, (await addAgent(two.c.id)).id);
    expect(got.intent.id).toBe(two.i.id);
    expect(hintOf(got)).toEqual({ model: "default", returns: 2, reason: "Changes for this intent came back 2 times since it last changed course, so this attempt asks for the stronger model class (default)." });
  });

  it("is off without FT_MODEL_STEPUP, and on only for the colonies it lists", async () => {
    for (const [setting, on] of [
      [null, false],
      ["off", false],
      ["some-other-colony", false],
      [(id: string) => `x, ${id}`, true],
    ] as const) {
      const { c } = await setup(setting, 2);
      expect(hintOf(await take(c.id, (await addAgent(c.id)).id)) !== undefined, String(setting)).toBe(on);
    }
  });

  it("starts again after a landing or a substantive amendment, and leaves changes of direction out", async () => {
    const landed = await setup("on", 2);
    await past(landed.c.id, landed.i.id, "prp_landed", "landed", 5_000);
    expect(hintOf(await take(landed.c.id, (await addAgent(landed.c.id)).id))).toBeUndefined();

    const amended = await setup("on", 2);
    expect((await api("PATCH", `/colonies/${amended.c.id}/intents/${amended.i.id}`, { why: "Return two, not one", reason: "clearer" })).status).toBe(200);
    expect(hintOf(await take(amended.c.id, (await addAgent(amended.c.id)).id))).toBeUndefined();

    const redirected = await setup("on", 1);
    await past(redirected.c.id, redirected.i.id, "prp_withdrawn", "returned", 5_000, "withdrawn: rule rul_1 retracted");
    await past(redirected.c.id, redirected.i.id, "prp_recalled", "returned", 6_000, "superseded: recalled by its agent");
    expect(hintOf(await take(redirected.c.id, (await addAgent(redirected.c.id)).id))).toBeUndefined();
  });

  it("keeps asking after a third return, which still reaches the needs-you strip", async () => {
    const { c, i } = await setup("on", 3);
    expect(hintOf(await take(c.id, (await addAgent(c.id)).id))).toMatchObject({ model: "default", returns: 3 });
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.stuck?.items.find((s) => s.kind === "returns")).toMatchObject({ intentId: i.id, returns: 3 });
  });
});
