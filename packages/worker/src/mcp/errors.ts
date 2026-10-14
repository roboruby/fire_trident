import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorEnvelope } from "../agents/rpc.ts";
import type { ErrorEnvelope } from "../agents/rpc.ts";

/**
 * Failed MCP tool calls, machine-readable. Every failed call of either FireTrident MCP server returns `isError: true`
 * with `structuredContent: { error }` (agents/rpc.ts ErrorEnvelope: kind, message, retryable, retryAfterMs, status,
 * next) and the same JSON as its text, so a client that only reads text still gets it, and parses it as JSON.
 */

/** Refusals whose next call is clear, matched on the status and the start of the sentence the colony or a tool wrote. */
const NEXT_CALLS: ReadonlyArray<{ status: number; sentence: RegExp; next: string }> = [
  // The intent was amended under the change (colony/direction.ts staleRevisionError): take hands it back at the new revision.
  { status: 409, sentence: /^intent revised: /, next: "Call take: it hands back this intent at its current revision. Redo the change on it, then propose again." },
  // The work went stale: the intent was withdrawn, landed or sealed, another agent holds it, or its contest was decided.
  {
    status: 409,
    sentence: /^intent withdrawn: |^intent \S+ is already (?:landed|abandoned)\b|^intent \S+ is held by another agent\b|^intent \S+: its contest was decided\b/,
    next: "Call take for other work: this intent is no longer yours to change.",
  },
  { status: 400, sentence: /^call join first\b/, next: "Call join with the colony id." },
  { status: 400, sentence: /^you hold no intent; call take first\b/, next: "Call take." },
];

/** The next call after a failure, when it is clear (a revision conflict, stale work, a missing join or take); undefined otherwise. */
export function nextCall(e: Pick<ErrorEnvelope, "status" | "message">): string | undefined {
  return NEXT_CALLS.find((n) => n.status === e.status && n.sentence.test(e.message))?.next;
}

/** A failed call's result: `isError`, the envelope as `structuredContent.error`, and the same JSON as its text. */
export function errorResult(error: ErrorEnvelope): CallToolResult {
  return { isError: true, structuredContent: { error }, content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }] };
}

/** A failed tool call from anything thrown: its envelope (agents/rpc.ts errorEnvelope), with the next call when it is clear. */
export function toolError(err: unknown, random?: () => number): CallToolResult {
  const error = errorEnvelope(err, random);
  const next = nextCall(error);
  return errorResult(next ? { ...error, next } : error);
}

/** Longest SDK sentence kept: its schema failures list the arguments to fix. */
const MAX_SDK_MESSAGE = 1_000;

/** The envelope of a failure the SDK reports on its own: a tool that does not exist (not_found), or arguments that fail its schema (validation). */
export function sdkFailure(message: string): ErrorEnvelope {
  const text = (message || "error").trim();
  const clipped = text.length > MAX_SDK_MESSAGE ? `${text.slice(0, MAX_SDK_MESSAGE - 1)}…` : text;
  if (/\bTool \S+ (?:not found|disabled)\b/.test(text)) return { kind: "not_found", message: clipped, retryable: false, status: 404 };
  return { kind: "validation", message: clipped, retryable: false, status: 400 };
}

/**
 * Give the SDK's own failed tool calls the same shape as the tools' (it answers an unknown tool, or arguments that
 * fail a tool's schema, with plain text through its createToolError). Feature-detected: an SDK without that method
 * keeps its plain text (test/mcp/errors.test.ts notices). Returns the server.
 */
export function structuredToolErrors<S extends McpServer>(server: S): S {
  const sdk = server as unknown as { createToolError?: (message: string) => CallToolResult };
  if (typeof sdk.createToolError === "function") sdk.createToolError = (message: string) => errorResult(sdkFailure(message));
  return server;
}
