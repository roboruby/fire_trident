import { describe, expect, it } from "vitest";
import type { Landing, LineageNote } from "@fire_trident/core";
import { colors, formatWhy } from "../src/format.ts";
import { confirmedLine, decidesLines, decidesRequest, presetWords } from "../src/gateline.ts";
import { decidesOf } from "../src/decides.ts";
import { main, type Io } from "../src/run.ts";

/** How a colony decides in the CLI: `ft status` prints the preset and the 30-day split, `ft why` the rule that confirmed each landing. */

const c = colors(false);
const NOW = 1_792_000_000_000;

const PRESETS = ["local-development", "central-development", "pre-production", "production"].map((name) => ({ name, label: name.replace(/-/g, " "), lets: `${name} lets things land.`, settings: [] }));

/** A report as GET /api/colonies/:id/decides sends it. */
const REPORT = {
  colonyId: "web",
  preset: "production",
  nearest: "production",
  differs: [],
  settings: [],
  lets: "A deterministic proof, a second opinion's approval with p(needs_human) under 0.2, or the reflex alone at confidence 0.9 or more lands a change without a person.",
  reviewing: true,
  protectedPaths: 0,
  dangerAllow: 0,
  always: "Whatever the preset, a person decides a change with a danger pattern.",
  presets: PRESETS,
  split: { days: 30, since: NOW - 30 * 86_400_000, total: 40, counts: { deterministic: 24, model: 10, autonomy: 4, person: 2, unreviewed: 0 } },
  at: NOW,
};

const R3_CHECK = {
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

const landing: Landing = { id: "lnd_1", colonyId: "web", trunkSha: "b".repeat(40), parentSha: "a".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: NOW - 60_000 };
const note = (checks: unknown[]): LineageNote =>
  ({
    schema: "firetrident.lineage/v1",
    landingId: "lnd_1",
    colonyId: "web",
    proposals: [{ id: "prp_1", agentId: "agt_1", agentKind: "internal", intent: { id: "int_1", title: "Add a helper", why: "" }, writeSet: [{ path: "src/a.ts", blob: "c".repeat(40) }], readSet: [], decisions: [], evidence: { checks, residual: [] } }],
  }) as unknown as LineageNote;

describe("ft status: how the colony decides", () => {
  it("prints the preset with the 30-day split, then what it lets land without a person", () => {
    expect(decidesRequest("web")).toEqual({ method: "GET", path: "/api/colonies/web/decides" });
    expect(decidesLines(REPORT, c)).toEqual([
      "decides    production · Last 30 days: 40 changes landed, 24 by deterministic proof (60%), 10 by a model (25%), 4 on earned autonomy (10%), 2 by a person (5%).",
      `           ${REPORT.lets}`,
    ]);
  });

  it("says custom with what differs from the nearest preset, in yellow, and warns when review is off", () => {
    const custom = {
      ...REPORT,
      preset: "custom",
      reviewing: false,
      differs: [
        { field: "needsHuman", label: "p(needs_human) a landing stays under", value: 0.25, preset: 0.2 },
        { field: "commentProof", label: "comment-only proof", value: false, preset: true },
        { field: "hit", label: "detector answer that counts as a hit", value: 0.4, preset: 0.3 },
        { field: "alertsPerHour", label: "escalations to people per hour", value: 10, preset: 120 },
      ],
    };
    expect(presetWords(decidesOf(custom)!)).toBe(
      "custom, nearest production: p(needs_human) a landing stays under 0.25 (preset 0.2), comment-only proof off (preset on), detector answer that counts as a hit 0.4 (preset 0.3) and 1 more",
    );
    const lines = decidesLines(custom, colors(true));
    expect(lines[0]).toContain("\u001b[33mcustom, nearest production:");
    expect(lines.at(-1)).toContain("Review is off now: changes go to their lanes without the gate");
  });

  it("prints nothing for a server that predates the report", () => {
    expect(decidesLines(undefined, c)).toEqual([]);
    expect(decidesLines({ error: "no route" }, c)).toEqual([]);
  });
});

describe("ft why: the rule that confirmed each landing", () => {
  it("prints the rule with the values it used, and the preset then", () => {
    expect(confirmedLine(note([R3_CHECK]), c)).toBe("R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 20 ≥ 20 · preset production");
    const text = formatWhy({ path: "src/a.ts" }, [{ landing, note: note([R3_CHECK]) }], {}, c, NOW);
    expect(text).toContain("\n  gate     R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 20 ≥ 20 · preset production\n");
    // Under the answerable line, before the proposal.
    expect(text.indexOf("  answer   ")).toBeLessThan(text.indexOf("  gate     "));
    expect(text.indexOf("  gate     ")).toBeLessThan(text.indexOf("  proposal "));
  });

  it("says when no review is recorded, in yellow", () => {
    expect(confirmedLine(note([]), colors(true))).toBe("\u001b[33mNo review recorded: no gate decision is kept with this change.\u001b[39m");
  });
});

/** An Io whose fetch answers from `routes` by path (404 for anything else). */
function io(routes: Record<string, unknown>): Io & { out: string[]; calls: string[] } {
  const out: string[] = [];
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const body = routes[path];
    return body === undefined ? new Response(JSON.stringify({ error: `no route for GET ${path}` }), { status: 404 }) : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    env: { FT_URL: "https://ft.test", FT_USER: "tester", NO_COLOR: "1", HOME: "/nonexistent" },
    stdout: (l) => void out.push(l),
    stderr: (l) => void out.push(l),
    isTTY: false,
    fetch,
    readFile: async () => {
      throw new Error("no config file");
    },
    sleep: async () => undefined,
    now: () => NOW,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => undefined,
    out,
    calls,
  };
}

const snapshot = { colony: { id: "web", name: "web", trunk: { namespace: "n", name: "web--trunk", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 } };

describe("running ft status and ft why", () => {
  it("ft status reads the report and prints its lines; an older server prints none", async () => {
    const t = io({ "/api/colonies/web": snapshot, "/api/colonies/web/decides": REPORT });
    expect(await main(["status", "web"], t)).toBe(0);
    expect(t.calls).toContain("/api/colonies/web/decides");
    expect(t.out.join("\n")).toContain("decides    production · Last 30 days: 40 changes landed, 24 by deterministic proof (60%)");
    const old = io({ "/api/colonies/web": snapshot });
    expect(await main(["status", "web"], old)).toBe(0);
    expect(old.out.join("\n")).not.toContain("decides ");
  });

  it("ft why prints the confirming rule under each landing", async () => {
    const t = io({ "/api/colonies/web": snapshot, "/api/colonies/web/why": [{ landing, note: note([R3_CHECK]) }] });
    expect(await main(["why", "web", "src/a.ts"], t)).toBe(0);
    expect(t.out.join("\n")).toContain("  gate     R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 20 ≥ 20 · preset production");
  });
});
