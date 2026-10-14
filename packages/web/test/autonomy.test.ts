import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpBackend, saveToken } from "../src/api.ts";
import { autonomyRow, autonomyView, parseAutonomy, revocationOf, whenWords, type AutonomyRegion, type AutonomyReport } from "../src/autonomy.ts";
import { AUTONOMY_SHOWN, AutonomyStripView } from "../src/components/AutonomyStrip.tsx";

/** Earned autonomy on the Review tab: the immune report read without a token, and the strip's sentences. */

// Local times, so the clock words read the same in every time zone.
const NOW = new Date(2026, 9, 14, 18, 0).getTime();
const NOON = new Date(2026, 9, 14, 12, 3).getTime();
const NIGHT_BEFORE = new Date(2026, 9, 13, 0, 14).getTime();
const PRP = "prp_mv5xi9ltfmkw0b";

const region = (r: Partial<AutonomyRegion> & { region: string }): AutonomyRegion => ({ approved: 0, earned: false, revokedAt: null, reason: null, lastAt: null, ...r });
const report = (regions: AutonomyRegion[], extra: Partial<AutonomyReport> = {}): AutonomyReport => ({ enabled: true, after: 3, regions, ...extra });

/** An immune report as the colony sends it (GET /api/colonies/:id/immune), with what the strip does not read trimmed. */
function immune(autonomy: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: true, policy: { enabled: true, autonomyAfter: 3 }, antibodies: [], detectors: [], autonomy, alerts: { lastHour: 0, budget: 30 }, decisions: [], ...extra };
}

describe("parseAutonomy", () => {
  it("reads each region as the colony sent it, with the threshold from its policy", () => {
    const raw = immune([
      { region: "src", approved: 7, earned: true, revokedAt: null, reason: null, lastAt: NOON },
      { region: "src/routes", approved: 2, earned: false, revokedAt: NIGHT_BEFORE, reason: `escalated ${PRP}`, lastAt: NOON + 5 },
    ]);
    expect(parseAutonomy(JSON.parse(JSON.stringify({ ...raw, policy: { autonomyAfter: 5 } })))).toEqual({
      enabled: true,
      after: 5,
      regions: [
        { region: "src", approved: 7, earned: true, revokedAt: null, reason: null, lastAt: NOON },
        { region: "src/routes", approved: 2, earned: false, revokedAt: NIGHT_BEFORE, reason: `escalated ${PRP}`, lastAt: NOON + 5 },
      ],
    });
  });

  it("reads a server that predates lastAt, and drops what it cannot use", () => {
    const raw = immune([{ region: "src", approved: 3 }, { region: "", approved: 9 }, { approved: 1 }, null, { region: "lib\u001b[31m", approved: "7", revokedAt: -1, reason: 4 }], { policy: {} });
    expect(parseAutonomy(raw)).toEqual({
      enabled: true,
      after: 3,
      regions: [
        { region: "src", approved: 3, earned: true, revokedAt: null, reason: null, lastAt: null },
        { region: "lib [31m", approved: 0, earned: false, revokedAt: null, reason: null, lastAt: null },
      ],
    });
    expect(parseAutonomy(immune([], { enabled: false }))?.enabled).toBe(false);
  });

  it("is null for an older server or anything malformed", () => {
    expect(parseAutonomy(undefined)).toBeNull();
    expect(parseAutonomy({ antibodies: [] })).toBeNull();
    expect(parseAutonomy({ autonomy: "src" })).toBeNull();
    expect(parseAutonomy([])).toBeNull();
  });
});

describe("each region's sentence", () => {
  it("says what was earned", () => {
    expect(autonomyRow(region({ region: "src/api", approved: 7, earned: true }), 3, NOW)).toEqual({ region: "src/api", state: "earned", badge: "earned", text: "Earned with 7 approved landings." });
  });

  it("says how far a region is, and what earns it", () => {
    expect(autonomyRow(region({ region: "src/api", approved: 2 }), 3, NOW)).toEqual({
      region: "src/api",
      state: "progress",
      badge: "2 of 3",
      text: "2 of 3 approved landings. 1 more approved landing earns it.",
    });
    expect(autonomyRow(region({ region: "src/api" }), 3, NOW).text).toBe("0 of 3 approved landings. 3 more approved landings earn it.");
  });

  it("says what revoked it, when, and what earns it back", () => {
    expect(autonomyRow(region({ region: "src/auth", revokedAt: NOON, reason: `rejected ${PRP} by maya` }), 3, NOW)).toEqual({
      region: "src/auth",
      state: "revoked",
      badge: "revoked",
      text: "Revoked at 12:03 when a person rejected prp_fmkw0b. 3 more approved landings earn it back.",
      proposalId: PRP,
    });
    expect(autonomyRow(region({ region: "src/routes", approved: 2, revokedAt: NIGHT_BEFORE, reason: `escalated ${PRP}` }), 3, NOW).text).toBe(
      "Revoked on Oct 13 at 00:14 when prp_fmkw0b was sent to a person. 2 of 3 have landed approved since. 1 more approved landing earns it back.",
    );
    expect(autonomyRow(region({ region: "src", revokedAt: NOON, reason: "reset by hand" }), 3, NOW).text).toBe("Revoked at 12:03 (reset by hand). 3 more approved landings earn it back.");
  });

  it("says when a region earned it back", () => {
    const back = autonomyRow(region({ region: "src/auth", approved: 3, earned: true, revokedAt: NOON, reason: `rejected ${PRP} by maya` }), 3, NOW);
    expect(back).toMatchObject({ state: "earned", text: "Earned back with 3 approved landings since a person rejected prp_fmkw0b at 12:03.", proposalId: PRP });
  });

  it("reads the colony's reasons and clock times", () => {
    expect(revocationOf(`rejected ${PRP} by maya`)).toEqual({ kind: "rejected", proposalId: PRP });
    expect(revocationOf(`escalated ${PRP}`)).toEqual({ kind: "escalated", proposalId: PRP });
    expect(revocationOf("something else")).toEqual({ kind: "other", text: "something else" });
    expect(revocationOf(null)).toBeNull();
    expect(whenWords(NOON, NOW)).toBe("at 12:03");
    expect(whenWords(NIGHT_BEFORE, NOW)).toBe("on Oct 13 at 00:14");
  });
});

describe("the strip's view", () => {
  it("counts the regions earned and revoked, and lists the latest to move first", () => {
    const v = autonomyView(
      report([
        region({ region: "src", approved: 7, earned: true, lastAt: 100 }),
        region({ region: "src/routes", approved: 2, revokedAt: 250, reason: `escalated ${PRP}`, lastAt: 300 }),
        region({ region: "src/store", approved: 2, lastAt: 200 }),
      ]),
      NOW,
    );
    expect(v.headline).toBe("Autonomy earned in 1 of 3 regions · 1 revoked");
    expect(v.rows.map((r) => r.region)).toEqual(["src/routes", "src/store", "src"]);
    expect([v.earned, v.revoked, v.empty, v.off]).toEqual([1, 1, null, null]);
  });

  it("puts the newest revocations first from a server that predates lastAt, and keeps its order for the rest", () => {
    const v = autonomyView(
      report([
        region({ region: "src", approved: 7, earned: true }),
        region({ region: "src/a", revokedAt: 10, reason: `escalated ${PRP}` }),
        region({ region: "src/b", approved: 1 }),
        region({ region: "src/c", revokedAt: 20, reason: `rejected ${PRP} by maya` }),
      ]),
      NOW,
    );
    expect(v.rows.map((r) => r.region)).toEqual(["src/c", "src/a", "src", "src/b"]);
  });

  it("says what earns autonomy when nothing has been reviewed yet", () => {
    const v = autonomyView(report([]), NOW);
    expect(v.headline).toBe("No region has earned autonomy yet");
    expect(v.empty).toBe("Nothing has been reviewed in this colony yet, so no region has approved landings to count.");
    expect(v.explain).toBe(
      "A region earns autonomy once 3 of its changes land approved by a proof, a second model or a person. Then the reflex alone may land a change there when a person or a rule wrote its intent. An escalation to a person or a rejection there takes it back until 3 more land approved.",
    );
    expect(v.rows).toEqual([]);
  });

  it("says so when review is off", () => {
    expect(autonomyView(report([], { enabled: false }), NOW).off).toBe("Review is off in this colony: changes go to their lanes without review, so earned autonomy is not used.");
  });
});

describe("the strip", () => {
  const twelve = report(Array.from({ length: 12 }, (_, i) => region({ region: `src/r${i}`, approved: i % 4, earned: i % 4 === 3, lastAt: 1_000 - i })));

  it("shows the latest few regions and folds the rest", () => {
    const html = renderToStaticMarkup(createElement(AutonomyStripView, { report: twelve, now: NOW, onToggle: () => undefined }));
    expect(html).toContain("Autonomy earned in 3 of 12 regions");
    expect(html.match(/<li /g)).toHaveLength(AUTONOMY_SHOWN);
    expect(html).toContain("Show all 12 regions");
    const open = renderToStaticMarkup(createElement(AutonomyStripView, { report: twelve, now: NOW, open: true, onToggle: () => undefined }));
    expect(open.match(/<li /g)).toHaveLength(12);
    expect(open).toContain(`Show the latest ${AUTONOMY_SHOWN}`);
  });

  it("shows each region with its badge and sentence, and no fold for a handful", () => {
    const html = renderToStaticMarkup(createElement(AutonomyStripView, { report: report([region({ region: "src/auth", revokedAt: NOON, reason: `rejected ${PRP} by maya` })]), now: NOW, onToggle: () => undefined }));
    expect(html).toContain('<span class="autonomy-badge is-revoked">revoked</span>');
    expect(html).toContain(`title="${PRP}"`);
    expect(html).toContain("Revoked at 12:03 when a person rejected prp_fmkw0b.");
    expect(html).not.toContain("Show all");
    // The files at the top of the repository, named as the Intents tab names them.
    const root = renderToStaticMarkup(createElement(AutonomyStripView, { report: report([region({ region: ".", approved: 1 })]), now: NOW }));
    expect(root).toContain('title="Files at the top of the repository">(root)</span>');
  });

  it("shows the empty state with what earns autonomy", () => {
    const html = renderToStaticMarkup(createElement(AutonomyStripView, { report: report([]), now: NOW }));
    expect(html).toContain("No region has earned autonomy yet");
    expect(html).toContain("Nothing has been reviewed in this colony yet");
    expect(html).toContain("A region earns autonomy once 3 of its changes land approved");
    expect(html).not.toContain("<ul");
  });
});

describe("reading the immune report", () => {
  afterEach(() => {
    saveToken("");
    vi.unstubAllGlobals();
  });

  it("asks the colony's public route and sends no token, even when this browser keeps one", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return new Response(JSON.stringify(immune([])), { status: 200 });
      }),
    );
    saveToken("operator-token");
    expect(parseAutonomy(await new HttpBackend("web").immune())).toEqual({ enabled: true, after: 3, regions: [] });
    expect(calls.map((c) => c.url)).toEqual(["/api/colonies/web/immune"]);
    expect(JSON.stringify(calls[0]?.init?.headers ?? {})).not.toMatch(/authorization|operator-token/i);
  });
});
