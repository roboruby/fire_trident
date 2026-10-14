import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RETRY_MAX_MS, RETRY_MIN_MS, errorEnvelope } from "../../src/agents/rpc.ts";
import type { ErrorEnvelope } from "../../src/agents/rpc.ts";
import { staleRevisionError, withdrawnError } from "../../src/colony/direction.ts";
import { ftError } from "../../src/colony/errors.ts";
import { nextCall, structuredToolErrors, toolError } from "../../src/mcp/errors.ts";
import { RETRY_RULE, SERVER_INSTRUCTIONS, serverInstructions } from "../../src/mcp/instructions.ts";

/** The text of a result, parsed as the MCP scripts parse it (JSON when it is JSON). */
function parsed(r: CallToolResult): { text: string; data: unknown } {
  const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { text, data };
}

/** A platform error as the runtime throws it: no status tag, sometimes marked retryable or overloaded. */
function platform(message: string, marks: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), marks);
}

describe("error envelopes", () => {
  it("maps each status to its kind and keeps the sentence without the tag", () => {
    const cases: Array<[number, ErrorEnvelope["kind"]]> = [
      [400, "validation"],
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [409, "conflict"],
      [413, "too_large"],
      [422, "validation"],
      [500, "server"],
      [503, "server"],
    ];
    for (const [status, kind] of cases) {
      expect(errorEnvelope(ftError(status, "what went wrong"))).toEqual({ kind, message: "what went wrong", retryable: false, status });
    }
    // Across RPC only the message survives: the tag in it is enough.
    expect(errorEnvelope(new Error("[ft:409] intent int_1 is held by another agent"))).toMatchObject({ kind: "conflict", message: "intent int_1 is held by another agent", status: 409 });
  });

  it("makes rate limits and platform failures retryable after a jittered 1 to 5 s, and nothing else", () => {
    expect(errorEnvelope(ftError(429, "model is throttled"), () => 0)).toEqual({ kind: "rate_limit", message: "model is throttled", retryable: true, retryAfterMs: RETRY_MIN_MS, status: 429 });
    for (const message of ["Durable Object is overloaded. Too many requests queued.", "Network connection lost.", "internal error; reference = 3ab9c0f1d2e4", "Durable Object reset because its code was updated."]) {
      const e = errorEnvelope(platform(message), () => 0.5);
      expect(e).toEqual({ kind: "unavailable", message, retryable: true, retryAfterMs: 3_000 });
      expect(e).not.toHaveProperty("status");
    }
    expect(errorEnvelope(platform("Network connection lost."), () => 0).retryAfterMs).toBe(RETRY_MIN_MS);
    expect(errorEnvelope(platform("Network connection lost."), () => 0.999999).retryAfterMs).toBe(RETRY_MAX_MS);
    for (let i = 0; i < 50; i++) {
      const after = errorEnvelope(platform("Network connection lost.")).retryAfterMs ?? 0;
      expect(after).toBeGreaterThanOrEqual(RETRY_MIN_MS);
      expect(after).toBeLessThanOrEqual(RETRY_MAX_MS);
    }
    // The runtime's own marks count, whatever the words.
    expect(errorEnvelope(platform("something transient", { retryable: true }))).toMatchObject({ kind: "unavailable", retryable: true });
    expect(errorEnvelope(platform("too busy", { overloaded: true }))).toMatchObject({ kind: "unavailable", retryable: true });
    // An object still on the previous deployment: retry after the API's 30 s.
    const upgrading = errorEnvelope(platform("The RPC receiver does not implement the method \"escalate\"."), () => 0);
    expect(upgrading).toMatchObject({ kind: "unavailable", retryable: true, retryAfterMs: 30_000 });
    // A bug of ours is a server failure: retrying does not help.
    expect(errorEnvelope(new TypeError("Cannot read properties of undefined (reading 'id')"))).toEqual({
      kind: "server",
      message: "Cannot read properties of undefined (reading 'id')",
      retryable: false,
    });
    // A tag wins over words that look like a platform failure.
    expect(errorEnvelope(ftError(400, "Network connection lost? no: a bad path"))).toMatchObject({ kind: "validation", retryable: false });
    expect(errorEnvelope("a thrown string")).toMatchObject({ kind: "server", message: "a thrown string" });
  });

  it("names the next call only where it is clear", () => {
    expect(nextCall({ status: 409, message: staleRevisionError("int_1", 1, 2, ["why"], "the spec changed") })).toMatch(/^Call take: it hands back this intent at its current revision/);
    expect(nextCall({ status: 409, message: withdrawnError("int_1", "not needed") })).toMatch(/^Call take for other work/);
    expect(nextCall({ status: 409, message: "intent int_1 is held by another agent" })).toMatch(/^Call take for other work/);
    expect(nextCall({ status: 409, message: "intent int_1 is already landed" })).toMatch(/^Call take for other work/);
    expect(nextCall({ status: 409, message: "intent int_1: its contest was decided (prp_2 won); stop work on it and take other work" })).toMatch(/^Call take for other work/);
    expect(nextCall({ status: 400, message: "call join first" })).toBe("Call join with the colony id.");
    expect(nextCall({ status: 400, message: "you hold no intent; call take first" })).toBe("Call take.");
    // Not clear, so not named: another conflict, the same words under another status, a validation failure.
    expect(nextCall({ status: 409, message: "intent int_1 already has a report waiting for a person" })).toBeUndefined();
    expect(nextCall({ status: 400, message: "intent revised: int_1 is at r2" })).toBeUndefined();
    expect(nextCall({ status: 400, message: "headSha must be a full 40-character commit id" })).toBeUndefined();
  });
});

describe("failed MCP tool calls", () => {
  it("carry the envelope as structured content and the same JSON as text, which the MCP scripts parse", () => {
    const r = toolError(new Error(`[ft:409] ${staleRevisionError("int_1", 1, 3, ["title"], "renamed")}`));
    expect(r.isError).toBe(true);
    const error = (r.structuredContent as { error: ErrorEnvelope }).error;
    expect(error).toMatchObject({ kind: "conflict", status: 409, retryable: false, next: expect.stringMatching(/^Call take/) });
    expect(error.message).toMatch(/^intent revised: int_1 is at r3/);
    // scripts/mcp_round3.ts and mcp_round4.ts: ok = isError !== true, data = JSON.parse(text) when it parses.
    const { text, data } = parsed(r);
    expect(data).toEqual({ error });
    expect(text).toContain("intent revised");
    // A platform failure says when to retry.
    const busy = toolError(platform("Durable Object is overloaded. Too many requests queued."), () => 1);
    expect(parsed(busy).data).toEqual({ error: { kind: "unavailable", message: "Durable Object is overloaded. Too many requests queued.", retryable: true, retryAfterMs: RETRY_MAX_MS } });
  });

  it("give the SDK's own failures (an unknown tool, arguments that fail the schema) the same shape", async () => {
    const server = structuredToolErrors(new McpServer({ name: "t", version: "0" }));
    server.registerTool("echo", { description: "echo", inputSchema: { word: z.string().min(1) } }, async (a) => ({ content: [{ type: "text", text: a.word }] }));
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const bad = (await client.callTool({ name: "echo", arguments: { word: 7 } })) as CallToolResult;
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as { error: ErrorEnvelope }).error).toMatchObject({ kind: "validation", status: 400, retryable: false });
    expect(parsed(bad).data).toEqual(bad.structuredContent);
    const missing = (await client.callTool({ name: "declare", arguments: {} })) as CallToolResult;
    expect((missing.structuredContent as { error: ErrorEnvelope }).error).toMatchObject({ kind: "not_found", status: 404, retryable: false });
    expect((missing.structuredContent as { error: ErrorEnvelope }).error.message).toContain("Tool declare not found");
    const good = (await client.callTool({ name: "echo", arguments: { word: "hi" } })) as CallToolResult;
    expect(good.isError).toBeFalsy();
    await client.close();
  });

  it("tells every client to retry only retryable errors, after retryAfterMs", () => {
    expect(RETRY_RULE).toMatch(/retry it only when error\.retryable is true, after error\.retryAfterMs/);
    expect(SERVER_INSTRUCTIONS).toContain(RETRY_RULE);
    expect(serverInstructions(true)).toContain(RETRY_RULE);
  });
});
