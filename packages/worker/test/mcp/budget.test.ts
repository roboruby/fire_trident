import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentInfo, Colony } from "@fire_trident/core";
import type { ErrorEnvelope } from "../../src/agents/rpc.ts";
import { BUDGET_NEXT, CallBudget, DEFAULT_BUDGET, budgetRefusal, callBudget, parseBudget } from "../../src/mcp/budget.ts";
import { FireTridentMcp } from "../../src/mcp/FireTridentMcp.ts";

/**
 * The per-session call budget (FT_AGENT_CALL_BUDGET, mcp/budget.ts): the token bucket on a hand-moved clock, and
 * FireTridentMcp with it, called by an MCP client over an in-memory transport against a colony that logs every call
 * that reaches it.
 */

// The server's base class needs the Workers runtime; these tests need only the env and the storage it holds.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/** A clock the test moves by hand. */
function handClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** `n` calls one after another, `gapMs` apart: how many the budget refused. */
function paced(b: CallBudget, clock: { advance: (ms: number) => void }, n: number, gapMs: number): number {
  let refused = 0;
  for (let i = 0; i < n; i++) {
    if (b.take() > 0) refused++;
    clock.advance(gapMs);
  }
  return refused;
}

/** `n` calls at the same instant (a client sending them in parallel): how many the budget refused. */
function atOnce(b: CallBudget, n: number): number {
  let refused = 0;
  for (let i = 0; i < n; i++) if (b.take() > 0) refused++;
  return refused;
}

describe("FT_AGENT_CALL_BUDGET", () => {
  it("is off when absent, off, or anything it cannot read", () => {
    for (const raw of [undefined, "", "  ", "off", "OFF", "true", "4", "4,", ",20", "0,20", "4,0", "-1,20", "4,2.5", "4,20,1", "fast", "1e3,20", "Infinity,1", "4;20"]) {
      expect(parseBudget(raw), String(raw)).toBeNull();
    }
    expect(callBudget(undefined)).toBeNull();
    expect(callBudget("off")).toBeNull();
  });

  it("is 4 calls a second and 20 at once with on, or the rate and burst it names", () => {
    expect(parseBudget("on")).toEqual({ perSecond: 4, burst: 20 });
    expect(parseBudget(" On ")).toEqual(DEFAULT_BUDGET);
    expect(parseBudget("8,40")).toEqual({ perSecond: 8, burst: 40 });
    expect(parseBudget("0.5, 3")).toEqual({ perSecond: 0.5, burst: 3 });
    expect(parseBudget(".5,1")).toEqual({ perSecond: 0.5, burst: 1 });
    expect(callBudget("8,40")?.limits).toEqual({ perSecond: 8, burst: 40 });
  });
});

describe("the call budget's bucket", () => {
  it("starts full: the burst passes at once, and the next call waits one token's time", () => {
    const clock = handClock();
    const b = new CallBudget(DEFAULT_BUDGET, clock.now);
    expect(b.available()).toBe(20);
    for (let i = 0; i < 20; i++) expect(b.take()).toBe(0);
    expect(b.take()).toBe(250);
    clock.advance(249);
    expect(b.take()).toBe(1);
    clock.advance(1);
    expect(b.take()).toBe(0);
    expect(b.take()).toBe(250);
  });

  it("counts the part of a token already back, and takes nothing from a refused call", () => {
    const clock = handClock();
    const b = new CallBudget({ perSecond: 4, burst: 2 }, clock.now);
    expect(atOnce(b, 2)).toBe(0);
    clock.advance(100); // 0.4 of a token is back
    expect(b.take()).toBe(150);
    for (let i = 0; i < 100; i++) expect(b.take()).toBe(150);
    clock.advance(150);
    expect(b.take()).toBe(0);
  });

  it("refills at its rate and never above its burst", () => {
    const clock = handClock();
    const b = new CallBudget(DEFAULT_BUDGET, clock.now);
    expect(atOnce(b, 20)).toBe(0);
    clock.advance(1_000);
    expect(b.available()).toBeCloseTo(4, 9);
    clock.advance(60_000); // 244 tokens' worth of time
    expect(b.available()).toBe(20);
    expect(atOnce(b, 21)).toBe(1);
  });

  it("adds nothing when the clock steps back", () => {
    const clock = handClock();
    const b = new CallBudget({ perSecond: 1, burst: 1 }, clock.now);
    expect(b.take()).toBe(0);
    clock.advance(-5_000);
    expect(b.take()).toBe(1_000);
    clock.advance(5_000 + 999);
    expect(b.take()).toBe(1);
    clock.advance(1);
    expect(b.take()).toBe(0);
  });

  it("always has a token for a call made retryAfterMs after its refusal, at any rate", () => {
    for (const perSecond of [4, 3, 7, 0.3, 4.5, 1000 / 7, 0.001]) {
      const clock = handClock();
      const b = new CallBudget({ perSecond, burst: 3 }, clock.now);
      atOnce(b, 3);
      for (let i = 0; i < 200; i++) {
        const wait = b.take();
        expect(wait, `${perSecond}/s, call ${i}`).toBeGreaterThan(0);
        clock.advance(wait);
        expect(b.take(), `${perSecond}/s, call ${i}`).toBe(0);
      }
    }
  });

  it("never refuses a client inside the rate", () => {
    // Four calls a second, evenly, for ten minutes.
    let clock = handClock();
    let b = new CallBudget(DEFAULT_BUDGET, clock.now);
    expect(paced(b, clock, 2_400, 250)).toBe(0);
    // Twenty calls at once every five seconds, for ten minutes.
    clock = handClock();
    b = new CallBudget(DEFAULT_BUDGET, clock.now);
    for (let turn = 0; turn < 120; turn++) {
      expect(atOnce(b, 20), `turn ${turn}`).toBe(0);
      clock.advance(5_000);
    }
    // A scripted agent following the guides with no time to think: join, then per change take, twelve reads at once,
    // propose and inbox with wait, which holds the next call until the proposal is decided (here 5 s).
    clock = handClock();
    b = new CallBudget(DEFAULT_BUDGET, clock.now);
    expect(atOnce(b, 1)).toBe(0);
    for (let change = 0; change < 100; change++) {
      expect(atOnce(b, 1 + 12 + 1 + 1), `change ${change}`).toBe(0);
      clock.advance(5_000);
    }
  });

  it("holds a polling loop to the rate after its burst", () => {
    const clock = handClock();
    const b = new CallBudget(DEFAULT_BUDGET, clock.now);
    // Thirty calls a second for a minute: the first twenty, then four a second.
    const calls = 30 * 60;
    const passed = calls - paced(b, clock, calls, 1000 / 30);
    expect(passed).toBeGreaterThanOrEqual(20 + 4 * 60 - 1);
    expect(passed).toBeLessThanOrEqual(20 + 4 * 60 + 1);
  });
});

describe("a refused call's error", () => {
  it("is rate_limit, retryable after the time until a token, status 429, with the next step", () => {
    expect(budgetRefusal(DEFAULT_BUDGET, 250)).toEqual({
      kind: "rate_limit",
      message: "too many calls from this session: it may make 4 tool calls a second, or 20 at once after a pause, so this call was not run",
      retryable: true,
      retryAfterMs: 250,
      status: 429,
      next: "Wait retryAfterMs before calling again; take and inbox accept wait, so the server can wait for you.",
    });
    expect(budgetRefusal({ perSecond: 1, burst: 5 }, 1_000).message).toContain("it may make 1 tool call a second, or 5 at once");
    expect(budgetRefusal({ perSecond: 0.5, burst: 2 }, 2_000).message).toContain("it may make 0.5 tool calls a second");
    expect(budgetRefusal({ perSecond: 1000 / 7, burst: 2 }, 7).message).toContain("it may make 143 tool calls a second");
  });
});

const BASE = "b".repeat(40);
const COLONY: Colony = {
  id: "col",
  name: "Colony",
  trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" },
  trunkSha: BASE,
  createdAt: 0,
  regionDepth: 1,
};

/** A colony and a trunk that answer the calls these tests make, and log each call that reaches them. */
function fakeObjects(reached: string[]): { colony: Record<string, (...a: never[]) => Promise<unknown>>; trunk: Record<string, (...a: never[]) => Promise<unknown>> } {
  const agent = (id: string, name: string): AgentInfo => ({ id, colonyId: "col", kind: "external", name, thresholds: {}, state: "idle", lastSeen: 0 });
  const log = <T>(name: string, value: T): T => {
    reached.push(name);
    return value;
  };
  return {
    colony: {
      getColony: async () => log("getColony", COLONY),
      getAgent: async (id: string) => log("getAgent", agent(id, "budget-test")),
      registerAgent: async (a: { name: string }) => log("registerAgent", agent("agt_1", a.name)),
      heartbeat: async () => log("heartbeat", undefined),
      inbox: async () => log("inbox", []),
      listRegions: async () => log("listRegions", []),
      take: async () => log("take", { wait: true, retryInMs: 1_000, reason: "no open intent" }),
      abandon: async () => log("abandon", undefined),
      addIntent: async () => log("addIntent", null),
      getProposal: async () => log("getProposal", null),
    },
    trunk: { why: async () => log("why", []) },
  };
}

/** A FireTridentMcp session with `env`, an MCP client connected to it, and the calls that reached the colony or trunk. */
async function session(env: Record<string, string>): Promise<{ call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>; reached: string[]; close: () => Promise<void> }> {
  const reached: string[] = [];
  const { colony, trunk } = fakeObjects(reached);
  const namespace = (stub: unknown) => ({ idFromName: (name: string) => name, get: () => stub });
  const stored = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => stored.get(key),
    put: async (key: string, value: unknown) => {
      stored.set(key, structuredClone(value));
    },
  };
  const server = new FireTridentMcp({ storage } as never, { ...env, COLONY: namespace(colony), TRUNK: namespace(trunk) } as never);
  await server.init();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverSide);
  const client = new Client({ name: "budget-test", version: "0.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    reached,
    close: () => client.close(),
  };
}

/** The envelope of a failed call, or null when the call succeeded. */
function errorOf(r: CallToolResult): ErrorEnvelope | null {
  return r.isError === true ? ((r.structuredContent as { error?: ErrorEnvelope } | undefined)?.error ?? null) : null;
}

/** The text of a result, as clients that read only text see it. */
function textOf(r: CallToolResult): string {
  return (r.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** How many of these results the budget refused. */
function refusals(results: CallToolResult[]): number {
  return results.filter((r) => errorOf(r)?.kind === "rate_limit").length;
}

describe("the MCP server with a call budget", () => {
  it("answers a call over the budget with rate_limit, and the call never reaches the colony", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000); // a frozen clock: nothing refills
    const s = await session({ FT_AGENT_CALL_BUDGET: "1,3" });
    try {
      expect(errorOf(await s.call("join", { colony: "col" }))).toBeNull();
      expect(errorOf(await s.call("inbox"))).toBeNull();
      expect(errorOf(await s.call("sense"))).toBeNull();
      const reached = [...s.reached];
      expect(reached).toContain("inbox");

      const refused = await s.call("inbox");
      const error = errorOf(refused);
      expect(error).toEqual({
        kind: "rate_limit",
        message: "too many calls from this session: it may make 1 tool call a second, or 3 at once after a pause, so this call was not run",
        retryable: true,
        retryAfterMs: 1_000,
        status: 429,
        next: BUDGET_NEXT,
      });
      // The same envelope as text, for clients that read only text.
      expect(JSON.parse(textOf(refused))).toEqual({ error });

      // Every tool is behind the budget: none of these runs, so none waits or reaches the colony or the trunk.
      const calls: Array<[string, Record<string, unknown>]> = [
        ["inbox", { wait: 30 }],
        ["take", { wait: 30 }],
        ["sense", {}],
        ["checkout", {}],
        ["read", { path: "src/a.ts" }],
        ["propose", { headSha: BASE }],
        ["why", { path: "src/a.ts" }],
        ["declare", { title: "t", why: "w", footprint: ["src/a.ts"] }],
        ["release", {}],
        ["escalate", { kind: "other", report: "r" }],
        ["join", { colony: "col" }],
      ];
      for (const [name, args] of calls) expect(errorOf(await s.call(name, args))?.kind, name).toBe("rate_limit");
      expect(s.reached).toEqual(reached);
    } finally {
      await s.close();
    }
  });

  it("refuses nothing when the budget is off, absent or unreadable", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const envs: Array<Record<string, string>> = [{}, { FT_AGENT_CALL_BUDGET: "off" }, { FT_AGENT_CALL_BUDGET: "fast" }];
    for (const env of envs) {
      const s = await session(env);
      try {
        await s.call("join", { colony: "col" });
        const results = await Promise.all(Array.from({ length: 60 }, () => s.call("inbox")));
        expect(refusals(results), JSON.stringify(env)).toBe(0);
        expect(s.reached.filter((c) => c === "inbox")).toHaveLength(60);
      } finally {
        await s.close();
      }
    }
  });

  it("with on, never refuses a client inside the rate, and holds a loop to it", async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const s = await session({ FT_AGENT_CALL_BUDGET: "on" });
    try {
      const results: CallToolResult[] = [await s.call("join", { colony: "col" })];
      // Model turns: up to twenty calls at once (sent in parallel), five seconds apart.
      const turn = async (n: number): Promise<void> => {
        const tools: Array<[string, Record<string, unknown>]> = [
          ["inbox", {}],
          ["sense", {}],
          ["why", { path: "src/a.ts" }],
          ["take", {}],
        ];
        results.push(...(await Promise.all(Array.from({ length: n }, (_, i) => s.call(...tools[i % tools.length]!)))));
      };
      await turn(19); // the join took one token
      for (let i = 0; i < 10; i++) {
        now += 5_000;
        await turn(20);
      }
      // Then a steady four calls a second for half a minute.
      for (let i = 0; i < 120; i++) {
        now += 250;
        results.push(await s.call("inbox"));
      }
      expect(results).toHaveLength(1 + 19 + 200 + 120);
      expect(refusals(results)).toBe(0);
      expect(results.filter((r) => r.isError === true)).toEqual([]);

      // A loop that does not wait: after a pause, the burst passes and the rest are refused unrun.
      now += 5_000;
      const before = s.reached.filter((c) => c === "inbox").length;
      const loop = await Promise.all(Array.from({ length: 100 }, () => s.call("inbox")));
      expect(refusals(loop)).toBe(80);
      expect(s.reached.filter((c) => c === "inbox").length - before).toBe(20);
    } finally {
      await s.close();
    }
  });
});
