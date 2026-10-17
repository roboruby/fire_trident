import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentInfo, IntentLifecycle } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, newColony, proposeEdit, take, tick } from "./helpers.ts";

/**
 * GET /colonies/:id/intents/:iid/lifecycle on the real ColonyDO: a public read of an intent's strip, from declared to
 * merged by a person, computed from what the colony records, and where a change left the path.
 */

const NO_TOKEN = {};

async function lifecycle(colonyId: string, intentId: string): Promise<IntentLifecycle> {
  const res = await api<IntentLifecycle>("GET", `/colonies/${colonyId}/intents/${intentId}/lifecycle`, undefined, NO_TOKEN);
  expect(res.status).toBe(200);
  return res.body;
}

const states = (l: IntentLifecycle) => l.current.steps.map((s) => `${s.key}:${s.state}`);

describe("an intent's lifecycle", () => {
  it("follows a change from declared to landed, without a token, and never marks the forge's steps done", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/life.ts"], { createdBy: "lee", source: "human" });
    const before = await lifecycle(c.id, i.id);
    expect([before.current.reached, before.changes]).toEqual(["declared", []]);
    expect(before.current.steps[0]).toMatchObject({ state: "done", text: "lee (a person)", link: { kind: "intent", id: i.id } });

    const a = await addAgent(c.id, "lander");
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    await tick(c.id, "src");
    const l = await eventually(
      () => lifecycle(c.id, i.id),
      (x) => x.current.reached === "landed",
    );
    expect(l).toMatchObject({ colonyId: c.id, intentId: i.id, caption: "FireTrident lands to its own trunk and never merges into your repository; the last two steps happen in your forge." });
    expect(l.current.proposalId).toBe(p.id);
    expect(states(l)).toEqual(["declared:done", "claimed:done", "proposed:done", "confirmed:done", "landed:done", "certified:todo", "taken-back:outside", "merged:outside"]);
    expect(l.current.steps[1]?.text).toBe("lander (bench agent)");
    expect(l.current.steps[4]?.link).toMatchObject({ kind: "landing" });
    // The harness runs no certification: the step says why it is not certified.
    expect(l.current.steps[5]?.text).toBe("not certified yet: trunk certification is off on this deployment");
    expect(l.current.steps[6]).toMatchObject({ text: "outside FireTrident: push certified as a branch and open a pull request", command: "git push <your-origin> certified:refs/heads/firetrident/certified" });
  });

  it("shows where a change left the path: escalated, then returned", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/esc.ts"]);
    const a = await addAgent(c.id, "bouncer");
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    await colony(c.id).updateProposal(p.id, { status: "escalated", reason: "escalated by llm: touches the session code" });
    const waiting = await lifecycle(c.id, i.id);
    expect(waiting.current.off).toMatchObject({ kind: "escalated", after: "proposed", text: "waiting for a person: escalated by llm: touches the session code", link: { kind: "proposal", id: p.id } });
    await colony(c.id).updateProposal(p.id, { status: "returned", reason: "llm: the change does not do what the intent asks" });
    const back = await lifecycle(c.id, i.id);
    expect(back.changes[0]?.off).toMatchObject({ kind: "returned", label: "Returned", text: "llm: the change does not do what the intent asks" });
  });

  it("shows an intent the colony took back from a silent agent as reaped", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/walk.ts"]);
    const res = await api<AgentInfo>("POST", `/colonies/${c.id}/agents`, { name: "walker", kind: "external" });
    const w = res.body;
    await take(c.id, w.id);
    await runInDurableObject(colony(c.id), (instance, state) => {
      state.storage.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", Date.now() - 11 * 60_000, w.id);
      (instance as unknown as { lastReap: number }).lastReap = 0;
    });
    await api("GET", `/colonies/${c.id}/metrics`);
    const l = await eventually(
      () => lifecycle(c.id, i.id),
      (x) => x.current.off?.kind === "reaped",
    );
    expect(l.current.off).toMatchObject({ kind: "reaped", after: "claimed" });
    expect(l.current.off?.text).toMatch(/^the colony took it back: walker was silent for 11 min( \d+ s)?; it is open for the next agent$/);
    expect(l.current.steps[1]).toMatchObject({ state: "done", text: "walker (outside agent)" });
  });

  it("answers 404 for an unknown intent or colony, and takes no writes", async () => {
    const c = await newColony();
    expect((await api("GET", `/colonies/${c.id}/intents/int_nope/lifecycle`, undefined, NO_TOKEN)).status).toBe(404);
    expect((await api("GET", "/colonies/no-such-colony/intents/int_1/lifecycle", undefined, NO_TOKEN)).status).toBe(404);
    expect((await api("POST", `/colonies/${c.id}/intents/int_1/lifecycle`, {})).status).toBe(404);
  });
});
