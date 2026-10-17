import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentInfo, ClosureReport, EventsPage, FieldReading, Intent, IntentClosure } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, newColony, proposeEdit, region, take, tick } from "./helpers.ts";

/**
 * The closure ledger (colony/closure.ts) on the real ColonyDO: every close or reopen of an intent an agent held is
 * recorded with its cause, the agent and the gap since its last sign of life; the reaper leaves a failure mark and takes
 * the colony's own silent-agent limit; the metrics report gives the shares per agent kind.
 */

const MIN = 60_000;

async function external(colonyId: string, name = "byo"): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "external" });
  expect(res.status).toBe(201);
  return res.body;
}

async function history(colonyId: string, intentId: string): Promise<{ intent: Intent; closures?: IntentClosure[] }> {
  const res = await api<{ intent: Intent; closures?: IntentClosure[] }>("GET", `/colonies/${colonyId}/intents/${intentId}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function closures(colonyId: string): Promise<ClosureReport> {
  return (await api<{ closures: ClosureReport }>("GET", `/colonies/${colonyId}/metrics`)).body.closures;
}

/** Make an agent look silent for `ms` and let the reaper look again at its next call. */
async function silence(colonyId: string, agentId: string, ms: number): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance, state) => {
    state.storage.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", Date.now() - ms, agentId);
    (instance as unknown as { lastReap: number }).lastReap = 0;
  });
}

/** The intent events of the record that carry a cause. */
async function caused(colonyId: string): Promise<Array<Record<string, unknown>>> {
  const page = (await api<EventsPage>("GET", `/colonies/${colonyId}/events?source=recorded`)).body;
  return page.events.filter((e) => e.t === "intent" && "cause" in e && e.cause !== undefined) as unknown as Array<Record<string, unknown>>;
}

describe("the closure ledger", () => {
  it("records landed, released, gave_up, escalated, withdrawn, returned and stopped with the agent and its kind", async () => {
    const c = await newColony();
    // Each case in its own region, so admission never turns a take away, and handed to its agent, so no take picks another
    // case's reopened intent.
    // landed: a synthetic agent's change lands.
    const landed = await addIntent(c.id, ["src/landed.ts"]);
    const s = await addAgent(c.id, "lander");
    await proposeEdit(c.id, await take(c.id, s.id), s.id);
    await tick(c.id, "src");
    const lh = await history(c.id, landed.id);
    expect(lh.intent.status).toBe("landed");
    expect(lh.closures?.[0]).toMatchObject({ cause: "landed", status: "landed", agentId: s.id, agentKind: "synthetic" });
    expect(lh.intent.closure).toMatchObject({ cause: "landed", agentId: s.id });

    // released: an outside agent gives it back (MCP release); its own call, so no gap.
    const x = await external(c.id, "releaser");
    const released = await addIntent(c.id, ["rel/released.md"], { assignedTo: x.id });
    await take(c.id, x.id);
    await colony(c.id).abandon(x.id, "not for me", "released");
    expect((await history(c.id, released.id)).closures?.[0]).toEqual({ cause: "released", at: expect.any(Number), status: "open", agentId: x.id, agentKind: "external", gapMs: 0 });

    // gave_up: the agent loop's own give-up; a caller that names no cause gets the kind's (synthetic: gave_up).
    const g = await addAgent(c.id, "quitter");
    const gaveUp = await addIntent(c.id, ["gup/gaveup.md"], { assignedTo: g.id });
    await take(c.id, g.id);
    await colony(c.id).abandon(g.id, "gave up at edit after 4 attempts");
    expect((await history(c.id, gaveUp.id)).closures?.[0]).toMatchObject({ cause: "gave_up", agentKind: "synthetic", gapMs: 0 });

    // escalated: the agent reports it to a person.
    const r = await external(c.id, "reporter");
    const reported = await addIntent(c.id, ["esc/reported.md"], { assignedTo: r.id });
    await take(c.id, r.id);
    await colony(c.id).escalate(r.id, { kind: "broken-test", report: "The test expects 2 and the spec says 3." });
    expect((await history(c.id, reported.id)).closures?.[0]).toMatchObject({ cause: "escalated", status: "open", agentId: r.id, gapMs: 0 });

    // withdrawn: a person calls it off while an agent holds it.
    const w = await external(c.id, "holder");
    const withdrawn = await addIntent(c.id, ["wd/withdrawn.md"], { assignedTo: w.id });
    await take(c.id, w.id);
    expect((await api("POST", `/colonies/${c.id}/intents/${withdrawn.id}/withdraw`, { reason: "not needed", by: "matt" })).status).toBe(200);
    const wh = await history(c.id, withdrawn.id);
    expect(wh.closures?.[0]).toMatchObject({ cause: "withdrawn", status: "withdrawn", agentId: w.id, agentKind: "external" });
    expect(wh.closures?.[0]?.gapMs).toBeGreaterThanOrEqual(0);

    // returned: review sends the holder's change back.
    const b = await addAgent(c.id, "bounced");
    const returned = await addIntent(c.id, ["docs/returned.md"], { assignedTo: b.id });
    const p = await proposeEdit(c.id, await take(c.id, b.id), b.id);
    await colony(c.id).updateProposal(p.id, { status: "returned", reason: "llm: the change does not do what the intent asks" });
    expect((await history(c.id, returned.id)).closures?.[0]).toMatchObject({ cause: "returned", status: "open", agentId: b.id });

    // stopped: a person stops the agent that holds it.
    const st = await external(c.id, "stopped");
    const stopped = await addIntent(c.id, ["stp/stopped.md"], { assignedTo: st.id });
    await take(c.id, st.id);
    expect((await api("POST", `/colonies/${c.id}/agents/${st.id}/stop`, { reason: "enough" })).status).toBe(200);
    expect((await history(c.id, stopped.id)).closures?.[0]).toMatchObject({ cause: "stopped", status: "open", agentId: st.id });

    // Every close went on the record's intent event too, with the same cause and agent.
    const events = await caused(c.id);
    expect(new Set(events.map((e) => e.cause))).toEqual(new Set(["landed", "released", "gave_up", "escalated", "withdrawn", "returned", "stopped"]));
    expect(events.find((e) => e.cause === "released")).toMatchObject({ intentId: released.id, status: "open", agentId: x.id, agentKind: "external", gapMs: 0 });

    // The metrics report's shares per agent kind.
    const m = await closures(c.id);
    expect(m.total).toBe(7);
    expect(m.byKind.external).toMatchObject({ total: 4, counts: { released: 1, escalated: 1, withdrawn: 1, stopped: 1 }, shares: { released: 0.25, escalated: 0.25 } });
    expect(m.byKind.synthetic).toMatchObject({ total: 3, counts: { landed: 1, gave_up: 1, returned: 1 } });
    expect(m.byKind.synthetic?.shares.landed).toBeCloseTo(1 / 3, 4);
    expect(m.reaped).toEqual({ count: 0, medianGapMs: null, maxGapMs: null });
    expect(m).toMatchObject({ silentTtlMs: 10 * MIN, silentTtlDefault: true });
  });

  it("the reaper takes an intent back from a silent agent with reaped_silent, the gap and a failure mark", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/walk.ts"]);
    const a = await external(c.id, "walker");
    await take(c.id, a.id);
    await silence(c.id, a.id, 11 * MIN);
    // Any call that reaps (here the metrics report) reopens it.
    await api("GET", `/colonies/${c.id}/metrics`);
    const h = await eventually(
      () => history(c.id, i.id),
      (x) => x.intent.status === "open",
    );
    const closure = h.closures?.[0];
    expect(closure).toMatchObject({ cause: "reaped_silent", status: "open", agentId: a.id, agentKind: "external" });
    expect(closure?.gapMs).toBeGreaterThanOrEqual(11 * MIN);
    expect(closure?.gapMs).toBeLessThan(12 * MIN);
    // The failure mark an abandon leaves, on the intent's file.
    const field = await eventually(
      async () => (await region(c.id, "src").reading()) as FieldReading,
      (r) => (r.byPath["src/lib/walk.ts"]?.failure ?? 0) > 0,
    );
    expect(field.byPath["src/lib/walk.ts"]!.failure).toBeCloseTo(0.5, 2);
    expect(field.byPath["src/lib/walk.ts"]!.claim).toBeUndefined();
    // The next taker sees why the intent came back.
    const b = await addAgent(c.id, "second");
    const again = await take(c.id, b.id);
    expect(again.intent.id).toBe(i.id);
    expect(again.intent.closure).toMatchObject({ cause: "reaped_silent", agentId: a.id });
    const e = (await caused(c.id)).find((x) => x.cause === "reaped_silent");
    expect(e).toMatchObject({ intentId: i.id, status: "open", agentId: a.id, agentKind: "external" });
    expect(e?.gapMs).toBeGreaterThanOrEqual(11 * MIN);
    const m = await closures(c.id);
    expect(m.byKind.external).toMatchObject({ total: 1, counts: { reaped_silent: 1 }, shares: { reaped_silent: 1 } });
    expect(m.reaped.count).toBe(1);
    expect(m.reaped.medianGapMs).toBe(closure?.gapMs);
  });

  it("the silent-agent limit is the colony's: ten minutes by default, set by a person, never under ten for in-platform agents", async () => {
    const c = await newColony();
    expect((await api("GET", `/colonies/${c.id}/silent-ttl`, undefined, {})).body).toMatchObject({ colonyId: c.id, ms: 10 * MIN, seconds: 600, default: true, inPlatformMs: 10 * MIN });

    // The default is as before: an agent silent for five minutes keeps its intent.
    const kept = await addIntent(c.id, ["docs/kept.md"]);
    const k = await external(c.id, "patient");
    await take(c.id, k.id);
    await silence(c.id, k.id, 5 * MIN);
    await api("GET", `/colonies/${c.id}/metrics`);
    expect((await history(c.id, kept.id)).intent.status).toBe("claimed");

    // Only a person sets it, within the bounds.
    expect((await api("POST", `/colonies/${c.id}/silent-ttl`, { seconds: 90 }, {})).status).toBe(401);
    const tooShort = await api<{ error: string }>("POST", `/colonies/${c.id}/silent-ttl`, { seconds: 30 });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error).toMatch(/seconds must be a number from 60 to 86400/);
    expect((await api("POST", `/colonies/${c.id}/silent-ttl`, { minutes: 2 })).status).toBe(400);
    const set = await api<Record<string, unknown>>("POST", `/colonies/${c.id}/silent-ttl`, { seconds: 90, by: "matt" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ms: 90_000, seconds: 90, default: false, inPlatformMs: 10 * MIN, setBy: "matt" });
    expect(set.body.note).toMatch(/silent for 90 s loses its claimed intents.*In-platform agents keep 10 min/);
    expect((await closures(c.id)).silentTtlMs).toBe(90_000);

    // At 90 s: an outside agent silent for 100 s loses its intent; a synthetic one keeps the ten minutes.
    const outside = await addIntent(c.id, ["docs/outside.md"]);
    const o = await external(c.id, "walker");
    await take(c.id, o.id);
    const inside = await addIntent(c.id, ["docs/inside.md"]);
    const s = await addAgent(c.id, "steady");
    await take(c.id, s.id);
    await silence(c.id, o.id, 100_000);
    await silence(c.id, s.id, 100_000);
    await api("GET", `/colonies/${c.id}/metrics`);
    const oh = await history(c.id, outside.id);
    expect(oh.intent.status).toBe("open");
    expect(oh.closures?.[0]).toMatchObject({ cause: "reaped_silent", agentId: o.id });
    expect(oh.closures?.[0]?.gapMs).toBeGreaterThanOrEqual(100_000);
    expect((await history(c.id, inside.id)).intent.status).toBe("claimed");
    // The patient agent from before has now been silent past 90 s too.
    expect((await history(c.id, kept.id)).intent.status).toBe("open");
    await silence(c.id, s.id, 11 * MIN);
    await api("GET", `/colonies/${c.id}/metrics`);
    expect((await history(c.id, inside.id)).closures?.[0]).toMatchObject({ cause: "reaped_silent", agentId: s.id, agentKind: "synthetic" });

    // Back to the default.
    const reset = await api<Record<string, unknown>>("POST", `/colonies/${c.id}/silent-ttl`, { seconds: null });
    expect(reset.body).toMatchObject({ ms: 10 * MIN, default: true });
    expect((await api("GET", `/colonies/does-not-exist/silent-ttl`)).status).toBe(404);
  });
});
