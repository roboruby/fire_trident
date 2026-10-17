/**
 * Bearer tokens against the deployment's own secrets (FT_ADMIN_TOKEN for writes, the A2A door and the vaccination
 * routes; FT_MCP_TOKEN for /mcp and /sse). A secret put from a file or a pasted line can keep the line break that
 * ended it, and no header a client sends carries one, so the configured side loses the CR and LF at its ends before the
 * compare. The presented side is compared exactly as sent: trimming it would let more than one token in.
 */

/** Constant-time comparison of two secrets (compares SHA-256 digests). */
export async function tokensEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length && i < y.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** A configured secret as it is compared: without the CR and LF characters at its start and end. */
export function configuredToken(value: string): string {
  return value.replace(/^[\r\n]+|[\r\n]+$/g, "");
}

/**
 * Whether a presented bearer token is the configured secret, compared in constant time after configuredToken. A
 * secret that is only line breaks matches nothing (fail closed). Every bearer check against a deployment secret goes
 * through here.
 */
export async function bearerMatches(presented: string, configured: string): Promise<boolean> {
  const expected = configuredToken(configured);
  if (expected === "") return false;
  return tokensEqual(presented, expected);
}
