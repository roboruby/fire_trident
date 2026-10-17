import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { changeLifecycle, intentLifecycle, type ColonySnapshot, type Landing, type LineageNote, type Proposal } from "@fire_trident/core";
import type { Backend } from "../src/api.ts";
import { IntentLifecycleView, LifecycleStrip, WhyLifecycles } from "../src/components/Lifecycle.tsx";
import { lifecycleHref, readLifecycle, reviewLifecycle, whyLifecycle } from "../src/lifecycle.ts";
import { ColonyStore } from "../src/store.ts";

/** The lifecycle strip on the colony page: built from a Why card's note and a review item, read for an intent, drawn with links. */

const NOW = 1_800_000_000_000;
const SHA = "a".repeat(40);
const GREEN = "c".repeat(40);
const gate = { name: "gate", ok: true, ms: 0, detail: "D3 innate+proof → land by deterministic at head 1 (confirmations: innate + deterministic): proof", gate: { rule: "D3 innate+proof", preset: "production", values: [] } };
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

function store(over: Partial<ColonySnapshot["colony"]> = {}): ColonyStore {
  const s = new ColonyStore("web");
  s.applySnapshot({
    colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: GREEN, createdAt: 0, regionDepth: 1, ...over },
    files: [{ path: "src/a.ts", size: 10 }],
    intents: [{ id: "int_1", colonyId: "web", title: "Add a limit", why: "", source: "human", footprint: ["src/a.ts"], priority: 1, status: "landed", createdAt: NOW - 3_600_000, createdBy: "lee" }],
    rules: [],
    agents: [{ id: "agt_1", colonyId: "web", kind: "internal", name: "worker-1", model: "@cf/google/gemma-4-26b-a4b-it", thresholds: {}, state: "idle", lastSeen: 0 }],
    recentLandings: [
      { id: "lnd_1", colonyId: "web", trunkSha: SHA, parentSha: "f".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: NOW - 60_000 },
      { id: "lnd_2", colonyId: "web", trunkSha: GREEN, parentSha: SHA, proposalIds: ["prp_2"], intentIds: ["int_2"], paths: ["src/b.ts"], regions: ["src"], at: NOW - 30_000 },
    ],
    violations: { total: 0, byRule: {} },
    funnel: { reflex: 0, llm: 0, human: 0 },
    metrics: {},
  } as unknown as ColonySnapshot);
  return s;
}

const entry = (): { landing: Landing; note: LineageNote } => ({
  landing: { id: "lnd_1", colonyId: "web", trunkSha: SHA, parentSha: "f".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: NOW - 60_000 },
  note: {
    schema: "firetrident.lineage/v1",
    landingId: "lnd_1",
    colonyId: "web",
    proposals: [{ id: "prp_1", agentId: "agt_1", agentKind: "internal", model: "@cf/google/gemma-4-26b-a4b-it", intent: { id: "int_1", title: "Add a limit", why: "", source: "human", createdBy: "lee" }, writeSet: [], readSet: [], decisions: [], evidence: { checks: [gate] } }],
  } as LineageNote,
});

describe("the strip on a Why card", () => {
  it("is built from the note, and placed by the newest green commit the page knows", () => {
    const s = store({ greenSha: GREEN });
    const e = entry();
    const strip = whyLifecycle(s, e.landing, e.note.proposals[0]!, e.note, null);
    expect(strip.reached).toBe("certified");
    expect(strip.steps.map((x) => x.text).slice(0, 6)).toEqual([
      "lee (a person)",
      "worker-1 (in-platform agent, gemma-4-26b-a4b-it)",
      "prp_1",
      "deterministic proof: D3 innate+proof",
      "lnd_1 · aaaaaaa",
      "certified commit ccccccc includes it",
    ]);
    expect(strip.steps[0]?.at).toBe(NOW - 3_600_000);
    // Without a green commit after it, it is not certified yet; a test row saying no tests wins.
    expect(whyLifecycle(store(), e.landing, e.note.proposals[0]!, e.note, null).reached).toBe("landed");
    const none = whyLifecycle(store({ greenSha: GREEN }), e.landing, e.note.proposals[0]!, e.note, { colonyId: "web", landingId: "lnd_1", trunkSha: SHA, baseSha: SHA, status: "no-tests", reason: "no test file on trunk", proof: { rungs: [], text: "" }, text: "" });
    expect(none.steps[5]).toMatchObject({ state: "none", text: "no tests this platform can run: no test file on trunk" });
  });

  it("renders the strip with each step linked to its evidence, the step reached marked, and the caption", () => {
    const s = store({ greenSha: GREEN });
    const backend = { mode: "live" } as unknown as Backend;
    const out = html(createElement(WhyLifecycles, { store: s, backend, entry: entry(), proposals: entry().note.proposals, auto: false }));
    expect(out).toContain('href="/api/colonies/web/intents/int_1"');
    expect(out).toContain('href="/api/colonies/web/proposals/prp_1"');
    expect(out).toContain('href="/api/colonies/web/notes/verify?landing=lnd_1"');
    expect(out).toContain('href="/api/colonies/web/landings/lnd_1/tests"');
    expect(out).toContain('href="/#take-back"');
    expect(out).toMatch(/<li class="life-step is-done is-reached" aria-current="step">.*Certified/);
    expect(out).toContain('class="life-step is-outside"');
    expect(out).toContain("Next, outside FireTrident:");
    expect(out).toContain("FireTrident lands to its own trunk and never merges into your repository; the last two steps happen in your forge.");
    // In the simulator there is no API to link to; the take-back commands are the landing page's.
    const mock = html(createElement(WhyLifecycles, { store: s, backend: { mode: "mock" } as unknown as Backend, entry: entry(), proposals: entry().note.proposals, auto: false }));
    expect(mock).not.toContain("/api/colonies");
    expect(mock).toContain('href="/#take-back"');
  });

  it("lists every step on demand, with the take-back command, and never draws the forge's steps as done", () => {
    const strip = whyLifecycle(store({ greenSha: GREEN }), entry().landing, entry().note.proposals[0]!, entry().note, null);
    const out = html(createElement(LifecycleStrip, { s: strip, href: () => null, now: NOW, open: true }));
    expect(out).toContain('<code class="life-cmd">git push &lt;your-origin&gt; certified:refs/heads/firetrident/certified</code>');
    expect(out).toContain("outside FireTrident: a person merges it in your forge");
    expect(out).not.toMatch(/life-item is-done[^"]*"><span class="life-item-k"><span class="life-mark" aria-hidden="true">✓<\/span>Taken back/);
    expect(strip.steps.filter((x) => x.key === "taken-back" || x.key === "merged").map((x) => x.state)).toEqual(["outside", "outside"]);
  });
});

describe("where a change left the path", () => {
  it("draws a returned change with its reason and the landing that beat it", () => {
    const strip = changeLifecycle({
      intent: { id: "int_1", status: "claimed" },
      change: { id: "prp_9", agentId: "agt_1", status: "returned", reason: "stale: src/a.ts changed", beatenBy: { landingId: "lnd_7", trunkSha: GREEN, title: "Rename a" }, evidence: { checks: [gate] } },
    });
    const out = html(createElement(LifecycleStrip, { s: strip, href: (l) => lifecycleHref("web", strip, l, "live"), now: NOW }));
    expect(out).toContain("life is-off is-returned");
    expect(out).toContain("<b>Returned after confirmed</b>: stale: src/a.ts changed");
    expect(out).toContain('href="/api/colonies/web/notes/verify?landing=lnd_7"');
    expect(out).toContain("“Rename a”");
    expect(out).toContain('class="life-step is-todo is-left"');
  });

  it("draws the review card's change as waiting for a person", () => {
    const s = store();
    const p = { id: "prp_5", intentId: "int_1", agentId: "agt_1", status: "escalated", reason: "escalated by llm: touches the session", createdAt: NOW - 5_000, evidence: { checks: [] } } as unknown as Proposal;
    const strip = reviewLifecycle(s, p);
    expect(strip.off).toMatchObject({ kind: "escalated", after: "proposed", text: "waiting for a person: escalated by llm: touches the session" });
    expect(strip.steps[0]?.text).toBe("a person");
    expect(strip.steps[1]?.text).toBe("worker-1 (in-platform agent, gemma-4-26b-a4b-it)");
  });
});

describe("an intent's strip, read from the colony", () => {
  const answer = intentLifecycle({ colonyId: "web", intent: { id: "int_1", status: "open", closure: { cause: "reaped_silent", at: NOW - 1_000, agentId: "agt_w", gapMs: 700_000 } }, changes: [], agents: { agt_w: { id: "agt_w", name: "walker" } } });

  it("reads the public route, and says why when it cannot", async () => {
    const asked: string[] = [];
    const ok = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify(answer));
    }) as typeof fetch;
    const l = await readLifecycle("web", "int_1", "live", ok);
    expect(asked).toEqual(["/api/colonies/web/intents/int_1/lifecycle"]);
    expect(l.state === "loaded" && l.lifecycle.current.off?.kind).toBe("reaped");
    expect(await readLifecycle("web", "int_1", "mock")).toEqual({ state: "unknown", why: "the simulator keeps no lifecycle" });
    const status = (code: number, headers: Record<string, string> = {}) => (async () => new Response("{}", { status: code, headers })) as unknown as typeof fetch;
    expect(await readLifecycle("web", "int_1", "live", status(404))).toMatchObject({ state: "unknown", why: expect.stringMatching(/does not keep/) });
    expect(await readLifecycle("web", "int_1", "replay", status(404, { "x-ft-recording": "miss" }))).toEqual({ state: "unknown", why: "this recording did not keep it" });
    expect(await readLifecycle("web", "int_1", "live", status(200))).toEqual({ state: "unknown", why: "the server's answer was not a lifecycle" });
    expect(await readLifecycle("web", "int_1", "live", (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch)).toEqual({ state: "unknown", why: "the colony API could not be reached" });
  });

  it("draws a reaped intent, and says while it reads", () => {
    const strip = answer.current;
    const out = html(createElement(LifecycleStrip, { s: strip, href: (l) => lifecycleHref("web", strip, l, "live"), now: NOW }));
    expect(out).toContain("life is-off is-reaped");
    expect(out).toContain("<b>Reaped after claimed</b>: the colony took it back: walker was silent for 11 min 40 s; it is open for the next agent");
    expect(html(createElement(IntentLifecycleView, { colonyId: "web", intentId: "int_1", mode: "live" }))).toContain("Reading its lifecycle…");
  });
});

describe("the strip at 375 px", () => {
  it("wraps its row and stacks its list on a narrow screen", () => {
    const css = readFileSync(new URL("../src/components/lifecycle.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.life-row \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{[\s\S]*\.life-item \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  });
});
