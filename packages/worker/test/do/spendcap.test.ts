import { describe, expect, it } from "vitest";
import type { ColonySpend, SpendCap } from "@fire_trident/core";
import { pausedSentence } from "../../src/colony/pause.ts";
import { SPEND_CAP_ACTOR } from "../../src/colony/spendcap.ts";
import { addAgent, addIntent, api, colony, newColony } from "./helpers.ts";

/**
 * The spend cap against the real ColonyDO (colony/spendcap.ts, api/spendcap.ts): a person sets it with the admin token;
 * the colony's status and metrics carry it in `spend`; an in-platform agent's call is reserved and settled through the
 * colony; at the agents' share the pause trips as platform:spend-cap, with the spend in its reason; a person who resumes
 * while still over is told the next call pauses again, and it does; raising the cap lifts the pause; removing it lifts
 * it too. A colony with no cap reports none.
 */

const GPT = "@cf/openai/gpt-oss-120b";
const ASK = { model: GPT, chars: 300, maxTokens: 100, copies: 1 };

/** The message an RPC call was refused with (null when it was not refused). */
async function refused(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("the spend cap", () => {
  it("is absent until a person sets one: the status, the metrics and the route say so, and an agent's call holds nothing", async () => {
    const c = await newColony();
    expect(await api("GET", `/colonies/${c.id}/spend-cap`, undefined, {})).toEqual({ status: 200, body: { colonyId: c.id, cap: null } });
    expect((await api<{ spend: ColonySpend }>("GET", `/colonies/${c.id}`)).body.spend.cap).toBeUndefined();
    expect((await api<{ spend: ColonySpend }>("GET", `/colonies/${c.id}/metrics`)).body.spend.cap).toBeUndefined();
    expect(await colony(c.id).spendReserve(ASK)).toEqual({ hold: null, capped: false });
  });

  it("needs the admin token to set, and a dollar amount", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/spend-cap`, { usd: 5 }, {})).status).toBe(401);
    for (const body of [{}, { usd: 0 }, { usd: -2 }, { usd: "5" }, { usd: 5, reviewReserveUsd: -1 }]) {
      const r = await api<{ error: string }>("POST", `/colonies/${c.id}/spend-cap`, body);
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('Send { "usd": 5, "reviewReserveUsd": 0.5 }');
    }
    const r = await api<{ error: string }>("POST", `/colonies/${c.id}/spend-cap`, { usd: 1, reviewReserveUsd: 1 });
    expect(r).toEqual({ status: 400, body: { error: "the review reserve must be a dollar amount of at least 0 and below the cap of $1.00" } });
  });

  it("trips the pause at the agents' share, re-trips after a resume while over, and lifts when a person raises the cap", async () => {
    const c = await newColony();
    const agent = await addAgent(c.id, "a");
    await addIntent(c.id, ["src/a.ts"]);
    const set = await api<{ cap: SpendCap; tripped: boolean; note: string }>("POST", `/colonies/${c.id}/spend-cap`, { usd: 1, reviewReserveUsd: 0.25, by: "maya" });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ colonyId: c.id, tripped: false, lifted: false, cap: { usd: 1, reviewReserveUsd: 0.25, spentUsd: 0, inFlightUsd: 0, state: "open", setBy: "maya" } });
    expect(set.body.note).toBe("Model calls this platform makes for the colony stop at $1.00: everything but review at $0.750, and review keeps $0.250 for changes in flight. $0.0000 spent so far.");
    // The status and the metrics carry it.
    expect((await api<{ spend: ColonySpend }>("GET", `/colonies/${c.id}`)).body.spend.cap).toMatchObject({ usd: 1, state: "open" });
    expect((await api<{ spend: ColonySpend }>("GET", `/colonies/${c.id}/metrics`)).body.spend.cap).toMatchObject({ usd: 1, reviewReserveUsd: 0.25 });

    // An agent's call: reserved, then settled at 2,285,715 input tokens on gpt-oss-120b ($0.80), past the agents' share.
    const { hold, capped } = await colony(c.id).spendReserve(ASK);
    expect(capped).toBe(true);
    expect(hold).toMatch(/^hld_/);
    expect((await colony(c.id).spendCap())!.inFlightUsd).toBeGreaterThan(0);
    await colony(c.id).spendSettle({ hold: hold!, model: GPT, usage: { input: 2_285_715, output: 0 } });
    const reason = "spend cap: $0.800 of $1.00 spent on model calls this platform made";
    const paused = await colony(c.id).pauseState();
    expect(paused.pauses[0]).toMatchObject({ scope: "colony", by: SPEND_CAP_ACTOR, reason });
    expect(paused.refusal).toBe(pausedSentence({ by: SPEND_CAP_ACTOR, reason }));
    expect(await colony(c.id).spendCap()).toMatchObject({ state: "review-only", inFlightUsd: 0 });

    // Takes stop (the pause does that), and another agent call is refused with the same sentence.
    expect(await api("POST", `/colonies/${c.id}/agents/${agent.id}/take`)).toEqual({ status: 409, body: { error: paused.refusal } });
    expect(await refused(colony(c.id).spendReserve(ASK))).toBe(`[ft:409] ${paused.refusal}`);

    // A person resumes while the spend is still at the cap: told so, and the next call pauses the agents again.
    const resumed = await api<{ resumed: unknown; spendCap?: string }>("POST", `/colonies/${c.id}/resume`, { by: "lee" });
    expect(resumed.status).toBe(200);
    expect(resumed.body.spendCap).toBe(
      `The spend cap is reached: $0.800 of $1.00 spent on model calls this platform made, so it will pause again at the next call. Raise the cap or remove it: ft spend-cap ${c.id} <usd> (or off).`,
    );
    expect((await colony(c.id).pauseState()).paused).toBe(false);
    expect(await refused(colony(c.id).spendReserve(ASK))).toBe(`[ft:409] ${pausedSentence({ by: SPEND_CAP_ACTOR, reason })}`);
    expect((await colony(c.id).pauseState()).pauses[0]).toMatchObject({ by: SPEND_CAP_ACTOR, reason });

    // Raising the cap past the spend lifts the pause, as the person who raised it.
    const raised = await api<{ lifted: boolean; cap: SpendCap; note: string }>("POST", `/colonies/${c.id}/spend-cap`, { usd: 5, by: "lee" });
    expect(raised.body).toMatchObject({ lifted: true, cap: { usd: 5, reviewReserveUsd: 0.25, state: "open" } });
    expect(raised.body.note).toContain("The pause the cap had tripped is lifted: agents may work again.");
    expect((await colony(c.id).pauseState()).paused).toBe(false);
    expect((await colony(c.id).spendReserve(ASK)).hold).toMatch(/^hld_/);
    // The pause and the resume are in the event record.
    const events = (await api<{ events: Array<{ t: string; by?: string }> }>("GET", `/colonies/${c.id}/events`)).body.events.filter((e) => e.t === "paused" || e.t === "resumed");
    expect(events.map((e) => [e.t, e.by])).toEqual([
      ["paused", SPEND_CAP_ACTOR],
      ["resumed", "lee"],
      ["paused", SPEND_CAP_ACTOR],
      ["resumed", "lee"],
    ]);
  });

  it("trips below its amount when the next call does not fit, says why, and a resume answer says it will pause again", async () => {
    const c = await newColony();
    await api("POST", `/colonies/${c.id}/spend-cap`, { usd: 0.0268, reviewReserveUsd: 0.005 });
    // $0.0072 spent: 20,572 input tokens on gpt-oss-120b.
    const { hold } = await colony(c.id).spendReserve(ASK);
    await colony(c.id).spendSettle({ hold: hold!, model: GPT, usage: { input: 20_572, output: 0 } });
    expect((await colony(c.id).pauseState()).paused).toBe(false);
    // An agent's write to kimi: 12,000 characters of prompt and 16,000 output tokens need up to $0.068.
    const write = { model: "@cf/moonshotai/kimi-k2.7-code", chars: 12_000, maxTokens: 16_000, copies: 1 };
    const size = "up to $0.068 for @cf/moonshotai/kimi-k2.7-code with up to 16,000 output tokens";
    const reason = `spend cap: $0.0072 of $0.027 spent on model calls this platform made, and the next call (${size}) does not fit in the $0.015 left to agents`;
    expect(await refused(colony(c.id).spendReserve(write))).toBe(`[ft:409] ${pausedSentence({ by: SPEND_CAP_ACTOR, reason })}`);
    expect((await colony(c.id).pauseState()).pauses[0]).toMatchObject({ by: SPEND_CAP_ACTOR, reason });
    const resumed = await api<{ spendCap?: string }>("POST", `/colonies/${c.id}/resume`, { by: "lee" });
    expect(resumed.body.spendCap).toBe(
      `The spend cap still leaves $0.015, less than the next model call may need (${size}): it will pause again at the next call. Raise the cap or remove it: ft spend-cap ${c.id} <usd> (or off).`,
    );
  });

  it("is removed with usd null, which lifts the pause it tripped", async () => {
    const c = await newColony();
    await api("POST", `/colonies/${c.id}/spend-cap`, { usd: 0.5, reviewReserveUsd: 0 });
    const { hold } = await colony(c.id).spendReserve(ASK);
    await colony(c.id).spendSettle({ hold: hold!, model: GPT, usage: { input: 2_000_000, output: 0 } });
    expect((await colony(c.id).pauseState()).paused).toBe(true);
    const removed = await api<{ cap: null; lifted: boolean; note: string }>("POST", `/colonies/${c.id}/spend-cap`, { usd: null, by: "maya" });
    expect(removed.body).toMatchObject({ colonyId: c.id, cap: null, lifted: true });
    expect(removed.body.note).toBe("No spend cap: model calls go on with no limit. The pause the cap had tripped is lifted: agents may work again.");
    expect((await colony(c.id).pauseState()).paused).toBe(false);
    expect(await colony(c.id).spendReserve(ASK)).toEqual({ hold: null, capped: false });
    expect((await api("GET", `/colonies/${c.id}/spend-cap`)).body).toEqual({ colonyId: c.id, cap: null });
  });
});
