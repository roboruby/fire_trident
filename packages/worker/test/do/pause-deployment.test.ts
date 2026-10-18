import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, PauseState } from "@fire_trident/core";
import { deploymentPause, pauseDeployment, resumeDeployment } from "../../src/api/pause.ts";
import { addAgent, addIntent, api, env, newColony, proposeEdit, proposal, take, tick } from "./helpers.ts";

/**
 * The deployment-wide pause (api/pause.ts): the registry instance of ColonyDO keeps the record, every registered
 * colony is told at once and reads it again within seconds by itself; it holds every colony, including one created
 * after it, until a person resumes; a colony paused on its own stays paused when the deployment resumes. Every test
 * resumes the deployment before it ends, whatever happens.
 */

const sentence = (by: string, reason: string) => `Agents are paused in this colony by ${by}: ${reason}. Reads still work; wait for a person to resume.`;

async function events(colonyId: string): Promise<Array<Record<string, unknown>>> {
  const page = await api<{ events: Array<ColonyEvent & { seq: number }> }>("GET", `/colonies/${colonyId}/events?source=recorded`);
  return page.body.events.filter((e) => e.t === "paused" || e.t === "resumed").map(({ seq: _seq, at: _at, ...e }) => e);
}

// One retry: under a full-suite load these tests can run out of time; alone they pass.
describe("pausing the whole deployment", { retry: 1 }, () => {
  it("holds every colony's agents and lanes, a new colony too, until a person resumes", async () => {
    const one = await newColony();
    const two = await newColony();
    const a = await addAgent(one.id, "a");
    const b = await addAgent(two.id, "b");
    await addIntent(one.id, ["src/lib/util.ts"]);
    await addIntent(two.id, ["src/lib/util.ts"]);
    const got = await take(one.id, a.id);
    const p = await proposeEdit(one.id, got, a.id);
    try {
      const res = await api<{ pause: PauseState; already: boolean; colonies: { total: number; told: number; failed: unknown[] } }>("POST", "/pause", { reason: "spend check", by: "ops" });
      expect(res.status).toBe(201);
      expect(res.body.pause).toMatchObject({ scope: "deployment", by: "ops", reason: "spend check" });
      expect(res.body.colonies.failed).toEqual([]);
      expect(res.body.colonies.told).toBeGreaterThanOrEqual(2);
      expect((await api("POST", "/pause", { reason: "again", by: "lee" })).body).toMatchObject({ already: true, pause: { by: "ops", reason: "spend check" } });
      expect((await api("GET", "/pause", undefined, {})).body).toEqual({ pause: res.body.pause });
      expect(await deploymentPause(env)).toEqual(res.body.pause);

      const no = sentence("ops", "spend check");
      expect(await api("POST", `/colonies/${two.id}/agents/${b.id}/take`)).toEqual({ status: 409, body: { error: no } });
      expect((await api<ColonySnapshot>("GET", `/colonies/${one.id}`)).body.pauses).toEqual([res.body.pause]);
      // The lane holds what waited in it.
      await tick(one.id, "src");
      expect((await proposal(one.id, p.id)).status).toBe("ready");
      // A colony created after the pause began reads it from the registry.
      const three = await newColony();
      // A synthetic agent is platform-run: refused while paused; an external one joins (it can still read).
      expect(await api("POST", `/colonies/${three.id}/agents`, { name: "c", kind: "synthetic" })).toEqual({ status: 409, body: { error: no } });
      expect((await api("POST", `/colonies/${three.id}/agents`, { name: "visitor", kind: "external" })).status).toBe(201);
      expect((await api("POST", `/colonies/${three.id}/intents`, { title: "t", why: "w", footprint: ["src/a.ts"], source: "agent" })).body).toEqual({ error: no });
      expect(await events(one.id)).toEqual([{ t: "paused", scope: "deployment", by: "ops", reason: "spend check" }]);
      expect(await events(three.id)).toEqual([{ t: "paused", scope: "deployment", by: "ops", reason: "spend check" }]);
    } finally {
      const back = await api<{ resumed: unknown; colonies: { failed: unknown[] } }>("POST", "/resume", { by: "ops" });
      expect(back.status).toBe(200);
    }
    expect(await deploymentPause(env)).toBeNull();
    expect((await take(two.id, b.id)).intent).toBeDefined();
    await tick(one.id, "src");
    expect((await proposal(one.id, p.id)).status).toBe("landed");
    expect((await events(one.id)).map((e) => e.t)).toEqual(["paused", "resumed"]);
    expect((await api("POST", "/resume", { by: "ops" })).body).toMatchObject({ already: true, resumed: null });
  });

  it("keeps a colony's own pause when the deployment resumes, and the other way round", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    await addIntent(c.id, ["src/lib/util.ts"]);
    try {
      await pauseDeployment(env, { reason: "budget", by: "spend cap" });
      expect((await api("POST", `/colonies/${c.id}/pause`, { reason: "demo", by: "maya" })).status).toBe(201);
      // The colony's own pause comes first in what agents are told.
      expect(await api("POST", `/colonies/${c.id}/agents/${a.id}/take`)).toEqual({ status: 409, body: { error: sentence("maya", "demo") } });
      const back = await resumeDeployment(env, { by: "ops" });
      expect(back).toMatchObject({ already: false, resumed: { scope: "deployment", by: "ops", paused: false } });
      expect(await api("POST", `/colonies/${c.id}/agents/${a.id}/take`)).toEqual({ status: 409, body: { error: sentence("maya", "demo") } });
      await pauseDeployment(env, { reason: "budget again", by: "spend cap" });
      const own = await api<{ pauses: PauseState[] }>("POST", `/colonies/${c.id}/resume`, { by: "maya" });
      expect(own.body.pauses).toMatchObject([{ scope: "deployment", by: "spend cap", reason: "budget again" }]);
      expect(await api("POST", `/colonies/${c.id}/agents/${a.id}/take`)).toEqual({ status: 409, body: { error: sentence("spend cap", "budget again") } });
    } finally {
      await resumeDeployment(env, { by: "ops" });
    }
    expect((await take(c.id, a.id)).intent).toBeDefined();
  });

  it("needs the admin token and a reason", async () => {
    expect((await api("POST", "/pause", { reason: "x" }, {})).status).toBe(401);
    expect((await api("POST", "/resume", {}, {})).status).toBe(401);
    expect((await api("POST", "/pause", {})).status).toBe(400);
    expect((await api("GET", "/pause", undefined, {})).body).toEqual({ pause: null });
  });
});
