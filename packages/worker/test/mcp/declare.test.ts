import { describe, expect, it } from "vitest";
import type { AgentInfo, Colony, Id, Intent, WorkspaceLease } from "@fire_trident/core";
import type { TakeResult } from "../../src/agents/rpc.ts";
import { DECLARE_REPLAY_MS, FireTridentTools, declareFingerprint } from "../../src/mcp/tools.ts";
import type { McpColonyRpc, Session, ToolContext } from "../../src/mcp/tools.ts";

/**
 * declare is idempotent for ten minutes within a session: a repeat with the same content returns the intent the
 * first one declared (replayed) instead of painting a second need for one change.
 */

const sha = (c: string): string => c.repeat(40).slice(0, 40);
const colonyInfo: Colony = { id: "col", name: "Colony", trunk: { namespace: "ft-trunk", name: "col--trunk", remote: "https://trunk.invalid/col--trunk.git" }, trunkSha: sha("b"), createdAt: 0, regionDepth: 1 };
const lease: WorkspaceLease = {
  repo: { namespace: "ft-ws-1", name: "col--ws-1", remote: "https://ws.invalid/col--ws-1.git" },
  token: "fixture-workspace",
  tokenExpiresAt: Date.UTC(2030, 0, 1),
  baseSha: sha("b"),
  leasedAt: 0,
  trunk: { remote: colonyInfo.trunk.remote, token: "fixture-trunk", sha: sha("b") },
};
const held = (id: string): Intent => ({ id, colonyId: "col", title: `held ${id}`, why: "w", source: "human", footprint: ["src/a.ts"], priority: 1, status: "claimed", createdAt: 0, createdBy: "t" });

type IntentInput = Omit<Intent, "id" | "status" | "createdAt">;

function setup() {
  const agents: AgentInfo[] = [];
  const state = {
    declared: [] as IntentInput[],
    /** Intents as the colony has them now (getIntent). */
    current: new Map<Id, Intent>(),
    /** The intent take hands out. */
    holding: held("int_held"),
    /** When set, the next addIntent fails with it. */
    failNext: null as Error | null,
    /** When set, addIntent waits for it (parallel declares overlap). */
    gate: null as Promise<void> | null,
  };
  const colony = {
    async getColony(): Promise<Colony | null> {
      return colonyInfo;
    },
    async getAgent(id: Id): Promise<AgentInfo | null> {
      return agents.find((a) => a.id === id) ?? null;
    },
    async registerAgent(a: { kind: AgentInfo["kind"]; name: string }): Promise<AgentInfo> {
      const info: AgentInfo = { id: `agt_${agents.length + 1}`, colonyId: "col", kind: a.kind, name: a.name, thresholds: {}, state: "idle", lastSeen: 0 };
      agents.push(info);
      return info;
    },
    async heartbeat(): Promise<void> {},
    async take(): Promise<TakeResult> {
      return { intent: state.holding, lease };
    },
    async addIntent(i: IntentInput): Promise<Intent> {
      if (state.gate) await state.gate;
      if (state.failNext) {
        const e = state.failNext;
        state.failNext = null;
        throw e;
      }
      state.declared.push(i);
      const intent: Intent = { ...i, id: `int_new${state.declared.length}`, status: "open", createdAt: 0 };
      state.current.set(intent.id, intent);
      return intent;
    },
    async getIntent(id: Id): Promise<Intent | null> {
      return state.current.get(id) ?? null;
    },
  };
  let session: Session = { reads: {}, proposals: [] };
  const clock = { now: 5_000_000 };
  const ctx: ToolContext = {
    colony: () => colony as unknown as McpColonyRpc,
    region: () => {
      throw new Error("not used");
    },
    trunk: () => ({ why: async () => [] }),
    repo: async () => {
      throw new Error("not used");
    },
    load: async () => structuredClone(session),
    save: async (s) => {
      session = structuredClone(s);
    },
    now: () => clock.now,
    sleep: async () => undefined,
  };
  return { tools: new FireTridentTools(ctx), state, clock, session: () => session, setSession: (s: Session) => (session = s) };
}

const ask = { title: "Add a rate limit", why: "Login can be brute-forced", footprint: ["src/login.ts", "src/limit.ts"], acceptance: ["429 after 5 tries"], priority: 3 };

describe("MCP declare: a repeat in the session returns the intent it declared", () => {
  it("declares once; the same content again (footprint in any order, padded text) is replayed, with the intent's status now", async () => {
    const { tools, state } = setup();
    await tools.join({ colony: "col" });
    const first = (await tools.declare(ask)) as Record<string, any>;
    expect(first).toEqual({ intent: { id: "int_new1", title: "Add a rate limit", status: "open", footprint: ["src/login.ts", "src/limit.ts"], parentId: null } });
    state.current.set("int_new1", { ...state.current.get("int_new1")!, status: "claimed" });
    const again = (await tools.declare({ ...ask, title: "  Add a rate limit ", footprint: ["src/limit.ts", " src/login.ts"] })) as Record<string, any>;
    expect(again).toMatchObject({ intent: { id: "int_new1", status: "claimed" }, replayed: true, declaredAt: new Date(5_000_000).toISOString() });
    expect(again.note).toMatch(/this is that intent, not a new one/);
    expect(state.declared).toHaveLength(1);
  });

  it("any other content declares another intent: title, why, footprint, acceptance, priority or parent", async () => {
    const { tools, state } = setup();
    await tools.join({ colony: "col" });
    await tools.declare(ask);
    const variants = [
      { ...ask, title: "Add a rate limit to login" },
      { ...ask, why: "Signup can be brute-forced" },
      { ...ask, footprint: ["src/login.ts"] },
      { ...ask, acceptance: ["429 after 3 tries"] },
      { ...ask, priority: 4 },
      { ...ask, parentId: "int_other" },
    ];
    for (const v of variants) expect(await tools.declare(v)).not.toHaveProperty("replayed");
    expect(state.declared).toHaveLength(1 + variants.length);
    // The default parent is the held intent: the same words while holding work are another intent.
    await tools.take();
    const child = (await tools.declare(ask)) as Record<string, any>;
    expect(child).not.toHaveProperty("replayed");
    expect(child.intent.parentId).toBe("int_held");
    expect(((await tools.declare(ask)) as Record<string, any>).replayed).toBe(true);
  });

  it("replays for ten minutes only", async () => {
    const { tools, state, clock } = setup();
    await tools.join({ colony: "col" });
    await tools.declare(ask);
    clock.now += DECLARE_REPLAY_MS - 1;
    expect(((await tools.declare(ask)) as Record<string, any>).replayed).toBe(true);
    clock.now += 1;
    const later = (await tools.declare(ask)) as Record<string, any>;
    expect(later).not.toHaveProperty("replayed");
    expect(later.intent.id).toBe("int_new2");
    expect(state.declared).toHaveLength(2);
  });

  it("repeats in flight together declare once", async () => {
    const { tools, state } = setup();
    await tools.join({ colony: "col" });
    let open!: () => void;
    state.gate = new Promise<void>((r) => (open = r));
    const calls = [tools.declare(ask), tools.declare(ask), tools.declare({ ...ask, footprint: [...ask.footprint].reverse() })];
    await new Promise((r) => setTimeout(r, 10));
    open();
    const answers = (await Promise.all(calls)) as Array<Record<string, any>>;
    expect(state.declared).toHaveLength(1);
    expect(answers.map((a) => a.intent.id)).toEqual(["int_new1", "int_new1", "int_new1"]);
    expect(answers.filter((a) => a.replayed === true)).toHaveLength(2);
  });

  it("a replay the colony cannot describe now answers with the intent as declared", async () => {
    const { tools, state } = setup();
    await tools.join({ colony: "col" });
    await tools.take();
    await tools.declare(ask);
    state.current.clear();
    expect(await tools.declare(ask)).toMatchObject({ intent: { id: "int_new1", title: ask.title, status: "open", footprint: ask.footprint, parentId: "int_held" }, replayed: true });
  });

  it("a declare that failed is not remembered: its retry declares", async () => {
    const { tools, state } = setup();
    await tools.join({ colony: "col" });
    state.failNext = new Error("Durable Object is overloaded. Too many requests queued.");
    await expect(tools.declare(ask)).rejects.toThrow(/overloaded/);
    const retried = (await tools.declare(ask)) as Record<string, any>;
    expect(retried).not.toHaveProperty("replayed");
    expect(state.declared).toHaveLength(1);
  });

  it("tolerates sessions saved before (none, or malformed entries), keeps at most 50, and forgets them when the session joins as another agent", async () => {
    const { tools, state, session, setSession } = setup();
    await tools.join({ colony: "col" });
    setSession({ ...session(), declared: [null, { fingerprint: 7 }, { fingerprint: "x", at: "soon", intent: {} }] as unknown as Session["declared"] });
    expect(await tools.declare(ask)).not.toHaveProperty("replayed");
    // Long footprints do not grow the session: an entry keeps the fingerprint, the intent id, its status and the time.
    const wide = Array.from({ length: 200 }, (_, i) => `src/generated/${"deep/".repeat(20)}file-${i}.ts`);
    for (let i = 0; i < 60; i++) await tools.declare({ ...ask, title: `t${i}`, footprint: wide });
    expect(session().declared).toHaveLength(50);
    expect(session().declared!.at(-1)).toEqual({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), at: 5_000_000, intentId: "int_new61", status: "open" });
    expect(JSON.stringify(session().declared).length).toBeLessThan(50 * 160);
    expect(((await tools.declare({ ...ask, title: "t59", footprint: wide })) as Record<string, any>).replayed).toBe(true);
    // Joining elsewhere starts a fresh session (another colony, so another agent): nothing to replay.
    const before = state.declared.length;
    expect(await tools.join({ colony: "elsewhere" })).toMatchObject({ agentId: "agt_2", resumed: false });
    expect(session().declared).toBeUndefined();
    expect(await tools.declare({ ...ask, title: "t59" })).not.toHaveProperty("replayed");
    expect(state.declared).toHaveLength(before + 1);
  });

  it("fingerprints the canonical content: sorted footprint, defaults filled, order of acceptance kept", async () => {
    const base = { title: "t", why: "w", footprint: ["b", "a"], priority: 1 };
    expect(await declareFingerprint(base)).toBe(await declareFingerprint({ ...base, footprint: ["a", "b"] }));
    expect(await declareFingerprint(base)).toBe(await declareFingerprint({ ...base, acceptance: [] }));
    expect(await declareFingerprint({ ...base, acceptance: ["x", "y"] })).not.toBe(await declareFingerprint({ ...base, acceptance: ["y", "x"] }));
    expect(await declareFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
