import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorStatus } from "../../src/agents/rpc.ts";
import { MAX_RETRY_AFTER_MS, isProviderThrottle, providerRetryAfterMs, throttleError, throttleRetryAfterMs } from "../../src/agents/throttle.ts";

/**
 * Provider throttling read the same way for every provider (agents/throttle.ts): Workers AI by its words and codes,
 * Anthropic by HTTP 429 and 529 on the AI SDK's error or on the last error a RetryError holds, with its Retry-After.
 * And the Anthropic branch of the agents' model client throws it, as the Workers AI branch always did.
 */

const generateText = vi.fn();
vi.mock("ai", () => ({ generateText: (...args: unknown[]) => generateText(...args) }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => (model: string) => ({ model }) }));

/** An AI SDK APICallError as the Anthropic provider throws it (the fields the classifier reads). */
function apiCallError(statusCode: number, message: string, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseHeaders: headers, isRetryable: true });
}

/** The AI SDK's RetryError after its own retries, holding the last error. */
function retryError(last: Error): Error {
  return Object.assign(new Error(`Failed after 3 attempts. Last error: ${last.message}`), { name: "AI_RetryError", reason: "maxRetriesExceeded", errors: [last, last, last], lastError: last });
}

describe("throttleError", () => {
  it("tags Anthropic's 529 Overloaded and 429 rate limit, directly or inside a RetryError", () => {
    for (const e of [apiCallError(529, "Overloaded"), retryError(apiCallError(529, "Overloaded")), apiCallError(429, "Number of request tokens has exceeded your per-minute limit"), retryError(apiCallError(429, "slow down"))]) {
      const t = throttleError(e, "claude-x");
      expect(errorStatus(t), e.message).toBe(429);
      expect(t.message).toMatch(/^\[ft:429\] model claude-x is throttled \(HTTP [45]29\)/);
    }
  });

  it("carries the provider's Retry-After: seconds, milliseconds or a date, held to five minutes", () => {
    const now = Date.parse("2026-10-18T10:00:00Z");
    expect(throttleRetryAfterMs(throttleError(apiCallError(429, "rate limited", { "retry-after": "30" }), "m", now))).toBe(30_000);
    expect(throttleRetryAfterMs(throttleError(retryError(apiCallError(529, "Overloaded", { "Retry-After-Ms": "1500" })), "m", now))).toBe(1_500);
    expect(providerRetryAfterMs(apiCallError(429, "x", { "retry-after": "Sat, 18 Oct 2026 10:00:20 GMT" }), now)).toBe(20_000);
    expect(providerRetryAfterMs(apiCallError(429, "x", { "retry-after": "86400" }), now)).toBe(MAX_RETRY_AFTER_MS);
    expect(providerRetryAfterMs(apiCallError(429, "x", { "retry-after": "soon" }), now)).toBeNull();
    expect(throttleRetryAfterMs(throttleError(apiCallError(529, "Overloaded"), "m"))).toBeNull();
    expect(throttleError(apiCallError(429, "x", { "retry-after": "12" }), "m").message).toContain("(the provider asks to wait 12 s)");
  });

  it("keeps Workers AI's throttles as before and leaves other failures alone", () => {
    expect(throttleError(new Error("AiError: 3040: out of capacity"), "@cf/m").message).toMatch(/^\[ft:429\] model @cf\/m is throttled: /);
    expect(throttleError(new Error("boom"), "m").message).toBe("boom");
    const bad = apiCallError(400, "prompt is too long");
    expect(throttleError(bad, "claude-x")).toBe(bad);
    expect(throttleError(retryError(apiCallError(500, "Internal server error")), "claude-x").message).not.toMatch(/\[ft:429\]/);
    // Already tagged: unchanged.
    const tagged = new Error("[ft:409] spend cap: no model call");
    expect(throttleError(tagged, "m")).toBe(tagged);
    expect(isProviderThrottle("rate limit reached")).toBe(true);
  });
});

describe("the agents' model client on Anthropic", () => {
  beforeEach(() => {
    generateText.mockReset();
  });

  it("throws a throttled call as [ft:429] with the provider's wait, as the Workers AI branch does", async () => {
    const { modelClient } = await import("../../src/agents/llm.ts");
    generateText.mockImplementation(async () => {
      throw retryError(apiCallError(529, "Overloaded", { "retry-after": "20" }));
    });
    const client = modelClient({ AI: {} as Ai, ANTHROPIC_API_KEY: "fixture-key" });
    const err = await client.complete({ model: "claude-x", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }).catch((e: unknown) => e);
    expect(errorStatus(err)).toBe(429);
    expect(throttleRetryAfterMs(err)).toBe(20_000);
  });

  it("sends no hedged copy to the model that just refused", async () => {
    const { modelClient } = await import("../../src/agents/llm.ts");
    generateText.mockImplementation(async () => {
      throw apiCallError(429, "rate limited");
    });
    const client = modelClient({ AI: {} as Ai, ANTHROPIC_API_KEY: "fixture-key" }, { site: "agent", afterMs: 60_000 });
    const err = await client.complete({ model: "claude-x", messages: [], maxTokens: 10 }).catch((e: unknown) => e);
    expect(errorStatus(err)).toBe(429);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("passes other failures through untagged", async () => {
    const { modelClient } = await import("../../src/agents/llm.ts");
    generateText.mockImplementation(async () => {
      throw apiCallError(400, "prompt is too long");
    });
    const client = modelClient({ AI: {} as Ai, ANTHROPIC_API_KEY: "fixture-key" });
    const err = await client.complete({ model: "claude-x", messages: [], maxTokens: 10 }).catch((e: unknown) => e);
    expect(errorStatus(err)).toBeNull();
    expect((err as Error).message).toBe("prompt is too long");
  });
});
