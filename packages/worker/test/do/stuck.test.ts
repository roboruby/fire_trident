import { SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, EventsPage, Id, StuckItem, StuckReport } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, newColony, proposeEdit, take } from "./helpers.ts";

/**
 * The stuck-work detector inside a real ColonyDO: each check found from the colony's own tables (times
 * moved back by hand, as if minutes had passed), served with the snapshot and the metrics report, and
 * published once per item on the colony's periodic tick.
 */

const MIN = 60_000;

async function sql<T = Record<string, unknown>>(colonyId: string, query: string, ...args: unknown[]): Promise<T[]> {
  const out: unknown = await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState): unknown => state.storage.sql.exec(query, ...args).toArray());
  return out as T[];
}

async function stuckOf(colonyId: string): Promise<StuckReport> {
  const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
  expect(snap.stuck).toBeDefined();
  return snap.stuck!;
}

/** A proposal row as the colony keeps it, for outcomes reached in the past. */
async function pastProposal(colonyId: string, intentId: Id, p: { id: string; status: string; at: number; reason?: string; agentId?: string }): Promise<void> {
  const agentId = p.agentId ?? "agt_past";
  const data = {
    id: p.id,
    colonyId,
    intentId,
    agentId,
    status: p.status,
    createdAt: p.at,
    writeSet: [{ path: "src/lib/util.ts", blob: "1".repeat(40) }],
    readSet: [],
    declared: { footprint: ["src/lib/util.ts"], summary: "past" },
    evidence: { checks: [] },
    ...(p.reason !== undefined ? { reason: p.reason } : {}),
  };
  await sql(
    colonyId,
    "INSERT INTO proposals (id, intent_id, agent_id, status, region, priority, created_at, updated_at, data) VALUES (?, ?, ?, ?, 'src', 1, ?, ?, ?)",
    p.id,
    intentId,
    agentId,
    p.status,
    p.at,
    p.at + 500,
    JSON.stringify(data),
  );
}

/** A certification result row as the certifier stores it. */
async function pastCertification(colonyId: string, sha: string, status: "green" | "red", at: number): Promise<void> {
  const counts = status === "green" ? { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 1 } : { tests: 10, pass: 7, fail: 3, cancelled: 0, skipped: 0, todo: 0, suites: 1 };
  const cert = { trunkSha: sha, status, startedAt: at, finishedAt: at + 200, counts, ...(status === "red" ? { failing: [{ name: "adds", file: "test/a.test.ts" }] } : {}) };
  await sql(
    colonyId,
    "INSERT INTO certifications (trunk_sha, landing_id, status, started_at, finished_at, inputs, test_key, data) VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?)",
    sha,
    status,
    at,
    at + 200,
    JSON.stringify(cert),
  );
}

describe("stuck work in the snapshot and the metrics report", () => {
  it("is an empty report when nothing is stuck", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const report = await stuckOf(c.id);
    expect(report).toEqual({ at: expect.any(Number), items: [], total: 0 });
  });

  it("names an intent claimed for ten minutes with no change, its agent and what the agent says it is doing", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"], { title: "Fix the helper" });
    const a = await addAgent(c.id, "forager-1");
    await take(c.id, a.id);
    expect((await api("POST", `/colonies/${c.id}/agents/${a.id}/status`, { note: "reading src/lib/util.ts" })).status).toBe(200);
    // Not yet: the claim is fresh.
    expect((await stuckOf(c.id)).items).toEqual([]);
    // Ten minutes pass with no change proposed.
    await sql(c.id, "UPDATE intents SET updated_at = ? WHERE id = ?", Date.now() - 11 * MIN, i.id);
    await sql(c.id, "UPDATE agents SET note_at = ? WHERE id = ?", Date.now() - 10.5 * MIN, a.id);
    const report = await stuckOf(c.id);
    expect(report.total).toBe(1);
    expect(report.items[0]).toMatchObject({ kind: "claimed", action: "agent", intentId: i.id, agentId: a.id, title: "Fix the helper", note: "reading src/lib/util.ts" });
    expect(report.items[0]?.text).toBe("“Fix the helper” is claimed by forager-1 with no change proposed yet; it says “reading src/lib/util.ts”");
    const m = (await api<{ stuck?: StuckReport }>("GET", `/colonies/${c.id}/metrics`)).body;
    expect(m.stuck?.items.map((x) => x.key)).toEqual(report.items.map((x) => x.key));
  });

  it("names an intent whose changes came back three times, with the latest reasons", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"], { title: "Shorten links" });
    const now = Date.now();
    await pastProposal(c.id, i.id, { id: "prp_a", status: "returned", at: now - 4 * MIN, reason: "llm: misses the empty slug" });
    await pastProposal(c.id, i.id, { id: "prp_b", status: "rejected", at: now - 3 * MIN, reason: "this rewrites the session cookie" });
    await pastProposal(c.id, i.id, { id: "prp_c", status: "returned", at: now - 2 * MIN, reason: "withdrawn: replaced by a newer intent" });
    expect((await stuckOf(c.id)).items).toEqual([]);
    await pastProposal(c.id, i.id, { id: "prp_d", status: "returned", at: now - 1 * MIN, reason: "stale: 1 path changed on trunk since read: src/lib/util.ts" });
    const [item] = (await stuckOf(c.id)).items;
    expect(item).toMatchObject({
      kind: "returns",
      action: "intent",
      intentId: i.id,
      returns: 3,
      reasons: ["stale: 1 path changed on trunk since read: src/lib/util.ts", "this rewrites the session cookie", "llm: misses the empty slug"],
    });
  });

  it("names a trunk red for fifteen minutes and says its repair waits for a person's answer", async () => {
    const c = await newColony();
    const now = Date.now();
    await pastCertification(c.id, "a".repeat(40), "green", now - 60 * MIN);
    await pastCertification(c.id, "b".repeat(40), "red", now - 20 * MIN);
    await pastCertification(c.id, "c".repeat(40), "red", now - 5 * MIN);
    const repair = await addIntent(c.id, ["src/lib/util.ts"], { title: "Make the failing tests pass: adds" });
    await sql(c.id, "UPDATE intents SET source = 'certify' WHERE id = ?", repair.id);
    let [item] = (await stuckOf(c.id)).items;
    expect(item).toMatchObject({ kind: "red", action: "tests", repair: "open", intentId: repair.id, trunkSha: "b".repeat(40), since: now - 20 * MIN + 200 });
    expect(item?.text).toBe("Trunk tests have been red since bbbbbbb (3 failing); repair “Make the failing tests pass: adds” waits for an agent to take it");
    // An agent takes the repair and reports the test as broken: the trunk now waits on a person.
    const a = await addAgent(c.id, "forager-2");
    await take(c.id, a.id);
    await colony(c.id).escalate(a.id, { intentId: repair.id, kind: "broken-test", report: "the test expects 405, the spec says 404" });
    [item] = (await stuckOf(c.id)).items;
    expect(item).toMatchObject({ kind: "red", action: "answer", repair: "reported", intentId: repair.id });
    // Ten minutes later the report itself is stuck too, and comes right after the red trunk.
    await sql(c.id, "UPDATE intents SET escalation = json_set(escalation, '$.at', ?) WHERE id = ?", Date.now() - 11 * MIN, repair.id);
    const report = await stuckOf(c.id);
    expect(report.items.map((x) => x.kind)).toEqual(["red", "report"]);
    expect(report.items[1]).toMatchObject({ action: "answer", intentId: repair.id, agentId: a.id, text: "forager-2 reported a broken test on “Make the failing tests pass: adds”; it waits for a person's answer" });
    // A green result ends it.
    await pastCertification(c.id, "d".repeat(40), "green", Date.now());
    expect((await stuckOf(c.id)).items.map((x) => x.kind)).toEqual(["report"]);
  });

  it("names a change waiting ten minutes for review, and an agent whose change has not moved", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"], { title: "Add a cache" });
    const a = await addAgent(c.id, "forager-3");
    const t = await take(c.id, a.id);
    // The lanes are held in tests, so the change waits in its lane.
    const p = await proposeEdit(c.id, t, a.id);
    expect(p.status).toBe("ready");
    const old = Date.now() - 12 * MIN;
    await sql(c.id, "UPDATE proposals SET created_at = ?, updated_at = ? WHERE id = ?", old, old, p.id);
    await sql(c.id, "UPDATE intents SET updated_at = ? WHERE id = ?", old, i.id);
    await sql(c.id, "UPDATE agents SET created_at = ? WHERE id = ?", old - MIN, a.id);
    let report = await stuckOf(c.id);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ kind: "agent", action: "agent", agentId: a.id, intentId: i.id, proposalId: p.id, since: old });
    expect(report.items[0]?.text).toBe(`forager-3 is alive but its work on “Add a cache” has not moved: its change ${p.id} still waits for its lane; it has not said what it is doing`);
    // The change goes to a person instead: the review check names it, and the agent is left out.
    await sql(c.id, "UPDATE proposals SET status = 'escalated', data = json_set(data, '$.status', 'escalated') WHERE id = ?", p.id);
    report = await stuckOf(c.id);
    expect(report.items.map((x) => [x.kind, x.action, x.proposalId])).toEqual([["review", "review", p.id]]);
    expect(report.items[0]?.text).toBe("A change for “Add a cache” by forager-3 waits for a person's review");
  });
});

describe("stuck events on the periodic tick", () => {
  /** Let the next tick look again at once (it looks at most every 30 seconds). */
  const lookAgain = (colonyId: string) =>
    runInDurableObject(colony(colonyId), (instance) => {
      (instance as unknown as { lastStuckSweep: number }).lastStuckSweep = 0;
    });
  const recorded = async (colonyId: string): Promise<StuckItem[]> =>
    (await api<EventsPage>("GET", `/colonies/${colonyId}/events?source=recorded&limit=5000`)).body.events.flatMap((e) => (e.t === "stuck" ? [e.item] : []));
  const ledger = async (colonyId: string): Promise<string[]> => (await sql<{ key: string }>(colonyId, "SELECT key FROM stuck_reported ORDER BY key")).map((r) => r.key);

  it("publishes an item once, nothing when it clears, and again when it comes back", async () => {
    const c = await newColony();
    const res = await SELF.fetch(`https://ft.test/api/colonies/${c.id}/live`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const live: ColonyEvent[] = [];
    ws.addEventListener("message", (m) => {
      live.push(...(JSON.parse(String(m.data)) as ColonyEvent[]));
    });
    const i = await addIntent(c.id, ["src/lib/util.ts"], { title: "Fix the helper" });
    const a = await addAgent(c.id, "forager-4");
    const t = await take(c.id, a.id);
    await sql(c.id, "UPDATE intents SET updated_at = ? WHERE id = ?", Date.now() - 11 * MIN, i.id);

    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    let items = await recorded(c.id);
    expect(items.map((x) => [x.kind, x.intentId, x.agentId])).toEqual([["claimed", i.id, a.id]]);
    for (let n = 0; n < 50 && !live.some((e) => e.t === "stuck"); n++) await new Promise((r) => setTimeout(r, 20));
    expect(live.find((e) => e.t === "stuck")).toMatchObject({ t: "stuck", item: { key: items[0]?.key, kind: "claimed" } });
    expect(await ledger(c.id)).toEqual([items[0]!.key]);

    // Still stuck on the next look: nothing more is published.
    await lookAgain(c.id);
    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    expect(await recorded(c.id)).toHaveLength(1);

    // It clears (the agent proposes): nothing is published and it leaves the ledger.
    const p = await proposeEdit(c.id, t, a.id);
    await lookAgain(c.id);
    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    expect(await recorded(c.id)).toHaveLength(1);
    expect(await ledger(c.id)).toEqual([]);

    // It comes back: a person returns the change, the agent takes the intent again and goes quiet.
    expect((await api("POST", `/colonies/${c.id}/review/${p.id}`, { decision: "return", reason: "split it in two", by: "matt" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const again = await take(c.id, a.id);
    expect(again.intent.id).toBe(i.id);
    await sql(c.id, "UPDATE intents SET updated_at = ? WHERE id = ?", Date.now() - 12 * MIN, i.id);
    await lookAgain(c.id);
    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    items = await recorded(c.id);
    expect(items.map((x) => x.kind)).toEqual(["claimed", "claimed"]);
    expect(items[1]?.key).not.toBe(items[0]?.key);
    ws.close(1000, "done");
  });

  it("looks at most every 30 seconds, and not without a viewer", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    await take(c.id, a.id);
    await sql(c.id, "UPDATE intents SET updated_at = ? WHERE id = ?", Date.now() - 11 * MIN, i.id);
    // No socket: the tick does nothing, so nothing is published (the snapshot still reports it).
    await runInDurableObject(colony(c.id), async (_i, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    expect(await recorded(c.id)).toEqual([]);
    expect((await stuckOf(c.id)).total).toBe(1);
    // A viewer connects; a look made a moment ago holds the next one back.
    const res = await SELF.fetch(`https://ft.test/api/colonies/${c.id}/live`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    await runInDurableObject(colony(c.id), (instance) => {
      (instance as unknown as { lastStuckSweep: number }).lastStuckSweep = Date.now();
    });
    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    expect(await recorded(c.id)).toEqual([]);
    await lookAgain(c.id);
    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    expect((await recorded(c.id)).map((x) => x.kind)).toEqual(["claimed"]);
    ws.close(1000, "done");
  });
});
