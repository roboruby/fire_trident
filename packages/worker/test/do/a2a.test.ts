import { runInDurableObject } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ColonySnapshot, Intent } from "@fire_trident/core";
import { a2aRoutes } from "../../src/api/a2a.ts";
import { createApi, requireAdmin, type ApiDeps, type ApiEnv } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";
import { AUTH, addAgent, api, colony, env, eventually, newColony, proposal, proposeEdit, take, tick, trunk, type Assignment } from "./helpers.ts";

/**
 * The Agent2Agent door against the real ColonyDO (FT_A2A): the agent card, SendMessage declaring an intent with the
 * admin token and refused without it, GetTask and ListTasks following the intent to its landing commit with no token,
 * CancelTask withdrawing it, each intent state's task state, a twin answered with the existing intent's task, and the
 * JSON-RPC errors. The routes are served by createApi, as the Worker serves them, with FT_A2A set on its env.
 */

/** The harness env with some Worker variables set, as a deployment's vars would set them. */
function withVars(vars: Record<string, string>): Env {
  return new Proxy(env, { get: (t, k) => (typeof k === "string" && k in vars ? vars[k] : Reflect.get(t, k)) }) as Env;
}
const ON = withVars({ FT_A2A: "on" });

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("colonies are made through the harness worker");
  },
  spawnSwarm: async () => ({}),
};
const full = new Hono<ApiEnv>();
full.route("/api", createApi(deps));

/** The routes alone with a short wait for a blocking SendMessage. */
function waiting(waitMs: number): Hono<ApiEnv> {
  const inner = new Hono<ApiEnv>();
  a2aRoutes(inner, requireAdmin, { waitMs, pollMs: 20 });
  const outer = new Hono<ApiEnv>();
  outer.route("/api", inner);
  return outer;
}

type Answer = { status: number; headers: Headers; body: any };

async function rpc(colonyId: string, method: string, params?: unknown, opts: { headers?: Record<string, string>; app?: Hono<ApiEnv>; vars?: Env; raw?: string; path?: string } = {}): Promise<Answer> {
  const body = opts.raw ?? JSON.stringify({ jsonrpc: "2.0", id: 7, method, ...(params !== undefined ? { params } : {}) });
  const res = await (opts.app ?? full).request(
    `https://ft.test/api/colonies/${colonyId}/a2a${opts.path ?? ""}`,
    { method: "POST", headers: { "content-type": "application/json", ...(opts.headers ?? AUTH) }, body },
    opts.vars ?? ON,
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function card(colonyId: string, vars: Env = ON): Promise<Answer> {
  const res = await full.request(`https://ft.test/api/colonies/${colonyId}/.well-known/agent-card.json`, {}, vars);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

let seq = 0;
/** SendMessage params: the text, a data part, and returnImmediately unless `wait`. */
function send(text: string, data: Record<string, unknown> = { footprint: ["src/lib/util.ts"] }, extra: { wait?: boolean; message?: Record<string, unknown> } = {}) {
  return {
    message: { messageId: `m-${++seq}`, role: "ROLE_USER", parts: [{ text }, { data }], ...(extra.message ?? {}) },
    ...(extra.wait ? {} : { configuration: { returnImmediately: true } }),
  };
}

/** Declare over A2A and answer the task. */
async function declare(colonyId: string, text = "Tidy util\nKeep helper as it is.", data?: Record<string, unknown>): Promise<any> {
  const res = await rpc(colonyId, "SendMessage", send(text, data));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.result.task;
}

/** GetTask with no token. */
async function task(colonyId: string, id: string, method = "GetTask"): Promise<any> {
  const res = await rpc(colonyId, method, { id }, { headers: {} });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.result;
}

const stateOf = (t: any): string => t.status.state;
const textOf = (t: any): string => t.status.message.parts[0].text;

/** Take, propose and land the colony's one open intent (src/lib/util.ts) with a synthetic agent. */
async function land(colonyId: string): Promise<{ got: Assignment; agentId: string; landingId: string; commit: string }> {
  const a = await addAgent(colonyId);
  const got = await take(colonyId, a.id);
  const p = await proposeEdit(colonyId, got, a.id);
  await tick(colonyId, "src");
  const landed = await proposal(colonyId, p.id);
  expect(landed.status).toBe("landed");
  const commit = (await trunk(colonyId).state()).landings.find((l) => l.id === landed.landingId)!.trunkSha;
  return { got, agentId: a.id, landingId: landed.landingId!, commit };
}

/** Set FT_TWINS on one colony's object, as a deployment variable would. */
async function twins(colonyId: string, value: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const self = instance as unknown as { env: object };
    self.env = new Proxy(self.env, { get: (t, k) => (k === "FT_TWINS" ? value : Reflect.get(t, k)) });
  });
}

describe("the agent card", () => {
  it("is public where FT_A2A covers the colony, and a 404 elsewhere", async () => {
    const c = await newColony();
    const res = await card(c.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: `FireTrident colony ${c.name}`,
      supportedInterfaces: [{ url: `https://ft.test/api/colonies/${c.id}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }, { protocolVersion: "0.3" }],
      securitySchemes: { adminToken: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
      skills: [{ id: "declare-intent" }],
    });
    expect(res.body.description).toContain(`(${c.id})`);
    for (const vars of [env, withVars({ FT_A2A: "off" }), withVars({ FT_A2A: "some-other-colony" })]) {
      const off = await card(c.id, vars);
      expect(off.status).toBe(404);
      expect(off.body.error).toBe(`the Agent2Agent door is off for colony ${c.id} (FT_A2A)`);
      expect((await rpc(c.id, "GetTask", { id: "int_x" }, { vars })).status).toBe(404);
    }
    expect(await card("no-such-colony")).toMatchObject({ status: 404, body: { error: "colony not found" } });
    expect((await rpc("no-such-colony", "GetTask", { id: "int_x" })).status).toBe(404);
    expect(await card(c.id, withVars({ FT_A2A: `x, ${c.id}` }))).toMatchObject({ status: 200 });
  });
});

describe("SendMessage", () => {
  it("declares an intent with the admin token, and refuses without it", async () => {
    const c = await newColony();
    const params = send("Tidy util\nKeep helper as it is.\nNo other file.", { footprint: ["src/lib/util.ts"], acceptance: ["helper() still returns 1"], priority: 2 });
    for (const headers of [{}, { authorization: "Bearer wrong" }] as Array<Record<string, string>>) {
      const refused = await rpc(c.id, "SendMessage", params, { headers });
      expect(refused.status).toBe(401);
      expect(refused.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(refused.body).toEqual({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32000, message: "SendMessage writes to the colony, and writes need the deployment's admin token: send it as an Authorization: Bearer header. GetTask and ListTasks need none." },
      });
    }
    // The token is checked before anything else is read.
    expect((await rpc(c.id, "SendMessage", { message: "not a message" }, { headers: {} })).status).toBe(401);
    expect((await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body.intents).toEqual([]);

    const ok = await rpc(c.id, "SendMessage", params);
    expect(ok.status).toBe(200);
    const t = ok.body.result.task;
    expect(t.id).toMatch(/^int_/);
    expect(t).toMatchObject({ contextId: c.id, status: { state: "TASK_STATE_SUBMITTED" }, metadata: { firetrident: { colony: c.id, intent: t.id, status: "open", createdBy: "a2a", source: "agent" } } });
    expect(textOf(t)).toBe(`Intent ${t.id} is open in colony ${c.id}: no agent has taken it yet. Follow it with GetTask; CancelTask withdraws it.`);
    const intent = (await colony(c.id).getIntent(t.id)) as Intent;
    expect(intent).toMatchObject({ title: "Tidy util", why: "Keep helper as it is.\nNo other file.", footprint: ["src/lib/util.ts"], acceptance: ["helper() still returns 1"], priority: 2, source: "agent", createdBy: "a2a", status: "open" });

    // 0.3: message/send answers the task itself, with kind and lowercase states.
    const old = await rpc(c.id, "message/send", { message: { kind: "message", messageId: "m-old", role: "user", parts: [{ kind: "text", text: "Tidy the guide" }, { kind: "data", data: { footprint: ["docs/guide.md"] } }] } });
    expect(old.body.result).toMatchObject({ kind: "task", contextId: c.id, status: { state: "submitted", message: { kind: "message", role: "agent" } } });
  });

  it("answers a twin with the existing intent's task and creates nothing, unless force", async () => {
    const c = await newColony();
    await twins(c.id, "on");
    const first = await declare(c.id, "Add rate limiting to /api/links\nAnonymous callers flood it.", { footprint: ["src/links/**"] });
    const twin = await rpc(c.id, "SendMessage", send("Rate-limit the links API\nCallers can flood it.", { footprint: ["src/links/handler.ts"] }));
    const t = twin.body.result.task;
    expect(t.id).toBe(first.id);
    expect(stateOf(t)).toBe("TASK_STATE_SUBMITTED");
    expect(textOf(t)).toBe(
      `Nothing new was declared: this message matches intent ${first.id} "Add rate limiting to /api/links", so this task follows that intent. To declare it anyway, send the message again with "force": true in a data part. Intent ${first.id} is open in colony ${c.id}: no agent has taken it yet. Follow it with GetTask; CancelTask withdraws it.`,
    );
    expect(t.metadata.firetrident).toMatchObject({ duplicateOf: first.id, similar: [{ id: first.id, score: 1 }] });
    const titled = (title: string) => api<ColonySnapshot>("GET", `/colonies/${c.id}`).then((s) => s.body.intents.filter((i) => i.title === title));
    expect(await titled("Rate-limit the links API")).toEqual([]);

    const forced = await rpc(c.id, "SendMessage", send("Rate-limit the links API", { footprint: ["src/links/handler.ts"], force: true }));
    expect(forced.body.result.task.id).not.toBe(first.id);
    expect(forced.body.result.task.metadata.firetrident).not.toHaveProperty("duplicateOf");
    expect(await titled("Rate-limit the links API")).toHaveLength(1);
  });

  it("waits for its task to end when blocking, and answers it as it stands when the wait runs out", async () => {
    const c = await newColony();
    // Nothing takes it: after the wait, still submitted, and the answer says to follow it.
    const short = await rpc(c.id, "SendMessage", send("Tidy util", undefined, { wait: true }), { app: waiting(150) });
    expect(stateOf(short.body.result.task)).toBe("TASK_STATE_SUBMITTED");
    expect(textOf(short.body.result.task)).toMatch(/^It is still submitted after 150 ms; an intent can take minutes, so follow it with GetTask\. Intent /);

    // An agent lands it while the call waits: the answer is the completed task.
    const d = await newColony();
    const pending = rpc(d.id, "SendMessage", send("Tidy util", undefined, { wait: true }), { app: waiting(15_000) });
    const a = await addAgent(d.id);
    const took = await eventually(
      () => api<Assignment | { wait: true }>("POST", `/colonies/${d.id}/agents/${a.id}/take`),
      (r) => !("wait" in r.body),
    );
    const got = took.body as Assignment;
    await proposeEdit(d.id, got, a.id);
    await tick(d.id, "src");
    const done = (await pending).body.result.task;
    expect(done.id).toBe(got.intent.id);
    expect(stateOf(done)).toBe("TASK_STATE_COMPLETED");
    expect(done.artifacts[0].parts[1].data.commit).toBe((await trunk(d.id).state()).head);

    // 0.3 does not block unless asked.
    const old = await rpc(c.id, "message/send", { message: { messageId: "m-x", role: "user", parts: [{ text: "Tidy the guide" }, { data: { footprint: ["docs/guide.md"] } }] } }, { app: waiting(10_000) });
    expect(old.body.result.status.state).toBe("submitted");
  });
});

describe("GetTask and ListTasks", () => {
  it("follow the intent to its landing commit with no token", async () => {
    const c = await newColony();
    const t = await declare(c.id);
    expect(stateOf(await task(c.id, t.id))).toBe("TASK_STATE_SUBMITTED");

    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    expect(got.intent.id).toBe(t.id);
    const claimed = await task(c.id, t.id);
    expect(stateOf(claimed)).toBe("TASK_STATE_WORKING");
    expect(textOf(claimed)).toBe(`An agent took intent ${t.id} and is working on it. Follow it with GetTask.`);

    const p = await proposeEdit(c.id, got, a.id);
    expect(stateOf(await task(c.id, t.id))).toBe("TASK_STATE_WORKING");
    await tick(c.id, "src");
    const landed = await proposal(c.id, p.id);
    const commit = (await trunk(c.id).state()).landings.find((l) => l.id === landed.landingId)!.trunkSha;

    const done = await task(c.id, t.id);
    expect(stateOf(done)).toBe("TASK_STATE_COMPLETED");
    const why = `https://ft.test/api/colonies/${c.id}/why?path=src%2Flib%2Futil.ts`;
    expect(textOf(done)).toBe(`Intent ${t.id} landed in trunk commit ${commit} (landing ${landed.landingId}). Read why each file changed with ft why ${c.id} src/lib/util.ts, or GET ${why}.`);
    expect(done.artifacts).toHaveLength(1);
    expect(done.artifacts[0].parts[1].data).toMatchObject({ landing: landed.landingId, commit, proposal: p.id, files: [{ path: "src/lib/util.ts", why }], whyCommand: `ft why ${c.id} src/lib/util.ts` });
    // The why link answers.
    expect((await api("GET", `/colonies/${c.id}/why?path=src%2Flib%2Futil.ts`, undefined, {})).status).toBe(200);

    // 0.3's tasks/get: the same task in 0.3's shapes.
    const old = await task(c.id, t.id, "tasks/get");
    expect(old).toMatchObject({ kind: "task", id: t.id, status: { state: "completed" }, artifacts: [{ parts: [{ kind: "text" }, { kind: "data", data: { commit } }] }] });

    // ListTasks: public, newest update first, artifacts only when asked.
    const listed = await rpc(c.id, "ListTasks", {}, { headers: {} });
    expect(listed.body.result).toMatchObject({ nextPageToken: "", pageSize: 50, totalSize: 1 });
    expect(listed.body.result.tasks.map((x: any) => [x.id, stateOf(x)])).toEqual([[t.id, "TASK_STATE_COMPLETED"]]);
    expect(listed.body.result.tasks[0]).not.toHaveProperty("artifacts");
    const withArtifacts = await rpc(c.id, "ListTasks", { includeArtifacts: true }, { headers: {} });
    expect(withArtifacts.body.result.tasks[0].artifacts[0].parts[1].data.commit).toBe(commit);
    expect((await rpc(c.id, "ListTasks", { status: "TASK_STATE_SUBMITTED" }, { headers: {} })).body.result).toEqual({ tasks: [], nextPageToken: "", pageSize: 50, totalSize: 0 });
    expect((await rpc(c.id, "ListTasks", { status: "TASK_STATE_COMPLETED" }, { headers: {} })).body.result.totalSize).toBe(1);
    expect((await rpc(c.id, "ListTasks", { contextId: "another-context" }, { headers: {} })).body.result.tasks).toEqual([]);

    // A landing the colony no longer keeps: the trunk writer names the commit.
    await runInDurableObject(colony(c.id), (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("DELETE FROM landings");
    });
    expect((await task(c.id, t.id)).artifacts[0].parts[1].data.commit).toBe(commit);
  });

  it("reads an agent's report waiting for a person as input-required", async () => {
    const c = await newColony();
    const t = await declare(c.id);
    const a = await addAgent(c.id);
    await take(c.id, a.id);
    await colony(c.id).escalate(a.id, { kind: "broken-test", report: "The test expects helper() to return 2." });
    const blocked = await task(c.id, t.id);
    expect(stateOf(blocked)).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(textOf(blocked)).toMatch(/^An agent reported that intent int_\w+ cannot be done as written \(broken-test\), so no agent takes it until a person answers/);
    expect(blocked.metadata.firetrident.report).toMatchObject({ kind: "broken-test", report: "The test expects helper() to return 2.", by: a.id });
    expect((await rpc(c.id, "ListTasks", { status: "TASK_STATE_INPUT_REQUIRED" }, { headers: {} })).body.result.tasks.map((x: any) => x.id)).toEqual([t.id]);
    // A person's dismissal reopens it: submitted again.
    await api("POST", `/colonies/${c.id}/intents/${t.id}/escalation`, { decision: "dismiss", note: "The test is right." });
    expect(stateOf(await task(c.id, t.id))).toBe("TASK_STATE_SUBMITTED");
  });

  it("pages newest update first, filters by time, and leaves vaccines out", async () => {
    const c = await newColony();
    const ids: string[] = [];
    for (const path of ["src/a.ts", "src/b.ts", "docs/c.md"]) ids.push((await declare(c.id, `Write ${path}`, { footprint: [path] })).id);
    const first = (await rpc(c.id, "ListTasks", { pageSize: 2 }, { headers: {} })).body.result;
    expect(first.tasks).toHaveLength(2);
    expect(first.totalSize).toBe(3);
    expect(first.pageSize).toBe(2);
    expect(first.nextPageToken).not.toBe("");
    const second = (await rpc(c.id, "ListTasks", { pageSize: 2, pageToken: first.nextPageToken }, { headers: {} })).body.result;
    expect(second.tasks).toHaveLength(1);
    expect(second.nextPageToken).toBe("");
    const seen = [...first.tasks, ...second.tasks].map((x: any) => x.id);
    expect([...seen].sort()).toEqual([...ids].sort());
    const times = [...first.tasks, ...second.tasks].map((x: any) => Date.parse(x.status.timestamp));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect((await rpc(c.id, "ListTasks", { statusTimestampAfter: new Date(Date.now() + 60_000).toISOString() }, { headers: {} })).body.result.tasks).toEqual([]);
    expect((await rpc(c.id, "ListTasks", { pageSize: 500 }, { headers: {} })).body.result.pageSize).toBe(100);

    await runInDurableObject(colony(c.id), (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE intents SET created_by = 'vaccine' WHERE id = ?", ids[0]);
    });
    expect((await rpc(c.id, "ListTasks", {}, { headers: {} })).body.result.totalSize).toBe(2);
    expect((await rpc(c.id, "GetTask", { id: ids[0] }, { headers: {} })).body.error.code).toBe(-32001);
  });
});

describe("CancelTask", () => {
  it("withdraws the intent with the admin token: canceled, and the same again on a repeat", async () => {
    const c = await newColony();
    const t = await declare(c.id);
    const refused = await rpc(c.id, "CancelTask", { id: t.id }, { headers: {} });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toMatchObject({ code: -32000, message: expect.stringMatching(/^CancelTask writes to the colony, and writes need the deployment's admin token/) });

    const canceled = await rpc(c.id, "CancelTask", { id: t.id, metadata: { reason: "plan changed" } });
    expect(stateOf(canceled.body.result)).toBe("TASK_STATE_CANCELED");
    expect(textOf(canceled.body.result)).toBe(`Intent ${t.id} was withdrawn by CancelTask (plan changed): its needs are gone and no agent will take it.`);
    expect((await colony(c.id).getIntent(t.id)) as Intent).toMatchObject({ status: "withdrawn", withdrawnReason: "canceled over A2A: plan changed" });
    expect(stateOf(await task(c.id, t.id))).toBe("TASK_STATE_CANCELED");
    expect(stateOf((await rpc(c.id, "CancelTask", { id: t.id })).body.result)).toBe("TASK_STATE_CANCELED");
    expect((await rpc(c.id, "tasks/cancel", { id: t.id })).body.result).toMatchObject({ kind: "task", status: { state: "canceled" } });
  });

  it("reads a person's withdrawal as failed, and refuses to cancel a failed or completed task", async () => {
    const c = await newColony();
    const t = await declare(c.id);
    await api("POST", `/colonies/${c.id}/intents/${t.id}/withdraw`, { reason: "superseded by the new plan" });
    const failed = await task(c.id, t.id);
    expect(stateOf(failed)).toBe("TASK_STATE_FAILED");
    expect(textOf(failed)).toBe(`Intent ${t.id} was withdrawn: superseded by the new plan. It will not land; send a new message to declare the work again.`);
    const no = await rpc(c.id, "CancelTask", { id: t.id });
    expect(no.body.error).toEqual({ code: -32002, message: `task ${t.id} is failed: ${textOf(failed)}` });

    const d = await newColony();
    const u = await declare(d.id);
    const { commit } = await land(d.id);
    const late = await rpc(d.id, "CancelTask", { id: u.id });
    expect(late.body.error.code).toBe(-32002);
    expect(late.body.error.message).toContain(`task ${u.id} is completed: Intent ${u.id} landed in trunk commit ${commit}`);
    expect(((await colony(d.id).getIntent(u.id)) as Intent).status).toBe("landed");
    expect((await rpc(d.id, "CancelTask", { id: "int_missing" })).body.error.code).toBe(-32001);
  });
});

describe("JSON-RPC errors", () => {
  it("answers each malformed request, unknown method and bad param with its standard code", async () => {
    const c = await newColony();
    const code = async (method: string, params?: unknown, opts: Parameters<typeof rpc>[3] = {}) => {
      const res = await rpc(c.id, method, params, opts);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.error as { code: number; message: string };
    };
    expect(await rpc(c.id, "", undefined, { raw: "{not json" })).toMatchObject({ status: 200, body: { jsonrpc: "2.0", id: null, error: { code: -32700 } } });
    expect((await code("", undefined, { raw: "[]" })).code).toBe(-32600);
    expect((await code("", undefined, { raw: JSON.stringify({ jsonrpc: "2.0", method: "GetTask", params: { id: "x" } }) })).message).toMatch(/needs an id/);
    expect((await code("", undefined, { raw: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "GetTask" }) })).code).toBe(-32600);
    expect(await code("tasks/reticulate")).toEqual({ code: -32601, message: 'no method "tasks/reticulate": this agent answers SendMessage, GetTask, ListTasks and CancelTask' });
    expect((await code("GetTask", ["x"])).code).toBe(-32602);
    expect((await code("GetTask", {})).message).toMatch(/params.id is required/);
    expect((await code("GetTask", { id: "int_missing" })).code).toBe(-32001);
    expect((await code("GetTask", { id: "int_missing", historyLength: -1 })).code).toBe(-32602);
    expect((await code("SendMessage", send("Tidy util", { acceptance: ["x"] }))).message).toMatch(/needs a footprint/);
    expect((await code("SendMessage", { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "x" }, { url: "https://example.com/a.png" }] } })).code).toBe(-32005);
    expect((await code("SendMessage", { ...send("Tidy util"), configuration: { returnImmediately: true, taskPushNotificationConfig: { url: "https://example.com/hook" } } })).code).toBe(-32003);
    expect((await code("SendMessage", { ...send("Tidy util"), configuration: { returnImmediately: true, acceptedOutputModes: ["image/png"] } })).code).toBe(-32005);
    expect((await code("SendStreamingMessage", send("Tidy util"))).code).toBe(-32004);
    expect((await code("SubscribeToTask", { id: "x" })).code).toBe(-32004);
    expect((await code("CreateTaskPushNotificationConfig", {})).code).toBe(-32003);
    expect((await code("GetExtendedAgentCard", {})).code).toBe(-32007);
    expect((await code("ListTasks", { pageToken: "not-a-token" })).message).toMatch(/pageToken is not one this agent gave/);
    expect((await code("ListTasks", { status: "TASK_STATE_DONE" })).code).toBe(-32602);
    expect((await code("ListTasks", { statusTimestampAfter: "yesterday" })).code).toBe(-32602);
    expect((await code("GetTask", { id: "x" }, { headers: { ...AUTH, "A2A-Version": "2.0" } })).code).toBe(-32009);
    expect((await rpc(c.id, "GetTask", { id: "int_missing" }, { path: "?A2A-Version=1.0" })).body.error.code).toBe(-32001);

    // A message on an existing task is a follow-up, which this door does not take.
    const t = await declare(c.id);
    expect(await code("SendMessage", send("More detail", undefined, { message: { taskId: t.id } }))).toEqual({
      code: -32004,
      message: `this agent takes no follow-up messages on a task: CancelTask ${t.id} and send a new message, or follow it with GetTask`,
    });
    expect((await code("SendMessage", send("More detail", undefined, { message: { taskId: "int_missing" } }))).code).toBe(-32001);
    expect((await code("SendMessage", send("Tidy util", undefined, { message: { contextId: "ctx-elsewhere" } }))).message).toBe(`this colony keeps one context, ${c.id}: send contextId "${c.id}" or none`);
    expect((await rpc(c.id, "SendMessage", send("Tidy docs", { footprint: ["docs/guide.md"] }, { message: { contextId: c.id } }))).body.result.task.contextId).toBe(c.id);
  });
});
