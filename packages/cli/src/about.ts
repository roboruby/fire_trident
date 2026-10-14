import type { ApiRequest } from "./api.ts";
import { ago } from "./format.ts";
import type { Colors } from "./format.ts";

/**
 * Which build the server runs, from GET /api/about (packages/worker/src/front/about.ts): `ft status` ends with it, so a
 * summary always says which code produced it.
 */

/** The call `ft status` makes after its summary (public, no token needed). */
export const ABOUT_REQUEST: ApiRequest = { method: "GET", path: "/api/about" };

/** What GET /api/about answers; every field may be missing on an odd or older server. */
export interface AboutLike {
  commit?: string | null;
  versionId?: string | null;
  versionTag?: string | null;
  deployedAt?: string | null;
  flags?: string[];
}

/** A short single-line string from the server, or null. */
function word(x: unknown, max: number): string | null {
  return typeof x === "string" && x.trim() !== "" && x.length <= max && !/[\u0000-\u001f\u007f-\u009f\s]/.test(x.trim()) ? x.trim() : null;
}

/**
 * The `build` row of `ft status`: "build      f9c7aad · firetrident.com · deployed 2h ago". Without a commit it names
 * the Worker version; null when the server says neither (an older server answers 404, which `ft status` skips).
 */
export function buildRow(about: AboutLike | undefined, baseUrl: string, c: Colors, now: number): string | null {
  if (!about || typeof about !== "object") return null;
  const commit = word(about.commit, 40);
  const version = word(about.versionId, 64);
  if (!commit && !version) return null;
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // keep the base URL as given
  }
  const at = typeof about.deployedAt === "string" ? Date.parse(about.deployedAt) : Number.NaN;
  const parts = [commit ? c.bold(commit) : `version ${version?.slice(0, 8)}`, host];
  if (Number.isFinite(at)) parts.push(`deployed ${ago(at, now)}`);
  return `${c.dim("build".padEnd(11))}${parts.join(c.dim(" · "))}`;
}
