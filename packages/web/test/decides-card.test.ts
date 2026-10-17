import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { decidesOf, landingConfirmed, type DecidesReport, type LineageNote } from "@fire_trident/core";
import { ConfirmedLine, DecidesCard, DecidesFold, DecidesRow } from "../src/components/Decides.tsx";
import { TargetDetails, TargetView } from "../src/components/FirstScreen.tsx";
import { decidesSummary, readDecides, type DecidesState } from "../src/decides.ts";
import { NoteCardView } from "../src/landing/LiveNote.tsx";
import { recordedCard } from "../src/landing/note.ts";
import { ColonyStore } from "../src/store.ts";
import { targetOf } from "../src/target.ts";

/** How a colony decides, on the page: the target panel's row, the card, the Why tab's fold, and each landing card's confirming rule. */

const PRESETS = [
  { name: "local-development", label: "local development", lets: "Almost anything lands without a person.", settings: [] },
  { name: "central-development", label: "central development", lets: "A proof, an approval under 0.5, or autonomy after 3 lands a change without a person.", settings: [] },
  { name: "pre-production", label: "pre-production", lets: "Fewer things land without a person.", settings: [] },
  { name: "production", label: "production", lets: "Only careful things land without a person.", settings: [] },
];

/** A report as GET /api/colonies/:id/decides sends it. */
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    colonyId: "web",
    preset: "central-development",
    nearest: "central-development",
    differs: [],
    settings: [
      { field: "confidence", label: "reflex confidence to act alone", value: 0.8 },
      { field: "commentProof", label: "comment-only proof", value: true },
    ],
    lets: "A proof, an approval under 0.5, or autonomy after 3 lands a change without a person.",
    reviewing: true,
    protectedPaths: 2,
    dangerAllow: 0,
    always: "Whatever the preset, a person decides a change with a danger pattern.",
    presets: PRESETS,
    split: { days: 30, since: 0, total: 40, counts: { deterministic: 24, model: 10, autonomy: 4, person: 2, unreviewed: 0 } },
    at: 1,
    ...over,
  };
}

const loaded = (over: Record<string, unknown> = {}): DecidesState => ({ state: "loaded", report: decidesOf(raw(over)) as DecidesReport });
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("reading the report", () => {
  const answer = (body: unknown, init: ResponseInit = {}) => (async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init })) as unknown as typeof fetch;

  it("reads it from the public route, and says why when it cannot", async () => {
    const asked: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify(raw()));
    }) as typeof fetch;
    const d = await readDecides("web", "live", fetcher);
    expect(asked).toEqual(["/api/colonies/web/decides"]);
    expect(d.state === "loaded" && d.report.preset).toBe("central-development");
    expect(await readDecides("web", "mock")).toEqual({ state: "unknown", why: "the simulator has no decide policy" });
    expect(await readDecides("web", "live", answer({ error: "no route" }, { status: 404 }))).toEqual({ state: "unknown", why: "this server does not report how its colonies decide" });
    expect(await readDecides("web", "replay", answer({ error: "Not in this recording" }, { status: 404, headers: { "x-ft-recording": "miss" } }))).toEqual({ state: "unknown", why: "this recording did not keep how the colony decides" });
    expect(await readDecides("web", "live", answer({ preset: 3 }))).toEqual({ state: "unknown", why: "the server's answer was not a report" });
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await readDecides("web", "live", down)).toEqual({ state: "unknown", why: "the colony API could not be reached" });
  });

  it("sums the split up in one line", () => {
    const d = loaded();
    expect(d.state === "loaded" && decidesSummary(d.report)).toBe("central development · 40 landed in 30 days: 60% proof · 25% model · 10% autonomy · 5% person");
    const quiet = loaded({ preset: "custom", nearest: "production", split: { days: 30, since: 0, total: 0, counts: {} } });
    expect(quiet.state === "loaded" && decidesSummary(quiet.report)).toBe("custom (nearest production) · nothing landed in the last 30 days");
  });
});

describe("the card", () => {
  it("names the preset, what it lets land without a person, and the 30-day split with counts and shares", () => {
    const out = html(createElement(DecidesCard, { d: loaded(), colonyId: "web" }));
    expect(out).toContain('aria-label="How this colony decides"');
    expect(out).toContain('<span class="dc-preset">central development</span>');
    expect(out).toContain("A proof, an approval under 0.5, or autonomy after 3 lands a change without a person.");
    expect(out).toContain("Last 30 days: <b>40</b> changes landed");
    expect(out).toContain('aria-label="deterministic proof 24 (60%), a model 10 (25%), earned autonomy 4 (10%), a person 2 (5%)"');
    expect(out).toMatch(/earned autonomy <b>4<\/b><span class="dc-pct">10%<\/span>/);
    // The four presets, this colony's marked, with the settings and how to change them.
    expect(out).toMatch(/<li class="is-current"><b>central development<\/b><span class="dc-tag">this colony<\/span>/);
    expect(out).toContain("<dt>reflex confidence to act alone</dt><dd class=\"mono\">0.8</dd>");
    expect(out).toContain("<dt>comment-only proof</dt><dd class=\"mono\">on</dd>");
    expect(out).toContain("<dt>protected paths</dt><dd class=\"mono\">2</dd>");
    expect(out).toContain("POST /api/colonies/web/decide/policy");
    // Read-only: nothing on the card changes the policy.
    expect(out).not.toMatch(/<button|<form|<input|<select/);
  });

  it("says custom with each value that differs from the nearest preset", () => {
    const out = html(
      createElement(DecidesCard, {
        d: loaded({ preset: "custom", nearest: "production", differs: [{ field: "needsHuman", label: "p(needs_human) a landing stays under", value: 0.25, preset: 0.2 }] }),
        colonyId: "web",
      }),
    );
    expect(out).toContain('<span class="dc-preset is-custom">custom (nearest production)</span>');
    expect(out).toContain("p(needs_human) a landing stays under <b>0.25</b> <span class=\"dc-dim\">(preset 0.2)</span>");
    expect(out).toMatch(/<li class="is-nearest"><b>production<\/b><span class="dc-tag">nearest<\/span>/);
  });

  it("warns when review is off, and says why it is not known", () => {
    expect(html(createElement(DecidesCard, { d: loaded({ reviewing: false }), colonyId: "web" }))).toContain("Review is off now: changes go to their lanes without the gate");
    expect(html(createElement(DecidesCard, { d: { state: "unknown", why: "this recording did not keep how the colony decides" }, colonyId: "web" }))).toContain("Not known: this recording did not keep how the colony decides.");
    expect(html(createElement(DecidesCard, { d: { state: "loading" }, colonyId: "web" }))).toContain("Reading the colony&#x27;s decide policy…");
  });

  it("folds to one line in the Why tab, and shows nothing there until it is read", () => {
    const out = html(createElement(DecidesFold, { d: loaded(), colonyId: "web" }));
    expect(out).toMatch(/^<details class="dc-fold"><summary><span class="dc-k">Decides<\/span> <b>central development<\/b><span class="dc-dim"> · 40 landed in 30 days: 60% proof/);
    expect(out).toContain('aria-label="How this colony decides"');
    expect(html(createElement(DecidesFold, { d: { state: "loading" }, colonyId: "web" }))).toBe("");
  });
});

describe("the target panel", () => {
  const store = (): ColonyStore => {
    const s = new ColonyStore("web");
    s.applySnapshot({
      colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: "b".repeat(40), createdAt: 0, regionDepth: 1 },
      files: [],
      intents: [],
      rules: [],
      agents: [],
      recentLandings: [],
      violations: { total: 0, byRule: {} },
      funnel: { reflex: 0, llm: 0, human: 0 },
      metrics: {},
    } as never);
    return s;
  };

  it("has a Decides row with the preset and the split, and the whole card under All of it", () => {
    const target = targetOf(store(), { state: "loaded", globs: [] });
    const head = html(createElement(TargetView, { target, decides: loaded() }));
    expect(head).toContain("<dt>Decides</dt>");
    expect(head).toContain("<b>central development</b><span class=\"fs-dim\"> · 40 landed in 30 days: 60% proof · 25% model · 10% autonomy · 5% person</span>");
    expect(html(createElement(TargetDetails, { target, decides: loaded(), colonyId: "web" }))).toContain('aria-label="How this colony decides"');
    // Without the report (a caller that has none), the panel is as it was.
    expect(html(createElement(TargetView, { target }))).not.toContain("Decides");
    expect(html(createElement(DecidesRow, { d: { state: "unknown", why: "the simulator has no decide policy" } }))).toContain("not known: the simulator has no decide policy");
  });
});

describe("a landing card's confirming rule", () => {
  const R3 = {
    name: "gate",
    ok: true,
    ms: 0,
    detail: "R3 innate+autonomy → land by reflex at head 9a7220a8f2f2 (confirmations: innate + autonomy): reflex clear (confidence 0.93), region has earned autonomy",
    gate: {
      rule: "R3 innate+autonomy",
      preset: "production",
      values: [
        { name: "confidence", value: 0.93, op: "≥", bound: 0.85 },
        { name: "p(needs_human)", value: 0.04, op: "<", bound: 0.2 },
        { name: "approved landings", value: 20, op: "≥", bound: 20 },
      ],
    },
  };
  const note = { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "web", proposals: [{ id: "prp_1", decisions: [], evidence: { checks: [R3] } }] } as unknown as LineageNote;

  it("shows the rule with the values it used and the preset then", () => {
    const out = html(createElement(ConfirmedLine, { c: landingConfirmed(note) }));
    expect(out).toContain('<div class="confirmed is-autonomy"><span class="confirmed-k">Confirmed</span>');
    expect(out).toContain("R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 &lt; 0.2, approved landings 20 ≥ 20");
    expect(out).toContain(">production</span>");
  });

  it("is on the landing page's note card, from the note alone", () => {
    const card = recordedCard();
    expect(card.confirmed?.text).toBe("D3 innate+proof: a deterministic proof, no model");
    const out = html(createElement(NoteCardView, { card, origin: "https://firetrident.com" }));
    expect(out).toContain('<span class="confirmed-k">Confirmed</span><span class="confirmed-text">D3 innate+proof: a deterministic proof, no model</span>');
  });
});
