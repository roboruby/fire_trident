import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, RecordedEvent } from "@fire_trident/core";
import { FieldSynth, ReplayEngine, Timeline, startingPoint } from "../src/replay.ts";
import { colonyHref, parseRoute } from "../src/route.ts";
import { ColonyStore } from "../src/store.ts";
import { TOUR_ABOUT, hasTour } from "../src/tour/catalog.ts";
import { FIRST_RED_TOUR } from "../src/tour/firstRed.ts";
import { ORDER_BACKEND_TOUR } from "../src/tour/orderBackend.ts";
import { loadTourSteps, type ColonyTour } from "../src/tour/tour.ts";
import { RUN_TOUR, loadTourData, runTourCheck, tourFor, tourIds } from "../src/tour/tours.ts";

/** The tours by colony: which colony gets which, what each reads, the address that picks one, and the run tour through the shared check. */

const T = 1_791_797_000_000;
const sha = (c: string) => c.repeat(40);

/** A run a rule started where nothing came back: three changes in flight at once, two landings on src/a.ts (tour.test.ts's calm run). */
function calm(): RecordedEvent[] {
  const events: ColonyEvent[] = [
    { t: "intent", at: T + 100, intentId: "i1", status: "open", title: "a", footprint: ["src/a.ts"] },
    { t: "intent", at: T + 100, intentId: "i2", status: "open", title: "b", footprint: ["src/b.ts"] },
    { t: "intent", at: T + 100, intentId: "i3", status: "open", title: "c", footprint: ["src/c.ts"] },
    { t: "violations", at: T + 200, total: 3, byRule: { r1: 3 } },
    { t: "intent", at: T + 300, intentId: "i1", status: "claimed", title: "a", footprint: ["src/a.ts"] },
    { t: "proposal", at: T + 1_000, proposalId: "p1", intentId: "i1", agentId: "a1", status: "checking" },
    { t: "proposal", at: T + 1_100, proposalId: "p2", intentId: "i2", agentId: "a2", status: "checking" },
    { t: "proposal", at: T + 1_200, proposalId: "p3", intentId: "i3", agentId: "a3", status: "ready" },
    { t: "proposal", at: T + 1_300, proposalId: "p1", intentId: "i1", agentId: "a1", status: "ready" },
    { t: "proposal", at: T + 2_000, proposalId: "p1", intentId: "i1", agentId: "a1", status: "landed" },
    { t: "landing", at: T + 2_000, landingId: "l1", trunkSha: sha("1"), proposalIds: ["p1"], paths: ["src/a.ts"] },
    { t: "proposal", at: T + 2_500, proposalId: "p2", intentId: "i2", agentId: "a2", status: "landed" },
    { t: "landing", at: T + 2_500, landingId: "l2", trunkSha: sha("2"), proposalIds: ["p2"], paths: ["src/a.ts", "src/b.ts"] },
    { t: "proposal", at: T + 3_000, proposalId: "p3", intentId: "i3", agentId: "a3", status: "landed" },
    { t: "landing", at: T + 3_000, landingId: "l3", trunkSha: sha("3"), proposalIds: ["p3"], paths: ["src/c.ts"] },
    { t: "violations", at: T + 3_000, total: 0, byRule: { r1: 0 } },
  ];
  return events.map((e, i) => ({ ...e, seq: i + 1 }));
}

function snapshot(): ColonySnapshot {
  return {
    colony: { id: "c", name: "c", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: sha("3"), createdAt: T, regionDepth: 1, source: { url: "https://example.com/r.git", branch: "main" } },
    files: ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => ({ path, size: 100 })),
    intents: [],
    rules: [{ id: "r1", colonyId: "c", kind: "forbid-pattern", spec: {}, description: "No console", approvedBy: "m", createdAt: T + 150 }],
    agents: [],
    recentLandings: [],
    violations: { total: 0, byRule: { r1: 0 } },
    funnel: { proof: 0, reflex: 0, llm: 0, human: 0 },
    metrics: {},
  };
}

describe("the tours by colony", () => {
  it("gives hono, first-red and order-backend their own, and every other colony the run tour", () => {
    expect(tourIds()).toEqual(["hono", "first-red", "order-backend"]);
    expect(tourFor("hono")).toBe(RUN_TOUR);
    expect(tourFor("first-red")).toBe(FIRST_RED_TOUR);
    expect(tourFor("order-backend")).toBe(ORDER_BACKEND_TOUR);
    expect(tourFor("shortlinks")).toBe(RUN_TOUR);
    // ?tour=<id> plays another colony's script on this one; an unknown name falls back to the colony's own.
    expect(tourFor("first-red-preview", "first-red")).toBe(FIRST_RED_TOUR);
    expect(tourFor("first-red", "nowhere")).toBe(FIRST_RED_TOUR);
    expect(tourFor("shortlinks", "nowhere")).toBe(RUN_TOUR);
  });

  it("keeps Hono's exact seven steps as the run tour", () => {
    expect(RUN_TOUR.id).toBe("hono");
    expect(RUN_TOUR.steps.map((s) => s.id)).toEqual(["rule", "claims", "land", "contention", "hot", "converge", "why"]);
    expect(RUN_TOUR.reads).toEqual({});
  });

  it("lists the colonies with a tour for the landing page, each with a line about it", () => {
    for (const id of tourIds()) {
      expect(hasTour(id)).toBe(true);
      expect(TOUR_ABOUT[id]).toMatch(/record/);
    }
    expect(hasTour("shortlinks")).toBe(false);
    expect(hasTour("toString")).toBe(false);
    for (const tour of [RUN_TOUR, FIRST_RED_TOUR, ORDER_BACKEND_TOUR] as ColonyTour[]) expect(tour.about).toBe(TOUR_ABOUT[tour.id]);
  });

  it("reads what a tour needs from the public API, with a failed read null", async () => {
    const asked: string[] = [];
    const get = async (suffix: string): Promise<unknown> => {
      asked.push(suffix);
      if (suffix === "/review") throw new Error("503");
      return { suffix };
    };
    expect(await loadTourData(ORDER_BACKEND_TOUR, get)).toEqual({ review: null, snapshot: { suffix: "" } });
    expect(asked).toEqual(["/review", ""]);
    expect(await loadTourData(RUN_TOUR, get)).toEqual({});
    expect(await loadTourData(FIRST_RED_TOUR, get)).toEqual({ certifications: { suffix: "/certifications?limit=50" } });
  });

  it("loads a script only on the moments its tour knows", () => {
    const data = { steps: [{ id: "a", at: "@green", caption: "g" }, { id: "b", at: ["@rule", "@held-1"], caption: { "@rule": "r", "@held-1": "h" } }] };
    expect(loadTourSteps(data).map((s) => s.id)).toEqual(["b"]);
    expect(loadTourSteps(data, new Set(["@green", "@held-1"])).map((s) => [s.id, s.at, s.caption])).toEqual([
      ["a", ["@green"], { "*": "g" }],
      ["b", ["@held-1"], { "@held-1": "h" }],
    ]);
  });

  it("tells and checks the run tour through the shared check, as scripts/tour_check.ts does", () => {
    const store = new ColonyStore("c");
    const timeline = new Timeline(calm());
    const { snapshot: initial, newFiles } = startingPoint(snapshot(), timeline);
    const engine = new ReplayEngine(store, timeline, initial, newFiles, new FieldSynth());
    const report = { metrics: { landings: 3, landedIntents: 3 }, funnel: { proof: 0, reflex: 0, llm: 0, human: 0 }, violations: { total: 0 }, convergence: { since: T + 150, initial: 3, fixed: 3, convergedAt: T + 3_000 } };
    const run = runTourCheck(RUN_TOUR, engine, {}, report, "recorded");
    expect(run.plan.stops.map((s) => s.step.id)).toEqual(["rule", "claims", "contention", "land", "hot", "converge", "why"]);
    expect(run.lines[0]).toEqual({ label: "1/7 The rule (@rule, 0.1 s into the record)", text: "A person declared one rule that found 3 violations in 3 files: each became a need in the field, and no one assigns the work." });
    expect(run.lines[5]?.text).toBe("3 violations fixed in 2.9 s: 3 intents landed in 3 commits after the rule, and none of them went through review.");
    expect(run.checks.filter((c) => !c.ok)).toEqual([]);
    expect(run.checks.map((c) => c.name)).toEqual([
      "violations the rule found",
      "violations fixed",
      "time to zero",
      "violations at the end",
      "funnel proof at the end",
      "funnel reflex at the end",
      "funnel llm at the end",
      "funnel human at the end",
      "landings at the end",
      "intents landed at the end",
    ]);
    expect(run.checks[2]).toMatchObject({ name: "time to zero", tour: "2.9 s", metrics: "2.9 s" });
  });
});

describe("the tour's address, by colony", () => {
  it("picks the colony's own tour with ?tour=1, and another colony's script by name", () => {
    expect(parseRoute("/c/first-red", "?tour=1")).toMatchObject({ kind: "colony", colonyId: "first-red", tour: true, tourScript: null, replay: { source: "auto", speed: 1 } });
    expect(parseRoute("/c/first-red", "?tour=true")).toMatchObject({ tour: true, tourScript: null });
    expect(parseRoute("/c/first-red-preview", "?tour=first-red")).toMatchObject({ tour: true, tourScript: "first-red", replay: { source: "auto" } });
    expect(parseRoute("/c/x", "?tour=order-backend&t=3&speed=2")).toMatchObject({ tour: true, tourScript: "order-backend", replay: { speed: 2, offsetS: 3 } });
    expect(parseRoute("/c/x", "?tour=first-red&mock=1")).toMatchObject({ tour: false, tourScript: null, replay: null });
    expect(parseRoute("/c/x", "?tour=0")).toMatchObject({ tour: false, tourScript: null });
    expect(parseRoute("/", "?mock=1")).toMatchObject({ colonyId: "demo", tour: false, tourScript: null });
    expect(colonyHref("first-red", { tour: true })).toBe("/c/first-red?tour=1");
    expect(colonyHref("first-red-preview", { tour: "first-red" })).toBe("/c/first-red-preview?tour=first-red");
    expect(colonyHref("order-backend", { replay: true })).toBe("/c/order-backend?replay=1");
  });
});
