import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentInfo, ColonySnapshot, FieldReading, InboxDirective, Intent, IntentEscalation, Landing, RecordedEvent } from "@fire_trident/core";
import type { LandedWhy } from "../../src/agents/landed.ts";
import type { ColonyDO } from "../../src/colony/ColonyDO.ts";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, api, colony, eventually, externalLanding, newColony, pool, proposal, proposeEdit, region, take, tick, trunk } from "./helpers.ts";

/**
 * What the colony tells the agents working on its files, against the real ColonyDO and RegionDO: why
 * the code is the way it is at take, landing notices while they work, and reports (escalations) that
 * an intent cannot be done as written, which a person answers.
 */

type Taken = Assignment & { context?: LandedWhy[] };

async function external(colonyId: string, name = "visitor"): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "external" });
  expect(res.status).toBe(201);
  return res.body;
}

/** Take, propose new content for the whole footprint, and land it through the src lane. */
async function landChange(colonyId: string, intent: Intent, agentId: string): Promise<Landing> {
  const got = await take(colonyId, agentId);
  expect(got.intent.id).toBe(intent.id);
  const p = await proposeEdit(colonyId, got, agentId);
  await tick(colonyId, "src");
  expect((await proposal(colonyId, p.id)).status).toBe("landed");
  const landings = (await trunk(colonyId).state()).landings;
  return landings[landings.length - 1]!;
}

/**
 * Call escalate inside the colony object and answer "ok" or the error's message: a refused call then
 * fails like any JS call (over RPC this pool reports it as an unhandled rejection too).
 */
async function escalateIn(colonyId: string, agentId: string, p: { intentId?: string; kind: string; report: string }): Promise<string> {
  return runInDurableObject(colony(colonyId), (instance: ColonyDO) =>
    instance.escalate(agentId, p as Parameters<ColonyDO["escalate"]>[1]).then(
      () => "ok",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    ),
  );
}

async function recorded(colonyId: string): Promise<RecordedEvent[]> {
  return (await colony(colonyId).eventsPage({ source: "recorded", limit: 5_000 })).events;
}

async function landingNotices(colonyId: string, agentId: string): Promise<InboxDirective[]> {
  const res = await api<Array<InboxDirective | { kind?: undefined }>>("GET", `/colonies/${colonyId}/agents/${agentId}/inbox`);
  expect(res.status).toBe(200);
  return res.body.filter((e): e is InboxDirective => e.kind === "directive" && (e as InboxDirective).directive.kind === "landing");
}

describe("why the code is the way it is, at take", () => {
  it("hands the taker the latest landings on its files, each with its intent's why", async () => {
    const c = await newColony();
    const why = `Callers need 2. ${"The router reads it on every request. ".repeat(12)}`;
    const i1 = await addIntent(c.id, ["src/lib/util.ts"], { title: "Make helper return 2", why });
    const a = await addAgent(c.id, "a");
    const first = (await take(c.id, a.id)) as Taken;
    expect(first.context).toBeUndefined(); // nothing landed on it yet
    const p = await proposeEdit(c.id, first, a.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("landed");
    const landing = (await trunk(c.id).state()).landings[0]!;

    const i2 = await addIntent(c.id, ["src/lib/util.ts", "src/app/main.ts"], { title: "Use the helper" });
    const got = (await take(c.id, a.id)) as Taken;
    expect(got.intent.id).toBe(i2.id);
    expect(got.context).toEqual([{ landingId: landing.id, at: landing.at, trunkSha: landing.trunkSha, intentId: i1.id, title: "Make helper return 2", why: expect.stringMatching(/^Callers need 2\. The router reads it/), paths: ["src/lib/util.ts"] }]);
    expect(got.context![0]!.why.length).toBe(300);
    // A repeated take hands the same assignment back, context included; files nothing landed on have none.
    expect(((await take(c.id, a.id)) as Taken).context).toEqual(got.context);
    const i3 = await addIntent(c.id, ["docs/guide.md"]);
    const d = await addAgent(c.id, "d");
    const other = (await take(c.id, d.id)) as Taken;
    expect(other.intent.id).toBe(i3.id);
    expect(other.context).toBeUndefined();
  });

  it("keeps the newest three per file, newest first, and answers a directory footprint too", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const landed: Landing[] = [];
    for (let n = 1; n <= 4; n++) {
      const intent = await addIntent(c.id, ["src/lib/util.ts"], { title: `Change ${n}`, why: `step ${n}` });
      landed.push(await landChange(c.id, intent, a.id));
    }
    const rows = await runInDurableObject(colony(c.id), (_i, state: DurableObjectState) => state.storage.sql.exec("SELECT landing_id FROM landing_paths WHERE path = 'src/lib/util.ts' ORDER BY at DESC").toArray());
    expect(rows.map((r) => r.landing_id)).toEqual([landed[3]!.id, landed[2]!.id, landed[1]!.id]);
    const dir = await addIntent(c.id, ["src/lib/"], { title: "Tidy the library" });
    const got = (await take(c.id, a.id)) as Taken;
    expect(got.intent.id).toBe(dir.id);
    expect(got.context!.map((e) => [e.title, e.why])).toEqual([
      ["Change 4", "step 4"],
      ["Change 3", "step 3"],
      ["Change 2", "step 2"],
    ]);
  });

  it("fills the index from landed changes when a colony landed work before it existed", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const i1 = await addIntent(c.id, ["src/lib/util.ts"], { title: "Make helper return 2", why: "Callers need 2." });
    const landing = await landChange(c.id, i1, a.id);
    await runInDurableObject(colony(c.id), (instance, state: DurableObjectState) => {
      state.storage.sql.exec("DELETE FROM landing_paths");
      (instance as unknown as { landedIndexReady: boolean }).landedIndexReady = false;
    });
    await addIntent(c.id, ["src/lib/util.ts"], { title: "Use it" });
    const got = (await take(c.id, a.id)) as Taken;
    expect(got.context).toEqual([expect.objectContaining({ landingId: landing.id, intentId: i1.id, title: "Make helper return 2", why: "Callers need 2.", paths: ["src/lib/util.ts"] })]);
  });
});

describe("landing notices", () => {
  it("tell the agents still working on the files: the blobs before and after, and the intent that changed them", async () => {
    const c = await newColony();
    const i1 = await addIntent(c.id, ["src/lib/util.ts"], { title: "Make helper return 2", why: "Callers need 2." });
    const a = await addAgent(c.id, "a");
    const got = await take(c.id, a.id);
    const p = await proposeEdit(c.id, got, a.id);
    // An external agent holds two intents on the same file (declared for it: no inhibition), another works elsewhere.
    const e = await external(c.id, "laptop");
    await addIntent(c.id, ["src/lib/util.ts"], { title: "Log the helper", assignedTo: e.id });
    const current = await addIntent(c.id, ["src/app/main.ts", "src/lib/util.ts"], { title: "Use the helper", assignedTo: e.id });
    const far = await external(c.id, "far");
    await addIntent(c.id, ["docs/guide.md"], { title: "Document", assignedTo: far.id });
    const before = (await trunk(c.id).state()).files["src/lib/util.ts"]!.blob;
    await tick(c.id, "src");
    const landing = (await trunk(c.id).state()).landings[0]!;

    const notices = await eventually(
      () => landingNotices(c.id, e.id),
      (l) => l.length > 0,
    );
    // One notice per agent per landing, about the intent it works on now.
    expect(notices).toHaveLength(1);
    expect(notices[0]!.directive).toMatchObject({
      kind: "landing",
      intentId: current.id,
      by: "colony",
      landing: {
        landingId: landing.id,
        trunkSha: landing.trunkSha,
        paths: [{ path: "src/lib/util.ts", before, after: p.writeSet[0]!.blob }],
        intentTitle: "Make helper return 2",
        why: "Callers need 2.",
      },
    });
    expect(notices[0]!.reason).toMatch(new RegExp(`^Trunk moved under intent ${current.id}: Landing ${landing.id} \\(trunk ${landing.trunkSha.slice(0, 7)}\\) changed src/lib/util\\.ts`));
    // Its author and an agent on other files hear nothing.
    expect(await landingNotices(c.id, a.id)).toEqual([]);
    expect(await landingNotices(c.id, far.id)).toEqual([]);
    const events = await recorded(c.id);
    expect(events.filter((ev) => ev.t === "directive" && ev.kind === "landing")).toEqual([
      expect.objectContaining({ agentId: e.id, intentId: current.id, by: "colony", directiveId: notices[0]!.directive.id }),
    ]);
    // The notice names the landing's intent, not the one it is about.
    expect(notices[0]!.directive.landing?.intentTitle).toBe(i1.title);
  });

  it("come from commits outside any intent too, and are kept for in-platform agents the push missed", async () => {
    const c = await newColony();
    const internal = await api<AgentInfo>("POST", `/colonies/${c.id}/agents`, { name: "writer", kind: "internal" });
    const held = await addIntent(c.id, ["src/lib/util.ts"], { title: "Rename helper", assignedTo: internal.body.id });
    // Synthetic agents are load: they are not told.
    const s = await addAgent(c.id, "synthetic");
    const loadIntent = await addIntent(c.id, ["src/lib/util.ts"], { title: "Load", assignedTo: s.id });
    const before = (await trunk(c.id).state()).files["src/lib/util.ts"]!.blob;
    const sha = await externalLanding(c.id, { "src/lib/util.ts": "export const helper = () => 3;\n" });
    const after = (await trunk(c.id).state()).files["src/lib/util.ts"]!.blob;
    // The harness has no agent objects: the push fails and the notice waits in the colony's record.
    const detail = await eventually(
      () => api<{ directives: Array<{ kind: string; landing?: unknown; deliveredAt?: number }> }>("GET", `/colonies/${c.id}/intents/${held.id}`),
      (r) => r.body.directives.some((d) => d.kind === "landing"),
    );
    const d = detail.body.directives.find((x) => x.kind === "landing")!;
    expect(d.landing).toEqual({ landingId: `lnd_external_${sha.slice(0, 8)}`, trunkSha: sha, paths: [{ path: "src/lib/util.ts", before, after }], intentTitle: "", why: "" });
    expect(d.deliveredAt).toBeUndefined();
    const load = (await api<{ directives: Array<{ kind: string }> }>("GET", `/colonies/${c.id}/intents/${loadIntent.id}`)).body;
    expect(load.directives.filter((x) => x.kind === "landing")).toEqual([]);
  });
});

describe("an agent reports an intent it cannot do as written", () => {
  async function escalated(): Promise<{ c: { id: string }; i: Intent; a: AgentInfo; report: string }> {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"], { title: "Fix the router test", why: "test/router.test.ts fails" });
    const a = await addAgent(c.id, "a");
    await take(c.id, a.id);
    const report = "test/router.test.ts:12 expects 405, but the spec says 404 for an unknown method";
    const res = await colony(c.id).escalate(a.id, { kind: "broken-test", report });
    expect(res.intent).toMatchObject({ id: i.id, status: "open", escalation: { kind: "broken-test", report, by: a.id } });
    expect(res.intent).not.toHaveProperty("assignedTo");
    return { c, i, a, report };
  }

  it("keeps the intent for a person, releases the agent with no failure mark, and offers the intent to no agent", async () => {
    const { c, i, a, report } = await escalated();
    expect(await colony(c.id).getAgent(a.id)).toMatchObject({ state: "idle" });
    expect((await colony(c.id).getAgent(a.id))?.intentId).toBeUndefined();
    await eventually(() => pool(c.id).state(), (s) => s.released.includes(a.id));
    const field = (await region(c.id, "src").reading()) as FieldReading;
    expect(field.byPath["src/lib/util.ts"]?.claim ?? 0).toBe(0);
    expect(field.byPath["src/lib/util.ts"]?.failure ?? 0).toBe(0);
    // No agent is offered it, the reporter included.
    const b = await addAgent(c.id, "b");
    for (const agent of [a, b]) expect((await api("POST", `/colonies/${c.id}/agents/${agent.id}/take`)).body).toMatchObject({ wait: true, reason: "no open intents" });
    // One open report per intent.
    expect(await escalateIn(c.id, a.id, { intentId: i.id, kind: "other", report: "again" })).toMatch(/already has a report waiting for a person/);
    // Every read carries it: the snapshot, the intent with its history, the list of open reports.
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.intents.find((x) => x.id === i.id)?.escalation).toEqual({ kind: "broken-test", report, by: a.id, at: expect.any(Number) });
    const detail = (await api<{ intent: Intent; escalations: IntentEscalation[] }>("GET", `/colonies/${c.id}/intents/${i.id}`)).body;
    expect(detail.intent.escalation).toMatchObject({ kind: "broken-test" });
    expect(detail.escalations).toEqual([{ kind: "broken-test", report, by: a.id, at: expect.any(Number) }]);
    expect((await api("GET", `/colonies/${c.id}/escalations`)).body).toMatchObject({ colonyId: c.id, total: 1, intents: [{ id: i.id, escalation: { kind: "broken-test" } }] });
    const events = await recorded(c.id);
    expect(events.filter((ev) => ev.t === "escalation")).toEqual([expect.objectContaining({ intentId: i.id, agentId: a.id, kind: "broken-test", report, title: "Fix the router test" })]);
    expect(events.some((ev) => ev.t === "intent" && ev.intentId === i.id && ev.status === "open")).toBe(true);
  });

  it("a person dismisses it: the intent is offered again, and the answer is guidance for the next taker", async () => {
    const { c, i, a, report } = await escalated();
    const path = `/colonies/${c.id}/intents/${i.id}/escalation`;
    expect((await api("POST", path, { decision: "dismiss", note: "x" }, {})).status).toBe(401);
    expect((await api("POST", path, { decision: "dismiss" })).status).toBe(400);
    expect((await api("POST", path, { decision: "amend", note: "x" })).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/intents/int_nope/escalation`, { decision: "dismiss", note: "x" })).status).toBe(404);
    const note = "The test is right: 405 is in the spec's method table.";
    const res = await api<{ intent: Intent }>("POST", path, { decision: "dismiss", note, by: "matt" });
    expect(res.status).toBe(200);
    expect(res.body.intent).toMatchObject({ id: i.id, status: "open", escalation: { kind: "broken-test", report, by: a.id, resolved: { decision: "dismiss", by: "matt", note, at: expect.any(Number) } } });
    expect((await api("POST", path, { decision: "dismiss", note })).status).toBe(409);
    expect((await api("GET", `/colonies/${c.id}/escalations`)).body.total).toBe(0);
    const b = await addAgent(c.id, "b");
    expect((await take(c.id, b.id)).intent.id).toBe(i.id);
    expect(await colony(c.id).guidance(i.id)).toEqual([expect.objectContaining({ message: note, by: "matt" })]);
    const detail = (await api<{ escalations: IntentEscalation[] }>("GET", `/colonies/${c.id}/intents/${i.id}`)).body;
    expect(detail.escalations[0]?.resolved).toMatchObject({ decision: "dismiss", note });
    const events = (await recorded(c.id)).filter((ev) => ev.t === "escalation");
    expect(events[1]).toMatchObject({ intentId: i.id, agentId: a.id, kind: "broken-test", resolved: { decision: "dismiss", by: "matt", note } });
  });

  it("a person amends it (offered again at the new revision) or withdraws it", async () => {
    const { c, i } = await escalated();
    const res = await api<{ intent: Intent }>("POST", `/colonies/${c.id}/intents/${i.id}/escalation`, { decision: "amend", note: "the spec changed", by: "matt", amend: { why: "Return 404 for an unknown method" } });
    expect(res.status).toBe(200);
    expect(res.body.intent).toMatchObject({ status: "open", revision: 2, why: "Return 404 for an unknown method", escalation: { resolved: { decision: "amend", note: "the spec changed" } } });
    const detail = (await api<{ revisions: Array<{ revision: number; changed: string[]; reason: string; by: string }> }>("GET", `/colonies/${c.id}/intents/${i.id}`)).body;
    expect(detail.revisions).toEqual([expect.objectContaining({ revision: 2, changed: ["why"], reason: "the spec changed", by: "matt" })]);
    const b = await addAgent(c.id, "b");
    expect((await take(c.id, b.id)).intent).toMatchObject({ id: i.id, revision: 2 });

    const other = await escalated();
    const gone = await api<{ intent: Intent }>("POST", `/colonies/${other.c.id}/intents/${other.i.id}/escalation`, { decision: "withdraw", note: "not needed any more" });
    expect(gone.body.intent).toMatchObject({ status: "withdrawn", withdrawnReason: "not needed any more", escalation: { resolved: { decision: "withdraw" } } });
  });

  it("sends a change in flight for the intent back, and it never lands", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const got = await take(c.id, a.id);
    const p = await proposeEdit(c.id, got, a.id);
    expect(p.status).toBe("ready");
    await colony(c.id).escalate(a.id, { intentId: i.id, kind: "impossible", report: "the helper cannot return 2 and 3" });
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "returned", reason: "superseded: its agent reported the intent to a person (impossible)" });
    await tick(c.id, "src");
    expect((await trunk(c.id).state()).landings).toHaveLength(0);
    const field = (await region(c.id, "src").reading()) as FieldReading;
    expect(field.byPath["src/lib/util.ts"]?.failure ?? 0).toBe(0);
  });

  it("checks the report and that the agent holds the intent", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const b = await addAgent(c.id, "b");
    expect(await escalateIn(c.id, a.id, { kind: "broken-test", report: "x" })).toMatch(/you hold no intent/);
    await take(c.id, a.id);
    expect(await escalateIn(c.id, a.id, { kind: "bug", report: "x" })).toMatch(/kind must be one of broken-test, contradictory-spec, impossible, other/);
    expect(await escalateIn(c.id, a.id, { kind: "other", report: "   " })).toMatch(/a report is required/);
    expect(await escalateIn(c.id, b.id, { intentId: i.id, kind: "other", report: "x" })).toMatch(/is not held by/);
    expect(await escalateIn(c.id, "agt_nope", { intentId: i.id, kind: "other", report: "x" })).toMatch(/unknown agent/);
    expect(await escalateIn(c.id, a.id, { intentId: "int_nope", kind: "other", report: "x" })).toMatch(/unknown intent/);
    expect((await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${i.id}`)).body.intent).toMatchObject({ status: "claimed", assignedTo: a.id });
  });
});
