import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, EventsPage, Proposal } from "@fire_trident/core";
import { FireTridentTools, type McpColonyRpc, type McpTrunkRpc, type Session, type ToolContext } from "../../src/mcp/tools.ts";
import { PROPOSE_REPLAY_NOTE } from "../../src/mcp/replay.ts";
import { addAgent, addIntent, api, colony, fakeSha, newColony, proposal, take, tick, trunk } from "./helpers.ts";
import type { Assignment } from "./helpers.ts";

/**
 * The retry contract: a propose replayed after its reply was lost (the same intent, head and content) gets the
 * proposal the first call made, and the colony records no second proposal and no second event, through the HTTP route
 * and through MCP propose, before and after the change lands.
 */

/** The colony's recorded proposal and intent events (metric and field samples come and go with time). */
async function changeEvents(colonyId: string): Promise<ColonyEvent[]> {
  const page = (await api<EventsPage>("GET", `/colonies/${colonyId}/events?limit=5000`)).body;
  return page.events.filter((e) => e.t === "proposal" || e.t === "intent" || e.t === "landing");
}

async function proposals(colonyId: string): Promise<number> {
  return (await api<{ metrics: Record<string, number> }>("GET", `/colonies/${colonyId}`)).body.metrics["proposals"] ?? 0;
}

/** A proposal body for an assignment at a fixed head commit, as an external agent posts it. */
async function body(colonyId: string, a: Assignment, agentId: string, headSha: string, blob: string): Promise<Record<string, unknown>> {
  return {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha,
    writeSet: [{ path: "src/lib/util.ts", blob }],
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, ["src/lib/util.ts"]),
    declared: { footprint: ["src/lib/util.ts"], summary: "edit" },
    evidence: { notVerified: "Not verified: anything beyond the edit" },
  };
}

/** MCP tools for one session on the real colony, taking inline changes; `session` reads and replaces what it stores. */
function mcp(): { tools: FireTridentTools; session: { get: () => Session; set: (s: Session) => void } } {
  let stored: Session = { reads: {}, proposals: [] };
  const ctx: ToolContext = {
    colony: (id) => colony(id) as unknown as McpColonyRpc,
    region: () => {
      throw new Error("not used");
    },
    trunk: (id) => trunk(id) as unknown as McpTrunkRpc,
    repo: async () => {
      throw new Error("an inline change reads no workspace");
    },
    inline: () => true,
    load: async () => structuredClone(stored),
    save: async (s) => {
      stored = structuredClone(s);
    },
    now: () => Date.now(),
    sleep: async () => undefined,
  };
  return { tools: new FireTridentTools(ctx), session: { get: () => structuredClone(stored), set: (s) => void (stored = structuredClone(s)) } };
}

type ProposeAnswer = { proposal: { id: string; status: string }; replayed?: boolean; note?: string; writeSet: unknown[] };

describe("a propose replayed after a lost reply", () => {
  it("over HTTP gets the same proposal and no second event, before and after it lands", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "http");
    const got = await take(c.id, a.id);
    const head = fakeSha();
    const blob = fakeSha();
    const first = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, head, blob));
    expect(first.status).toBe(201);
    const before = await changeEvents(c.id);
    expect(before.filter((e) => e.t === "proposal" && e.proposalId === first.body.id).length).toBeGreaterThan(0);

    const again = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, head, blob));
    expect(again).toMatchObject({ status: 201, body: { id: first.body.id, headSha: head } });
    expect(await changeEvents(c.id)).toEqual(before);
    expect(await proposals(c.id)).toBe(1);

    await tick(c.id, "src");
    expect((await proposal(c.id, first.body.id)).status).toBe("landed");
    const landed = await changeEvents(c.id);
    const late = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, await body(c.id, got, a.id, head, blob));
    expect(late.body).toMatchObject({ id: first.body.id, status: "landed" });
    expect(await changeEvents(c.id)).toEqual(landed);
    expect(await proposals(c.id)).toBe(1);
    expect((await trunk(c.id).state()).landings.filter((l) => l.proposalIds.includes(first.body.id))).toHaveLength(1);
  });

  it("over MCP gets the same proposal, marked replayed, and no second event, before and after it lands", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const { tools } = mcp();
    await tools.join({ colony: c.id, name: "outside" });
    await tools.take({});
    const files = [{ path: "src/lib/util.ts", content: "export const helper = 2;\n" }];
    const first = (await tools.propose({ files, notVerified: "the tests" })) as ProposeAnswer;
    expect(first.replayed).toBeUndefined();
    const before = await changeEvents(c.id);

    // The reply was lost: the agent sends the same call again. Its session gave up the intent with the first call.
    const again = (await tools.propose({ files, notVerified: "the tests" })) as ProposeAnswer;
    expect(again).toMatchObject({ proposal: { id: first.proposal.id, status: first.proposal.status }, replayed: true, note: PROPOSE_REPLAY_NOTE, writeSet: first.writeSet });
    expect(await changeEvents(c.id)).toEqual(before);
    expect(await proposals(c.id)).toBe(1);

    await tick(c.id, "src");
    expect((await proposal(c.id, first.proposal.id)).status).toBe("landed");
    const landed = await changeEvents(c.id);
    const late = (await tools.propose({ files, notVerified: "the tests" })) as ProposeAnswer;
    expect(late).toMatchObject({ proposal: { id: first.proposal.id, status: "landed" }, replayed: true });
    expect(await changeEvents(c.id)).toEqual(landed);
    expect(await proposals(c.id)).toBe(1);
  });

  it("over MCP gets the same proposal when the session lost its own write, from the colony's repeat rule", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const { tools, session } = mcp();
    await tools.join({ colony: c.id, name: "outside" });
    await tools.take({});
    const held = session.get();
    const files = [{ path: "src/lib/util.ts", content: "export const helper = 3;\n" }];
    const first = (await tools.propose({ files })) as ProposeAnswer;
    const before = await changeEvents(c.id);
    // The colony took the change, but the session's own record of it was lost: it still holds the intent.
    session.set(held);
    const again = (await tools.propose({ files })) as ProposeAnswer;
    expect(again.proposal.id).toBe(first.proposal.id);
    expect(await changeEvents(c.id)).toEqual(before);
    expect(await proposals(c.id)).toBe(1);
  });

  it("over MCP refuses a different change from a session that holds no intent, as before", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const { tools } = mcp();
    await tools.join({ colony: c.id, name: "outside" });
    await tools.take({});
    await tools.propose({ files: [{ path: "src/lib/util.ts", content: "export const helper = 4;\n" }] });
    for (const other of [{ files: [{ path: "src/lib/util.ts", content: "export const helper = 5;\n" }] }, { files: [{ path: "src/lib/other.ts", content: "x\n" }] }, { headSha: fakeSha() }]) {
      await expect(tools.propose(other)).rejects.toThrow("[ft:400] you hold no intent; call take first");
    }
    expect(await proposals(c.id)).toBe(1);
  });
});

describe("a propose retried while the first call is still in flight", () => {
  it("over HTTP gets the same proposal, never a second one", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "eager");
    const got = await take(c.id, a.id);
    const sent = await body(c.id, got, a.id, fakeSha(), fakeSha());
    // The next propose reads the deployment's pause switch from another object again, so the calls overlap there.
    await runInDurableObject(colony(c.id), (instance: unknown) => {
      const o = instance as { pauseSwitch: { readAt: number } | null };
      if (o.pauseSwitch) o.pauseSwitch.readAt = 0;
    });
    const answers = await Promise.all([1, 2, 3].map(() => api<Proposal>("POST", `/colonies/${c.id}/proposals`, sent)));
    expect(answers.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(answers.map((r) => r.body.id)).size).toBe(1);
    expect(await proposals(c.id)).toBe(1);
    const events = (await changeEvents(c.id)).filter((e) => e.t === "proposal");
    expect(new Set(events.map((e) => (e.t === "proposal" ? e.proposalId : "")))).toEqual(new Set([answers[0]!.body.id]));
  });
});
