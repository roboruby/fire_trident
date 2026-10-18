import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, EscalationKind, Id, Intent, IntentEscalation, WorkspaceLease } from "@fire_trident/core";
import type { TakeResult } from "../../src/agents/rpc.ts";
import { ESCALATE_REPLAY_MS, ESCALATE_REPLAY_NOTE, ESCALATE_RETRY, MAX_ESCALATED, rememberReport, repeatedReport } from "../../src/mcp/escalated.ts";
import { FireTridentTools } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * MCP escalate is idempotent, as its annotation says (mcp/escalated.ts): a report sent again after a lost reply gets
 * the first answer back and nothing new is reported, whether the session or only the colony saw the first one.
 */

const BASE = "b".repeat(40);
const colonyInfo: Colony = { id: "col", name: "Colony", trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" }, trunkSha: BASE, createdAt: 0, regionDepth: 1 };
const lease: WorkspaceLease = {
  repo: { namespace: "ft-ws-2", name: "col--ws-2", remote: "https://ws.invalid/col--ws-2.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Date.UTC(2030, 0, 1),
  baseSha: BASE,
  leasedAt: 0,
  trunk: { remote: colonyInfo.trunk.remote, token: "fixture-trunk", sha: BASE },
};
const theIntent: Intent = { id: "int_1", colonyId: "col", title: "Rename helper", why: "Clarity", source: "human", footprint: ["src/lib/util.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" };

/** A colony whose escalate keeps one open report per intent and answers a repeat from the same agent as ColonyDO does. */
class FakeColony {
  agents: AgentInfo[] = [];
  reports: Array<{ agentId: Id; intentId: Id; kind: EscalationKind; report: string }> = [];
  open = new Map<Id, IntentEscalation>();
  held = new Map<Id, Id>();
  paused = false;
  async getColony(): Promise<Colony | null> {
    return colonyInfo;
  }
  async getAgent(id: Id): Promise<AgentInfo | null> {
    return this.agents.find((a) => a.id === id) ?? null;
  }
  async registerAgent(a: { kind: AgentInfo["kind"]; name: string }): Promise<AgentInfo> {
    const info: AgentInfo = { id: `agt_${this.agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
    this.agents.push(info);
    return info;
  }
  async heartbeat(): Promise<void> {}
  async pauseState(): Promise<unknown> {
    return this.paused ? { paused: true, refusal: "Agents are paused in this colony by maya: demo. Reads still work; wait for a person to resume." } : { paused: false };
  }
  async take(agentId: Id): Promise<TakeResult> {
    if (this.open.has(theIntent.id)) return { wait: true, retryInMs: 5_000, reason: "no open intents" };
    this.held.set(agentId, theIntent.id);
    return { intent: theIntent, lease };
  }
  async escalate(agentId: Id, p: { intentId?: Id; kind: EscalationKind; report: string }): Promise<{ intent: Intent; escalation: IntentEscalation }> {
    const intentId = p.intentId ?? this.held.get(agentId);
    if (!intentId) throw new Error("[ft:400] you hold no intent: take one, or name the intent your report is about");
    const prior = this.open.get(intentId);
    const row = { escalation: prior ? JSON.stringify(prior) : null, escalation_open: prior ? 1 : 0 };
    const repeat = repeatedReport(row, agentId);
    if (repeat) return { intent: { ...theIntent, id: intentId, status: "open", escalation: repeat }, escalation: repeat };
    if (this.paused) throw new Error("[ft:409] Agents are paused in this colony by maya: demo. Reads still work; wait for a person to resume.");
    if (prior) throw new Error(`[ft:409] intent ${intentId} already has a report waiting for a person`);
    if (this.held.get(agentId) !== intentId) throw new Error(`[ft:409] intent ${intentId} is not held by ${agentId}: report on an intent you hold`);
    const escalation: IntentEscalation = { kind: p.kind, report: p.report, by: agentId, at: 7 };
    this.reports.push({ agentId, intentId, kind: p.kind, report: p.report });
    this.open.set(intentId, escalation);
    this.held.delete(agentId);
    return { intent: { ...theIntent, id: intentId, status: "open", escalation }, escalation };
  }
  /** A person dismisses the open report: the intent is offered again. */
  dismiss(intentId: Id): void {
    this.open.delete(intentId);
  }
}

function setup() {
  const colony = new FakeColony();
  let session: Session = { reads: {}, proposals: [] };
  const clock = { now: 1_000_000 };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => ({ reading: async () => ({}) as never }),
    trunk: () => ({ why: async () => [] }),
    repo: async () => {
      throw new Error("not used");
    },
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => clock.now,
  };
  return { tools: new FireTridentTools(ctx), colony, session: () => session, setSession: (s: Session) => (session = s), clock };
}

const FIRST = {
  escalated: { intentId: "int_1", title: "Rename helper", kind: "broken-test" },
  receipt: "Report queued for a person. Intent int_1 waits for their answer (amend, withdraw or dismiss); no agent is offered it meanwhile. Your claim and workspace lease are released: make no further changes for it.",
  next: "Call take for other work.",
};

describe("MCP escalate is idempotent", () => {
  it("answers a repeat after a lost reply with the first answer, with or without the intent id, and reports nothing new", async () => {
    const { tools, colony } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    expect(await tools.escalate({ kind: "broken-test", report: "test/a.test.ts expects 405; the spec says 404" })).toEqual(FIRST);
    // The client timed out and sends it again: the session holds no intent any more.
    expect(await tools.escalate({ kind: "broken-test", report: "test/a.test.ts expects 405; the spec says 404" })).toEqual({ ...FIRST, replayed: true, note: ESCALATE_REPLAY_NOTE });
    expect(await tools.escalate({ intentId: "int_1", kind: "other", report: "worded differently this time" })).toEqual({ ...FIRST, replayed: true, note: ESCALATE_REPLAY_NOTE });
    expect(colony.reports).toHaveLength(1);
  });

  it("replays even while the colony is paused: nothing is written", async () => {
    const { tools, colony } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.escalate({ kind: "broken-test", report: "r" });
    colony.paused = true;
    expect(await tools.escalate({ kind: "broken-test", report: "r" })).toMatchObject({ replayed: true });
  });

  it("gets the first answer from the colony when the session never saw it, and forgets the intent then", async () => {
    const { tools, colony, session } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    // The first call reached the colony, but its answer never reached the session.
    await colony.escalate("agt_1", { intentId: "int_1", kind: "contradictory-spec", report: "first" });
    expect(session().intent?.id).toBe("int_1");
    expect(await tools.escalate({ kind: "other", report: "second try" })).toMatchObject({ escalated: { intentId: "int_1", kind: "contradictory-spec" } });
    expect(colony.reports).toHaveLength(1);
    expect(session().intent).toBeUndefined();
    // And the session remembers it for the next repeat.
    expect(await tools.escalate({ kind: "other", report: "third" })).toMatchObject({ replayed: true });
  });

  it("forgets reports after the window, and reports anew once it holds the intent again", async () => {
    const { tools, colony, clock } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.escalate({ kind: "broken-test", report: "r" });
    clock.now += ESCALATE_REPLAY_MS;
    await expect(tools.escalate({ kind: "broken-test", report: "r" })).rejects.toThrow(/you hold no intent/);
    // A person dismissed the report and the agent took the intent again: a new report is a new report.
    colony.dismiss("int_1");
    clock.now -= ESCALATE_REPLAY_MS;
    await tools.take();
    expect(await tools.escalate({ kind: "impossible", report: "still wrong" })).toMatchObject({ escalated: { intentId: "int_1", kind: "impossible" } });
    expect(colony.reports.map((r) => r.kind)).toEqual(["broken-test", "impossible"]);
  });

  it("does not replay another agent's report, and the colony still refuses a second report from someone else", async () => {
    const { tools, colony } = setup();
    await tools.join({ colony: "col" });
    await colony.registerAgent({ kind: "external", name: "other" });
    colony.held.set("agt_2", "int_1");
    await colony.escalate("agt_2", { intentId: "int_1", kind: "other", report: "theirs" });
    await expect(tools.escalate({ intentId: "int_1", kind: "other", report: "mine" })).rejects.toThrow(/already has a report waiting/);
  });

  it("says so in the tool's contract, and the session keeps a bounded list", () => {
    expect(ESCALATE_RETRY).toMatch(/you get the first answer back with replayed: true, and nothing new is reported/);
    const s: Session = { reads: {}, proposals: [], agentId: "agt_1" };
    for (let i = 0; i < MAX_ESCALATED + 5; i++) rememberReport(s, { intentId: `int_${i}`, title: "t", kind: "other", agentId: "agt_1", at: 100 + i }, 200);
    expect(s.escalated).toHaveLength(MAX_ESCALATED);
    expect(s.escalated!.at(-1)!.intentId).toBe(`int_${MAX_ESCALATED + 4}`);
  });

  it("repeatedReport: only this agent's own open report, never a resolved one or the colony's chain hold", () => {
    const open = (e: Record<string, unknown>) => ({ escalation: JSON.stringify(e), escalation_open: 1 });
    expect(repeatedReport(open({ kind: "other", report: "r", by: "agt_1", at: 1 }), "agt_1")).toMatchObject({ kind: "other", by: "agt_1" });
    expect(repeatedReport(open({ kind: "other", report: "r", by: "agt_2", at: 1 }), "agt_1")).toBeNull();
    expect(repeatedReport(open({ kind: "chain", report: "r", by: "agt_1", at: 1 }), "agt_1")).toBeNull();
    expect(repeatedReport({ escalation: JSON.stringify({ kind: "other", report: "r", by: "agt_1", at: 1 }), escalation_open: 0 }, "agt_1")).toBeNull();
    expect(repeatedReport(open({ kind: "other", report: "r", by: "agt_1", at: 1, resolved: { by: "maya", at: 2, decision: "dismiss", note: "n" } }), "agt_1")).toBeNull();
    expect(repeatedReport(null, "agt_1")).toBeNull();
  });
});
