import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentInfo, ColonySnapshot, FieldReading, InboxDirective, Intent, Proposal, Rule } from "@fire_trident/core";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, api, colony, eventually, externalLanding, fakeSha, newColony, pool, proposal, proposeEdit, region, rows, take, tick, trunk } from "./helpers.ts";

/**
 * Changing direction against the real ColonyDO and RegionDO: amend, withdraw, retract, direct,
 * relay, recall, the lane's pre-land check, and the trunk writer's direction fence (its commit point).
 */

/** Propose new content for the intent's footprint, built on `intentRevision` (omitted when undefined). */
async function proposeAt(colonyId: string, a: Assignment, agentId: string, intentRevision?: number): Promise<{ status: number; body: any }> {
  const current = await trunk(colonyId).baseBlobs(a.lease.baseSha, a.intent.footprint);
  return api("POST", `/colonies/${colonyId}/proposals`, {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: a.intent.footprint.map((path) => ({ path, blob: fakeSha() })),
    readSet: current,
    declared: { footprint: a.intent.footprint, summary: "edit" },
    ...(intentRevision !== undefined ? { intentRevision } : {}),
  });
}

async function agentRow(colonyId: string, agentId: string): Promise<AgentInfo> {
  return (await colony(colonyId).getAgent(agentId)) as AgentInfo;
}

async function external(colonyId: string, name = "visitor"): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "external" });
  expect(res.status).toBe(201);
  return res.body;
}

async function reading(colonyId: string, name: string): Promise<FieldReading> {
  return (await region(colonyId, name).reading()) as FieldReading;
}

describe("amend an intent", () => {
  it("raises the revision, moves needs and claims, sends stale work back, and the holder keeps the intent", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    const p1 = await proposeEdit(c.id, got, a.id);
    expect(p1.status).toBe("ready");

    const res = await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { why: "test, second take", footprint: ["src/lib/util.ts", "src/app/main.ts"], reason: "main needs it too", by: "matt" });
    expect(res.status).toBe(200);
    expect(res.body.revision).toMatchObject({ revision: 2, changed: ["why", "footprint"], substantive: true, by: "matt", reason: "main needs it too", before: { why: "test" }, after: { why: "test, second take" } });
    // p1 was waiting in its lane: the trunk writer's fence confirms it is stopped, and records r2 for every later cycle.
    expect(res.body).toMatchObject({ returned: 1, landed: [], confirmed: true });
    expect(await trunk(c.id).directionRecord(i.id)).toMatchObject({ revision: 2, revisions: [{ revision: 2, changed: ["why", "footprint"], reason: "main needs it too" }] });
    // The harness has no AgentDO: the push fails and the notice waits in the colony's record.
    expect(res.body.notified).toEqual([{ agentId: a.id, directiveId: expect.stringMatching(/^dir_/), delivery: "failed" }]);
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "returned", reason: "intent revised: r1 → r2, why and footprint changed (main needs it too)" });

    // The holder keeps the intent, its claim and its lease.
    const detail = (await api("GET", `/colonies/${c.id}/intents/${i.id}`)).body;
    expect(detail.intent).toMatchObject({ status: "claimed", assignedTo: a.id, revision: 2, why: "test, second take", footprint: ["src/lib/util.ts", "src/app/main.ts"] });
    expect(detail.revisions).toEqual([expect.objectContaining({ revision: 2, changed: ["why", "footprint"], substantive: true })]);
    expect(detail.directives).toEqual([expect.objectContaining({ kind: "revision", agentId: a.id, revision: 2, changed: ["why", "footprint"], message: "main needs it too" })]);
    const ag = await agentRow(c.id, a.id);
    expect(ag).toMatchObject({ state: "working", intentId: i.id });
    expect(ag.workspace).toBeDefined();

    // Needs moved with the footprint; the holder's claim followed; no failure mark from a redirect.
    const field = await reading(c.id, "src");
    expect(field.byPath["src/app/main.ts"]?.need).toBeCloseTo(1, 3);
    expect(field.byPath["src/app/main.ts"]?.claim ?? 0).toBeGreaterThan(0.9);
    expect(field.byPath["src/lib/util.ts"]?.failure ?? 0).toBe(0);

    // The lane never lands the stale change.
    await tick(c.id, "src");
    expect((await trunk(c.id).state()).landings).toHaveLength(0);

    // A change still built on r1 is refused; the same agent takes r2 and its change lands.
    const stale = await proposeAt(c.id, got, a.id, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/^intent revised: .+ is at r2 \(why and footprint changed: main needs it too\); this change was built on r1/);
    const again = await take(c.id, a.id);
    expect(again.intent).toMatchObject({ id: i.id, revision: 2 });
    const fresh = await proposeAt(c.id, again, a.id, 2);
    expect(fresh.status).toBe(201);
    expect(fresh.body).toMatchObject({ status: "ready", intentRevision: 2 });
    expect(fresh.body.evidence.direction).toMatchObject({ intentRevision: 2, revisions: [{ revision: 2, changed: ["why", "footprint"], reason: "main needs it too", by: "matt" }] });
    await tick(c.id, "src");
    expect(await proposal(c.id, fresh.body.id)).toMatchObject({ status: "landed" });
  });

  it("only moves the queue for a priority change, and changes nothing for a no-op", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    const p1 = await proposeEdit(c.id, got, a.id);
    const res = await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { priority: 4, reason: "urgent" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ returned: 0, notified: [], revision: { revision: 2, changed: ["priority"], substantive: false } });
    expect((await proposal(c.id, p1.id)).status).toBe("ready");
    expect((await reading(c.id, "src")).byPath["src/lib/util.ts"]?.need).toBeCloseTo(4, 3);
    const same = await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { priority: 4, reason: "again" });
    expect(same.body).toMatchObject({ revision: null, returned: 0 });
    expect(same.body.intent.revision).toBe(2);
    // r1 → r2 changed only the priority: a change that says r1 still fits.
    await tick(c.id, "src");
    expect((await proposal(c.id, p1.id)).status).toBe("landed");
  });

  it("validates the request", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    expect((await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { why: "x" })).status).toBe(400); // no reason
    expect((await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { reason: "x" })).status).toBe(400); // nothing to change
    expect((await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { footprint: [], reason: "x" })).status).toBe(400);
    expect((await api("PATCH", `/colonies/${c.id}/intents/int_nope`, { why: "x", reason: "x" })).status).toBe(404);
    expect((await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { why: "x", reason: "x" }, {})).status).toBe(401);
    expect((await api("GET", `/colonies/${c.id}/intents/int_nope`)).status).toBe(404);
  });

  it("holds an external agent to the revision it last saw until it reads the notice", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const e = await external(c.id);
    const got = await take(c.id, e.id);
    expect((await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { title: "Change util differently", reason: "new plan" })).body.notified).toEqual([
      { agentId: e.id, directiveId: expect.any(String), delivery: "inbox" },
    ]);
    const refused = await proposeAt(c.id, got, e.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/^intent revised: /);
    const inbox = await api<InboxDirective[]>("GET", `/colonies/${c.id}/agents/${e.id}/inbox`);
    expect(inbox.status).toBe(200);
    expect(inbox.body[0]).toMatchObject({ kind: "directive", status: "directive", intentId: i.id, directive: { kind: "revision", revision: 2, via: "inbox" } });
    expect(inbox.body[0]!.reason).toMatch(/^Intent .+ revised to r2 \(title changed\): new plan\. Call take/);
    const accepted = await proposeAt(c.id, got, e.id);
    expect(accepted.status).toBe(201);
    expect(accepted.body.intentRevision).toBe(2);
  });
});

describe("withdraw an intent", () => {
  it("evaporates its needs, sends work in flight back, stops the holder, and nothing for it lands", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    const p1 = await proposeEdit(c.id, got, a.id);
    const res = await api("POST", `/colonies/${c.id}/intents/${i.id}/withdraw`, { reason: "not needed", by: "matt" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: { status: "withdrawn", withdrawnReason: "not needed" }, returned: 1, landed: [], confirmed: true });
    expect(res.body.intent.assignedTo).toBeUndefined();
    expect(await trunk(c.id).directionRecord(i.id)).toMatchObject({ status: "withdrawn", withdrawnReason: "not needed" });
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "returned", reason: "withdrawn: not needed" });
    expect(await agentRow(c.id, a.id)).toMatchObject({ state: "idle" });
    expect((await agentRow(c.id, a.id)).intentId).toBeUndefined();
    await eventually(() => pool(c.id).state(), (s) => s.released.includes(a.id));
    const cell = (await reading(c.id, "src")).byPath["src/lib/util.ts"] ?? {};
    expect(cell.need ?? 0).toBe(0);
    expect(cell.claim ?? 0).toBe(0);
    expect(cell.failure ?? 0).toBe(0);

    await tick(c.id, "src");
    expect((await trunk(c.id).state()).landings).toHaveLength(0);
    const late = await proposeAt(c.id, got, a.id);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe(`intent withdrawn: ${i.id} (not needed); stop work on it and take other work.`);
    expect((await api("POST", `/colonies/${c.id}/intents/${i.id}/withdraw`, { reason: "again" })).body).toMatchObject({ already: true, returned: 0 });
    expect((await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { why: "x", reason: "x" })).status).toBe(409);
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.intents.find((x) => x.id === i.id)).toMatchObject({ status: "withdrawn", withdrawnReason: "not needed" });
    expect(snap.metrics.intentsWithdrawn).toBe(1);
    // Nobody takes it again.
    const b = await addAgent(c.id, "b");
    expect((await api("POST", `/colonies/${c.id}/agents/${b.id}/take`)).body).toMatchObject({ wait: true, reason: "no open intents" });
  });

  it("leaves landed work untouched", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("landed");
    const res = await api("POST", `/colonies/${c.id}/intents/${i.id}/withdraw`, { reason: "too late" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already landed; landed work is untouched/);
    expect((await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { why: "x", reason: "x" })).status).toBe(409);
    expect((await api("POST", `/colonies/${c.id}/intents/${i.id}/withdraw`, {})).status).toBe(400);
  });
});

describe("retract a rule", () => {
  it("keeps the rule in history, withdraws its unlanded intents, and leaves landed ones alone", async () => {
    const c = await newColony();
    await externalLanding(c.id, { "src/app/main.ts": 'console.log("a");\n', "src/lib/util.ts": "console.log(1);\n" });
    const added = await api<{ rule: Rule; intents: number }>("POST", `/colonies/${c.id}/rules`, { kind: "forbid-pattern", spec: { pattern: "console\\.log", hint: "use the logger" }, description: "No console.log", approvedBy: "matt" });
    expect(added.body.intents).toBe(2);
    const rule = added.body.rule;
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    const p = await proposeEdit(c.id, got, a.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("landed");

    expect((await api("DELETE", `/colonies/${c.id}/rules/${rule.id}`, {})).status).toBe(400);
    const res = await api("DELETE", `/colonies/${c.id}/rules/${rule.id}?reason=${encodeURIComponent("logging is fine here")}&by=matt`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ withdrawn: 1, returned: 0, landed: [], confirmed: true, rule: { id: rule.id, retractedBy: "matt", retractReason: "logging is fine here", retractedAt: expect.any(Number) } });
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.violations.total).toBe(0);
    expect(snap.rules[0]).toMatchObject({ id: rule.id, retractedBy: "matt", retractReason: "logging is fine here" });
    const mine = snap.intents.filter((x) => x.ruleId === rule.id);
    expect(mine.find((x) => x.id === got.intent.id)).toMatchObject({ status: "landed" });
    expect(mine.find((x) => x.id !== got.intent.id)).toMatchObject({ status: "withdrawn", withdrawnReason: `rule ${rule.id} retracted: logging is fine here` });
    // The trunk writer's fence holds the withdrawal for every later cycle; the landed intent has no record.
    expect(await trunk(c.id).directionRecord(mine.find((x) => x.id !== got.intent.id)!.id)).toMatchObject({ status: "withdrawn" });
    expect(await trunk(c.id).directionRecord(got.intent.id)).toBeNull();
    expect((await api("DELETE", `/colonies/${c.id}/rules/${rule.id}`, { reason: "again" })).body).toMatchObject({ already: true });
    expect((await api("DELETE", `/colonies/${c.id}/rules/rul_nope`, { reason: "x" })).status).toBe(404);
  });
});

describe("directives, status notes and recall", () => {
  it("leaves a directive in an external agent's inbox, records its note, and stamps both into its next change", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const e = await external(c.id);
    const got = await take(c.id, e.id);
    const d = await api("POST", `/colonies/${c.id}/agents/${e.id}/directive`, { message: "Use the logger, not console", by: "matt" });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ kind: "guidance", agentId: e.id, intentId: i.id, message: "Use the logger, not console", by: "matt", delivery: "inbox" });
    expect(d.body.deliveredAt).toBeUndefined();
    const inbox = (await api<Array<InboxDirective | Proposal>>("GET", `/colonies/${c.id}/agents/${e.id}/inbox`)).body;
    expect(inbox[0]).toMatchObject({ status: "directive", reason: `Directive from matt about intent ${i.id}: Use the logger, not console`, directive: { via: "inbox", deliveredAt: expect.any(Number) } });

    const note = await api("POST", `/colonies/${c.id}/agents/${e.id}/status`, { note: "  editing\n src/lib/util.ts  " });
    expect(note.body).toMatchObject({ note: "editing src/lib/util.ts", emitted: true });
    const listed = (await api<{ agents: Array<AgentInfo> }>("GET", `/colonies/${c.id}/agents`)).body.agents.find((x) => x.id === e.id);
    expect(listed).toMatchObject({ note: "editing src/lib/util.ts", noteAt: expect.any(Number) });

    const p = await proposeAt(c.id, got, e.id);
    expect(p.body.evidence.direction).toEqual({
      intentRevision: 1,
      directives: [{ id: d.body.id, message: "Use the logger, not console", by: "matt", at: d.body.at }],
      note: "editing src/lib/util.ts",
    });

    expect((await api("POST", `/colonies/${c.id}/agents/agt_nope/directive`, { message: "x" })).status).toBe(404);
    expect((await api("POST", `/colonies/${c.id}/agents/${e.id}/directive`, { message: "  " })).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/agents/${e.id}/directive`, { message: "x", intentId: "int_nope" })).status).toBe(404);
    expect((await api("POST", `/colonies/${c.id}/agents/${e.id}/status`, { note: "" })).status).toBe(400);
  });

  it("marks a directive read only when the inbox actually shows it", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const e = await external(c.id);
    const got = await take(c.id, e.id);
    const d = await api("POST", `/colonies/${c.id}/agents/${e.id}/directive`, { message: "keep it short", by: "matt" });
    // Two newer proposals push the directive out of a two-entry inbox.
    for (let k = 0; k < 2; k++) {
      await new Promise((r) => setTimeout(r, 5));
      expect((await proposeAt(c.id, got, e.id)).status).toBe(201);
    }
    const short = (await api<Array<{ status: string }>>("GET", `/colonies/${c.id}/agents/${e.id}/inbox?limit=2`)).body;
    expect(short.map((x) => x.status)).not.toContain("directive");
    expect((await api<{ directives: Array<{ id: string; deliveredAt?: number }> }>("GET", `/colonies/${c.id}/intents/${got.intent.id}`)).body.directives[0]).toMatchObject({ id: d.body.id });
    expect((await api<{ directives: Array<{ deliveredAt?: number }> }>("GET", `/colonies/${c.id}/intents/${got.intent.id}`)).body.directives[0]!.deliveredAt).toBeUndefined();
    const full = (await api<Array<{ status: string; directive?: { deliveredAt?: number } }>>("GET", `/colonies/${c.id}/agents/${e.id}/inbox?limit=10`)).body;
    expect(full.find((x) => x.status === "directive")?.directive?.deliveredAt).toEqual(expect.any(Number));
  });

  it("treats guidance as part of the intent: whoever proposes carries it, and reviewers see it", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const first = await addAgent(c.id, "first");
    await take(c.id, first.id);
    const d = await api("POST", `/colonies/${c.id}/agents/${first.id}/directive`, { message: "Also export VERSION = 2", by: "matt" });
    expect(d.body.intentId).toBe(i.id);
    // The first agent stops (its claim goes back); another takes the intent over.
    expect((await api("POST", `/colonies/${c.id}/agents/${first.id}/stop`, { reason: "gone" })).status).toBe(200);
    const second = await addAgent(c.id, "second");
    const got = await take(c.id, second.id);
    expect(got.intent.id).toBe(i.id);
    const guidance = [{ id: d.body.id, message: "Also export VERSION = 2", by: "matt", at: d.body.at }];
    expect(await colony(c.id).guidance(i.id)).toEqual(guidance);
    const p = await proposeAt(c.id, got, second.id);
    expect(p.body.evidence.direction.directives).toEqual(guidance);
    const reviewed = await runInDurableObject(colony(c.id), (instance: unknown) => (instance as { reviewIntent(id: string): Intent | null }).reviewIntent(i.id));
    expect(reviewed?.why).toBe(
      "test\n\nDirectives from a human operator about this intent (they refine it; the agent was told to follow them, and where they conflict with the text above they take precedence):\n- Also export VERSION = 2 (from matt)",
    );
    // The intent itself is unchanged: guidance is not an amendment.
    expect((await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${i.id}`)).body.intent.why).toBe("test");
  });

  it("lets an agent recall its own change in flight and keep its intent, claim and lease", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    const b = await addAgent(c.id, "b");
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    let refused = "";
    try {
      await colony(c.id).recall(b.id, p.id, "not yours");
    } catch (e) {
      refused = String(e);
    }
    expect(refused).toMatch(/is not .*'s/);
    const back = await colony(c.id).recall(a.id, p.id, "directive dir_1 from matt");
    expect(back).toMatchObject({ status: "returned", reason: "superseded: directive dir_1 from matt" });
    expect((await api("GET", `/colonies/${c.id}/intents/${i.id}`)).body.intent).toMatchObject({ status: "claimed", assignedTo: a.id });
    const ag = await agentRow(c.id, a.id);
    expect(ag).toMatchObject({ state: "working", intentId: i.id });
    expect(ag.workspace).toBeDefined();
    expect((await reading(c.id, "src")).byPath["src/lib/util.ts"]?.failure ?? 0).toBe(0);
    await tick(c.id, "src");
    expect((await trunk(c.id).state()).landings).toHaveLength(0);
    expect((await colony(c.id).recall(a.id, p.id, "again")).status).toBe("returned");
  });
});

describe("the lane's pre-land check and the lineage context", () => {
  it("never lands a change whose intent was withdrawn or revised while it sat in the lane", async () => {
    const c = await newColony();
    const i1 = await addIntent(c.id, ["src/lib/util.ts"]);
    const i2 = await addIntent(c.id, ["src/app/main.ts"]);
    const a1 = await addAgent(c.id, "a1");
    const a2 = await addAgent(c.id, "a2");
    const g1 = await take(c.id, a1.id);
    const g2 = await take(c.id, a2.id);
    const byIntent = new Map([[g1.intent.id, { g: g1, a: a1 }], [g2.intent.id, { g: g2, a: a2 }]]);
    const p1 = await proposeEdit(c.id, byIntent.get(i1.id)!.g, byIntent.get(i1.id)!.a.id);
    const p2 = await proposeEdit(c.id, byIntent.get(i2.id)!.g, byIntent.get(i2.id)!.a.id);
    // Change direction behind the lane's back, as when a withdrawal and an amendment race a tick.
    await runInDurableObject(colony(c.id), (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE intents SET status = 'withdrawn', withdrawn_reason = 'raced the lane' WHERE id = ?", i1.id);
      state.storage.sql.exec("UPDATE intents SET revision = 2 WHERE id = ?", i2.id);
      state.storage.sql.exec(
        "INSERT INTO intent_revisions (intent_id, revision, at, by, reason, changed, before, after, substantive) VALUES (?, 2, ?, 'matt', 'new why', '[\"why\"]', '{}', '{}', 1)",
        i2.id,
        Date.now(),
      );
    });
    await tick(c.id, "src");
    expect((await trunk(c.id).state()).landings).toHaveLength(0);
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "returned", reason: "withdrawn: raced the lane" });
    expect(await proposal(c.id, p2.id)).toMatchObject({ status: "returned", reason: "intent revised: r1 → r2, why changed (new why)" });
    // The withdrawn intent's agent stops; the revised intent's holder keeps it and works on.
    expect(await agentRow(c.id, byIntent.get(i1.id)!.a.id)).toMatchObject({ state: "idle" });
    expect(await agentRow(c.id, byIntent.get(i2.id)!.a.id)).toMatchObject({ state: "working", intentId: i2.id });
    expect((await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${i2.id}`)).body.intent).toMatchObject({ status: "claimed", assignedTo: byIntent.get(i2.id)!.a.id });
  });

  it("hands the lane each intent's direction and each proposal's recorded decisions", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
    const stub = colony(c.id);
    await stub.recordDecision({ kind: "triage", subject: p.id, layer: "reflex", answers: { model: "@cf/cloudflare/clef", reflex: { needsHuman: 0.04, sensitive: 0.01, offIntent: 0.02, risk: 0.3 } }, p: 0.71, action: "consult" });
    await stub.recordDecision({ kind: "triage", subject: p.id, layer: "llm", answers: { model: "@cf/openai/gpt-oss-120b", verdict: { verdict: "approve", reason: "only the import changed" } }, p: 0.9, action: "land" });
    await stub.recordDecision({ kind: "triage", subject: "prp_other", layer: "human", answers: {}, p: 1, action: "approve" });
    const ctx = await stub.landContext([i.id], [a.id], [p.id]);
    expect(ctx.intents[i.id]).toMatchObject({ title: i.title, why: "test", status: "proposed", revision: 1 });
    expect(ctx.agents[a.id]).toEqual({ kind: "synthetic" });
    expect(ctx.decisions).toEqual({
      [p.id]: [
        expect.objectContaining({ layer: "reflex", p: 0.71, action: "consult", by: "@cf/cloudflare/clef", answer: "needs_human 0.04, touches_sensitive 0.01, off_intent 0.02, risk 0.30", question: expect.any(String), at: expect.any(Number) }),
        expect.objectContaining({ layer: "llm", p: 0.9, action: "land", by: "@cf/openai/gpt-oss-120b", answer: "approve: only the import changed" }),
      ],
    });
    expect((await stub.landContext([i.id], [a.id])).decisions).toEqual({});
    await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { why: "test again", reason: "sharper" });
    const after = await stub.landContext([i.id], [], []);
    expect(after.intents[i.id]).toMatchObject({ revision: 2, revisions: [{ revision: 2, changed: ["why"], reason: "sharper", at: expect.any(Number) }] });
  });
});

describe("the direction fence: a change of direction meets a trunk writer mid-cycle", () => {
  /** An intent with one agent's change built on r1, sitting in its lane (the trunk writer is about to take it). */
  async function inFlight() {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const got = await take(c.id, a.id);
    const p1 = await proposeEdit(c.id, got, a.id);
    expect(p1).toMatchObject({ status: "ready", intentRevision: 1 });
    return { c, i, a, p1 };
  }

  /** Wait until `check` passes, or fail. */
  async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, what: string): Promise<T> {
    const v = await eventually(read, check, 10_000);
    if (!check(v)) throw new Error(`timed out waiting for ${what}`);
    return v;
  }

  /**
   * The trunk writer's cycle holding `batch` has passed its direction check and is pushing when `act` (an
   * amendment or a withdrawal through the API) runs: the fence waits for the cycle. Returns the act's answer.
   */
  async function midPush<T>(colonyId: string, batch: Proposal[], act: () => Promise<T>): Promise<T> {
    await trunk(colonyId).holdNextLand("push");
    const cycle = trunk(colonyId).land(batch);
    await until(() => trunk(colonyId).held(), (h) => h, "the cycle to reach its push");
    const answer = act();
    await until(() => trunk(colonyId).fenceWaiting(), (n) => n > 0, "the fence to wait for the cycle");
    await trunk(colonyId).releaseLand();
    await cycle;
    return answer;
  }

  /** The lane's causal record of a return (sigma's input); a person's change of course leaves none. */
  async function returnCause(colonyId: string, proposalId: string): Promise<unknown[]> {
    return rows(region(colonyId, "src"), "SELECT id FROM causes WHERE id = ?", `ret:${proposalId}`);
  }

  it("stops a change queued before the writer's direction check: the answer says stopped and nothing lands", async () => {
    const { c, i, p1 } = await inFlight();
    await trunk(c.id).setReportLandings(false);
    await trunk(c.id).holdNextLand("read");
    // The lane checks direction (still live) and hands p1 to the writer, where it waits for a cycle.
    const ticking = tick(c.id, "src");
    await until(() => trunk(c.id).held(), (h) => h, "the lane's batch to wait for a cycle");
    const res = await api("POST", `/colonies/${c.id}/intents/${i.id}/withdraw`, { reason: "not needed", by: "matt" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: { status: "withdrawn" }, returned: 1, landed: [], confirmed: true });
    expect(res.body.unconfirmed).toBeUndefined();
    expect(await trunk(c.id).directionRecord(i.id)).toMatchObject({ status: "withdrawn", withdrawnReason: "not needed" });

    await trunk(c.id).releaseLand();
    await ticking;
    expect((await trunk(c.id).state()).landings).toHaveLength(0);
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "returned", reason: "withdrawn: not needed" });
    expect((await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${i.id}`)).body.intent).toMatchObject({ status: "withdrawn" });
    expect(await returnCause(c.id, p1.id)).toEqual([]);
  });

  it("waits for a cycle that read the old direction, then names its landing: the withdrawal lost the race", async () => {
    const { c, i, p1 } = await inFlight();
    await trunk(c.id).setReportLandings(false);
    await trunk(c.id).holdNextLand("push");
    const ticking = tick(c.id, "src");
    await until(() => trunk(c.id).held(), (h) => h, "the cycle to reach its push");
    const withdrawing = api("POST", `/colonies/${c.id}/intents/${i.id}/withdraw`, { reason: "not needed", by: "matt" });
    await until(() => trunk(c.id).fenceWaiting(), (n) => n > 0, "the fence to wait for the cycle");
    await trunk(c.id).releaseLand();
    const res = await withdrawing;
    await ticking;

    const landings = (await trunk(c.id).state()).landings;
    expect(landings.map((l) => l.proposalIds)).toEqual([[p1.id]]);
    const l = landings[0]!;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ returned: 0, confirmed: true, landed: [{ proposalId: p1.id, landingId: l.id, trunkSha: l.trunkSha }] });
    // Settled before the answer: the change and the intent show landed, and the change says why.
    expect(res.body.intent).toMatchObject({ status: "landed", withdrawnReason: "not needed" });
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "landed", landingId: l.id, reason: "landed before the withdrawal reached the trunk writer (withdrawn: not needed)" });
    expect(await returnCause(c.id, p1.id)).toEqual([]);
    expect((await region(c.id, "src").status()).lane).toBe(0);
  });

  it("repairs a landing whose answer was lost: the lane kept the change, the withdrawal dequeued it, the fence names it", async () => {
    const { c, i, p1 } = await inFlight();
    // The writer lands p1 and its answer is lost (a deploy reset it mid-call); nobody reports the landing.
    await trunk(c.id).loseNextAnswers(1);
    await tick(c.id, "src");
    const l = (await trunk(c.id).state()).landings[0]!;
    expect(l.proposalIds).toEqual([p1.id]);
    expect((await proposal(c.id, p1.id)).status).toBe("ready");

    const res = await api("POST", `/colonies/${c.id}/intents/${i.id}/withdraw`, { reason: "not needed", by: "matt" });
    expect(res.body).toMatchObject({ returned: 0, confirmed: true, landed: [{ proposalId: p1.id, landingId: l.id, trunkSha: l.trunkSha }] });
    expect(res.body.intent).toMatchObject({ status: "landed" });
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "landed", landingId: l.id });
    expect((await region(c.id, "src").status()).lane).toBe(0);
    await tick(c.id, "src");
    expect((await trunk(c.id).state()).landings).toHaveLength(1);
  });

  it("lands the change built on r1 but keeps the intent open at r2, and says so", async () => {
    const { c, i, a, p1 } = await inFlight();
    const amend = await midPush(c.id, [p1], () => api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { why: "test, the other way", reason: "do it the other way", by: "matt" }));
    const landings = (await trunk(c.id).state()).landings;
    expect(landings).toHaveLength(1);
    expect(amend.body).toMatchObject({ returned: 0, confirmed: true, landed: [{ proposalId: p1.id, landingId: landings[0]!.id, trunkSha: landings[0]!.trunkSha }] });
    expect(amend.body.intent).toMatchObject({ status: "open", revision: 2 });
    expect(await trunk(c.id).directionRecord(i.id)).toMatchObject({ revision: 2, revisions: [{ revision: 2, changed: ["why"], reason: "do it the other way" }] });

    const landed = await proposal(c.id, p1.id);
    expect(landed).toMatchObject({ status: "landed", landingId: landings[0]!.id, reason: "landed a change built on r1; r2 still to do" });
    const detail = (await api("GET", `/colonies/${c.id}/intents/${i.id}`)).body;
    expect(detail.intent).toMatchObject({ status: "open", revision: 2, why: "test, the other way" });
    expect(detail.intent.assignedTo).toBeUndefined();
    expect(detail.directives[0]).toMatchObject({ kind: "revision", agentId: a.id, revision: 2, changed: ["why"], by: "colony", message: "landed a change built on r1; r2 still to do" });
    const events = (await api<{ events: Array<Record<string, unknown>> }>("GET", `/colonies/${c.id}/events?limit=5000`)).body.events;
    expect(events).toContainEqual(expect.objectContaining({ t: "directive", intentId: i.id, agentId: a.id, by: "colony", message: "landed a change built on r1; r2 still to do" }));
    expect(events).toContainEqual(expect.objectContaining({ t: "proposal", proposalId: p1.id, status: "landed", reason: "landed a change built on r1; r2 still to do" }));
    expect(events.some((e) => e.t === "intent" && e.intentId === i.id && e.status === "landed")).toBe(false);
    // Its need stays for the next taker; the agent whose change landed is done with it.
    expect((await reading(c.id, "src")).byPath["src/lib/util.ts"]?.need).toBeCloseTo(1, 3);
    expect(await agentRow(c.id, a.id)).toMatchObject({ state: "idle" });

    // The next taker gets r2 (once the colony's shared field reading no longer shows a's claim), and r2 lands and closes the intent.
    const b = await addAgent(c.id, "b");
    const taken = await eventually(
      () => api<Assignment | { wait: true }>("POST", `/colonies/${c.id}/agents/${b.id}/take`),
      (res) => !("wait" in res.body),
    );
    const again = taken.body as Assignment;
    expect(again.intent).toMatchObject({ id: i.id, revision: 2 });
    const r2 = await proposeAt(c.id, again, b.id, 2);
    expect(r2.status).toBe(201);
    await tick(c.id, "src");
    expect(await proposal(c.id, r2.body.id)).toMatchObject({ status: "landed" });
    expect((await api("GET", `/colonies/${c.id}/intents/${i.id}`)).body.intent).toMatchObject({ status: "landed", revision: 2 });
  });

  it("leaves the intent with a holder already working on r2", async () => {
    const { c, i, a, p1 } = await inFlight();
    await trunk(c.id).holdNextLand("push");
    const cycle = trunk(c.id).land([p1]);
    await until(() => trunk(c.id).held(), (h) => h, "the cycle to reach its push");
    const amending = api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { footprint: ["src/lib/util.ts", "src/app/main.ts"], reason: "main too", by: "matt" });
    await until(() => trunk(c.id).fenceWaiting(), (n) => n > 0, "the fence to wait for the cycle");
    // While the writer pushes p1, the first agent stops and another takes the intent at r2.
    expect((await api("POST", `/colonies/${c.id}/agents/${a.id}/stop`, { reason: "gone" })).status).toBe(200);
    const b = await addAgent(c.id, "b");
    const got = await take(c.id, b.id);
    expect(got.intent).toMatchObject({ id: i.id, revision: 2 });
    await trunk(c.id).releaseLand();
    await cycle;
    expect((await amending).body).toMatchObject({ returned: 0, confirmed: true, landed: [{ proposalId: p1.id }] });
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "landed", reason: "landed a change built on r1; r2 still to do" });
    expect((await api("GET", `/colonies/${c.id}/intents/${i.id}`)).body.intent).toMatchObject({ status: "claimed", assignedTo: b.id, revision: 2 });
    expect(await agentRow(c.id, b.id)).toMatchObject({ state: "working", intentId: i.id });
    // b builds r2 on trunk as it is now (with p1 in it); it lands and closes the intent.
    const head = (await trunk(c.id).state()).head;
    const r2 = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, {
      intentId: i.id,
      agentId: b.id,
      workspace: got.lease.repo,
      baseSha: head,
      headSha: fakeSha(),
      writeSet: got.intent.footprint.map((path) => ({ path, blob: fakeSha() })),
      readSet: await trunk(c.id).baseBlobs(head, got.intent.footprint),
      declared: { footprint: got.intent.footprint, summary: "r2" },
      intentRevision: 2,
    });
    expect(r2.status).toBe(201);
    await tick(c.id, "src");
    expect(await proposal(c.id, r2.body.id)).toMatchObject({ status: "landed" });
    expect((await api("GET", `/colonies/${c.id}/intents/${i.id}`)).body.intent).toMatchObject({ status: "landed" });
  });

  it("closes the intent as before when only the priority moved", async () => {
    const { c, i, p1 } = await inFlight();
    await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { priority: 3, reason: "urgent" });
    // A priority-only amendment redirects nothing: the writer has no record for the intent, and p1 lands.
    expect(await trunk(c.id).directionRecord(i.id)).toBeNull();
    await trunk(c.id).land([p1]);
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "landed" });
    expect((await proposal(c.id, p1.id)).reason).toBeUndefined();
    expect((await api("GET", `/colonies/${c.id}/intents/${i.id}`)).body.intent).toMatchObject({ status: "landed", revision: 2 });
  });

  it("says unconfirmed when the trunk writer does not answer", async () => {
    const { c, i, p1 } = await inFlight();
    await trunk(c.id).failNextFences(1);
    const res = await api("POST", `/colonies/${c.id}/intents/${i.id}/withdraw`, { reason: "not needed", by: "matt" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: { status: "withdrawn" }, returned: 0, landed: [], confirmed: false, unconfirmed: [p1.id] });
    // The colony's own state changed as before: the change went back and left its lane.
    expect(await proposal(c.id, p1.id)).toMatchObject({ status: "returned", reason: "withdrawn: not needed" });
    expect((await region(c.id, "src").status()).lane).toBe(0);
  });
});
