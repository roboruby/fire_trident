import { describe, expect, it } from "vitest";
import { FIRST_EVENTS, SCALE_CONDITIONS, SCALE_MIN_LANDINGS, goalsCard, loadGoalsCard, loadScaleCard, scaleCard, versionOf, type GetJson, type HeldChange } from "../src/landing/showcase.ts";

/** The scale and goals cards of the results strip: what they say, read from the routes that answer without a token. */

const RUST = "Move the order backend to Rust";
const GO = "Move the order backend to Go";
const TS = "Move the order backend to TypeScript";

/** A fake API: each URL's answer, and every URL asked (in order). */
function api(answers: Record<string, unknown>): { get: GetJson; asked: string[] } {
  const asked: string[] = [];
  const get: GetJson = async (url) => {
    asked.push(url);
    if (!(url in answers)) throw new Error(`404 ${url}`);
    return answers[url];
  };
  return { get, asked };
}

describe("scale card", () => {
  it("says the landings, the agents and the time from the first landing to the last", () => {
    const card = scaleCard({ landings: 1237, landedIntents: 7412, agents: 2001, firstLandingAt: 1_000_000, lastLandingAt: 1_140_000 });
    expect(card).toEqual({
      headline: "1,237 landings",
      lede: "by 2,001 synthetic agents in one repository in 2 min 20 s",
      details: ["7,412 intents landed, 530 landings a minute over the run", SCALE_CONDITIONS],
      origin: "synthetic agents, no models",
    });
  });

  it("leaves the time out when it cannot bound the run, and shows nothing before a landing", () => {
    expect(scaleCard({ landings: 120, landedIntents: 400, agents: 50, firstLandingAt: null, lastLandingAt: 5 })?.lede).toBe("by 50 synthetic agents in one repository");
    expect(scaleCard({ landings: 120, landedIntents: 400, agents: 50, firstLandingAt: null, lastLandingAt: 5 })?.details[0]).toBe("400 intents landed");
    // The probe before a run, or nothing yet: no card.
    expect(scaleCard({ landings: SCALE_MIN_LANDINGS - 1, landedIntents: 99, agents: 1, firstLandingAt: 1, lastLandingAt: 2 })).toBeNull();
    expect(scaleCard({ landings: 0, landedIntents: 0, agents: 2000, firstLandingAt: null, lastLandingAt: null })).toBeNull();
  });

  it("reads the first landing from the start of the record and the last from the listing", async () => {
    const metrics: Record<string, number> = { landings: 900, landedIntents: 5400, agents: 2001 };
    const { get, asked } = api({
      [`/api/colonies/scale/events?limit=${FIRST_EVENTS}`]: {
        events: [
          { seq: 1, t: "agent", at: 10, agentId: "agt_probe", kind: "synthetic", state: "idle" },
          { seq: 2, t: "landing", at: 60_000, landingId: "lnd_1", trunkSha: "a", proposalIds: ["prp_1"], paths: ["bench/probe/p.txt"] },
        ],
        next: 3,
      },
    });
    const card = await loadScaleCard("scale", (k) => metrics[k] ?? 0, { id: "scale", lastLandingAt: 180_000 }, get);
    expect(card?.lede).toBe("by 2,001 synthetic agents in one repository in 2 min");
    expect(card?.details[0]).toBe("5,400 intents landed, 450 landings a minute over the run");
    expect(asked).toEqual([`/api/colonies/scale/events?limit=${FIRST_EVENTS}`]);
  });

  it("does not read the record of a colony with no landings", async () => {
    const { get, asked } = api({});
    expect(await loadScaleCard("scale", () => 0, undefined, get)).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("goals card", () => {
  const held = (id: string, title: string, agentId: string, status: string, decision: HeldChange["decision"] = null): HeldChange => ({ id, intentId: `int_${id}`, agentId, title, status, decision });
  const undone = { landingId: "lnd_rust", intentId: "int_rust", title: RUST, agentId: "agt_rust" };

  it("says how many changes wait, what they would undo, and that a deterministic check held them", () => {
    const card = goalsCard({ held: [held("go", GO, "agt_go", "escalated"), held("ts", TS, "agt_ts", "escalated")], undone });
    expect(card).toEqual({
      headline: "2 changes wait for a person",
      lede: "three agents moved one backend to three languages; the first landed and the others would undo it",
      details: [`both would undo the landing of “${RUST}”`, "held by a deterministic check, not a model"],
      origin: "scripted agents over MCP",
    });
  });

  it("says what a person decided once nothing waits, and stays true after", () => {
    const card = goalsCard({ held: [held("go", GO, "agt_go", "landed", "approve"), held("ts", TS, "agt_ts", "returned", "return")], undone });
    expect(card?.headline).toBe("Decided by a person");
    expect(card?.lede).toBe("three agents moved one backend to three languages; the first landed and the others would have undone it");
    expect(card?.details).toEqual([`both would have undone the landing of “${RUST}”`, "a person kept the Go version", "a person sent the TypeScript version back to its agent", "held by a deterministic check, not a model"]);
  });

  it("counts one waiting change while the other is decided, and words every decision", () => {
    const card = goalsCard({ held: [held("go", GO, "agt_go", "ready", "approve"), held("ts", TS, "agt_ts", "escalated")], undone });
    expect(card?.headline).toBe("1 change waits for a person");
    expect(card?.details).toContain("a person approved the Go version");
    expect(goalsCard({ held: [held("ts", TS, "agt_ts", "rejected", "reject")], undone })?.details).toContain("a person rejected the TypeScript version");
    expect(goalsCard({ held: [held("go", GO, "agt_go", "returned", "approve")], undone })?.details).toContain("a person approved the Go version, and it went back to its agent");
  });

  it("speaks of goals for one file when the titles do not name a language, and shows nothing without a held change", () => {
    const card = goalsCard({ held: [held("a", "Cache the totals", "agt_a", "escalated")], undone: { ...undone, title: "Compute totals on read" } });
    expect(card?.lede).toBe("two agents had two goals for one file; the first landed and the other would undo it");
    expect(card?.details[0]).toBe("it would undo the landing of “Compute totals on read”");
    expect(versionOf("Cache the totals")).toBe("“Cache the totals”");
    expect(goalsCard({ held: [], undone: null })).toBeNull();
  });

  /** The demo colony's record: the seed and the Rust change landed, the Go and TypeScript changes held; then, optionally, a person's decisions. */
  function record(decided: boolean): unknown[] {
    const reason = (agent: string) => `escalated by deterministic: would undo 5 lines in src/backend.ts that landing lnd_rust wrote 3 seconds ago for intent "${RUST}" (${agent}), a different intent; a person decides which goal stands`;
    const events: unknown[] = [
      { t: "intent", at: 1, intentId: "int_seed", status: "claimed", title: "Start the order backend", footprint: ["src/backend.ts"] },
      { t: "intent", at: 2, intentId: "int_rust", status: "claimed", title: RUST, footprint: ["src/backend.ts"] },
      { t: "intent", at: 2, intentId: "int_go", status: "claimed", title: GO, footprint: ["src/backend.ts"] },
      { t: "intent", at: 2, intentId: "int_ts", status: "claimed", title: TS, footprint: ["src/backend.ts"] },
      { t: "proposal", at: 3, proposalId: "prp_rust", intentId: "int_rust", agentId: "agt_rust", status: "ready" },
      { t: "landing", at: 4, landingId: "lnd_rust", trunkSha: "b", proposalIds: ["prp_rust"], paths: ["src/backend.ts"] },
      { t: "proposal", at: 5, proposalId: "prp_go", intentId: "int_go", agentId: "agt_go", status: "escalated", reason: reason("go") },
      { t: "proposal", at: 6, proposalId: "prp_ts", intentId: "int_ts", agentId: "agt_ts", status: "escalated", reason: reason("ts") },
      // A model's escalation is not a goal conflict.
      { t: "proposal", at: 6, proposalId: "prp_other", intentId: "int_seed", agentId: "agt_seed", status: "escalated", reason: "escalated by llm: risky" },
    ];
    if (decided) {
      events.push({ t: "decision", at: 7, decisionId: "dec_1", kind: "triage", layer: "human", p: 1, action: "approve", subject: "prp_go" });
      events.push({ t: "decision", at: 8, decisionId: "dec_2", kind: "triage", layer: "human", p: 1, action: "return", subject: "prp_ts" });
    }
    return events;
  }
  const proposal = (id: string, intentId: string, agentId: string, status: string) => ({ id, intentId, agentId, status, undoes: [{ landingId: "lnd_rust", intentId: "int_rust", path: "src/backend.ts", lines: 5 }] });

  it("reads the held changes from the record and each one's own record", async () => {
    const { get, asked } = api({
      "/api/colonies/order-backend/events?after=0&limit=5000": { events: record(false), next: null },
      "/api/colonies/order-backend/proposals/prp_go": proposal("prp_go", "int_go", "agt_go", "escalated"),
      "/api/colonies/order-backend/proposals/prp_ts": proposal("prp_ts", "int_ts", "agt_ts", "escalated"),
    });
    const card = await loadGoalsCard("order-backend", get);
    expect(card?.headline).toBe("2 changes wait for a person");
    expect(card?.lede).toBe("three agents moved one backend to three languages; the first landed and the others would undo it");
    expect(card?.details[0]).toBe(`both would undo the landing of “${RUST}”`);
    expect(asked).not.toContain("/api/colonies/order-backend/proposals/prp_other");
  });

  it("follows a person's decisions, reading the undone intent's title when the record lacks it", async () => {
    const events = record(true).filter((e) => (e as { intentId?: string }).intentId !== "int_rust" || (e as { t: string }).t !== "intent");
    const { get } = api({
      "/api/colonies/order-backend/events?after=0&limit=5000": { events, next: null },
      "/api/colonies/order-backend/proposals/prp_go": proposal("prp_go", "int_go", "agt_go", "landed"),
      "/api/colonies/order-backend/proposals/prp_ts": proposal("prp_ts", "int_ts", "agt_ts", "returned"),
      "/api/colonies/order-backend/intents/int_rust": { intent: { id: "int_rust", title: RUST }, revisions: [], directives: [], escalations: [] },
    });
    const card = await loadGoalsCard("order-backend", get);
    expect(card?.headline).toBe("Decided by a person");
    expect(card?.details).toEqual([`both would have undone the landing of “${RUST}”`, "a person kept the Go version", "a person sent the TypeScript version back to its agent", "held by a deterministic check, not a model"]);
  });

  it("shows nothing for a colony that held no change for a goal conflict, or that does not exist", async () => {
    const quiet = api({ "/api/colonies/order-backend/events?after=0&limit=5000": { events: record(false).slice(0, 6), next: null } });
    expect(await loadGoalsCard("order-backend", quiet.get)).toBeNull();
    await expect(loadGoalsCard("order-backend", api({}).get)).rejects.toThrow("404");
  });
});
