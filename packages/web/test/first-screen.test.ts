import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, ColonySnapshot, Rule } from "@fire_trident/core";
import { CurveView, DistanceView, ExceptionsView, TargetDetails, TargetView } from "../src/components/FirstScreen.tsx";
import { distanceAt, distanceOf, distanceSeries, runCurve, stepPath, summarize, windowCurve } from "../src/distance.ts";
import { exceptionsOf, isHeldMerge } from "../src/exceptions.ts";
import { ColonyStore } from "../src/store.ts";
import { policyGlobs, readProtected, targetOf } from "../src/target.ts";

/**
 * The colony's first screen: the distance to target from a snapshot (each kind, the total, "At target"), the target
 * panel (rules with who approved them, acceptance, protected paths), the convergence curve from an event record, and
 * the exceptions strip.
 */

const A = "a".repeat(40);
const B = "b".repeat(40);
const T0 = 1_792_000_000_000;
const counts = (pass: number, fail: number, cancelled = 0) => ({ tests: pass + fail + cancelled, pass, fail, cancelled, skipped: 0, todo: 0, suites: 1 });

const RULE: Rule = { id: "rul_1", colonyId: "web", kind: "forbid-pattern", spec: {}, description: "No console calls in src.", approvedBy: "maya", createdAt: T0 };
const RETRACTED: Rule = { id: "rul_0", colonyId: "web", kind: "forbid-pattern", spec: {}, description: "No default exports", approvedBy: "sam", createdAt: T0 - 9_000, retractedAt: T0 - 5_000 };

function intent(id: string, extra: Record<string, unknown>) {
  return { id, colonyId: "web", title: id, why: "", source: "human", footprint: [`src/${id}.ts`], priority: 1, status: "open", createdAt: T0, createdBy: "maya", ...extra };
}

function snapshot(extra: Partial<Record<keyof ColonySnapshot, unknown>> = {}): ColonySnapshot {
  return {
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: B, greenSha: A, createdAt: 0, regionDepth: 1, certification: { trunkSha: B, status: "red", startedAt: 1, finishedAt: 2, counts: counts(10, 2, 1) } },
    files: [],
    intents: [
      intent("dark", { title: "Add a dark mode", acceptance: ["The toggle persists across reloads", "  ", "No other file changes"] }),
      intent("helper", { title: "Extract the date helper", source: "agent", status: "claimed" }),
      intent("held", { title: "Move the router", source: "agent", status: "proposed" }),
      intent("rulefix", { title: "No console calls in src in src/a.ts", source: "rule", ruleId: "rul_1", footprint: ["src/a.ts"] }),
      intent("repair", { title: "Make the failing tests pass: test/a.test.ts", source: "certify" }),
      intent("slugs", { title: "Return 404 for unknown slugs", escalation: { kind: "contradictory-spec", report: "The test expects 405", by: "agt_1", at: T0 } }),
      intent("shipped", { title: "Ship the footer", status: "landed" }),
      intent("split", { title: "Split src/big.ts into smaller modules", source: "system", footprint: ["src/big.ts"] }),
    ],
    rules: [RETRACTED, RULE],
    agents: [],
    recentLandings: [],
    violations: { total: 5, byRule: { rul_1: 5 } },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: { reviewQueue: 2 },
    ...extra,
  } as unknown as ColonySnapshot;
}

/** The fixture colony, with one change held for a person (a held merge) on the agent's "held" intent. */
function loaded(snap = snapshot()): ColonyStore {
  const s = new ColonyStore("web");
  s.applySnapshot(snap);
  s.applyEvents([
    {
      t: "proposal",
      at: T0 + 1,
      proposalId: "prp_1",
      intentId: "held",
      agentId: "agt_2",
      status: "escalated",
      reason: "A person approved this change against an older trunk; trunk has since changed src/router.ts (aaaaaaaaaa at its base, bbbbbbbbbb on trunk, merged as cccccccccc), so it was not merged automatically.",
    },
  ]);
  return s;
}

describe("the distance to target, from a snapshot", () => {
  it("counts each kind once: violations, failing tests, unmet intents by origin, and what waits for a person", () => {
    const d = distanceOf(loaded());
    const by = Object.fromEntries(d.kinds.map((k) => [k.key, k]));
    expect(d.kinds.map((k) => k.key)).toEqual(["violations", "tests", "intents", "waiting"]);
    expect(by.violations).toMatchObject({ count: 5, label: "rule violations", parts: [{ key: "rul_1", label: "No console calls in src", count: 5 }] });
    // Red on the head: 2 failed and 1 cancelled.
    expect(by.tests).toMatchObject({ count: 3, label: "failing tests" });
    // A rule's intent and a certification repair count as their violations and tests; the reported and the held ones wait.
    expect(by.intents?.count).toBe(3);
    expect(by.intents?.parts).toEqual([
      { key: "human", label: "from people", count: 1 },
      { key: "agent", label: "from agents", count: 1 },
      { key: "system", label: "from the colony", count: 1 },
    ]);
    expect(by.waiting).toMatchObject({ count: 3, label: "waiting for a person" });
    expect(by.waiting?.parts).toEqual([
      { key: "review", label: "changes to review", count: 2 },
      { key: "reports", label: "agent report", count: 1 },
    ]);
    expect(d.total).toBe(14);
    expect(d.atTarget).toBe(false);
  });

  it("keeps the last red result's failing tests while the next run is going", () => {
    const s = loaded();
    s.applyEvents([{ t: "certify", at: T0 + 2, trunkSha: "c".repeat(40), status: "running" }]);
    expect(distanceOf(s).kinds.find((k) => k.key === "tests")?.count).toBe(3);
    s.applyEvents([{ t: "certify", at: T0 + 3, trunkSha: "c".repeat(40), status: "green", counts: counts(13, 0) }]);
    expect(distanceOf(s).kinds.find((k) => k.key === "tests")?.count).toBe(0);
  });

  it("is At target when every kind is zero, and never before the colony loads", () => {
    const done = snapshot({
      intents: [intent("shipped", { status: "landed" }), intent("rulefix", { source: "rule", ruleId: "rul_1", status: "landed" })],
      violations: { total: 0, byRule: { rul_1: 0 } },
      metrics: { reviewQueue: 0 },
      colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: A, greenSha: A, createdAt: 0, regionDepth: 1, certification: { trunkSha: A, status: "green", startedAt: 1, finishedAt: 2, counts: counts(13, 0) } },
    });
    const s = new ColonyStore("web");
    expect(distanceOf(s)).toMatchObject({ total: 0, atTarget: false });
    s.applySnapshot(done);
    const d = distanceOf(s);
    expect(d.total).toBe(0);
    expect(d.atTarget).toBe(true);
    expect(d.kinds.every((k) => k.count === 0 && k.parts.length === 0)).toBe(true);
    const html = renderToStaticMarkup(createElement(DistanceView, { distance: d }));
    expect(html).toContain('<span class="fs-at">At target</span>');
    expect(html).not.toContain("fs-total-n");
  });

  it("renders the total and one number per kind with what it is made of", () => {
    const html = renderToStaticMarkup(createElement(DistanceView, { distance: distanceOf(loaded()) }));
    expect(html).toContain('<span class="fs-total-n">14</span>');
    expect(html).toContain('<li class="fs-kind fs-kind-violations"');
    expect(html).toContain('<b class="fs-kind-n">5</b><span class="fs-kind-label">rule violations</span>');
    expect(html).toContain("1 from people · 1 from agents · 1 more");
    expect(html).toContain("2 changes to review · 1 agent report");
  });
});

describe("the target panel", () => {
  const pp = { state: "loaded" as const, globs: ["src/auth/**", "db/migrations"] };

  it("reads rules in force with who approved them, acceptance of open intents, goals and certification", () => {
    const t = targetOf(loaded(), pp);
    expect(t.rules).toEqual([{ id: "rul_1", head: "No console calls in src", description: "No console calls in src.", approvedBy: "maya", kind: "forbid-pattern", createdAt: T0, open: 5 }]);
    expect(t.retracted).toBe(1);
    // Blank acceptance lines are dropped.
    expect(t.acceptance).toEqual([{ intentId: "dark", title: "Add a dark mode", lines: ["The toggle persists across reloads", "No other file changes"] }]);
    expect(t.acceptanceLines).toBe(2);
    expect(t.goals).toMatchObject({ people: 2, rules: 1 });
    expect(t.goals.list.map((g) => g.id)).toEqual(["dark", "slugs", "rulefix"]);
    expect(t.cert).toEqual({ status: "red", sha: B.slice(0, 7), detail: "3 failing", certified: A.slice(0, 7), atHead: false });
  });

  it("renders rules with their approvers, acceptance and protected paths, words as text", () => {
    const s = loaded();
    s.rules.set("rul_2", { ...RULE, id: "rul_2", description: "No <script> tags in templates", approvedBy: "sam", createdAt: T0 + 5 });
    const t = targetOf(s, pp);
    const head = renderToStaticMarkup(createElement(TargetView, { target: t }));
    expect(head).toContain("<b>2</b> rules, approved by maya, sam: ");
    expect(head).toContain('<span class="fs-quote">No console calls in src</span>');
    expect(head).toContain("<b>2</b> lines on 1 open intent: ");
    expect(head).toContain("The toggle persists across reloads");
    expect(head).toContain('<span class="mono fs-globs">src/auth/**, db/migrations</span>');
    expect(head).toContain("<b>3</b> open: 2 from people, 1 from rules");
    expect(head).toContain("tests <b>red</b> on <span class=\"mono\">bbbbbbb</span>");
    expect(head).toContain("behind trunk");
    const all = renderToStaticMarkup(createElement(TargetDetails, { target: t }));
    expect(all).toContain('approved by <b class="fs-who">maya</b> · 5 violations open');
    expect(all).toContain('approved by <b class="fs-who">sam</b> · satisfied');
    expect(all).toContain("No &lt;script&gt; tags in templates");
    expect(all).toContain("<li>No other file changes</li>");
    expect(all).toContain("<li>src/auth/**</li><li>db/migrations</li>");
  });

  it("says when the protected paths are not known, and when none are set", () => {
    const unknown = renderToStaticMarkup(createElement(TargetView, { target: targetOf(loaded(), { state: "unknown", why: "this recording did not keep the decide policy" }) }));
    expect(unknown).toContain("not known: this recording did not keep the decide policy");
    const none = renderToStaticMarkup(createElement(TargetView, { target: targetOf(loaded(), { state: "loaded", globs: [] }) }));
    expect(none).toContain("no paths only a person may change");
  });

  it("reads the protected paths from the decide policy, a recording's miss, or the simulator", async () => {
    expect(policyGlobs({ protectedPaths: ["src/auth/**", " db ", "src/auth/**", 7] })).toEqual(["src/auth/**", "db"]);
    expect(policyGlobs(null)).toBeNull();
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
    expect(await readProtected("web", "live", answer(200, { protectedPaths: ["src/auth/**"] }))).toEqual({ state: "loaded", globs: ["src/auth/**"] });
    expect(await readProtected("web", "replay", answer(404, { error: "Not in this recording" }, { "x-ft-recording": "miss" }))).toEqual({ state: "unknown", why: "this recording did not keep the decide policy" });
    expect(await readProtected("web", "live", answer(200, null))).toMatchObject({ state: "unknown" });
    expect(await readProtected("web", "mock")).toEqual({ state: "unknown", why: "the simulator has no decide policy" });
  });
});

describe("the convergence curve, from a run's events", () => {
  const ev = (dt: number, e: Record<string, unknown>): ColonyEvent => ({ at: T0 + dt, ...e }) as unknown as ColonyEvent;
  const events: ColonyEvent[] = [
    ev(2_000, { t: "intent", intentId: "r1", status: "open", title: "No console calls in src in src/a.ts", footprint: ["src/a.ts"] }),
    ev(4_000, { t: "violations", total: 10, byRule: { rul_1: 10 } }),
    ev(5_000, { t: "intent", intentId: "h1", status: "open", title: "Add search", footprint: ["src/search.ts"] }),
    ev(6_000, { t: "certify", trunkSha: A, status: "red", counts: counts(4, 1) }),
    ev(7_000, { t: "proposal", proposalId: "p1", intentId: "h1", agentId: "agt_1", status: "escalated" }),
    ev(20_000, { t: "violations", total: 4, byRule: { rul_1: 4 } }),
    ev(21_000, { t: "escalation", intentId: "r1", agentId: "agt_2", kind: "other", report: "The import is generated", title: "r1" }),
    ev(30_000, { t: "proposal", proposalId: "p1", intentId: "h1", agentId: "agt_1", status: "landed" }),
    ev(30_000, { t: "intent", intentId: "h1", status: "landed", title: "Add search", footprint: ["src/search.ts"] }),
    ev(31_000, { t: "escalation", intentId: "r1", agentId: "agt_2", kind: "other", report: "", title: "r1", resolved: { by: "maya", at: T0 + 31_000, decision: "dismiss", note: "" } }),
    ev(40_000, { t: "violations", total: 0, byRule: { rul_1: 0 } }),
    ev(41_000, { t: "certify", trunkSha: B, status: "running" }),
    ev(50_000, { t: "certify", trunkSha: B, status: "green", counts: counts(5, 0) }),
  ];

  it("follows every kind, counting a rule's intent by its violations and a held change as waiting", () => {
    const points = distanceSeries({ events }, [RULE]);
    expect(points.map((p) => [p.at - T0, p.total])).toEqual([
      [2_000, 0],
      [4_000, 10],
      [5_000, 11],
      [6_000, 12],
      [7_000, 12],
      [20_000, 6],
      [21_000, 7],
      [30_000, 6],
      [31_000, 5],
      [40_000, 1],
      [50_000, 0],
    ]);
    // At 7 s the intent's change waits for a person: no longer an unmet intent, now waiting.
    expect(points[4]).toMatchObject({ violations: 10, tests: 1, intents: 0, waiting: 1 });
    expect(distanceAt(points, T0 + 25_000)).toBe(7);
    expect(distanceAt(points, T0)).toBe(0);
  });

  it("uses what the page learned of an intent's origin over its title", () => {
    const points = distanceSeries({ events }, [RULE], (id) => (id === "h1" ? { source: "certify" } : undefined));
    expect(points.every((p) => p.intents === 0)).toBe(true);
  });

  it("says how far it climbed and how long it took to get back to zero, from the rule change", () => {
    const points = distanceSeries({ events }, [RULE]);
    expect(summarize(points, [RULE])).toEqual({ peak: 12, peakAt: T0 + 6_000, from: T0, zeroAt: T0 + 50_000, last: 0 });
    const curve = runCurve(points, T0, T0 + 52_000, T0 + 25_000, [RULE]);
    expect(curve).toMatchObject({ kind: "run", caption: "12 → 0 in 50 s", max: 12, t0: T0, t1: T0 + 52_000 });
    const html = renderToStaticMarkup(createElement(CurveView, { curve }));
    expect(html).toContain("12 → 0 in 50 s");
    expect(html).toContain(" · 7 at this point");
    expect(html).toContain('class="fs-now"');
    expect(html).toContain('class="fs-zero"');
  });

  it("draws steps across the span, cut at the replay's time", () => {
    const points = distanceSeries({ events }, [RULE]);
    const full = stepPath(points, T0, T0 + 50_000, 100, 20, 12, 0);
    expect(full.startsWith("M0 20.0 H4.0 V20.0 H8.0 V3.3")).toBe(true);
    expect(full.endsWith("H100.0 V20.0 H100.0")).toBe(true);
    expect(stepPath(points, T0, T0 + 50_000, 100, 20, 12, 0, T0 + 10_000).endsWith("H20.0")).toBe(true);
    expect(stepPath([], T0, T0 + 1, 100, 20, 1)).toBe("");
  });

  it("falls back to the live window of violations, and says when there is no curve", () => {
    const w = windowCurve({ bucketMs: 60_000, start: T0, violations: [40, 30, 12, 9], landings: [] }, 3);
    expect(w).toMatchObject({ kind: "window", caption: "Violations, last 4 min: 40 at the peak, 3 now", now: null });
    expect(w?.points.map((p) => p.total)).toEqual([40, 30, 12, 3]);
    expect(windowCurve(null, 0)).toBeNull();
    expect(renderToStaticMarkup(createElement(CurveView, { curve: null }))).toContain("A replay draws its run&#x27;s whole convergence curve from the record.");
  });
});

describe("the exceptions strip", () => {
  it("is the needs-you line, with held merges named on the review need and the pause in force", () => {
    const s = loaded();
    s.applyEvents([{ t: "paused", at: T0 + 5, scope: "colony", by: "maya", reason: "<b>demo reset</b>" }]);
    const x = exceptionsOf(s);
    expect(x.held).toBe(1);
    expect(x.needs.map((n) => n.key)).toEqual(["review", "reports", "tests"]);
    expect(x.needs[0]?.label).toBe("changes to review (1 held merge)");
    expect(x.pause).toMatchObject({ scope: "colony", by: "maya" });
    const html = renderToStaticMarkup(createElement(ExceptionsView, { exceptions: x, colonyId: "web" }));
    expect(html).toContain('<span class="needs-k">Exceptions</span>');
    expect(html).toContain("Paused by maya: &lt;b&gt;demo reset&lt;/b&gt;");
    expect(html).toContain('<b class="need-n">2</b><span class="need-label">changes to review (1 held merge)</span>');
    expect(html).toContain('<b class="need-n">3</b><span class="need-label">failing on bbbbbbb</span>');
    expect(isHeldMerge("stale: src/a.ts (expected 1, trunk has 2)")).toBe(false);
  });

  it("says plainly when nothing needs a person", () => {
    const html = renderToStaticMarkup(createElement(ExceptionsView, { exceptions: { needs: [], held: 0, pause: null } }));
    expect(html).toContain('class="fs-needs is-quiet"');
    expect(html).toContain("Nothing needs a person.");
    expect(renderToStaticMarkup(createElement(ExceptionsView, { exceptions: { needs: [], held: 0, pause: null }, replay: true }))).toContain("Nothing needed a person at this point.");
  });
});
