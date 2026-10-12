import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, FieldReading, Rule } from "@fire_trident/core";
import { METRIC_KEYS, SERIES_BUCKETS } from "../../src/colony/metrics.ts";
import type { AgentListEntry, ColonySummary, SnapshotWithSeries } from "../../src/colony/metrics.ts";
import { addAgent, addIntent, api, colony, newColony, proposeEdit, take, tick } from "./helpers.ts";

type AgentList = { colonyId: string; total: number; byState: Record<string, number>; agents: AgentListEntry[] };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("colony registry", () => {
  it("lists created colonies with live counters", async () => {
    const c = await newColony();
    await addAgent(c.id);
    await addIntent(c.id, ["src/lib/util.ts"]);
    const res = await api<{ total: number; colonies: ColonySummary[] }>("GET", "/colonies");
    expect(res.status).toBe(200);
    const mine = res.body.colonies.find((x) => x.id === c.id);
    expect(mine).toMatchObject({ id: c.id, name: c.name, trunkSha: c.trunkSha, createdAt: c.createdAt, lastLandingAt: null });
    expect(mine?.counters).toMatchObject({ agentsActive: 1, intentsOpen: 1, landings: 0, proposalsInFlight: 0, violations: 0 });
    expect(res.body.total).toBe(res.body.colonies.length);
  });
});

describe("snapshot metrics and series", () => {
  it("carries every stable metric and 30 one-minute buckets that count landings and violations", async () => {
    const c = await newColony();
    const empty = (await api<SnapshotWithSeries>("GET", `/colonies/${c.id}`)).body;
    for (const k of METRIC_KEYS) expect(empty.metrics).toHaveProperty(k);
    expect(empty.series.bucketMs).toBe(60_000);
    expect(empty.series.landings).toEqual(new Array(SERIES_BUCKETS).fill(0));
    expect(empty.series.start + SERIES_BUCKETS * 60_000).toBeGreaterThan(Date.now());

    const rule = await api<{ rule: Rule; violations: number }>("POST", `/colonies/${c.id}/rules`, {
      kind: "forbid-pattern",
      spec: { pattern: "console\\.log", hint: "use the logger" },
      description: "No console.log",
    });
    expect(rule.body.violations).toBe(1);
    const agent = await addAgent(c.id);
    const a = await take(c.id, agent.id);
    await proposeEdit(c.id, a, agent.id);
    const inFlight = (await api<{ metrics: Record<string, number> }>("GET", `/colonies/${c.id}/metrics`)).body.metrics;
    expect(inFlight).toMatchObject({ proposalsInFlight: 1, agentsWorking: 1, intentsProposed: 1, violations: 1 });
    await tick(c.id, "src");

    const m = (await api<SnapshotWithSeries>("GET", `/colonies/${c.id}/metrics`)).body;
    expect(m.metrics).toMatchObject({ landings: 1, landingsPerMin: 1, proposalsInFlight: 0, violations: 0, intentsLanded: 1, rules: 1 });
    expect(sum(m.series.landings)).toBe(1);
    expect(sum(m.series.proposals)).toBe(1);
    // A gauge keeps the last value of each minute: the rule and its fix landed in the same one.
    expect(m.series.violations.at(-1)).toBe(0);
    expect(m.funnel).toEqual({ reflex: 0, llm: 0, human: 0 });
  });

  it("re-sends live metrics to connected sockets on the metrics tick", async () => {
    const c = await newColony();
    const res = await SELF.fetch(`https://ft.test/api/colonies/${c.id}/live`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const metrics = new Map<string, number>();
    ws.addEventListener("message", (m) => {
      for (const e of JSON.parse(String(m.data)) as ColonyEvent[]) if (e.t === "metric") metrics.set(e.name, e.value);
    });
    await addAgent(c.id, "one");
    await addAgent(c.id, "two");
    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    for (let i = 0; i < 50 && !metrics.has("agentsActive"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(metrics.get("agentsActive")).toBe(2);
    expect(metrics.get("landingsPerMin")).toBe(0);
    ws.close(1000, "done");
  });
});

describe("agent operations", () => {
  it("lists agents with their intent and stops one, reopening its claim", async () => {
    const c = await newColony();
    const one = await addAgent(c.id, "one");
    const two = await addAgent(c.id, "two");
    await addIntent(c.id, ["src/lib/util.ts"]);
    const held = await take(c.id, one.id);

    const list = (await api<AgentList>("GET", `/colonies/${c.id}/agents`)).body;
    expect(list.total).toBe(2);
    const listed = list.agents.find((a) => a.id === one.id);
    expect(listed).toMatchObject({ state: "working", kind: "synthetic", intentId: held.intent.id, intentTitle: held.intent.title });
    expect(listed?.workspace?.token).toBe("");
    // The harness has no agent objects, so the journal is reported missing rather than failing the list.
    expect(listed?.journalError).toBeTruthy();

    expect((await api("POST", `/colonies/${c.id}/agents/${one.id}/stop`, undefined, {})).status).toBe(401);
    expect((await api("POST", `/colonies/${c.id}/agents/agt_missing/stop`)).status).toBe(404);
    const stop = await api("POST", `/colonies/${c.id}/agents/${one.id}/stop`, { reason: "test stop" });
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ ok: true, agentId: one.id, stopped: [one.id], retired: 1 });

    const snap = (await api<SnapshotWithSeries>("GET", `/colonies/${c.id}`)).body;
    expect(snap.intents.find((i) => i.id === held.intent.id)?.status).toBe("open");
    expect(snap.agents.find((a) => a.id === one.id)?.state).toBe("dead");
    expect(snap.metrics).toMatchObject({ agentsActive: 1, agentsDead: 1, intentsClaimed: 0, intentsOpen: 1 });
    expect((await api<AgentList>("GET", `/colonies/${c.id}/agents`)).body.agents.map((a) => a.id)).toEqual([two.id]);
    const all = (await api<AgentList>("GET", `/colonies/${c.id}/agents?all=1&journal=0`)).body;
    expect(all.agents.find((a) => a.id === one.id)).toMatchObject({ state: "dead", stopReason: "test stop" });
    expect(all.agents.every((a) => a.journalError === undefined)).toBe(true);
  });

  it("stops every in-platform agent and leaves external ones", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/swarm`, { count: 3, kind: "synthetic" })).status).toBe(202);
    const ext = await api<{ id: string }>("POST", `/colonies/${c.id}/agents`, { name: "outside", kind: "external" });
    const res = await api("POST", `/colonies/${c.id}/swarm/stop`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, considered: 3, retired: 3 });
    expect((await api("POST", `/colonies/${c.id}/swarm/stop`, {})).body).toMatchObject({ ok: true, considered: 0 });
    expect((await api("POST", `/colonies/${c.id}/swarm/stop`, { all: true })).body).toMatchObject({ considered: 3 });
    expect((await api<AgentList>("GET", `/colonies/${c.id}/agents`)).body.agents.map((a) => a.id)).toEqual([ext.body.id]);
    expect((await api("POST", "/colonies/no-such-colony/swarm/stop")).status).toBe(404);
  });
});

describe("field", () => {
  it("reads every touched region and refuses unknown ones", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts", "docs/guide.md"]);
    const all = (await api<FieldReading[]>("GET", `/colonies/${c.id}/field`)).body;
    expect(all.map((r) => r.region).sort()).toEqual(["docs", "src"]);
    expect(all.find((r) => r.region === "src")?.byPath["src/lib/util.ts"]).toEqual({ need: 1 });
    expect((await api<FieldReading[]>("GET", `/colonies/${c.id}/field?region=src`)).body).toHaveLength(1);
    expect((await api("GET", `/colonies/${c.id}/field?region=nope`)).status).toBe(404);
  });
});

describe("DELETE /api/colonies/:id", () => {
  it("refuses without the token, erases the colony, unregisters it, and is idempotent", async () => {
    const c = await newColony();
    await addAgent(c.id);
    await addIntent(c.id, ["src/lib/util.ts"]);
    expect((await api("DELETE", `/colonies/${c.id}`, undefined, {})).status).toBe(401);
    expect((await api("DELETE", `/colonies/${c.id}`, undefined, { authorization: "Bearer wrong" })).status).toBe(401);

    const res = await api<{ found: boolean; ok: boolean; unregistered: boolean; agents: { stopped: number }; objects: Array<{ object: string; cleared: boolean }> }>(
      "DELETE",
      `/colonies/${c.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ colonyId: c.id, found: true, ok: true, unregistered: true, agents: { stopped: 1 } });
    expect(res.body.objects).toContainEqual({ object: `ColonyDO ${c.id}`, cleared: true });
    expect(res.body.objects.find((o) => o.object === `RegionDO ${c.id}:src`)).toBeDefined();

    expect((await api("GET", `/colonies/${c.id}`)).status).toBe(404);
    expect((await api<{ colonies: ColonySummary[] }>("GET", "/colonies")).body.colonies.map((x) => x.id)).not.toContain(c.id);
    const again = await api("DELETE", `/colonies/${c.id}`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ found: false, ok: true });

    // The name is free again.
    const back = await api("POST", "/colonies", { name: c.name });
    expect(back.status).toBe(201);
    expect((await api<SnapshotWithSeries>("GET", `/colonies/${c.id}`)).body.intents).toEqual([]);
  });
});
