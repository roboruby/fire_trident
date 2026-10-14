import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ErrorEnvelope } from "../agents/rpc.ts";
import { errorResult } from "./errors.ts";

/**
 * A call budget for each MCP session (FT_AGENT_CALL_BUDGET). Takes are gated and paced, and `take` and `inbox` can
 * wait on the server, but a client that ignores `wait` and loops on `inbox`, `read`, `sense` or `checkout` would
 * otherwise be limited only by the colony object it calls. Each session gets a token bucket: every tool call takes a
 * token before its tool runs, and a call that finds the bucket empty answers `rate_limit` without running, so it never
 * reaches the colony.
 *
 * The bucket lives in the session's Durable Object (FireTridentMcp), in memory: a new session, or a session object
 * started again after it went idle or after a deploy, begins with a full bucket. That costs little: an idle session's
 * bucket would have refilled anyway, and a client that never pauses keeps its object alive, so it gains at most one
 * more burst when a deploy restarts the object.
 */

/** How fast one session may call tools: tokens that come back a second, and the most it holds (its burst). */
export interface BudgetLimits {
  perSecond: number;
  burst: number;
}

/**
 * The budget "on" turns on: 4 tool calls a second, and 20 at once after a pause.
 * - An agent that follows the guides makes one call per model turn, or a few when its client sends them together, and a
 *   turn takes seconds. A whole change (join, take with wait, a read per file, propose, inbox with wait) averages well
 *   under one call a second, so four a second leaves it several times its need.
 * - Clients send several calls at once (a model turn that reads a handful of files in parallel): twenty pass back to
 *   back, and five quiet seconds refill the bucket.
 * - A loop that polls without wait gets four calls a second through to the colony, whatever its own rate: a loop
 *   polling thirty times a second has 26 of its 30 calls a second answered here, unrun, at no cost to the colony.
 */
export const DEFAULT_BUDGET: Readonly<BudgetLimits> = { perSecond: 4, burst: 20 };

/** What a refused call should do instead (the envelope's `next`). */
export const BUDGET_NEXT = "Wait retryAfterMs before calling again; take and inbox accept wait, so the server can wait for you.";

/** Slack for floating-point refill: a token that is 1e-9 short of whole after exact arithmetic counts as whole. */
const EPSILON = 1e-9;

/**
 * FT_AGENT_CALL_BUDGET: "on" for DEFAULT_BUDGET, or "<calls per second>,<burst>" (a rate above 0, and a whole burst of
 * at least 1, such as "8,40"). Absent, "off" or anything else is off (null), so a deployment without it behaves as
 * before and a typo never refuses an agent.
 */
export function parseBudget(raw: string | undefined): BudgetLimits | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "on") return { ...DEFAULT_BUDGET };
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*,\s*(\d+)$/.exec(s);
  if (!m) return null;
  const perSecond = Number(m[1]);
  const burst = Number(m[2]);
  return Number.isFinite(perSecond) && perSecond > 0 && Number.isSafeInteger(burst) && burst >= 1 ? { perSecond, burst } : null;
}

/**
 * One session's token bucket. It starts full (`burst` tokens); a call takes one; tokens come back continuously at
 * `perSecond`, never above `burst`. A refused call takes nothing. `now` is the clock (tests inject one); a clock that
 * steps back adds no tokens.
 */
export class CallBudget {
  private tokens: number;
  private last: number;

  constructor(
    readonly limits: Readonly<BudgetLimits>,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = limits.burst;
    this.last = now();
  }

  /** Take a token for one call: 0 when the call may run, otherwise the milliseconds until a token is back (at least 1). */
  take(): number {
    this.refill();
    if (this.tokens >= 1 - EPSILON) {
      this.tokens = Math.max(0, this.tokens - 1);
      return 0;
    }
    const ms = ((1 - this.tokens) * 1000) / this.limits.perSecond;
    // Half of EPSILON's worth of time comes off before rounding up, so floating-point noise never adds a millisecond
    // (from 0.996 tokens at 4 a second the wait is 1 ms, not 2), and a call made that long after still finds a token.
    return Math.max(1, Math.ceil(ms - (EPSILON * 500) / this.limits.perSecond));
  }

  /** Tokens in the bucket now (fractions included). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const t = this.now();
    if (!Number.isFinite(t) || t <= this.last) return;
    this.tokens = Math.min(this.limits.burst, this.tokens + ((t - this.last) * this.limits.perSecond) / 1000);
    this.last = t;
  }
}

/** The session budget FT_AGENT_CALL_BUDGET asks for, full, or null when it is off. */
export function callBudget(raw: string | undefined, now?: () => number): CallBudget | null {
  const limits = parseBudget(raw);
  if (!limits) return null;
  return now ? new CallBudget(limits, now) : new CallBudget(limits);
}

/** A rate as a sentence shows it: 4, 0.5, 2.25 (three significant digits at most). */
function rateText(n: number): string {
  return String(Number(n.toPrecision(3)));
}

/**
 * What a call the budget refused answers: `rate_limit`, retryable after `retryAfterMs` (the time until a token is
 * back), status 429, and the next step: wait, and let take and inbox wait on the server instead of polling.
 */
export function budgetRefusal(limits: Readonly<BudgetLimits>, retryAfterMs: number): ErrorEnvelope {
  const rate = rateText(limits.perSecond);
  return {
    kind: "rate_limit",
    message: `too many calls from this session: it may make ${rate} tool call${rate === "1" ? "" : "s"} a second, or ${limits.burst} at once after a pause, so this call was not run`,
    retryable: true,
    retryAfterMs,
    status: 429,
    next: BUDGET_NEXT,
  };
}

/** A tool handler as the SDK calls it: (args, extra), or (extra) for a tool without arguments. */
type ToolHandler = (...args: unknown[]) => unknown;

/**
 * Put every tool registered on `server` from now on behind `budget`: a call takes a token before its handler runs, and
 * a call the budget refuses answers budgetRefusal (as a failed tool call, mcp/errors.ts) without running the handler.
 * The SDK checks a call's arguments before the handler, so an unknown tool or bad arguments take no token. With no
 * budget (the flag is off) the server is left as it is. Returns the server.
 */
export function budgetTools<S extends McpServer>(server: S, budget: CallBudget | null): S {
  if (!budget) return server;
  const target = server as unknown as { registerTool: (name: string, config: unknown, cb: ToolHandler) => unknown };
  const register = target.registerTool.bind(server);
  target.registerTool = (name, config, cb) =>
    register(name, config, async (...args: unknown[]): Promise<unknown> => {
      const wait = budget.take();
      if (wait > 0) return errorResult(budgetRefusal(budget.limits, wait));
      return cb(...args);
    });
  return server;
}
