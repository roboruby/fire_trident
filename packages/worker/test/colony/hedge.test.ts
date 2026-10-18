import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelClient } from "../../src/agents/llm.ts";
import { HEDGE_AFTER_MS, cleanHedgeRecord, hedgeAfterMs, hedgeFor, hedgeSummary, hedgeText, hedged, type Hedge, type HedgeRecord } from "../../src/colony/hedge.ts";
import { meteredAi, resolverClient } from "../../src/colony/spend.ts";
import { CallLimiter } from "../../src/decide/limiter.ts";
import { pairJudge, type ContestCandidate } from "../../src/decide/contest.ts";
import { fileDiff } from "../../src/decide/diff.ts";

/**
 * Hedged model calls (FT_HEDGE): a call with no answer after its site's wait goes out once more, the first answer wins,
 * the other copy is aborted, an error wins only once both failed, and a losing copy that answers anyway is handed back
 * so its tokens count. Timers and the clock are faked, so every wait below is exact.
 */

/** One scripted call: answer `value` (or fail with `error`) after `ms`; `stops` makes it fail at once when aborted. */
interface Script {
  ms: number;
  value?: unknown;
  error?: string;
  stops?: boolean;
}

/** A call function that follows one script per call, in order, and records each call's model, signal and abort. */
function scripted(scripts: Script[]) {
  const calls: Array<{ model: string; signal: AbortSignal | undefined; aborted: boolean }> = [];
  const call = (model: string, signal?: AbortSignal): Promise<unknown> => {
    const s = scripts[calls.length] ?? { ms: 0, value: "unscripted" };
    const rec = { model, signal, aborted: false };
    calls.push(rec);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (s.error !== undefined ? reject(new Error(s.error)) : resolve(s.value)), s.ms);
      signal?.addEventListener("abort", () => {
        rec.aborted = true;
        if (s.stops) {
          clearTimeout(timer);
          reject(new Error("The operation was aborted"));
        }
      });
    });
  };
  return { call, calls };
}

/** A hedge as hedgeFor makes it, with its counters kept. */
function hedge(extra: Partial<Hedge> = {}): Hedge & { counted: Record<string, number> } {
  const counted: Record<string, number> = {};
  return { site: "review", afterMs: 8_000, bump: (name, delta) => void (counted[name] = (counted[name] ?? 0) + delta), counted, ...extra };
}

/** Watch a promise from now on: its value, its error, or "pending" so far. */
function track<T>(p: Promise<T>): () => { value: T } | { error: unknown } | "pending" {
  let out: { value: T } | { error: unknown } | "pending" = "pending";
  p.then(
    (value) => void (out = { value }),
    (error: unknown) => void (out = { error }),
  );
  return () => out;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a hedged call", () => {
  it("sends no copy when the original answers in time", async () => {
    const s = scripted([{ ms: 2_000, value: "fast" }]);
    const h = hedge();
    const p = hedged(s.call, "m", h);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p).toEqual({ value: "fast", model: "m" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls).toHaveLength(1);
    expect(h.counted).toEqual({});
  });

  it("takes the copy's answer when the original is slow, aborts the original, and hands back its late answer for counting", async () => {
    const s = scripted([
      { ms: 30_000, value: { response: "slow", usage: { prompt_tokens: 100, completion_tokens: 20 } } },
      { ms: 1_000, value: { response: "fast", usage: { prompt_tokens: 100, completion_tokens: 15 } } },
    ]);
    const late: Array<{ model: string; value: unknown }> = [];
    const h = hedge({ onLate: (model, value) => void late.push({ model, value }) });
    const p = hedged(s.call, "m", h);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.map((c) => c.model)).toEqual(["m", "m"]);
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(r.value).toMatchObject({ response: "fast" });
    expect(r.hedged).toEqual({ after_ms: 8_000, winner: "copy", model: "m", cause: "slow" });
    expect(s.calls[0]!.aborted).toBe(true);
    expect(s.calls[1]!.aborted).toBe(false);
    expect(h.counted).toEqual({ "hedge.review.sent": 1, "hedge.review.copy": 1 });
    // The original ignored the abort and answered at 30 s: its tokens were spent, so they come back to be counted.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(late).toEqual([{ model: "m", value: { response: "slow", usage: { prompt_tokens: 100, completion_tokens: 20 } } }]);
    expect(await r.late).toEqual({ model: "m", value: { response: "slow", usage: { prompt_tokens: 100, completion_tokens: 20 } } });
  });

  it("counts nothing for an original that stopped when aborted", async () => {
    const s = scripted([{ ms: 30_000, value: "slow", stops: true }, { ms: 500, value: "fast" }]);
    const late: unknown[] = [];
    const p = hedged(s.call, "m", hedge({ onLate: (_m, v) => void late.push(v) }));
    await vi.advanceTimersByTimeAsync(8_500);
    const r = await p;
    expect(r.value).toBe("fast");
    expect(await r.late).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late).toEqual([]);
  });

  it("sends the copy at once when the original fails first, and the copy's answer wins", async () => {
    const s = scripted([{ ms: 200, error: "upstream answered 502" }, { ms: 1_000, value: "ok" }]);
    const p = hedged(s.call, "m", hedge());
    await vi.advanceTimersByTimeAsync(200);
    expect(s.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(r.value).toBe("ok");
    expect(r.hedged).toEqual({ after_ms: 200, winner: "copy", model: "m", cause: "failed" });
    expect(hedgeText(r.hedged!)).toBe("answered by the hedge copy, sent when the original failed after 0.2 s");
  });

  it("fails with the original's error only once both copies have failed", async () => {
    const s = scripted([{ ms: 10_000, error: "original failed" }, { ms: 5_000, error: "copy failed" }]);
    const p = track(hedged(s.call, "m", hedge()));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(s.calls).toHaveLength(2);
    // The original failed at 10 s; the copy is still running, so the call has not failed yet.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p()).toBe("pending");
    await vi.advanceTimersByTimeAsync(3_001);
    expect(p()).toMatchObject({ error: expect.objectContaining({ message: "original failed" }) });
  });

  it("keeps the original's answer when it beats its copy, and says a copy went out", async () => {
    const s = scripted([{ ms: 9_000, value: "original" }, { ms: 5_000, value: "copy" }]);
    const p = hedged(s.call, "m", hedge());
    await vi.advanceTimersByTimeAsync(9_000);
    const r = await p;
    expect(r).toMatchObject({ value: "original", model: "m", hedged: { after_ms: 8_000, winner: "original", model: "m", cause: "slow" } });
    expect(s.calls[1]!.aborted).toBe(true);
    expect(hedgeText(r.hedged!)).toBe("answered by the original; its hedge copy went out after 8.0 s");
  });

  it("sends at most one copy", async () => {
    const s = scripted([{ ms: 100_000, value: "a" }, { ms: 100_000, value: "b" }]);
    void hedged(s.call, "m", hedge());
    await vi.advanceTimersByTimeAsync(99_000);
    expect(s.calls).toHaveLength(2);
  });

  it("sends a throttled original's copy only to another model", async () => {
    const same = scripted([{ ms: 100, error: "3040: out of capacity" }]);
    const p = track(hedged(same.call, "m", hedge()));
    await vi.advanceTimersByTimeAsync(100);
    expect(p()).toMatchObject({ error: expect.objectContaining({ message: "3040: out of capacity" }) });
    expect(same.calls).toHaveLength(1);
    const other = scripted([{ ms: 100, error: "3040: out of capacity" }, { ms: 100, value: "ok" }]);
    const q = hedged(other.call, "m", hedge({ copyModel: "fallback" }));
    await vi.advanceTimersByTimeAsync(201);
    expect(await q).toMatchObject({ value: "ok", model: "fallback", hedged: { winner: "copy", model: "fallback", cause: "failed" } });
    expect(other.calls.map((c) => c.model)).toEqual(["m", "fallback"]);
  });

  it("sends no copy when the limiter has no slot for it, and frees the slot it took", async () => {
    const limiter = new CallLimiter(1, 100);
    const held = await limiter.acquire("m", Date.now());
    const s = scripted([{ ms: 20_000, value: "late but alone" }]);
    const p = hedged(s.call, "m", hedge({ admit: (m) => limiter.acquire(m, 0) }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toEqual({ value: "late but alone", model: "m" });
    expect(s.calls).toHaveLength(1);
    held!();
    const t = scripted([{ ms: 20_000, value: "slow" }, { ms: 1_000, value: "copy" }]);
    const q = hedged(t.call, "m", hedge({ admit: (m) => limiter.acquire(m, 0) }));
    await vi.advanceTimersByTimeAsync(9_000);
    expect((await q).value).toBe("copy");
    expect(limiter.active).toBe(0);
  });

  it("is the call alone, with no signal, when the hedge is off", async () => {
    const s = scripted([{ ms: 30_000, value: "slow" }]);
    const off = hedgeFor({}, "c1", "review");
    expect(off).toBeNull();
    const p = hedged(s.call, "m", off);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toEqual({ value: "slow", model: "m" });
    expect(s.calls).toEqual([{ model: "m", signal: undefined, aborted: false }]);
  });
});

describe("a hedged call with a validity check (a malformed answer is a failed attempt)", () => {
  const ok = (v: unknown): boolean => typeof v === "string" && v.startsWith("ok");

  it("sends the copy at once when the original's answer is malformed, takes the copy's, and hands back the malformed one for counting", async () => {
    const s = scripted([{ ms: 1_000, value: "garbled" }, { ms: 2_000, value: "ok: merged" }]);
    const late: Array<{ model: string; value: unknown }> = [];
    const h = hedge({ onLate: (model, value) => void late.push({ model, value }) });
    const p = hedged(s.call, "m", h, Date.now, ok);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await p;
    expect(r).toMatchObject({ value: "ok: merged", model: "m", hedged: { after_ms: 1_000, winner: "copy", model: "m", cause: "invalid" } });
    expect(hedgeText(r.hedged!)).toBe("answered by the hedge copy, sent when the original's answer was malformed after 1.0 s");
    expect(late).toEqual([{ model: "m", value: "garbled" }]);
    expect(await r.late).toEqual({ model: "m", value: "garbled" });
    expect(h.counted).toEqual({ "hedge.review.sent": 1, "hedge.review.copy": 1 });
  });

  it("ends with the original's answer when the copy's is malformed too, and counts both", async () => {
    const s = scripted([{ ms: 500, value: "garbled 1" }, { ms: 500, value: "garbled 2" }]);
    const late: unknown[] = [];
    const p = hedged(s.call, "m", hedge({ onLate: (_m, v) => void late.push(v) }), Date.now, ok);
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(r).toMatchObject({ value: "garbled 1", hedged: { winner: "original", cause: "invalid", after_ms: 500 } });
    expect(hedgeText(r.hedged!)).toBe("the original's answer was malformed, and its hedge copy, sent after 0.5 s, gave no well-formed one");
    expect(late).toEqual(["garbled 2"]);
    expect(await r.late).toEqual({ model: "m", value: "garbled 2" });
  });

  it("ends with the original's malformed answer when the limiter has no slot for a copy", async () => {
    const limiter = new CallLimiter(1, 100);
    const held = await limiter.acquire("m", Date.now());
    const s = scripted([{ ms: 300, value: "garbled" }]);
    const p = hedged(s.call, "m", hedge({ admit: (m) => limiter.acquire(m, 0) }), Date.now, ok);
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toEqual({ value: "garbled", model: "m" });
    expect(s.calls).toHaveLength(1);
    held!();
  });

  it("waits for the original when a slow call's copy answers malformed, and keeps its answer", async () => {
    const s = scripted([{ ms: 12_000, value: "ok: original" }, { ms: 1_000, value: "garbled copy" }]);
    const late: unknown[] = [];
    const p = track(hedged(s.call, "m", hedge({ onLate: (_m, v) => void late.push(v) }), Date.now, ok));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(s.calls).toHaveLength(2);
    expect(p()).toBe("pending");
    await vi.advanceTimersByTimeAsync(3_000);
    const r = p() as { value: Awaited<ReturnType<typeof hedged<unknown>>> };
    expect(r.value).toMatchObject({ value: "ok: original", hedged: { winner: "original", cause: "slow" } });
    expect(late).toEqual(["garbled copy"]);
  });

  it("takes a malformed copy's answer over the original's error, and a check that throws finds the answer malformed", async () => {
    const s = scripted([{ ms: 100, error: "upstream answered 502" }, { ms: 100, value: "garbled" }]);
    const p = hedged(s.call, "m", hedge(), Date.now, ok);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toMatchObject({ value: "garbled", hedged: { winner: "copy", cause: "failed" } });
    const t = scripted([{ ms: 100, value: "anything" }, { ms: 100, value: "ok" }]);
    const q = hedged(
      t.call,
      "m",
      hedge(),
      Date.now,
      (v) => {
        if (v === "anything") throw new Error("cannot read it");
        return true;
      },
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(await q).toMatchObject({ value: "ok", hedged: { winner: "copy", cause: "invalid" } });
  });

  it("is the call alone when the hedge is off: a malformed answer is the answer, as before", async () => {
    const s = scripted([{ ms: 100, value: "garbled" }]);
    const p = hedged(s.call, "m", null, Date.now, ok);
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toEqual({ value: "garbled", model: "m" });
    expect(s.calls).toHaveLength(1);
  });

  it("reads a stored record with the new cause, and an unknown cause as slow", () => {
    expect(cleanHedgeRecord({ after_ms: 1_200, winner: "copy", model: "m", cause: "invalid" })).toEqual({ after_ms: 1_200, winner: "copy", model: "m", cause: "invalid" });
    expect(cleanHedgeRecord({ after_ms: 1_200, winner: "copy", model: "m", cause: "weird" })?.cause).toBe("slow");
  });
});

describe("the flag and the waits", () => {
  it("covers the colonies FT_HEDGE names, like FT_REVALIDATE", () => {
    expect(hedgeFor({ FT_HEDGE: "on" }, "c1", "agent")).toMatchObject({ site: "agent", afterMs: HEDGE_AFTER_MS.agent });
    expect(hedgeFor({ FT_HEDGE: "c2, c1" }, "c1", "reflex")).toMatchObject({ site: "reflex", afterMs: 3_000 });
    expect(hedgeFor({ FT_HEDGE: "c2" }, "c1", "reflex")).toBeNull();
    expect(hedgeFor({ FT_HEDGE: "off" }, "c1", "reflex")).toBeNull();
    expect(hedgeFor({ FT_HEDGE: "" }, "c1", "reflex")).toBeNull();
  });

  it("takes FT_HEDGE_MS for every site, or by site, held to 1 s .. 10 minutes", () => {
    expect(hedgeAfterMs(undefined, "review")).toBe(12_000);
    expect(hedgeAfterMs("8000", "review")).toBe(8_000);
    expect(hedgeAfterMs("8000", "agent")).toBe(8_000);
    expect(hedgeAfterMs("review=5000, agent=90000", "agent")).toBe(90_000);
    expect(hedgeAfterMs("review=5000, agent=90000", "judge")).toBe(12_000);
    expect(hedgeAfterMs("8000,reflex=2000", "reflex")).toBe(2_000);
    expect(hedgeAfterMs("8000,reflex=2000", "resolver")).toBe(8_000);
    expect(hedgeAfterMs("8", "review")).toBe(1_000);
    expect(hedgeAfterMs("99999999", "review")).toBe(600_000);
    expect(hedgeAfterMs("soon, review=-1", "review")).toBe(12_000);
    expect(hedgeAfterMs(8000 as unknown as string, "judge")).toBe(8_000);
    expect(hedgeFor({ FT_HEDGE: "on", FT_HEDGE_MS: "agent=90000" }, "c1", "agent")?.afterMs).toBe(90_000);
  });

  it("words the records as people read them", () => {
    const copy: HedgeRecord = { after_ms: 8_000, winner: "copy", model: "@cf/b", cause: "slow" };
    expect(hedgeText(copy)).toBe("answered by the hedge copy after 8.0 s");
    expect(hedgeText(copy, "@cf/a")).toBe("answered by the hedge copy to @cf/b after 8.0 s");
    expect(hedgeText(copy, "@cf/b")).toBe("answered by the hedge copy after 8.0 s");
    expect(hedgeSummary([])).toBeNull();
    expect(hedgeSummary([copy])).toBe("1 answer came from a hedge copy sent after 8.0 s");
    expect(hedgeSummary([{ ...copy, winner: "original" }])).toBe("a hedge copy went out after 8.0 s; the original answered");
    expect(hedgeSummary([copy, { ...copy, after_ms: 12_000, winner: "original" }])).toBe("1 answer came from a hedge copy sent after up to 12.0 s");
  });

  it("reads stored records back defensively: anything else is no hedge", () => {
    expect(cleanHedgeRecord({ after_ms: 8_000.4, winner: "copy", model: " @cf/b ", cause: "failed" })).toEqual({ after_ms: 8_000, winner: "copy", model: "@cf/b", cause: "failed" });
    expect(cleanHedgeRecord({ after_ms: 1, winner: "original", model: "m" })).toEqual({ after_ms: 1, winner: "original", model: "m", cause: "slow" });
    for (const odd of [undefined, null, "copy", [], {}, { after_ms: "8", winner: "copy", model: "m" }, { after_ms: 8, winner: "both", model: "m" }, { after_ms: 8, winner: "copy", model: "" }]) {
      expect(cleanHedgeRecord(odd)).toBeNull();
    }
  });
});

/** A Workers AI binding: each model answers after its own delay with its own usage; `stops` models fail when aborted. */
function binding(delays: Record<string, number>, stops = false) {
  const runs: Array<{ model: string; signal?: AbortSignal; aborted: boolean }> = [];
  return {
    runs,
    run(model: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
      const rec: { model: string; signal?: AbortSignal; aborted: boolean } = { model, aborted: false, ...(options?.signal ? { signal: options.signal } : {}) };
      const n = runs.push(rec);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ response: input.questions ? "" : `<file>\nreply ${n}\n</file>`, usage: { prompt_tokens: 100 * n, completion_tokens: 10 * n } }),
          delays[model] ?? 0,
        );
        options?.signal?.addEventListener("abort", () => {
          rec.aborted = true;
          if (stops) {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }
        });
      });
    },
  };
}

describe("the agents' model client and the resolver's", () => {
  it("answers from the copy when the original is slow, and counts both copies' tokens under the resolver", async () => {
    // The first run takes 60 s (and ignores its abort), the copy answers at once.
    let n = 0;
    const raw = binding({});
    const slowThenFast = {
      run: (model: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        n++;
        if (n === 1) return new Promise((resolve) => setTimeout(() => resolve({ response: "<file>\nslow\n</file>", usage: { prompt_tokens: 900, completion_tokens: 90 } }), 60_000));
        return raw.run(model, input, options);
      },
    };
    const counted: Record<string, number> = {};
    const h = hedgeFor({ FT_HEDGE: "on" }, "c1", "resolver");
    const client = resolverClient({ AI: slowThenFast as unknown as Ai, ANTHROPIC_API_KEY: undefined, FT_DEFAULT_MODEL: "@cf/vendor/strong", FT_BULK_MODEL: "@cf/vendor/cheap" }, (name, delta) => void (counted[name] = (counted[name] ?? 0) + delta), h);
    const p = client.complete({ model: "default", messages: [{ role: "user", content: "merge" }], maxTokens: 100 });
    await vi.advanceTimersByTimeAsync(20_001);
    const reply = await p;
    expect(reply.text).toContain("reply 1");
    expect(reply.model).toBe("@cf/vendor/strong");
    expect(reply.hedged).toEqual({ after_ms: 20_000, winner: "copy", model: "@cf/vendor/strong", cause: "slow" });
    expect(counted).toEqual({ "resolver.tokensIn:@cf/vendor/strong": 100, "resolver.tokensOut:@cf/vendor/strong": 10 });
    // The slow original answers at 60 s anyway: its tokens count too.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(counted).toEqual({ "resolver.tokensIn:@cf/vendor/strong": 1_000, "resolver.tokensOut:@cf/vendor/strong": 100 });
    expect(await reply.late).toEqual({ model: "@cf/vendor/strong", usage: { input: 900, output: 90, cached: 0, neurons: 0 } });
  });

  it("takes the copy's reply when the original's text fails the request's check, and counts the malformed one's tokens", async () => {
    let n = 0;
    const garbledThenGood = {
      run: (_model: string, _input: Record<string, unknown>) => {
        n++;
        const text = n === 1 ? "no file block here" : "<file>\nmerged\n</file>";
        return Promise.resolve({ response: text, usage: { prompt_tokens: 100 * n, completion_tokens: 10 * n } });
      },
    };
    const counted: Record<string, number> = {};
    const h = hedgeFor({ FT_HEDGE: "on" }, "c1", "resolver");
    const client = resolverClient({ AI: garbledThenGood as unknown as Ai, ANTHROPIC_API_KEY: undefined, FT_DEFAULT_MODEL: "@cf/vendor/strong", FT_BULK_MODEL: "@cf/vendor/cheap" }, (name, delta) => void (counted[name] = (counted[name] ?? 0) + delta), h);
    const reply = await client.complete({ model: "default", messages: [{ role: "user", content: "merge" }], maxTokens: 100, valid: (text) => (text ?? "").includes("<file>") });
    expect(reply.text).toContain("merged");
    expect(reply.hedged).toEqual({ after_ms: 0, winner: "copy", model: "@cf/vendor/strong", cause: "invalid" });
    expect(await reply.late).toEqual({ model: "@cf/vendor/strong", usage: { input: 100, output: 10, cached: 0, neurons: 0 } });
    expect(counted).toEqual({ "resolver.tokensIn:@cf/vendor/strong": 300, "resolver.tokensOut:@cf/vendor/strong": 30 });
    expect(n).toBe(2);
  });

  it("sends the call exactly as before when the flag is off", async () => {
    const ai = binding({ "@cf/vendor/strong": 70_000 });
    const client = modelClient({ AI: ai as unknown as Ai, FT_DEFAULT_MODEL: "@cf/vendor/strong", FT_BULK_MODEL: "@cf/vendor/cheap" }, hedgeFor({}, "c1", "agent"));
    const p = client.complete({ model: "default", messages: [], maxTokens: 10 });
    await vi.advanceTimersByTimeAsync(70_000);
    const reply = await p;
    expect(reply.hedged).toBeUndefined();
    expect(reply.late).toBeUndefined();
    expect(ai.runs).toEqual([{ model: "@cf/vendor/strong", aborted: false }]);
  });
});

/** A contestant whose change is one small new file. */
function candidate(id: string, text: string): ContestCandidate {
  return { proposalId: id, agentId: `agt_${id}`, model: "@cf/author/model", createdAt: 0, proof: false, residual: 0, danger: false, size: null, diffs: [fileDiff("src/a.ts", null, text)] } as unknown as ContestCandidate;
}

describe("the contest judge", () => {
  it("asks the copy of the same model when one order is slow, says so in the verdict, and counts every run", async () => {
    // Runs answer in order: the first order at once (100 tokens in), the second order after 50 s (200), its copy at once (300).
    let n = 0;
    const raw = {
      run: (_model: string, _input: Record<string, unknown>): Promise<unknown> => {
        n++;
        const better = n === 1 ? "A" : "B";
        const answer = { response: JSON.stringify({ better, reason: `run ${n}` }), usage: { prompt_tokens: 100 * n, completion_tokens: n } };
        return new Promise((resolve) => setTimeout(() => resolve(answer), n === 2 ? 50_000 : 0));
      },
    };
    // The binding as ColonyDO.judgeSpend meters it: each run counted when it answers.
    const counted: Record<string, number> = {};
    const ai = meteredAi(raw, "contest.judge", (name, delta) => void (counted[name] = (counted[name] ?? 0) + delta));
    const judge = pairJudge({ ai, models: ["@cf/judge/one"], limiter: new CallLimiter(8, 120), intent: { title: "Add a", why: "Asked for." }, hedge: hedgeFor({ FT_HEDGE: "on" }, "c1", "judge") });
    const v = judge(candidate("prp_x", "export const a = 1;\n"), candidate("prp_y", "export const a = 2;\n"));
    await vi.advanceTimersByTimeAsync(12_001);
    const verdict = await v;
    expect(verdict.better).toBe("first");
    expect(verdict.hedged).toEqual([{ after_ms: 12_000, winner: "copy", model: "@cf/judge/one", cause: "slow" }]);
    expect(verdict.why).toContain("(1 answer came from a hedge copy sent after 12.0 s)");
    expect(counted).toEqual({ "contest.judge.tokensIn:@cf/judge/one": 400, "contest.judge.tokensOut:@cf/judge/one": 4 });
    // The slow order answers at 50 s anyway: its tokens count too.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(counted).toEqual({ "contest.judge.tokensIn:@cf/judge/one": 600, "contest.judge.tokensOut:@cf/judge/one": 6 });
  });
});
