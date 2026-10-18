/**
 * A provider refusing work it may not take right now, read the same way whichever provider serves the model. Workers
 * AI says so in its error message: the per-account, per-model request rate (3021; models that need Workers Paid get 20
 * requests a minute) or a lack of capacity (3040). Anthropic answers HTTP 429 (rate limit) or 529 (overloaded), often
 * with a Retry-After header; the AI SDK retries twice on its own and then throws the call's APICallError, or a
 * RetryError whose last error is one. Either way the call fails with one `[ft:429]` error carrying the provider's wait
 * when it gave one (throttleRetryAfterMs), so the agent loop waits (loop.ts throttled) instead of counting a failure.
 */

/** Messages that mean the provider throttled the call (Workers AI's codes and words, Anthropic's "Overloaded"). */
const THROTTLED = /rate limit|\b3021\b|\b3040\b|out of capacity|too many requests|\b429\b|overloaded/i;
/** HTTP statuses that mean the provider throttled the call: 429 (rate limit) and 529 (Anthropic is overloaded). */
const THROTTLED_STATUS: ReadonlySet<number> = new Set([429, 529]);
/** Errors walked at most through `lastError` and `cause` (a cycle in odd error objects ends the walk). */
const MAX_CHAIN = 4;
/** The longest provider wait a throttled step honors (a misread date must not park an agent for hours). */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** A `[ft:429]` error with the wait the provider asked for, when it asked for one. */
export interface ThrottleError extends Error {
  retryAfterMs?: number;
}

type ErrorLike = { statusCode?: unknown; responseHeaders?: unknown; lastError?: unknown; cause?: unknown; message?: unknown };

/** The error and the errors it wraps (an AI SDK RetryError's last error, a cause), nearest first. */
function chain(e: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let cur: unknown = e;
  while (cur !== null && typeof cur === "object" && out.length < MAX_CHAIN && !out.includes(cur as ErrorLike)) {
    const x = cur as ErrorLike;
    out.push(x);
    cur = x.lastError ?? x.cause;
  }
  return out;
}

/** The first HTTP status an error or the errors it wraps report, or null. */
export function providerStatus(e: unknown): number | null {
  for (const x of chain(e)) if (typeof x.statusCode === "number" && Number.isFinite(x.statusCode)) return x.statusCode;
  return null;
}

/** One response header, case-insensitively, from the plain record the AI SDK keeps (or a Headers object). */
function header(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      const v = (headers as { get(n: string): unknown }).get(name);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (k.toLowerCase() === name && typeof v === "string") return v;
  return null;
}

/**
 * The wait a throttled provider asked for, in ms: `retry-after-ms`, else `retry-after` as seconds or an HTTP date, from
 * the error or the errors it wraps; held to MAX_RETRY_AFTER_MS. Null when it asked for none, or the value does not read.
 */
export function providerRetryAfterMs(e: unknown, now: number = Date.now()): number | null {
  for (const x of chain(e)) {
    const ms = header(x.responseHeaders, "retry-after-ms");
    if (ms !== null && ms.trim() !== "" && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(ms)));
    const after = header(x.responseHeaders, "retry-after");
    if (after === null || after.trim() === "") continue;
    const seconds = Number(after.trim());
    if (Number.isFinite(seconds)) {
      if (seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
      continue;
    }
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
  }
  return null;
}

/** Whether a failed model call was the provider throttling it: by status (429, 529) anywhere in the chain, or by its words. */
export function isProviderThrottle(e: unknown): boolean {
  const status = providerStatus(e);
  if (status !== null && THROTTLED_STATUS.has(status)) return true;
  return chain(e).some((x) => typeof x.message === "string" && THROTTLED.test(x.message)) || (typeof e === "string" && THROTTLED.test(e));
}

/**
 * The error to throw for a failed model call: tagged `[ft:429]`, with the provider's wait (retryAfterMs) when it gave
 * one, when the provider throttled it; anything else as it was. An error already tagged `[ft:NNN]` passes unchanged.
 */
export function throttleError(e: unknown, model: string, now: number = Date.now()): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/^\[ft:\d{3}\]/.test(msg) || !isProviderThrottle(e)) return e instanceof Error ? e : new Error(msg);
  const wait = providerRetryAfterMs(e, now);
  const status = providerStatus(e);
  const asked = wait !== null ? ` (the provider asks to wait ${Math.ceil(wait / 1000)} s)` : "";
  const out: ThrottleError = new Error(`[ft:429] model ${model} is throttled${status !== null ? ` (HTTP ${status})` : ""}${asked}: ${msg.slice(0, 200)}`);
  if (wait !== null) out.retryAfterMs = wait;
  return out;
}

/** The wait a throttle error carries from its provider (throttleError), or null. */
export function throttleRetryAfterMs(e: unknown): number | null {
  const v = e && typeof e === "object" ? (e as ThrottleError).retryAfterMs : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(MAX_RETRY_AFTER_MS, v) : null;
}
