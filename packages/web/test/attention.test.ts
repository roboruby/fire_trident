import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot } from "@fire_trident/core";
import { agentsOn, waitingWhy } from "../src/agents.ts";
import { needsYou } from "../src/needs.ts";
import { ColonyStore } from "../src/store.ts";

/** What needs a person (the strip under the trunk bar) and who is on a file (the map's hover card). */

const A = "a".repeat(40);
const B = "b".repeat(40);

function loaded(extra: { intents?: unknown[]; agents?: unknown[]; metrics?: Record<string, number> } = {}): ColonyStore {
  const s = new ColonyStore("web");
  s.now = () => 1_000_000;
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: A, createdAt: 0, regionDepth: 1 },
    files: [{ path: "src/a.ts", size: 10 }],
    intents: extra.intents ?? [],
    rules: [],
    agents: extra.agents ?? [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: extra.metrics ?? {},
  } as unknown as ColonySnapshot);
  return s;
}

const intent = (id: string, status = "open", footprint = [`src/${id}.ts`]) => ({ id, colonyId: "web", title: `Intent ${id}`, why: "w", source: "rule", footprint, priority: 1, status, createdAt: 0, createdBy: "t" });
const agent = (id: string, state: string, intentId?: string, extra: Record<string, unknown> = {}) => ({ id, colonyId: "web", kind: "internal", name: id, model: "m-1", thresholds: {}, state, lastSeen: 0, ...(intentId ? { intentId } : {}), ...extra });

describe("needsYou", () => {
  it("shows nothing when nothing needs a person", () => {
    expect(needsYou(loaded({ intents: [intent("i1")] }))).toEqual([]);
  });

  it("counts reviews, reports, a red trunk and intents that keep coming back, each with its tab", () => {
    const s = loaded({ intents: [intent("i1"), intent("i2", "claimed")], metrics: { reviewQueue: 2 } });
    s.applyEvents([
      { t: "escalation", at: 1, intentId: "i1", agentId: "a1", kind: "impossible", report: "r", title: "Intent i1" },
      { t: "certify", at: 2, trunkSha: A, status: "red", counts: { tests: 10, pass: 7, fail: 3, cancelled: 0, skipped: 0, todo: 0, suites: 1 } },
      ...[1, 2, 3].map((k): ColonyEvent => ({ t: "proposal", at: 3, proposalId: `p${k}`, intentId: "i2", agentId: "a2", status: "returned", reason: "stale" })),
    ]);
    const needs = needsYou(s);
    expect(needs.map((n) => [n.key, n.count, n.tab, n.focus ?? null])).toEqual([
      ["review", 2, "review", null],
      ["reports", 1, "review", null],
      ["tests", 3, "events", "certify"],
      ["returns", 1, "intents", "returned"],
    ]);
    expect(needs.map((n) => n.label)).toEqual(["changes to review", "agent report", "failing on aaaaaaa", "intent returned 3+ times"]);
  });

  it("names a red result on an older commit while the head waits, and drops it once green", () => {
    const s = loaded();
    s.applyEvents([{ t: "certify", at: 1, trunkSha: A, status: "red" }]);
    s.applyEvents([{ t: "landing", at: 2, landingId: "l2", trunkSha: B, proposalIds: [], paths: [] }]);
    const [tests] = needsYou(s);
    expect(tests).toMatchObject({ key: "tests", count: 0, label: "tests red on aaaaaaa" });
    expect(tests?.title).toContain("still waiting for its run");
    s.applyEvents([{ t: "certify", at: 3, trunkSha: B, status: "green" }]);
    expect(needsYou(s)).toEqual([]);
  });
});

describe("agents on a file", () => {
  it("lists the agents holding a file, busiest and most recently heard from first", () => {
    const s = loaded({
      intents: [intent("i1", "claimed", ["src/a.ts", "src/b.ts"]), intent("i2", "claimed", ["src/a.ts"]), intent("i3", "claimed", ["src/c.ts"])],
      agents: [agent("w1", "working", "i1", { note: "reading src/a.ts", noteAt: 5 }), agent("w2", "proposing", "i2"), agent("w3", "working", "i3"), agent("idle", "idle")],
    });
    s.applyEvents([{ t: "agent", at: 1, agentId: "w4", kind: "internal", state: "working", intentId: "i2", paths: ["src/a.ts"] }]);
    const on = agentsOn(s, "src/a.ts", 2);
    expect(on.total).toBe(3);
    expect(on.list.map((a) => a.id)).toEqual(["w1", "w4"]);
    expect(agentsOn(s, "src/zzz.ts").total).toBe(0);
  });

  it("says what an agent waits for: a person, its lane, or work it can take", () => {
    const s = loaded({
      intents: [intent("i1", "claimed"), intent("i2", "claimed"), intent("i3", "open")],
      agents: [agent("p1", "proposing", "i1"), agent("p2", "proposing", "i2"), agent("w", "waiting"), agent("busy", "working", "i3")],
    });
    s.applyEvents([
      { t: "proposal", at: 1, proposalId: "x1", intentId: "i1", agentId: "p1", status: "escalated" },
      { t: "proposal", at: 1, proposalId: "x2", intentId: "i2", agentId: "p2", status: "ready" },
    ]);
    const get = (id: string) => s.agents.get(id)!;
    expect(waitingWhy(s, get("p1"))).toBe("Its change waits for a person in the Review tab.");
    expect(waitingWhy(s, get("p2"))).toBe("Its change is being checked and waits for its lane to land it.");
    expect(waitingWhy(s, get("busy"))).toBeNull();
    expect(waitingWhy(s, get("w"))).toMatch(/^Nothing it can take yet/);
    get("w").waitReason = "every open intent's files are claimed by another agent";
    expect(waitingWhy(s, get("w"))).toBe("Waiting: every open intent's files are claimed by another agent.");
    const empty = loaded({ agents: [agent("w", "waiting")] });
    expect(waitingWhy(empty, empty.agents.get("w")!)).toBe("Nothing is open to take right now. It checks again on its own.");
  });

  it("says when an agent's own report waits for a person", () => {
    const s = loaded({ intents: [intent("i1", "claimed")], agents: [agent("a1", "waiting", "i1")] });
    s.applyEvents([{ t: "escalation", at: 1, intentId: "i1", agentId: "a1", kind: "broken-test", report: "r", title: "Intent i1" }]);
    expect(waitingWhy(s, s.agents.get("a1")!)).toMatch(/^It reported that its intent can't be done as written/);
  });
});
