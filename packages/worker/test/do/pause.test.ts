import { runInDurableObject } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { blobId, changesetId } from "@fire_trident/core";
import type { ColonyEvent, ColonySnapshot, FileVersion, Intent, Path, Proposal } from "@fire_trident/core";
import { createApi, type ApiDeps, type ApiEnv } from "../../src/api/app.ts";
import { ColonyDO } from "../../src/colony/ColonyDO.ts";
import type { PauseView } from "../../src/colony/pause.ts";
import type { Env } from "../../src/env.ts";
import { AUTH, addAgent, addIntent, api, colony, env, headSha, newColony, proposal, proposeEdit, region, take, tick, type Assignment } from "./helpers.ts";

/**
 * The pause switch against the real ColonyDO and RegionDO (colony/pause.ts): a person pauses a colony's agents with a
 * reason; every agent door is refused with one sentence while reads and every person's action go on; the lane holds
 * what is in it until a person resumes; the pause and the resume are in the event record; and the pause is stored, so
 * an object started again over the same storage is still paused.
 */

const sentence = (by: string, reason: string) => `Agents are paused in this colony by ${by}: ${reason}. Reads still work; wait for a person to resume.`;

/** The message an RPC call was refused with (null when it was not refused). */
async function refused(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function pause(colonyId: string, reason = "demo reset", by = "maya") {
  return api("POST", `/colonies/${colonyId}/pause`, { reason, by });
}

async function resume(colonyId: string, by = "maya") {
  return api("POST", `/colonies/${colonyId}/resume`, { by });
}

/** A well-formed inline change for an assignment (innate checks pass, so only the policy decides). */
function inlineChange(colonyId: string, a: Assignment, agentId: string, path: Path, text: string) {
  const writeSet: FileVersion[] = [{ path, blob: blobId(text) }];
  return {
    colonyId,
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: [],
    declared: { footprint: a.intent.footprint, summary: "inline" },
    evidence: { notVerified: "Not verified: anything beyond the edit" },
    contents: { [blobId(text)]: text },
  };
}

/** The Worker's API as createApi serves it, with Worker variables set (FT_A2A for the Agent2Agent door). */
const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("colonies are made through the harness worker");
  },
  spawnSwarm: async () => ({ started: 1 }),
};
const app = new Hono<ApiEnv>();
app.route("/api", createApi(deps));
const A2A_ON = new Proxy(env, { get: (t, k) => (k === "FT_A2A" ? "on" : Reflect.get(t, k)) }) as Env;

async function a2a(colonyId: string, method: string, params: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(
    `https://ft.test/api/colonies/${colonyId}/a2a`,
    { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
    A2A_ON,
  );
  return { status: res.status, body: await res.json() };
}

describe("pausing a colony's agents", () => {
  it("refuses every agent door with one sentence, while reads and a person's actions go on", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const b = await addAgent(c.id, "b");
    await addIntent(c.id, ["src/lib/util.ts"]);
    const got = await take(c.id, a.id);
    const later = await addIntent(c.id, ["docs/guide.md"]);
    const task = (await a2a(c.id, "SendMessage", { message: { role: "ROLE_USER", messageId: "m1", parts: [{ text: "Tidy the guide\nIt is long." }, { data: { footprint: ["docs/guide.md"] } }] }, configuration: { returnImmediately: true } })).body.result.task;
    expect(task.id).toMatch(/^int_/);

    const paused = await pause(c.id);
    expect(paused.status).toBe(201);
    expect(paused.body).toMatchObject({ colonyId: c.id, already: false, pause: { scope: "colony", by: "maya", reason: "demo reset" } });
    // A second pause stands as the first one is: its who and why are kept.
    expect((await pause(c.id, "another reason", "lee")).body).toMatchObject({ already: true, pause: { by: "maya", reason: "demo reset" } });
    const no = sentence("maya", "demo reset");

    // Agent doors: take, propose, an agent's declaration, a report, platform-run agents, a swarm, the Agent2Agent writes.
    expect(await api("POST", `/colonies/${c.id}/agents/${b.id}/take`)).toEqual({ status: 409, body: { error: no } });
    const propose = await api("POST", `/colonies/${c.id}/proposals`, {
      intentId: got.intent.id,
      agentId: a.id,
      workspace: got.lease.repo,
      baseSha: got.lease.baseSha,
      headSha: "f".repeat(40),
      writeSet: [{ path: "src/lib/util.ts", blob: "e".repeat(40) }],
      readSet: [],
      declared: { footprint: got.intent.footprint, summary: "edit" },
    });
    expect(propose).toEqual({ status: 409, body: { error: no } });
    expect(await api("POST", `/colonies/${c.id}/intents`, { title: "An agent's idea", why: "x", footprint: ["src/x.ts"], source: "agent" })).toEqual({ status: 409, body: { error: no } });
    expect(await refused(colony(c.id).escalate(a.id, { kind: "impossible", report: "the test asks for two answers" }))).toBe(`[ft:409] ${no}`);
    expect(await api("POST", `/colonies/${c.id}/agents`, { name: "synthetic", kind: "synthetic" })).toEqual({ status: 409, body: { error: no } });
    expect(await api("POST", `/colonies/${c.id}/swarm`, { count: 2 })).toEqual({ status: 409, body: { error: no } });
    for (const [method, params] of [
      ["SendMessage", { message: { role: "ROLE_USER", messageId: "m2", parts: [{ text: "More work" }, { data: { footprint: ["src/y.ts"] } }] } }],
      ["CancelTask", { id: task.id }],
    ] as const) {
      const r = await a2a(c.id, method, params);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: -32000, message: no });
    }
    // The colony itself refuses an Agent2Agent cancel, whatever door it came through.
    expect(await refused(colony(c.id).withdrawIntent(task.id, { reason: "cancel", by: "a2a" }))).toBe(`[ft:409] ${no}`);

    // Reads, and what keeps an agent's place: the snapshot (with the pause), the switch, the field, a proposal, the inbox, a heartbeat, joining.
    const snap = await api<ColonySnapshot>("GET", `/colonies/${c.id}`);
    expect(snap.status).toBe(200);
    expect(snap.body.pauses).toEqual([{ scope: "colony", by: "maya", reason: "demo reset", at: paused.body.pause.at }]);
    expect((await api<PauseView>("GET", `/colonies/${c.id}/pause`, undefined, {})).body).toMatchObject({ paused: true, refusal: no });
    expect((await api("GET", `/colonies/${c.id}/field`)).status).toBe(200);
    expect((await api("GET", `/colonies/${c.id}/agents/${a.id}/inbox`)).status).toBe(200);
    expect((await api("GET", `/colonies/${c.id}/intents/${later.id}`)).status).toBe(200);
    expect((await a2a(c.id, "GetTask", { id: task.id })).body.result.id).toBe(task.id);
    expect((await api("POST", `/colonies/${c.id}/agents/${a.id}/heartbeat`)).status).toBe(200);
    expect((await api("POST", `/colonies/${c.id}/agents`, { name: "visitor", kind: "external" })).status).toBe(201);

    // A person's actions: declare, amend, withdraw.
    expect((await api("POST", `/colonies/${c.id}/intents`, { title: "A person's intent", why: "x", footprint: ["src/z.ts"] })).status).toBe(201);
    expect((await api("PATCH", `/colonies/${c.id}/intents/${later.id}`, { priority: 4, reason: "matters more" })).status).toBe(200);
    expect((await api<{ intent: Intent }>("POST", `/colonies/${c.id}/intents/${task.id}/withdraw`, { reason: "not now" })).body.intent.status).toBe("withdrawn");

    // Resume: the doors open again.
    const resumed = await resume(c.id);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ already: false, pauses: [], resumed: { scope: "colony", paused: false, by: "maya", pausedAt: paused.body.pause.at } });
    expect((await resume(c.id)).body).toMatchObject({ already: true, resumed: null });
    expect((await take(c.id, b.id)).intent.id).toBe(later.id);
    expect((await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body.pauses).toBeUndefined();
  });

  it("asks for a reason, and only the admin token pauses or resumes", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/pause`, {})).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/pause`, { reason: "   " })).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/pause`, { reason: "x" }, {})).status).toBe(401);
    expect((await api("POST", `/colonies/${c.id}/resume`, {}, {})).status).toBe(401);
    expect((await api("POST", "/colonies/no-such-colony/pause", { reason: "x" })).status).toBe(404);
    // Who paused, from the token's holder by default; a reason is one line.
    expect((await api("POST", `/colonies/${c.id}/pause`, { reason: "line one\nline two" })).body.pause).toMatchObject({ by: "api", reason: "line one line two" });
  });

  it("holds the lane while paused, and lands what waited once a person resumes", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    await addIntent(c.id, ["src/lib/util.ts"]);
    const got = await take(c.id, a.id);
    const p = await proposeEdit(c.id, got, a.id);
    expect(p.status).toBe("ready");
    const head = await headSha(c.id);

    await pause(c.id, "hold the trunk");
    expect(await tick(c.id, "src")).toBe(true);
    expect((await proposal(c.id, p.id)).status).toBe("ready");
    expect((await region(c.id, "src").status()).lane).toBe(1);
    expect(await headSha(c.id)).toBe(head);
    // Held, not failed: another tick holds again without counting an attempt.
    expect(await tick(c.id, "src")).toBe(true);
    expect((await proposal(c.id, p.id)).status).toBe("ready");

    await resume(c.id);
    expect(await tick(c.id, "src")).toBe(true);
    expect((await proposal(c.id, p.id)).status).toBe("landed");
    expect(await headSha(c.id)).not.toBe(head);
  });

  it("lets a person approve a change while paused; it waits in its lane until the resume", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, { enabled: false, protectedPaths: ["src/lib/**"] })).status).toBe(200);
    const a = await addAgent(c.id, "a");
    await addIntent(c.id, ["src/lib/util.ts"]);
    const got = await take(c.id, a.id);
    const made = (await colony(c.id).propose(inlineChange(c.id, got, a.id, "src/lib/util.ts", "export function helper() {\n  return 2;\n}\n"))) as Proposal;
    let p = await proposal(c.id, made.id);
    for (let i = 0; i < 60 && p.status === "checking"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      p = await proposal(c.id, made.id);
    }
    expect(p.status).toBe("escalated");

    await pause(c.id);
    expect((await api("POST", `/colonies/${c.id}/review/${made.id}`, { decision: "approve", reason: "looks right", by: "maya" })).status).toBe(200);
    expect((await proposal(c.id, made.id)).status).toBe("ready");
    await tick(c.id, "src");
    expect((await proposal(c.id, made.id)).status).toBe("ready");
    await resume(c.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, made.id)).status).toBe("landed");
  });

  it("records the pause and the resume in the colony's event record", async () => {
    const c = await newColony();
    const paused = await pause(c.id, "spend check", "ops");
    await resume(c.id, "maya");
    const page = await api<{ events: Array<ColonyEvent & { seq: number }> }>("GET", `/colonies/${c.id}/events?source=recorded`);
    const mine = page.body.events.filter((e) => e.t === "paused" || e.t === "resumed").map(({ seq: _seq, at: _at, ...e }) => e);
    expect(mine).toEqual([
      { t: "paused", scope: "colony", by: "ops", reason: "spend check" },
      { t: "resumed", scope: "colony", by: "maya", pausedAt: paused.body.pause.at },
    ]);
  });

  it("keeps the pause in storage: an object started again over it is still paused", async () => {
    const c = await newColony();
    await pause(c.id, "overnight", "maya");
    const view = (await runInDurableObject(colony(c.id), async (_instance: ColonyDO, state: DurableObjectState) => new ColonyDO(state, env).pauseState())) as PauseView;
    expect(view).toMatchObject({ paused: true, pauses: [{ scope: "colony", by: "maya", reason: "overnight" }], refusal: sentence("maya", "overnight") });
  });
});
