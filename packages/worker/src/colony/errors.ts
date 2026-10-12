/**
 * Errors that keep their HTTP status across Durable Object RPC.
 *
 * RPC preserves an error's message but not its class or extra fields, so the
 * status travels inside the message as a `[ft:NNN]` tag that the API strips.
 */

const TAG = /\[ft:(\d{3})\]\s*/;

/** Build an error carrying an HTTP status (404, 409, ...) that survives RPC. */
export function ftError(status: number, message: string): Error {
  return new Error(`[ft:${status}] ${message}`);
}

/** Decode an error (possibly re-thrown by RPC) into a status and a clean message. */
export function decodeError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const m = TAG.exec(raw);
  if (!m) return { status: 500, message: raw || "internal error" };
  return { status: Number(m[1]), message: raw.slice((m.index ?? 0) + m[0].length) || "error" };
}

/** Short error text for logs and reasons (never throws). */
export function errorText(err: unknown): string {
  const { message } = decodeError(err);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}
