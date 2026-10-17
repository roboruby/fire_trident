import { describe, expect, it } from "vitest";
import { colors } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";
import { trunkHealthLines } from "../src/trunkhealth.ts";

/** Trunk health in `ft status` (trunkhealth.ts): the server's line and sentences under a `health` label, or why there are none. */

const c = colors(false);
const NOW = 1_792_000_000_000;

const MEASURED = {
  status: "measured",
  text: "red 2 times in 400 landings, 3.4 min to green at p50, 0 landings built on red",
  detail: ["Red for 6.8 min of the 2.0 d measured (0.2%).", "Repairs: 2 intents held by agents for 9.1 min.", 5],
  red: { ms: 408_000, share: 0.0024 },
};

describe("trunk health rows", () => {
  it("prints the line, then each sentence under it", () => {
    expect(trunkHealthLines({ trunkHealth: MEASURED }, c)).toEqual([
      "health     red 2 times in 400 landings, 3.4 min to green at p50, 0 landings built on red",
      "           Red for 6.8 min of the 2.0 d measured (0.2%).",
      "           Repairs: 2 intents held by agents for 9.1 min.",
    ]);
  });

  it("marks trunk red now in yellow, and a report with no numbers in dim, with its line only", () => {
    const red = trunkHealthLines({ trunkHealth: { ...MEASURED, detail: [], red: { since: 1 } } }, colors(true));
    expect(red[0]).toContain("\u001b[33mred 2 times in 400 landings");
    expect(trunkHealthLines({ trunkHealth: { status: "no-tests", text: "trunk health not measured: certification found no test this platform can run", reason: "no test files" } }, c)).toEqual([
      "health     trunk health not measured: certification found no test this platform can run",
    ]);
  });

  it("prints nothing for an answer without a report, and keeps control characters out", () => {
    for (const raw of [undefined, null, {}, { trunkHealth: { status: "measured" } }, { trunkHealth: { status: "odd", text: "x" } }]) expect(trunkHealthLines(raw, c)).toEqual([]);
    expect(trunkHealthLines({ trunkHealth: { status: "off", text: "off\u001b[2J\nnow" } }, c)).toEqual(["health     off [2J now"]);
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

describe("ft status: trunk health", () => {
  it("reads GET /metrics and prints the rows after the summary; an older server prints none", async () => {
    const t = io({ "/api/colonies/web": snapshot, "/api/colonies/web/metrics": { trunkHealth: MEASURED } });
    expect(await main(["status", "web"], t)).toBe(0);
    expect(t.calls).toContain("/api/colonies/web/metrics");
    expect(t.out.join("\n")).toContain("health     red 2 times in 400 landings, 3.4 min to green at p50, 0 landings built on red\n           Red for 6.8 min");
    const old = io({ "/api/colonies/web": snapshot, "/api/colonies/web/metrics": { metrics: {} } });
    expect(await main(["status", "web"], old)).toBe(0);
    expect(old.out.join("\n")).not.toContain("health ");
  });
});
