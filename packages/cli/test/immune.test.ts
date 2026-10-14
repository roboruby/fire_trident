import { describe, expect, it } from "vitest";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors } from "../src/format.ts";
import { autonomyLine, autonomyOf, formatImmune, latestFirst, regionSentence, revokedBy, type AutonomyRegionLike } from "../src/immune.ts";
import { main, type Io } from "../src/run.ts";

/** Earned autonomy in the CLI: one line in ft status, and ft immune for each region's standing. */

const c = colors(false);
const NOW = 10_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const REJECTED = "prp_mv5xi9ltfmkw0b";
const ESCALATED = "prp_mv87vsgw1mfsjl";

/** An immune report as the colony sends it (GET /api/colonies/:id/immune). */
const REPORT = {
  enabled: true,
  policy: { enabled: true, autonomyAfter: 3 },
  antibodies: [
    { id: "ab_1", question: "Does this change log a token?", state: "active", recurrences: 2 },
    { id: "ab_2", question: "Does it skip the rate limit?", state: "advisory", recurrences: 0 },
  ],
  detectors: [
    { id: "clef:needs_human", fires: 12, useful: 3, notUseful: 4, state: "advisory" },
    { id: "clef:off_intent", fires: 2, useful: 0, notUseful: 0, state: "active" },
  ],
  autonomy: [
    { region: "src", approved: 7, earned: true, revokedAt: null, reason: null, lastAt: NOW - 2 * HOUR },
    { region: "src/auth", approved: 0, earned: false, revokedAt: NOW - 12 * MIN, reason: `rejected ${REJECTED} by maya`, lastAt: NOW - 12 * MIN },
    { region: "src/routes", approved: 3, earned: true, revokedAt: NOW - 3 * HOUR, reason: `escalated ${ESCALATED}`, lastAt: NOW - 30 * MIN },
    { region: "src/store", approved: 2, earned: false, revokedAt: null, reason: null, lastAt: NOW - HOUR },
  ],
  alerts: { lastHour: 2, budget: 30 },
  decisions: [],
};

const region = (r: Partial<AutonomyRegionLike> & { region: string }): AutonomyRegionLike => ({ approved: 0, earned: false, revokedAt: null, reason: null, lastAt: null, ...r });

function ok(argv: string[]) {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.command;
}

function err(argv: string[]): string {
  const r = parseCommand(argv);
  if (r.ok) throw new Error(`expected a usage error for ${argv.join(" ")}`);
  return r.error;
}

describe("ft immune: parsing and requests", () => {
  it("takes one colony and reads its immune report", () => {
    expect(ok(["immune", "web"])).toEqual({ name: "immune", colony: "web" });
    expect(err(["immune"])).toMatch(/missing <colony>/);
    expect(err(["immune", "web", "src"])).toMatch(/unexpected argument "src"/);
    expect(planRequest(ok(["immune", "web"]), "matt")).toEqual({ method: "GET", path: "/api/colonies/web/immune" });
    expect(helpText("immune")).toMatch(/^ft immune <colony>/);
    expect(helpText()).toContain("immune <colony>");
  });
});

describe("each region's sentence", () => {
  it("says what was earned, what revoked it, and what earns it back", () => {
    expect(regionSentence(region({ region: "src", approved: 7, earned: true }), 3, NOW)).toBe("Earned with 7 approved landings.");
    expect(regionSentence(region({ region: "src", approved: 2 }), 3, NOW)).toBe("1 more approved landing earns it.");
    expect(regionSentence(region({ region: "src" }), 3, NOW)).toBe("3 more approved landings earn it.");
    expect(regionSentence(region({ region: "src/auth", revokedAt: NOW - 12 * MIN, reason: `rejected ${REJECTED} by maya` }), 3, NOW)).toBe(
      `Revoked 12m ago when a person rejected ${REJECTED}. 3 more approved landings earn it back.`,
    );
    expect(regionSentence(region({ region: "src/auth", approved: 2, revokedAt: NOW - 2 * HOUR, reason: `escalated ${ESCALATED}` }), 3, NOW)).toBe(
      `Revoked 2h ago when ${ESCALATED} was sent to a person. 1 more approved landing earns it back.`,
    );
    expect(regionSentence(region({ region: "src/auth", approved: 4, earned: true, revokedAt: NOW - 2 * HOUR, reason: `escalated ${ESCALATED}` }), 3, NOW)).toBe(
      `Earned back with 4 approved landings since ${ESCALATED} was sent to a person 2h ago.`,
    );
    expect(regionSentence(region({ region: "src", revokedAt: NOW - 2 * HOUR, reason: "reset by hand" }), 3, NOW)).toBe("Revoked 2h ago (reset by hand). 3 more approved landings earn it back.");
  });

  it("reads the colony's reasons", () => {
    expect(revokedBy(`rejected ${REJECTED} by maya`)).toBe(`a person rejected ${REJECTED}`);
    expect(revokedBy(`escalated ${ESCALATED}`)).toBe(`${ESCALATED} was sent to a person`);
    expect(revokedBy("reset by hand")).toBeNull();
    expect(revokedBy(null)).toBeNull();
  });

  it("lists the latest to move first, and the newest revocations first from a server that predates lastAt", () => {
    expect(latestFirst(autonomyOf(REPORT)?.regions ?? []).map((r) => r.region)).toEqual(["src/auth", "src/routes", "src/store", "src"]);
    const old = [region({ region: "a", approved: 5, earned: true }), region({ region: "b", revokedAt: 10 }), region({ region: "c", approved: 1 }), region({ region: "d", revokedAt: 20 })];
    expect(latestFirst(old).map((r) => r.region)).toEqual(["d", "b", "a", "c"]);
  });
});

describe("ft immune and ft status: output", () => {
  it("prints each region's standing, then the antibodies, detectors, alert budget and the rule", () => {
    expect(formatImmune("web", REPORT, c, NOW).split("\n")).toEqual([
      "web: autonomy 2 of 4 regions earned, 1 revoked",
      "",
      "REGION      AUTONOMY  APPROVED  MOVED    WHAT HAPPENED",
      `src/auth    revoked     0 of 3  12m ago  Revoked 12m ago when a person rejected ${REJECTED}. 3 more approved landings earn it back.`,
      `src/routes  earned           3  30m ago  Earned back with 3 approved landings since ${ESCALATED} was sent to a person 3h ago.`,
      "src/store   not yet     2 of 3  1h ago   1 more approved landing earns it.",
      "src         earned           7  2h ago   Earned with 7 approved landings.",
      "",
      "antibodies 1 active, 1 advisory; they caught 2 later rejections again",
      "detectors  clef:needs_human advisory (fired 12, 3 useful, 4 not useful) · clef:off_intent active (fired 2)",
      "alerts     2 of 30 escalations to a person in the last hour",
      "",
      "A region earns autonomy once 3 of its changes land approved by a proof, a second model or a person.",
      "Then the reflex alone may land a change there when a person or a rule wrote its intent.",
      "An escalation to a person or a rejection there takes it back until 3 more land approved.",
    ]);
  });

  it("says what earns autonomy when nothing has been reviewed, and when review is off", () => {
    const empty = formatImmune("web", { ...REPORT, antibodies: [], detectors: [], autonomy: [] }, c, NOW).split("\n");
    expect(empty.slice(0, 5)).toEqual([
      "web: no region has earned autonomy yet",
      "Nothing has been reviewed in this colony yet, so no region has approved landings to count.",
      "",
      "antibodies none yet: a person's rejection that no antibody caught mints one",
      "detectors  none has fired yet",
    ]);
    expect(empty.at(-3)).toBe("A region earns autonomy once 3 of its changes land approved by a proof, a second model or a person.");
    expect(formatImmune("web", { ...REPORT, enabled: false }, c, NOW).split("\n")[1]).toBe("Review is off in this colony: changes go to their lanes without review, so earned autonomy is not used.");
    expect(formatImmune("web", { antibodies: [] }, c, NOW)).toBe("web: the server sent no earned autonomy (it predates the immune report)");
    // The files at the top of the repository, named as the web map names them.
    expect(formatImmune("web", { ...REPORT, autonomy: [{ region: ".", approved: 1, earned: false }] }, c, NOW).split("\n")[3]).toBe("(root)  not yet     1 of 3  -      2 more approved landings earn it.");
  });

  it("sums autonomy up in one ft status line", () => {
    expect(autonomyLine(REPORT, "web", c)).toBe("autonomy   2 of 4 regions earned, 1 revoked · ft immune web");
    expect(autonomyLine({ ...REPORT, autonomy: [REPORT.autonomy[0]] }, "web", c)).toBe("autonomy   1 of 1 region earned · ft immune web");
    expect(autonomyLine({ ...REPORT, autonomy: [] }, "web", c)).toBe("autonomy   no region yet: nothing has been reviewed");
    expect(autonomyLine({ ...REPORT, enabled: false }, "web", c)).toBe("autonomy   not used: review is off");
    expect(autonomyLine(undefined, "web", c)).toBeNull();
    expect(autonomyLine({ error: "no route" }, "web", c)).toBeNull();
  });

  it("reads defensively and keeps server text on one line", () => {
    const a = autonomyOf({ policy: {}, autonomy: [{ region: "src/a\u001b[31m", approved: "7" }, { region: "" }, null, { region: "lib", approved: 4 }] });
    expect(a).toEqual({
      enabled: true,
      after: 3,
      regions: [
        { region: "src/a [31m", approved: 0, earned: false, revokedAt: null, reason: null, lastAt: null },
        { region: "lib", approved: 4, earned: true, revokedAt: null, reason: null, lastAt: null },
      ],
    });
  });
});

/** An Io whose fetch answers from `routes` by path and records each call (no network). */
function io(routes: Record<string, unknown>, env: Record<string, string> = {}): Io & { out: string[]; calls: Array<{ path: string; auth: string | null }> } {
  const out: string[] = [];
  const calls: Array<{ path: string; auth: string | null }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, auth: new Headers(init?.headers).get("authorization") });
    const body = routes[path];
    return body === undefined ? new Response(JSON.stringify({ error: `no route for GET ${path}` }), { status: 404 }) : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    env: { FT_URL: "https://ft.test", FT_USER: "tester", NO_COLOR: "1", HOME: "/nonexistent", ...env },
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

describe("ft immune and ft status: running", () => {
  it("reads the immune report without a token", async () => {
    const t = io({ "/api/colonies/web/immune": REPORT });
    expect(await main(["immune", "web"], t)).toBe(0);
    expect(t.calls).toEqual([{ path: "/api/colonies/web/immune", auth: null }]);
    expect(t.out.join("\n").split("\n")[0]).toBe("web: autonomy 2 of 4 regions earned, 1 revoked");
    const json = io({ "/api/colonies/web/immune": REPORT });
    expect(await main(["immune", "web", "--json"], json)).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toEqual(REPORT);
  });

  it("adds the autonomy line to ft status, and none for a server without the report", async () => {
    const t = io({ "/api/colonies/web": snapshot, "/api/colonies/web/immune": REPORT });
    expect(await main(["status", "web"], t)).toBe(0);
    expect(t.out).toContain("autonomy   2 of 4 regions earned, 1 revoked · ft immune web");
    expect(t.calls.map((k) => k.path)).toEqual(["/api/colonies/web", "/api/colonies/web/decide/policy", "/api/colonies/web/immune", "/api/about"]);
    const old = io({ "/api/colonies/web": snapshot });
    expect(await main(["status", "web"], old)).toBe(0);
    expect(old.out.join("\n")).not.toContain("autonomy");
  });
});
