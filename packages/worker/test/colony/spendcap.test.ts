import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import type { ModelClient, ModelReply } from "../../src/agents/loop.ts";
import type { AiRunner } from "../../src/decide/reflex.ts";
import { ColonyPause, isPauseRefusal, pausedSentence, type SqlRunner } from "../../src/colony/pause.ts";
import {
  HOLD_TTL_MS,
  BUSY_REFUSAL,
  REVIEW_REFUSAL,
  SHARE_REFUSAL,
  SPEND_CAP_ACTOR,
  SpendCapBook,
  agentCapGate,
  agentReserve,
  agentSettle,
  callText,
  capPrice,
  cappedAi,
  cappedClient,
  estimateUsd,
  isSpendCapRefusal,
  localGate,
  settledUsd,
  type CapGate,
  type SpendCapHost,
} from "../../src/colony/spendcap.ts";

/**
 * The spend cap's book (colony/spendcap.ts) over a colony's storage, with the real pause switch: reservations keep
 * calls in flight together under the cap, the pause trips at the agents' share with the spend in its reason, review
 * spends its reserve and then makes no call, raising or removing the cap lifts the pause it tripped, and a colony with
 * no cap calls its models exactly as before.
 */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlite(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...(b as never[]));
      return { toArray: () => rows };
    },
  };
}

const GPT = "@cf/openai/gpt-oss-120b";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";

/** A colony's cap and pause switch over one storage; `book` is the colony's spend as it last counted it. */
function harness(sql: SqlRunner = sqlite()) {
  const clock = { now: 1_000_000 };
  const events: ColonyEvent[] = [];
  const pending: Array<Promise<unknown>> = [];
  const state = { book: 0, refreshes: 0 };
  const pause = new ColonyPause({ sql, now: () => clock.now, readDeployment: async () => null, publish: (e) => void events.push(...e), tellWriter: async () => true });
  const host: SpendCapHost = {
    sql,
    now: () => clock.now,
    bookUsd: () => state.book,
    refreshBook: () => void state.refreshes++,
    ownPause: () => pause.own(),
    trip: (reason) => pause.pause({ by: SPEND_CAP_ACTOR, reason }),
    lift: (by, reason) => pause.resume({ by, reason }),
    waitUntil: (p) => void pending.push(p),
  };
  const cap = new SpendCapBook(host);
  return { cap, pause, sql, clock, events, pending, state, host, settled: () => Promise.all(pending) };
}

/** A Workers AI binding whose runs answer when the test lets them, each reporting `tokens` (input, output). */
class SlowAi implements AiRunner {
  runs: Array<{ model: string; options: unknown; release: () => void }> = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly tokens: { input: number; output: number }) {}
  run(model: string, _input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise((resolve) => {
      this.runs.push({
        model,
        options,
        release: () => {
          this.inFlight--;
          resolve({ response: "{}", usage: { prompt_tokens: this.tokens.input, completion_tokens: this.tokens.output } });
        },
      });
    });
  }
}

/** A request of about `chars` characters asking for `maxTokens` out. */
function request(chars: number, maxTokens: number): Record<string, unknown> {
  return { messages: [{ role: "user", content: "x".repeat(Math.max(0, chars - 60)) }], max_tokens: maxTokens };
}

describe("what a call is reserved and settled at", () => {
  it("prices the prompt at three characters a token and the output at its limit, at the model's list price", () => {
    // 3,000 characters: 1,000 input tokens at $0.35 a million, 2,000 output tokens at $0.75 a million.
    expect(estimateUsd(GPT, 3_000, 2_000)).toBeCloseTo((1_000 * 0.35 + 2_000 * 0.75) / 1e6, 12);
    expect(settledUsd(GPT, { input: 1_000_000, output: 0 })).toBeCloseTo(0.35, 12);
    expect(settledUsd(GPT, null)).toBe(0);
  });

  it("holds a model with no list price to the dearest listed one, so nothing is free against the cap", () => {
    expect(capPrice("@cf/x/unlisted")).toEqual(capPrice(KIMI));
    expect(settledUsd("@cf/x/unlisted", { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(4.95, 10);
  });

  it("tells its refusals from outages, across RPC too", () => {
    expect(isSpendCapRefusal(new Error(`[ft:409] ${REVIEW_REFUSAL}`))).toBe(true);
    expect(isSpendCapRefusal(REVIEW_REFUSAL)).toBe(true);
    expect(isSpendCapRefusal(SHARE_REFUSAL)).toBe(true);
    expect(isSpendCapRefusal(new Error(`[ft:409] ${pausedSentence({ by: SPEND_CAP_ACTOR, reason: "spend cap: $1.00 of $1.00 spent on model calls this platform made" })}`))).toBe(true);
    expect(isSpendCapRefusal(new Error(`[ft:409] ${pausedSentence({ by: "maya", reason: "demo reset" })}`))).toBe(false);
    expect(isSpendCapRefusal("model did not answer within 45 s")).toBe(false);
    // A call that only waits for the calls in flight reads as an outage, not as the cap: review does not send it to a person.
    expect(isSpendCapRefusal(new Error(`[ft:429] ${BUSY_REFUSAL}`))).toBe(false);
    // No figures in the refusals: a call site reads digits such as 429 as throttling.
    expect(REVIEW_REFUSAL + SHARE_REFUSAL + BUSY_REFUSAL).not.toMatch(/\d/);
  });
});

describe("a colony with no cap", () => {
  it("holds nothing, settles nothing, reports no cap, and runs each call exactly as it was asked", async () => {
    const h = harness();
    expect(h.cap.state()).toBeNull();
    expect(h.cap.reserve({ use: "agents", usd: 1e6 })).toEqual({ ok: true, hold: null });
    const seen: unknown[][] = [];
    const ai: AiRunner = { run: async (...args: unknown[]) => (seen.push(args), { response: "ok" }) } as AiRunner;
    const capped = cappedAi(ai, h.cap, "review");
    expect(await capped.run(GPT, { messages: [] })).toEqual({ response: "ok" });
    await capped.run(GPT, { messages: [] }, { signal: undefined });
    // Without options the binding is called with two arguments, as before (a signal would change Workers AI's request).
    expect(seen.map((a) => a.length)).toEqual([2, 3]);
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM spend_cap_holds").toArray()).toEqual([{ n: 0 }]);
    expect(h.pause.own()).toBeNull();
    expect(h.state.refreshes).toBe(0);
  });
});

describe("reservations", () => {
  it("keep calls in flight together under the cap: the one that would pass it is refused before it starts", async () => {
    const h = harness();
    await h.cap.set({ usd: 1, reviewReserveUsd: 0, by: "maya" });
    // Each call reserves 0.3 (1,000,000 output tokens at $0.30 a million on gpt-oss-20b) and reports $0.10 when it ends.
    const model = "@cf/openai/gpt-oss-20b";
    const ai = new SlowAi({ input: 0, output: 333_334 });
    const capped = cappedAi(ai, h.cap, "agents");
    const calls = Array.from({ length: 5 }, () => capped.run(model, request(0, 1_000_000)).then(() => "ran", (e: Error) => e.message));
    await Promise.resolve();
    // Three fit (0.9 of 1.0); the fourth and fifth are refused before they reach the model. They would fit once the
    // calls in flight settle, so they wait (429, as for a throttled model) and nothing trips.
    expect(ai.runs).toHaveLength(3);
    expect(h.cap.state()!.inFlightUsd).toBeCloseTo(0.9, 4);
    expect(h.cap.state()!.spentUsd).toBe(0);
    ai.runs.forEach((r) => r.release());
    expect(await Promise.all(calls)).toEqual(["ran", "ran", "ran", `[ft:429] ${BUSY_REFUSAL}`, `[ft:429] ${BUSY_REFUSAL}`]);
    expect(ai.maxInFlight).toBe(3);
    await h.settled();
    expect(h.pause.own()).toBeNull();
    // Settled at what they cost: the unused part of each hold is released, and the next calls fit again.
    expect(h.cap.state()!.inFlightUsd).toBe(0);
    expect(h.cap.state()!.spentUsd).toBeCloseTo(0.3, 5);
    const next = [capped.run(model, request(0, 1_000_000)), capped.run(model, request(0, 1_000_000))];
    await Promise.resolve();
    expect(ai.runs).toHaveLength(5);
    ai.runs.slice(3).forEach((r) => r.release());
    await Promise.all(next);
    expect(h.cap.state()!.spentUsd).toBeCloseTo(0.5, 5);
  });

  it("trip the pause when a call does not fit even with nothing else in flight", async () => {
    const h = harness();
    await h.cap.set({ usd: 1, reviewReserveUsd: 0, by: "maya" });
    h.cap.settle(null, 0.8);
    await h.settled();
    expect(h.pause.own()).toBeNull();
    expect(h.cap.reserve({ use: "agents", usd: 0.3 })).toMatchObject({ ok: false, busy: false });
    await h.settled();
    expect(h.pause.own()).toMatchObject({
      by: SPEND_CAP_ACTOR,
      reason: "spend cap: $0.800 of $1.00 spent on model calls this platform made, and the next call (up to $0.300) does not fit in the $0.200 left to agents",
    });
    // In the colony the refusal names the cap, never a figure.
    await expect(cappedAi(new SlowAi({ input: 0, output: 0 }), h.cap, "judge").run("@cf/openai/gpt-oss-20b", request(0, 1_000_000))).rejects.toThrow(`[ft:409] ${SHARE_REFUSAL}`);
  });

  it("reserve twice for a call that may send a hedged copy, settle the answer, and keep one copy's hold until the loser ends", async () => {
    const h = harness();
    await h.cap.set({ usd: 1, reviewReserveUsd: 0, by: "maya" });
    let lose!: (v: { model: string; usage: NonNullable<ModelReply["usage"]> | null } | null) => void;
    const client: ModelClient = {
      complete: async () => ({ text: "x", model: GPT, usage: { input: 1_000, output: 0, cached: 0, neurons: 0 }, late: new Promise((r) => (lose = r)) }),
    };
    const gate = localGate(h.cap, "resolver", (m) => m);
    const one = estimateUsd(GPT, 1_008, 1_000);
    const capped = cappedClient(client, gate, 2);
    const reply = await capped.complete({ model: GPT, messages: [{ role: "user", content: "y".repeat(1_000) }], maxTokens: 1_000 });
    expect(reply.text).toBe("x");
    // The answer is settled (1,000 input tokens), and one copy's hold stays while the losing copy is out.
    expect(h.cap.state()!.inFlightUsd).toBeCloseTo(one, 8);
    expect(h.cap.state()!.spentUsd).toBeCloseTo(0.00035, 8);
    lose({ model: GPT, usage: { input: 1_000, output: 0, cached: 0, neurons: 0 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.cap.state()).toMatchObject({ inFlightUsd: 0, spentUsd: 0.0007 });
  });

  it("drop a hold never settled after HOLD_TTL_MS, and a late settle still counts what was spent", async () => {
    const h = harness();
    await h.cap.set({ usd: 1, reviewReserveUsd: 0, by: "maya" });
    const held = h.cap.reserve({ use: "agents", usd: 0.5 });
    expect(held.ok).toBe(true);
    expect(h.cap.state()!.inFlightUsd).toBe(0.5);
    h.clock.now += HOLD_TTL_MS + 1;
    expect(h.cap.state()!.inFlightUsd).toBe(0);
    h.cap.settle(held.ok ? held.hold : null, 0.2);
    expect(h.cap.state()!.spentUsd).toBe(0.2);
  });

  it("count the spend as the colony counts it or as the calls settled since the cap, whichever is more", async () => {
    const h = harness();
    h.state.book = 0.4;
    await h.cap.set({ usd: 2, by: "maya" });
    expect(h.cap.state()).toMatchObject({ spentUsd: 0.4, reviewReserveUsd: 0.2 });
    // An agent's call settles before its journal is read: the cap sees it at once.
    h.cap.settle(null, 0.3);
    expect(h.cap.state()!.spentUsd).toBe(0.7);
    // A call no reservation saw (in flight when the cap was set) shows in the colony's count later: that counts too.
    h.state.book = 1.1;
    expect(h.cap.state()!.spentUsd).toBe(1.1);
  });

  it("survive a restart: the cap and the holds are in the colony's storage", async () => {
    const sql = sqlite();
    const a = harness(sql);
    await a.cap.set({ usd: 3, reviewReserveUsd: 1, by: "maya" });
    a.cap.reserve({ use: "agents", usd: 0.25 });
    const b = harness(sql);
    expect(b.cap.state()).toMatchObject({ usd: 3, reviewReserveUsd: 1, inFlightUsd: 0.25, setBy: "maya", state: "open" });
  });
});

describe("at the cap", () => {
  it("trips the pause with the spend in its reason, as platform:spend-cap, once the agents' share is spent", async () => {
    const h = harness();
    await h.cap.set({ usd: 1, reviewReserveUsd: 0.25, by: "maya" });
    const held = h.cap.reserve({ use: "agents", usd: 0.1 });
    expect(held.ok).toBe(true);
    // The call cost more than expected and brings the spend to the share (1 - 0.25).
    h.cap.settle(held.ok ? held.hold : null, 0.75);
    await h.settled();
    expect(h.pause.own()).toMatchObject({ scope: "colony", by: SPEND_CAP_ACTOR, reason: "spend cap: $0.750 of $1.00 spent on model calls this platform made" });
    expect(h.events).toEqual([expect.objectContaining({ t: "paused", by: SPEND_CAP_ACTOR, reason: "spend cap: $0.750 of $1.00 spent on model calls this platform made" })]);
    expect(h.cap.state()!.state).toBe("review-only");
  });

  it("refuses an agent's call with the pause's sentence, which the agent's loop waits on", async () => {
    const h = harness();
    h.state.book = 0.9;
    await h.cap.set({ usd: 1, reviewReserveUsd: 0.1, by: "maya" });
    await h.settled();
    let err: unknown;
    try {
      agentReserve(h.cap, { model: GPT, chars: 300, maxTokens: 100, copies: 1 }, (m) => m);
    } catch (e) {
      err = e;
    }
    expect(isPauseRefusal(err)).toBe(true);
    expect(isSpendCapRefusal(err)).toBe(true);
    expect((err as Error).message).toBe(`[ft:409] ${pausedSentence({ by: SPEND_CAP_ACTOR, reason: "spend cap: $0.900 of $1.00 spent on model calls this platform made" })}`);
  });

  it("lets review spend its reserve after agents stopped, then refuses it too: review makes no model call", async () => {
    const h = harness();
    h.state.book = 0.75;
    await h.cap.set({ usd: 1, reviewReserveUsd: 0.25, by: "maya" });
    expect(h.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR });
    expect(h.cap.reserve({ use: "agents", usd: 0.01 }).ok).toBe(false);
    expect(h.cap.reserve({ use: "judge", usd: 0.01 }).ok).toBe(false);
    const review = h.cap.reserve({ use: "review", usd: 0.2 });
    expect(review.ok).toBe(true);
    h.cap.settle(review.ok ? review.hold : null, 0.24);
    expect(h.cap.state()).toMatchObject({ state: "review-only", spentUsd: 0.99 });
    expect(h.cap.reserve({ use: "review", usd: 0.02 })).toMatchObject({ ok: false });
    // Through the binding: the refusal is the review one, and the model is never called.
    const ai = new SlowAi({ input: 1, output: 1 });
    await expect(cappedAi(ai, h.cap, "review").run(GPT, request(300, 20_000))).rejects.toThrow(REVIEW_REFUSAL);
    expect(ai.runs).toHaveLength(0);
    h.state.book = 1;
    expect(h.cap.state()!.state).toBe("spent");
  });

  it("trips at once when a person sets a cap the spend already passed", async () => {
    const h = harness();
    h.state.book = 2;
    const res = await h.cap.set({ usd: 1.5, by: "maya" });
    expect(res).toMatchObject({ tripped: true, lifted: false, cap: { usd: 1.5, reviewReserveUsd: 0.15, state: "spent" } });
    expect(res.note).toContain("already at the cap, so the agents are paused now");
    expect(h.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR, reason: "spend cap: $2.00 of $1.50 spent on model calls this platform made" });
  });
});

describe("lifting the cap's pause", () => {
  it("raising the cap past the spend lifts it, as the person who raised it", async () => {
    const h = harness();
    h.state.book = 0.95;
    await h.cap.set({ usd: 1, by: "maya" });
    expect(h.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR });
    // Not enough: the agents' share of $1.20 (less $0.10 kept) is still spent.
    const short = await h.cap.set({ usd: 1.04, by: "maya" });
    expect(short).toMatchObject({ lifted: false, tripped: false });
    expect(short.note).toContain("stay paused");
    const raised = await h.cap.set({ usd: 5, by: "lee" });
    expect(raised).toMatchObject({ lifted: true, cap: { usd: 5, reviewReserveUsd: 0.1, state: "open" } });
    expect(h.pause.own()).toBeNull();
    expect(h.events.at(-1)).toMatchObject({ t: "resumed", by: "lee", reason: "spend cap raised to $5.00" });
    expect(h.cap.reserve({ use: "agents", usd: 0.5 }).ok).toBe(true);
  });

  it("removing the cap lifts it and lets every call go on", async () => {
    const h = harness();
    h.state.book = 3;
    await h.cap.set({ usd: 1, by: "maya" });
    const res = await h.cap.clear({ by: "lee" });
    expect(res).toMatchObject({ cap: null, lifted: true });
    expect(h.pause.own()).toBeNull();
    expect(h.cap.reserve({ use: "agents", usd: 100 })).toEqual({ ok: true, hold: null });
  });

  it("never lifts a person's own pause, and never trips over one", async () => {
    const h = harness();
    await h.pause.pause({ by: "maya", reason: "demo reset" });
    h.state.book = 3;
    expect(await h.cap.set({ usd: 1, by: "maya" })).toMatchObject({ tripped: false });
    expect(h.cap.reserve({ use: "agents", usd: 0.1 }).ok).toBe(false);
    await h.settled();
    expect(h.pause.own()).toMatchObject({ by: "maya", reason: "demo reset" });
    expect(await h.cap.set({ usd: 10, by: "lee" })).toMatchObject({ lifted: false });
    expect(await h.cap.clear({ by: "lee" })).toMatchObject({ lifted: false });
    expect(h.pause.own()).toMatchObject({ by: "maya" });
  });

  it("a person who resumes while the spend is at the cap is told, and the next call pauses the agents again", async () => {
    const h = harness();
    h.state.book = 0.95;
    await h.cap.set({ usd: 1, by: "maya" });
    await h.pause.resume({ by: "lee" });
    expect(h.cap.resumeNote("web")).toBe(
      "The spend cap is reached: $0.950 of $1.00 spent on model calls this platform made, so it will pause again at the next call. Raise the cap or remove it: ft spend-cap web <usd> (or off).",
    );
    expect(h.cap.reserve({ use: "agents", usd: 0.01 }).ok).toBe(false);
    await h.settled();
    expect(h.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR });
    await h.cap.set({ usd: 2, by: "lee" });
    expect(h.cap.resumeNote("web")).toBeNull();
  });
});

describe("a cap that trips below its amount", () => {
  // As on staging: a $0.0268 cap keeping $0.005 for review, $0.0072 spent, and an agent's write to kimi (12,000
  // characters of prompt, 16,000 output tokens) that needs up to $0.068.
  const KIMI_WRITE = { model: KIMI, chars: 12_000, maxTokens: 16_000, copies: 1 };
  const SIZE = "up to $0.068 for @cf/moonshotai/kimi-k2.7-code with up to 16,000 output tokens";

  async function tripped() {
    const h = harness();
    h.state.book = 0.0072;
    await h.cap.set({ usd: 0.0268, reviewReserveUsd: 0.005, by: "maya" });
    expect(h.pause.own()).toBeNull();
    let err: unknown;
    try {
      agentReserve(h.cap, KIMI_WRITE, (m) => m);
    } catch (e) {
      err = e;
    }
    await h.settled();
    return { h, err };
  }

  it("names what sized the call in the pause's reason: its model and its output limit", async () => {
    const { h, err } = await tripped();
    const reason = `spend cap: $0.0072 of $0.027 spent on model calls this platform made, and the next call (${SIZE}) does not fit in the $0.015 left to agents`;
    expect(h.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR, reason });
    expect((err as Error).message).toBe(`[ft:409] ${pausedSentence({ by: SPEND_CAP_ACTOR, reason })}`);
    // A call in the colony names its request's model and max_tokens too, and a hedged one says it holds two copies.
    const c = harness();
    c.state.book = 0.0072;
    await c.cap.set({ usd: 0.0268, reviewReserveUsd: 0.005, by: "maya" });
    await expect(cappedAi(new SlowAi({ input: 0, output: 0 }), c.cap, "judge").run(GPT, request(300, 40_000))).rejects.toThrow(SHARE_REFUSAL);
    await c.settled();
    expect(c.pause.own()!.reason).toContain(`(up to $0.030 for ${GPT} with up to 40,000 output tokens) does not fit`);
    expect(callText(0.136, { model: KIMI, maxTokens: 16_000 }, 2)).toBe("up to $0.136 for @cf/moonshotai/kimi-k2.7-code with up to 16,000 output tokens, twice for a hedged copy");
    expect(callText(0.02, { model: GPT, maxTokens: null })).toBe(`up to $0.020 for ${GPT} with no output limit (held at 4,000 output tokens)`);
    expect(callText(0.02, null)).toBe("up to $0.020");
  });

  it("tells a person who resumes that it will pause again at the next call, though the spend is under the cap", async () => {
    const { h } = await tripped();
    await h.pause.resume({ by: "lee" });
    expect(h.cap.resumeNote("web")).toBe(
      `The spend cap still leaves $0.015, less than the next model call may need (${SIZE}): it will pause again at the next call. Raise the cap or remove it: ft spend-cap web <usd> (or off).`,
    );
    // And it does: the same call trips the pause again.
    expect(() => agentReserve(h.cap, KIMI_WRITE, (m) => m)).toThrow(/spend cap: \$0\.0072 of \$0\.027/);
    await h.settled();
    expect(h.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR });
  });

  it("says the same when a raise lifts the pause but still leaves less than that call, and nothing once there is room", async () => {
    const { h } = await tripped();
    const short = await h.cap.set({ usd: 0.05, by: "lee" });
    expect(short.lifted).toBe(true);
    expect(short.note).toContain(`The pause the cap had tripped is lifted: agents may work again. The spend cap still leaves $0.038, less than the next model call may need (${SIZE}): it will pause again at the next call.`);
    expect(h.cap.resumeNote("web")).toContain("it will pause again at the next call");
    const enough = await h.cap.set({ usd: 0.1, by: "lee" });
    expect(enough.note).not.toContain("pause again");
    expect(h.cap.resumeNote("web")).toBeNull();
    expect(agentReserve(h.cap, KIMI_WRITE, (m) => m).hold).toMatch(/^hld_/);
    // Removing the cap forgets the call that did not fit.
    await h.cap.clear({ by: "lee" });
    expect(h.sql.exec("SELECT COUNT(*) AS n FROM spend_cap_need").toArray()).toEqual([{ n: 0 }]);
  });
});

describe("setting the cap", () => {
  it("keeps the review reserve below the cap, defaulting to a tenth of it and keeping the last one when raised", async () => {
    const h = harness();
    expect((await h.cap.set({ usd: 10, by: "maya" })).cap).toMatchObject({ usd: 10, reviewReserveUsd: 1 });
    expect((await h.cap.set({ usd: 20, by: "maya" })).cap).toMatchObject({ usd: 20, reviewReserveUsd: 1 });
    expect((await h.cap.set({ usd: 20, reviewReserveUsd: 0, by: "maya" })).cap).toMatchObject({ reviewReserveUsd: 0 });
    expect((await h.cap.set({ usd: "7.50", reviewReserveUsd: "2", by: "maya" })).cap).toMatchObject({ usd: 7.5, reviewReserveUsd: 2 });
    await expect(h.cap.set({ usd: 0, by: "maya" })).rejects.toThrow("[ft:400] the cap must be a dollar amount above 0");
    await expect(h.cap.set({ usd: -1, by: "maya" })).rejects.toThrow("[ft:400]");
    await expect(h.cap.set({ usd: "five", by: "maya" })).rejects.toThrow("[ft:400]");
    await expect(h.cap.set({ usd: 5, reviewReserveUsd: 5, by: "maya" })).rejects.toThrow("[ft:400] the review reserve must be a dollar amount of at least 0 and below the cap of $5.00");
  });
});

describe("an agent's gate over RPC", () => {
  const ask = { model: GPT, chars: 300, maxTokens: 100, copies: 1 };

  it("reserves with the colony and settles after; with no cap the colony says so and nothing is settled", async () => {
    const h = harness();
    const settles: unknown[] = [];
    const colony = {
      spendReserve: async (a: typeof ask) => agentReserve(h.cap, a, (m) => m),
      spendSettle: async (s: Parameters<typeof agentSettle>[1]) => (settles.push(s), agentSettle(h.cap, s, (m) => m)),
    };
    const memo = { capped: null as boolean | null };
    const gate = agentCapGate(colony, "agt_1", memo);
    expect(await gate.reserve(ask)).toEqual({ hold: null });
    expect(memo.capped).toBe(false);
    await h.cap.set({ usd: 1, by: "maya" });
    const { hold } = await gate.reserve(ask);
    expect(hold).toMatch(/^hld_/);
    expect(memo.capped).toBe(true);
    await gate.settle({ hold: hold!, model: GPT, usage: { input: 1_000_000, output: 0 } });
    expect(h.cap.state()).toMatchObject({ spentUsd: 0.35, inFlightUsd: 0 });
  });

  it("lets the call go on for a colony on the previous code, or one known to have no cap that does not answer; fails closed otherwise", async () => {
    const old = agentCapGate({ spendReserve: async () => Promise.reject(new Error("RPC receiver does not implement the method \"spendReserve\".")) }, "agt_1");
    expect(await old.reserve(ask)).toEqual({ hold: null });
    const down = { spendReserve: async () => Promise.reject(new Error("Network connection lost.")) };
    expect(await agentCapGate(down, "agt_1", { capped: false }).reserve(ask)).toEqual({ hold: null });
    await expect(agentCapGate(down, "agt_1", { capped: true }).reserve(ask)).rejects.toThrow(/^\[ft:429\] the colony did not answer its spend cap check, so no model call started/);
    await expect(agentCapGate(down, "agt_1").reserve(ask)).rejects.toThrow("[ft:429]");
    // A refusal passes as it is: the loop reads it as a pause.
    const refusal = new Error(`[ft:409] ${pausedSentence({ by: SPEND_CAP_ACTOR, reason: "spend cap: $1.00 of $1.00 spent on model calls this platform made" })}`);
    await expect(agentCapGate({ spendReserve: async () => Promise.reject(refusal) }, "agt_1", { capped: false }).reserve(ask)).rejects.toBe(refusal);
    // A colony with no spend methods at all (a test fake) has no cap.
    expect(await agentCapGate({}, "agt_1").reserve(ask)).toEqual({ hold: null });
  });

  it("tells an agent whose call only waits for the calls in flight to wait as for a throttled model, tripping nothing", async () => {
    const h = harness();
    await h.cap.set({ usd: 1, reviewReserveUsd: 0, by: "maya" });
    // gpt-oss-120b: 1,000,000 output tokens hold $0.75.
    const big = { model: GPT, chars: 0, maxTokens: 1_000_000, copies: 1 };
    expect(agentReserve(h.cap, big, (m) => m).hold).toMatch(/^hld_/);
    expect(() => agentReserve(h.cap, big, (m) => m)).toThrow(`[ft:429] ${BUSY_REFUSAL}`);
    await h.settled();
    expect(h.pause.own()).toBeNull();
  });

  it("starts no model call when the colony refuses, and releases the hold when the call fails", async () => {
    const h = harness();
    await h.cap.set({ usd: 1, reviewReserveUsd: 0, by: "maya" });
    let calls = 0;
    const failing: ModelClient = {
      complete: async () => {
        calls++;
        throw new Error("model down");
      },
    };
    const gate: CapGate = agentCapGate({ spendReserve: async (a) => agentReserve(h.cap, a, (m) => m), spendSettle: async (s) => agentSettle(h.cap, s, (m) => m) }, "agt_1");
    await expect(cappedClient(failing, gate).complete({ model: GPT, messages: [], maxTokens: 100 })).rejects.toThrow("model down");
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.cap.state()).toMatchObject({ inFlightUsd: 0, spentUsd: 0 });
    h.state.book = 1;
    h.clock.now += 2_000;
    await expect(cappedClient(failing, gate).complete({ model: GPT, messages: [], maxTokens: 100 })).rejects.toSatisfy(isPauseRefusal);
    expect(calls).toBe(1);
  });
});
