import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot, Id, Intent } from "@fire_trident/core";
import { addAgent, api, colony, newColony, take } from "./helpers.ts";

/**
 * Twin intents caught at declare through the real ColonyDO (FT_TWINS): a person's or an agent's intent whose title
 * words and footprint match an intent the colony has open, claimed, proposed or landed in the last 30 minutes is not
 * created; the answer is that intent with duplicateOf, similar and a note (REST 200), and force: true creates it anyway.
 * Rule intents, certification repairs and the colony's own intents are never checked, and with the flag off
 * everything is as before.
 */

type TwinBody = Intent & { duplicateOf?: Id; similar?: Array<{ id: Id; title: string; status: string; score: number }>; note?: string };

/** Set FT_TWINS on one colony's object, as a deployment variable would. */
async function twins(colonyId: string, value: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const self = instance as unknown as { env: object };
    self.env = new Proxy(self.env, { get: (t, k) => (k === "FT_TWINS" ? value : Reflect.get(t, k)) });
  });
}

/** Mark an intent landed `ago` minutes ago, as the colony records a landing. */
async function landedAgo(colonyId: string, intentId: Id, ago: number): Promise<void> {
  await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState) => {
    state.storage.sql.exec("UPDATE intents SET status = 'landed', updated_at = ? WHERE id = ?", Date.now() - ago * 60_000, intentId);
  });
}

/** POST /intents with a title, a footprint and anything else. */
function declare(colonyId: string, title: string, footprint: string[], extra: Record<string, unknown> = {}) {
  return api<TwinBody>("POST", `/colonies/${colonyId}/intents`, { title, why: "twins check", footprint, ...extra });
}

/** The colony's intents with this title. */
async function titled(colonyId: string, title: string): Promise<Intent[]> {
  const snap = await api<ColonySnapshot>("GET", `/colonies/${colonyId}`);
  return snap.body.intents.filter((i) => i.title === title);
}

const FIRST = "Add rate limiting to /api/links";
const TWIN = "Rate-limit the links API";

/** A colony with FT_TWINS set to `setting` (none when null) and the first intent declared. */
async function setup(setting: string | null | ((colonyId: string) => string) = "on") {
  const c = await newColony();
  if (setting !== null) await twins(c.id, typeof setting === "function" ? setting(c.id) : setting);
  const first = await declare(c.id, FIRST, ["src/links/**"]);
  expect(first.status).toBe(201);
  return { c, first: first.body };
}

describe("twin intents at declare", () => {
  it("answers a twin with the existing intent, duplicateOf, similar and a note, and creates nothing", async () => {
    const { c, first } = await setup();
    const twin = await declare(c.id, TWIN, ["src/links/handler.ts"]);
    expect(twin.status).toBe(200);
    expect(twin.body).toMatchObject({ id: first.id, title: FIRST, status: "open", footprint: ["src/links/**"], duplicateOf: first.id });
    expect(twin.body.similar).toEqual([{ id: first.id, title: FIRST, status: "open", score: 1 }]);
    expect(twin.body.note).toBe(`This looks like ${first.id} "${FIRST}" (open): take that one, or declare again with force: true if yours is different work.`);
    expect(await titled(c.id, TWIN)).toEqual([]);

    // Taken by an agent: the answer says so.
    const agent = await addAgent(c.id);
    expect((await take(c.id, agent.id)).intent.id).toBe(first.id);
    const held = await declare(c.id, "Rate limit for the links api", ["src/links/"]);
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ duplicateOf: first.id, status: "claimed", similar: [{ id: first.id, status: "claimed", score: 1 }] });
    expect(held.body.note).toMatch(/\(claimed\): an agent is already on it, so leave it to them, or declare again with force: true/);
  });

  it("creates the intent when only the title matches", async () => {
    const { c } = await setup();
    const res = await declare(c.id, TWIN, ["src/users/handler.ts", "README.md"]);
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("duplicateOf");
    expect(await titled(c.id, TWIN)).toHaveLength(1);
  });

  it("creates the intent when only the footprint matches", async () => {
    const { c } = await setup();
    for (const title of ["Add caching to /api/links", "Remove rate limiting from /api/links", "Rate-limit the links API for anonymous callers"]) {
      const res = await declare(c.id, title, ["src/links/handler.ts"]);
      expect(res.status, title).toBe(201);
    }
  });

  it("creates it anyway with force: true", async () => {
    const { c, first } = await setup();
    const res = await declare(c.id, TWIN, ["src/links/handler.ts"], { force: true });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(first.id);
    expect(res.body).not.toHaveProperty("duplicateOf");
    expect(await titled(c.id, TWIN)).toHaveLength(1);
  });

  it("counts an intent landed in the last 30 minutes, and not one landed earlier", async () => {
    const recent = await setup();
    await landedAgo(recent.c.id, recent.first.id, 29);
    const caught = await declare(recent.c.id, TWIN, ["src/links/handler.ts"]);
    expect(caught.status).toBe(200);
    expect(caught.body).toMatchObject({ duplicateOf: recent.first.id, status: "landed" });
    expect(caught.body.note).toMatch(/\(landed\): it landed in the last 30 minutes, so read trunk first/);

    const old = await setup();
    await landedAgo(old.c.id, old.first.id, 31);
    expect((await declare(old.c.id, TWIN, ["src/links/handler.ts"])).status).toBe(201);
  });

  it("never checks rule intents, certification repairs or the colony's own intents", async () => {
    const { c, first } = await setup();
    const rule = await declare(c.id, TWIN, ["src/links/handler.ts"], { source: "rule" });
    expect(rule.status).toBe(201);
    expect(rule.body).toMatchObject({ source: "rule" });
    const stub = colony(c.id);
    for (const source of ["certify", "system"] as const) {
      const res = await stub.declareIntent({ colonyId: c.id, title: TWIN, why: "w", source, footprint: ["src/links/handler.ts"], priority: 1, createdBy: source });
      expect(res, source).not.toHaveProperty("duplicateOf");
      expect(res.intent.source).toBe(source);
    }
    // An agent's declare through the same door is checked.
    const agent = await stub.declareIntent({ colonyId: c.id, title: TWIN, why: "w", source: "agent", footprint: ["src/links/handler.ts"], priority: 1, createdBy: "agt_x" });
    expect(agent).toMatchObject({ duplicateOf: first.id });
  });

  it("never answers with the declared intent's own parent", async () => {
    const { c, first } = await setup();
    const child = await declare(c.id, TWIN, ["src/links/handler.ts"], { parentId: first.id });
    expect(child.status).toBe(201);
    expect(child.body.parentId).toBe(first.id);
  });

  it("is off without FT_TWINS, and on only for the colonies it lists", async () => {
    for (const [setting, on] of [
      [null, false],
      ["off", false],
      ["some-other-colony", false],
      [(id: string) => `x, ${id}`, true],
    ] as const) {
      const { c, first } = await setup(setting);
      const res = await declare(c.id, TWIN, ["src/links/handler.ts"]);
      expect(res.status, String(setting)).toBe(on ? 200 : 201);
      if (on) expect(res.body.duplicateOf).toBe(first.id);
      else expect(Object.keys(res.body).sort(), String(setting)).toEqual(Object.keys(first).sort());
    }
  });
});
