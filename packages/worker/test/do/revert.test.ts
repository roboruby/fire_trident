import { describe, expect, it } from "vitest";
import type { ColonyEvent, Intent, Landing } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, newColony, proposal, proposeEdit, take, tick, trunk } from "./helpers.ts";

type Reverted = { landing: Landing; reverted: Landing; redo: string[] };

/** One intent on `path`, taken by `agentId`, proposed and landed through the lane; returns its landing id. */
async function landOn(colonyId: string, agentId: string, path: string): Promise<{ intent: Intent; landingId: string }> {
  const intent = await addIntent(colonyId, [path]);
  const p = await proposeEdit(colonyId, await take(colonyId, agentId), agentId);
  expect(await tick(colonyId, "src")).toBe(true);
  const landed = await proposal(colonyId, p.id);
  expect(landed.status).toBe("landed");
  return { intent, landingId: landed.landingId! };
}

describe("revert", () => {
  it("undoes a landing as a new trunk commit, brings its intent back, and records who and why", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const original = (await trunk(c.id).state()).files["src/lib/util.ts"]!.content;
    const { intent, landingId } = await landOn(c.id, a.id, "src/lib/util.ts");
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]!.content).not.toBe(original);

    const res = await api<Reverted>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "breaks the helper", by: "matt" });
    expect(res.status).toBe(200);
    expect(res.body.reverted.id).toBe(landingId);
    expect(res.body.landing.paths).toEqual(["src/lib/util.ts"]);
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]!.content).toBe(original);
    expect((await colony(c.id).getColony())!.trunkSha).toBe(res.body.landing.trunkSha);

    // The intent comes back as a new one: parent is the reverted intent, the why starts with the reason.
    expect(res.body.redo).toHaveLength(1);
    const redo = (await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${res.body.redo[0]}`)).body.intent;
    expect(redo).toMatchObject({ status: "open", parentId: intent.id, source: "human", createdBy: "matt", footprint: ["src/lib/util.ts"], title: `Redo after revert: ${intent.title}` });
    expect(redo.why.startsWith(`matt reverted ${landingId} (`)).toBe(true);
    expect(redo.why).toContain("breaks the helper");

    const events = (await api<{ events: ColonyEvent[] }>("GET", `/colonies/${c.id}/events?limit=5000`)).body.events;
    expect(events.find((e) => e.t === "reverted")).toMatchObject({ of: landingId, landingId: res.body.landing.id, by: "matt", reason: "breaks the helper", redo: res.body.redo, paths: ["src/lib/util.ts"] });
    expect(events.some((e) => e.t === "landing" && e.landingId === res.body.landing.id)).toBe(true);

    // A revert can itself be undone, by the commit it made; --no-redo declares nothing.
    const again = await api<Reverted>("POST", `/colonies/${c.id}/landings/${res.body.landing.trunkSha.slice(0, 10)}/revert`, { reason: "it was fine", redo: false });
    expect(again.status).toBe(200);
    expect(again.body.redo).toEqual([]);
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]!.content).not.toBe(original);
  });

  it("refuses when work landed on top, naming the path and the landing, and changes nothing", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const first = await landOn(c.id, a.id, "src/lib/util.ts");
    const second = await landOn(c.id, a.id, "src/lib/util.ts");
    const head = (await trunk(c.id).state()).head;
    const res = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/${first.landingId}/revert`, { reason: "too early" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`work landed on top of ${first.landingId}: src/lib/util.ts changed since by ${second.landingId}`);
    expect((await trunk(c.id).state()).head).toBe(head);
    const events = (await api<{ events: ColonyEvent[] }>("GET", `/colonies/${c.id}/events?limit=5000`)).body.events;
    expect(events.some((e) => e.t === "reverted")).toBe(false);
  });

  it("needs a reason, a known landing and the operator token", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/landings/lnd_nope/revert`, { reason: "" })).status).toBe(400);
    const missing = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/lnd_nope/revert`, { reason: "r" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("no landing lnd_nope");
    expect((await api("POST", `/colonies/${c.id}/landings/lnd_nope/revert`, { reason: "r" }, {})).status).toBe(401);
  });
});
