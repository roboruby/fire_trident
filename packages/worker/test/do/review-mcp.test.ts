import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Proposal } from "@fire_trident/core";
import worker from "../../src/index.ts";
import type { Env } from "../../src/env.ts";
import { DECISION_CODE_META } from "../../src/mcp/review/codes.ts";
import { addAgent, addIntent, colony, env, newColony, proposal, proposeEdit, take } from "./helpers.ts";

/**
 * The review endpoint through the Worker's own fetch handler (src/index.ts routes /mcp/review before /mcp/*) over the
 * real ColonyDO: a person lists what waits, reads a card built from the view the decide engine kept, and approves and
 * returns through ColonyDO.decide; the agents' MCP token is refused.
 */

const SITE = "https://ft.test";
const MCP_TOKEN = "test-mcp-token";
const testEnv = { ...env, FT_MCP_TOKEN: MCP_TOKEN } as unknown as Env;

const VIEW = {
  files: [{ path: "src/app/main.ts", status: "modified", added: 1, removed: 1, hunks: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const token = req.header('Authorization');\n export {};", truncated: false }],
  filesChanged: 1,
  danger: [{ path: "src/app/main.ts", line: 1, cls: "auth", pattern: "auth:authorization-header", label: "auth (authorization-header) at src/app/main.ts:1: const token = req.header('Authorization');" }],
  residual: [],
};

async function fetchWorker(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "reviewer", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${SITE}/mcp/review`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => fetchWorker(new Request(url, init)),
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; data: any; code: string | undefined }> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  const code = res._meta?.[DECISION_CODE_META];
  return { ok: res.isError !== true, text, data: res.structuredContent, code: typeof code === "string" ? code : undefined };
}

/** Two escalated proposals in a fresh colony, the first with the view the decide engine keeps for its reviewer. */
async function escalatedPair(): Promise<{ colonyId: string; a: Proposal; b: Proposal }> {
  const c = await newColony();
  await addIntent(c.id, ["src/app/main.ts"]);
  await addIntent(c.id, ["docs/guide.md"]);
  const x = await addAgent(c.id, "x");
  const y = await addAgent(c.id, "y");
  const a = await proposeEdit(c.id, await take(c.id, x.id), x.id);
  const b = await proposeEdit(c.id, await take(c.id, y.id), y.id);
  await colony(c.id).updateProposals([
    { id: a.id, patch: { status: "escalated" } },
    { id: b.id, patch: { status: "escalated" } },
  ]);
  await runInDurableObject(colony(c.id), (_instance: unknown, state: DurableObjectState) => {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS decide_review (proposal_id TEXT PRIMARY KEY, view TEXT NOT NULL, at INTEGER NOT NULL)");
    state.storage.sql.exec("INSERT OR REPLACE INTO decide_review (proposal_id, view, at) VALUES (?, ?, ?)", a.id, JSON.stringify(VIEW), Date.now());
  });
  return { colonyId: c.id, a, b };
}

async function humanDecision(colonyId: string, proposalId: string): Promise<Record<string, unknown> | undefined> {
  const answers = await runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) =>
    state.storage.sql.exec<{ answers: string }>("SELECT answers FROM decisions WHERE subject = ? AND layer = 'human' ORDER BY at DESC LIMIT 1", proposalId).toArray()[0]?.answers,
  );
  return typeof answers === "string" ? (JSON.parse(answers) as Record<string, unknown>) : undefined;
}

describe("review endpoint through the Worker", () => {
  it("a person lists what waits, reads a card, approves one and returns the other", async () => {
    const { colonyId, a, b } = await escalatedPair();
    const client = await connect("test-admin");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["decide", "review_card", "review_queue"]);

    const q = await call(client, "review_queue", { colony: colonyId });
    expect(q.ok).toBe(true);
    expect(q.data.waiting).toBe(2);
    expect(q.data.items.map((i: { proposalId: string }) => i.proposalId).sort()).toEqual([a.id, b.id].sort());
    expect(q.data.items.find((i: { proposalId: string }) => i.proposalId === a.id)).toMatchObject({ title: "Change src/app/main.ts", danger: 1, severe: true });

    const card = await call(client, "review_card", { colony: colonyId, proposalId: a.id });
    expect(card.ok).toBe(true);
    expect(card.data.look.danger[0]).toMatchObject({ where: "src/app/main.ts:1", what: ["auth (authorization-header)"] });
    expect(card.data.agent).toMatchObject({ kind: "synthetic" });
    expect(card.text).toContain("Look here first");

    // Without the card's code, nothing is decided: what a model can send.
    const bare = await call(client, "decide", { colony: colonyId, proposalId: a.id, decision: "approve", reason: "Read the header code.", by: "Matt S" });
    expect(bare.data.error).toMatchObject({ status: 403, message: `Decisions are made by clicking Approve or Return in the review view, or in the web review queue at ${SITE}/c/${colonyId}.` });
    expect((await proposal(colonyId, a.id)).status).toBe("escalated");

    expect(card.code).toBeDefined();
    const approved = await call(client, "decide", { colony: colonyId, proposalId: a.id, decision: "approve", reason: "Read the header code.", by: "Matt S", code: card.code });
    expect(approved.ok).toBe(true);
    expect(approved.text).toBe(`Approved by Matt S: ${a.id} rejoins its lane and lands on the next cycle.`);
    expect((await proposal(colonyId, a.id)).status).toBe("ready");
    expect(await humanDecision(colonyId, a.id)).toMatchObject({ decision: "approve", reason: "Read the header code.", by: "Matt S" });

    const bCard = await call(client, "review_card", { colony: colonyId, proposalId: b.id });
    expect(bCard.ok).toBe(true);
    const returned = await call(client, "decide", { colony: colonyId, proposalId: b.id, decision: "return", reason: "Say why the guide changes.", by: "Matt S", code: bCard.code });
    expect(returned.ok).toBe(true);
    const back = await proposal(colonyId, b.id);
    expect(back.status).toBe("returned");
    expect(back.reason).toBe("Say why the guide changes.");

    // Decided changes wait no more: a second decision is refused and nothing changes.
    const again = await call(client, "decide", { colony: colonyId, proposalId: a.id, decision: "return", reason: "changed my mind", by: "Matt S", code: card.code });
    expect(again.data.error).toMatchObject({ status: 409 });
    expect((await proposal(colonyId, a.id)).status).toBe("ready");
    expect((await call(client, "review_queue", { colony: colonyId })).data.waiting).toBe(0);
  });

  it("the colony spends a decision code once, in a table it creates on first use", async () => {
    const { colonyId, a } = await escalatedPair();
    const stub = colony(colonyId) as unknown as { spendReviewCode(nonce: string, proposalId: string, expiresAt: number): Promise<boolean> };
    const expiresAt = Date.now() + 60_000;
    expect(await stub.spendReviewCode("a".repeat(32), a.id, expiresAt)).toBe(true);
    expect(await stub.spendReviewCode("a".repeat(32), a.id, expiresAt)).toBe(false);
    expect(await stub.spendReviewCode("b".repeat(32), a.id, expiresAt - 1)).toBe(false);
  });

  it("refuses the agents' MCP token and no token; the agents' /mcp gate never sees /mcp/review", async () => {
    await expect(connect(MCP_TOKEN)).rejects.toThrow();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const agent = await fetchWorker(new Request(`${SITE}/mcp/review`, { method: "POST", headers: { ...headers, authorization: `Bearer ${MCP_TOKEN}` }, body }));
    expect(agent.status).toBe(401);
    expect(((await agent.json()) as { error: string }).error).toContain("the agents' MCP token does not open it");
    const none = await fetchWorker(new Request(`${SITE}/mcp/review`, { method: "POST", headers, body }));
    expect(none.status).toBe(401);
  });
});
