import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, StuckItem } from "@fire_trident/core";
import { StuckList } from "../src/components/NeedsYou.tsx";
import { needsYou, stuckNow, stuckTarget, type Need } from "../src/needs.ts";
import { ColonyStore } from "../src/store.ts";

/** Stuck work in the needs-you strip: the colony's report, `stuck` events, what clears an item, and what each one leads to. */

const NOW = 10_000_000;
const MIN = 60_000;
const A = "a".repeat(40);
const B = "b".repeat(40);

function loaded(extra: { intents?: unknown[]; agents?: unknown[]; stuck?: unknown; red?: boolean } = {}): ColonyStore {
  const s = new ColonyStore("web");
  s.now = () => NOW;
  s.applySnapshot({
    colony: {
      id: "web",
      name: "web",
      trunk: { namespace: "n", name: "t", remote: "r" },
      trunkSha: A,
      createdAt: 0,
      regionDepth: 1,
      ...(extra.red ? { certification: { trunkSha: A, status: "red", startedAt: NOW - 20 * MIN, finishedAt: NOW - 20 * MIN } } : {}),
    },
    files: [{ path: "src/a.ts", size: 10 }],
    intents: extra.intents ?? [],
    rules: [],
    agents: extra.agents ?? [],
    recentLandings: [],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
    ...(extra.stuck ? { stuck: extra.stuck } : {}),
  } as unknown as ColonySnapshot);
  return s;
}

const intent = (id: string, status = "claimed", extra: Record<string, unknown> = {}) => ({ id, colonyId: "web", title: `Intent ${id}`, why: "w", source: "rule", footprint: [`src/${id}.ts`], priority: 1, status, createdAt: 0, createdBy: "t", ...extra });
const agent = (id: string, state: string, intentId?: string, extra: Record<string, unknown> = {}) => ({ id, colonyId: "web", kind: "internal", name: id, model: "m-1", thresholds: {}, state, lastSeen: 0, ...(intentId ? { intentId } : {}), ...extra });
const item = (over: Partial<StuckItem> & Pick<StuckItem, "key" | "kind">): StuckItem => ({ since: NOW - 12 * MIN, text: `what ${over.key} is`, action: "agent", ...over });
const report = (items: StuckItem[], total = items.length) => ({ at: NOW, items, total });

const claimed = item({ key: "claimed:i1", kind: "claimed", intentId: "i1", agentId: "a1" });
const answer = item({ key: "report:i2", kind: "report", intentId: "i2", action: "answer", since: NOW - 30 * MIN });
const red = item({ key: `red:${A}`, kind: "red", action: "review", since: NOW - 40 * MIN, trunkSha: A, repair: "review", proposalId: "p9" });
const escalation = { kind: "broken-test", report: "the test is wrong", by: "a2", at: NOW - 30 * MIN };

describe("stuck work in the needs-you strip", () => {
  it("lists the colony's stuck work, the kinds most in need of a person first", () => {
    const s = loaded({ intents: [intent("i1"), intent("i2", "open", { escalation })], agents: [agent("a1", "working", "i1")], stuck: report([claimed, answer, red]), red: true });
    const need = needsYou(s).find((n) => n.key === "stuck");
    expect(need).toMatchObject({ key: "stuck", count: 3, label: "stuck", tab: "review" });
    expect(need?.items?.map((x) => x.key)).toEqual([red.key, answer.key, claimed.key]);
    expect(need?.title).toMatch(/^Work that stopped moving/);
  });

  it("hides an item once the page sees its work move, until the colony's next report", () => {
    const s = loaded({ intents: [intent("i1"), intent("i2", "open", { escalation })], agents: [agent("a1", "working", "i1")], stuck: report([claimed, answer, red]), red: true });
    s.applyEvents([
      // The agent proposes: the claim is no longer stuck.
      { t: "intent", at: NOW, intentId: "i1", status: "proposed", title: "Intent i1", footprint: ["src/i1.ts"] },
      // A person answers the report.
      { t: "escalation", at: NOW, intentId: "i2", agentId: "a2", kind: "broken-test", report: "the test is wrong", title: "Intent i2", resolved: { by: "m", at: NOW, decision: "dismiss", note: "the test is right" } },
    ]);
    expect(stuckNow(s).map((x) => x.key)).toEqual([red.key]);
    s.applyEvents([{ t: "certify", at: NOW, trunkSha: B, status: "green" }, { t: "landing", at: NOW, landingId: "l1", trunkSha: B, proposalIds: [], paths: [] }]);
    expect(needsYou(s).find((n) => n.key === "stuck")).toBeUndefined();
    // The next report is the authority: what it lists is stuck again.
    s.applyStuck(report([item({ key: "claimed:i9", kind: "claimed", intentId: "i9" })], 4));
    const need = needsYou(s).find((n) => n.key === "stuck");
    expect(need?.items?.map((x) => x.key)).toEqual(["claimed:i9"]);
    expect(need?.count).toBe(4);
  });

  it("adds what `stuck` events report, once per key", () => {
    const s = loaded({ intents: [intent("i1")], agents: [agent("a1", "working", "i1")] });
    expect(needsYou(s)).toEqual([]);
    const ev: ColonyEvent = { t: "stuck", at: NOW, item: claimed };
    s.applyEvents([ev, ev, { t: "stuck", at: NOW, item: { kind: "nonsense" } as unknown as StuckItem }]);
    expect(stuckNow(s).map((x) => x.key)).toEqual([claimed.key]);
    expect(s.typeCounts.get("stuck")).toBe(3);
  });

  it("keeps a change while it waits for review, and an agent until it moves", () => {
    const review = item({ key: "review:p1", kind: "review", action: "review", proposalId: "p1", intentId: "i1" });
    const quiet = item({ key: "agent:a3", kind: "agent", agentId: "a3", intentId: "i3", since: NOW - 15 * MIN });
    const s = loaded({ intents: [intent("i1", "proposed"), intent("i3", "proposed")], agents: [agent("a3", "proposing", "i3")], stuck: report([review, quiet]) });
    s.applyEvents([{ t: "proposal", at: NOW, proposalId: "p1", intentId: "i1", agentId: "a1", status: "escalated" }]);
    expect(stuckNow(s).map((x) => x.kind)).toEqual(["review", "agent"]);
    s.applyEvents([
      { t: "proposal", at: NOW, proposalId: "p1", intentId: "i1", agentId: "a1", status: "ready" },
      { t: "status", at: NOW - MIN, agentId: "a3", note: "rebasing on trunk" },
    ]);
    expect(stuckNow(s)).toEqual([]);
  });

  it("leaves nothing stuck from a server without the detector, and ignores what is not a report", () => {
    const s = loaded({ stuck: report([claimed]) });
    expect(s.stuck.size).toBe(1);
    s.applyStuck(undefined);
    s.applyStuck({ items: "no" });
    expect(s.stuck.size).toBe(1);
    s.applyStuck(report([{ key: "x", kind: "claimed" } as unknown as StuckItem]));
    expect(s.stuck.size).toBe(0);
    expect(loaded().stuck.size).toBe(0);
  });

  it("sends each action where a person deals with it", () => {
    const s = loaded({ intents: [intent("i1"), intent("i4", "open")], agents: [agent("a1", "working", "i1")] });
    expect(stuckTarget(s, { ...answer, seenAt: NOW })).toEqual({ tab: "review" });
    expect(stuckTarget(s, { ...red, seenAt: NOW })).toEqual({ tab: "review" });
    expect(stuckTarget(s, { ...red, action: "tests", seenAt: NOW })).toEqual({ tab: "events", focus: "certify" });
    expect(stuckTarget(s, { ...item({ key: "returns:i4", kind: "returns", action: "intent", intentId: "i4" }), seenAt: NOW })).toEqual({ tab: "intents", focus: "open" });
    expect(stuckTarget(s, { ...item({ key: "returns:i1", kind: "returns", action: "intent", intentId: "i1" }), seenAt: NOW })).toEqual({ tab: "intents", focus: "claimed" });
    // Look at the agent: the Why tab on a file it holds says who is there, their state and their last note.
    expect(stuckTarget(s, { ...claimed, seenAt: NOW })).toEqual({ tab: "why", path: "src/i1.ts" });
    expect(stuckTarget(s, { ...claimed, agentId: "gone", intentId: "unknown", seenAt: NOW })).toEqual({ tab: "intents", focus: "claimed" });
  });

  it("renders each item with how long, its text as text, and what to do", () => {
    const hostile = item({ key: "claimed:i1", kind: "claimed", intentId: "i1", agentId: "a1", text: "“<b>Fix</b>” is claimed by a1 with no change proposed yet" });
    const s = loaded({ intents: [intent("i1"), intent("i2", "open", { escalation })], agents: [agent("a1", "working", "i1")], stuck: report([hostile, answer], 4) });
    const need = needsYou(s).find((n) => n.key === "stuck") as Need;
    const html = renderToStaticMarkup(createElement(StuckList, { store: s, need, onGo: () => undefined }));
    expect(html).toContain('<li class="stuck stuck-report">');
    expect(html).toContain(">30m<");
    expect(html).toContain(">12m<");
    expect(html).toContain("&lt;b&gt;Fix&lt;/b&gt;");
    expect(html).not.toContain("<b>Fix</b>");
    expect(html).toContain(">Answer the report</button>");
    expect(html).toContain(">Look at the agent</button>");
    expect(html).toContain("2 more: ft status lists them");
  });
});
