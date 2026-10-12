import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, FieldReading, Rule } from "@fire_trident/core";
import { addAgent, addIntent, api, headSha, newColony, region } from "./helpers.ts";

describe("POST /api/colonies", () => {
  it("creates a colony from its slug and serves the snapshot", async () => {
    const res = await api("POST", "/colonies", { name: "  Démo App #1 ", regionDepth: 2, pool: 4 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "demo-app-1", name: "Démo App #1", regionDepth: 2 });
    expect(res.body.trunk).toMatchObject({ namespace: "ft-trunk", name: "demo-app-1--trunk" });
    expect(res.body.trunkSha).toBe(await headSha("demo-app-1"));

    const again = await api("POST", "/colonies", { name: "demo app 1" });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("already exists");

    const snap = await api<ColonySnapshot & { rules: Rule[] }>("GET", "/colonies/demo-app-1");
    expect(snap.status).toBe(200);
    expect(snap.body.colony.id).toBe("demo-app-1");
    expect(snap.body.files.map((f) => f.path).sort()).toEqual(["README.md", "docs/guide.md", "src/app/main.ts", "src/lib/util.ts"]);
    expect(snap.body.intents).toEqual([]);
    expect(snap.body.violations).toEqual({ total: 0, byRule: {} });
    expect(snap.body.funnel).toEqual({ reflex: 0, llm: 0, human: 0 });
    expect(snap.body.rules).toEqual([]);
  });

  it("validates bodies and names", async () => {
    expect((await api("POST", "/colonies", {})).status).toBe(400);
    expect((await api("POST", "/colonies", { name: "!!!" })).status).toBe(400);
    expect((await api("POST", "/colonies", { name: "x", source: { url: "not a url" } })).status).toBe(400);
    const bad = await SELF.fetch("https://ft.test/api/colonies", { method: "POST", headers: { authorization: "Bearer test-admin" }, body: "{" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "body must be JSON" });
  });

  it("requires the admin token on mutating routes only", async () => {
    expect((await api("POST", "/colonies", { name: "nope" }, {})).status).toBe(401);
    expect((await api("POST", "/colonies", { name: "nope" }, { authorization: "Bearer wrong" })).status).toBe(401);
    const c = await newColony();
    expect((await api("GET", `/colonies/${c.id}`, undefined, {})).status).toBe(200);
    expect((await api("POST", `/colonies/${c.id}/intents`, { title: "t", footprint: ["a.ts"] }, {})).status).toBe(401);
  });

  it("returns JSON 404s for unknown colonies and routes", async () => {
    const missing = await api("GET", "/colonies/no-such-colony");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "colony not found" });
    expect((await api("GET", "/colonies/Bad_Id")).status).toBe(404);
    expect((await api("GET", "/nothing-here")).status).toBe(404);
    expect((await api("POST", "/colonies/no-such-colony/agents", { name: "a" })).status).toBe(404);
  });
});

describe("intents, agents and the field", () => {
  it("deposits need marks and reports the field per region", async () => {
    const c = await newColony();
    const intent = await addIntent(c.id, ["src/lib/util.ts", "./docs/guide.md"], { priority: 2 });
    expect(intent).toMatchObject({ status: "open", priority: 2, source: "human", footprint: ["src/lib/util.ts", "docs/guide.md"] });

    const field = await api<FieldReading[]>("GET", `/colonies/${c.id}/field`);
    expect(field.status).toBe(200);
    const byRegion = Object.fromEntries(field.body.map((r) => [r.region, r]));
    expect(Object.keys(byRegion).sort()).toEqual(["docs", "src"]);
    expect(byRegion["src"]!.byPath["src/lib/util.ts"]).toEqual({ need: 2 });
    expect(byRegion["docs"]!.totals.need).toBe(2);
    expect(byRegion["src"]!.admission).toEqual({ open: true, landingsPerMin: 0, activeAgents: 0 });

    const one = await api<FieldReading[]>("GET", `/colonies/${c.id}/field?region=docs`);
    expect(one.body).toHaveLength(1);
    expect(one.body[0]!.region).toBe("docs");
  });

  it("rejects bad intents", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/intents`, { title: "t", footprint: [] })).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/intents`, { title: "", footprint: ["a"] })).status).toBe(400);
    const orphan = await api("POST", `/colonies/${c.id}/intents`, { title: "t", footprint: ["a.ts"], parentId: "int_missing" });
    expect(orphan.status).toBe(404);
  });

  it("registers agents and swarms", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "solo");
    expect(a).toMatchObject({ colonyId: c.id, kind: "synthetic", name: "solo", state: "idle", thresholds: {} });
    const swarm = await api<{ agents: string[] }>("POST", `/colonies/${c.id}/swarm`, { agents: 3, kind: "synthetic" });
    expect(swarm.status).toBe(202);
    expect(swarm.body.agents).toHaveLength(3);
    expect((await api("POST", `/colonies/${c.id}/swarm`, { count: 0 })).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/swarm`, {})).status).toBe(400);
    const snap = await api<ColonySnapshot>("GET", `/colonies/${c.id}`);
    expect(snap.body.agents).toHaveLength(4);
    expect(snap.body.metrics["agents"]).toBe(4);
  });

  it("answers why and review queries", async () => {
    const c = await newColony();
    expect((await api("GET", `/colonies/${c.id}/why?path=src/lib/util.ts&line=3`)).body).toEqual([]);
    expect((await api("GET", `/colonies/${c.id}/why`)).status).toBe(400);
    expect((await api("GET", `/colonies/${c.id}/review`)).body).toEqual([]);
  });
});

describe("live hub", () => {
  it("streams batched ColonyEvent arrays over a hibernatable WebSocket", async () => {
    const c = await newColony();
    const plain = await SELF.fetch(`https://ft.test/api/colonies/${c.id}/live`);
    expect(plain.status).toBe(426);

    const res = await SELF.fetch(`https://ft.test/api/colonies/${c.id}/live`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const received: ColonyEvent[] = [];
    let frames = 0;
    const gotIntent = new Promise<void>((resolve) => {
      ws.addEventListener("message", (m) => {
        frames++;
        const parsed = JSON.parse(String(m.data)) as ColonyEvent[];
        expect(Array.isArray(parsed)).toBe(true);
        received.push(...parsed);
        if (received.some((e) => e.t === "intent")) resolve();
      });
    });
    await addAgent(c.id, "watcher");
    await addIntent(c.id, ["src/app/main.ts"]);
    await gotIntent;
    expect(received.some((e) => e.t === "agent" && e.state === "idle")).toBe(true);
    const intentEvent = received.find((e) => e.t === "intent");
    expect(intentEvent).toMatchObject({ t: "intent", status: "open", footprint: ["src/app/main.ts"] });
    expect(frames).toBeLessThanOrEqual(2);
    ws.close(1000, "done");
  });

  it("forwards mark events from regions to listeners", async () => {
    const c = await newColony();
    const res = await SELF.fetch(`https://ft.test/api/colonies/${c.id}/live`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const marks = new Promise<ColonyEvent>((resolve) => {
      ws.addEventListener("message", (m) => {
        const e = (JSON.parse(String(m.data)) as ColonyEvent[]).find((x) => x.t === "mark");
        if (e) resolve(e);
      });
    });
    await addIntent(c.id, ["src/lib/util.ts"], { priority: 3 });
    expect(await marks).toMatchObject({ t: "mark", region: "src", path: "src/lib/util.ts", kind: "need", value: 3 });
    ws.close(1000, "done");
    expect(await region(c.id, "src").status()).toMatchObject({ region: "src", colonyId: c.id, marks: 1, lane: 0 });
  });
});
