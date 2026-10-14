import type { Env } from "../env.ts";
import { publicColonies } from "../api/git-proxy.ts";
import { parseBudget } from "../mcp/budget.ts";
import { pushDelayMs } from "../trunk/direction.ts";

/**
 * GET /api/about: which build is serving (the git commit it was built from, the Worker version and its tag, when that
 * version was deployed) and which flags are on, by name only. A flag's value is never shown, and only names from the
 * lists below can appear: the same env holds the secrets, which no list here names.
 */

/**
 * Flags read like FT_REVALIDATE: "on" (every colony) or a comma-separated list of colony ids; absent, empty or "off" is
 * off. A new flag of that form goes here, or GET /api/about will not show it (test/front/about.test.ts checks env.ts).
 */
export const COLONY_FLAGS: readonly string[] = [
  "FT_ASYNC_PUBLISH",
  "FT_BISECT",
  "FT_CULPRITS",
  "FT_DELETION_GUARD",
  "FT_FIELD_GUIDE",
  "FT_GOAL_CONFLICT",
  "FT_INLINE",
  "FT_MEGAFILE",
  "FT_MERGE_INSERTIONS",
  "FT_MODEL_STEPUP",
  "FT_RESOLVER",
  "FT_REVALIDATE",
  "FT_TEXT_MERGE",
  "FT_TWINS",
  "FT_VIRTUAL_CHECKOUT",
];

/**
 * Flags with forms of their own, each with the test that says it is on, reading the value as the code that uses the
 * flag reads it (a variable can arrive as a JSON value when wrangler.jsonc writes it as a number or a boolean).
 */
export const OTHER_FLAGS: Readonly<Record<string, (value: unknown) => boolean>> = {
  FT_AGENT_CALL_BUDGET: (v) => typeof v === "string" && parseBudget(v) !== null,
  FT_IMPORT_WEIGHT: (v) => {
    const weight = typeof v === "string" || typeof v === "number" ? Number(v) : 0;
    return Number.isFinite(weight) && weight > 0;
  },
  FT_LAG_PROBE: (v) => !!v,
  FT_PUBLIC_GIT: (v) => typeof v === "string" && publicColonies(v).size > 0,
  FT_PUBLIC_MCP: (v) => typeof v === "string" && publicColonies(v).size > 0,
  FT_TEST_PUSH_DELAY_MS: (v) => typeof v === "string" && pushDelayMs(v) > 0,
  FT_TRUNK_TESTS: (v) => v === "on",
};

/** Everything else the Worker reads by an FT_ name: secrets, settings, models and tuning. Never listed. */
export const NOT_FLAGS: readonly string[] = [
  "FT_ADMIN_TOKEN",
  "FT_BUILD",
  "FT_BULK_MODEL",
  "FT_COCHANGE_WEIGHT",
  "FT_DEFAULT_MODEL",
  "FT_LATERAL_INHIBITION",
  "FT_MCP_TOKEN",
  "FT_OPEN_WRITES",
  "FT_PUBLIC_URL",
  "FT_REFLEX_MODEL",
  "FT_RESOLVER_MODEL",
];

/** What GET /api/about answers. Every field but `service` and `flags` is null when the deployment does not say. */
export interface About {
  service: "firetrident";
  /** FT_BUILD: the short git commit the deploy command passed (`--var FT_BUILD:<sha>`). */
  commit: string | null;
  /** The Worker version serving the request (the version metadata binding). */
  versionId: string | null;
  /** That version's tag (`wrangler deploy --tag`). */
  versionTag: string | null;
  /** When that version was uploaded, ISO 8601; `wrangler deploy` uploads and deploys it in one step. */
  deployedAt: string | null;
  /** The flags that are on, for every colony or for the colonies they list, by name, sorted. */
  flags: string[];
}

/** The part of the env GET /api/about reads. */
export type AboutEnv = Partial<Pick<Env, "CF_VERSION_METADATA" | "FT_BUILD">>;

const COMMIT = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;
const VERSION_ID = /^[0-9A-Za-z-]{1,64}$/;
const PRINTABLE = /^[\x20-\x7e]{1,100}$/;

/** "on", or a list naming at least one colony: on for some colony, read as core's revalidationEnabled reads it. */
function onForSome(value: unknown): boolean {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "" || s === "off") return false;
  return s === "on" || s.split(",").some((id) => id.trim() !== "");
}

/** Names of the flags that are on in `env`, sorted. Only names from COLONY_FLAGS and OTHER_FLAGS can appear. */
export function flagsOn(env: object): string[] {
  const vars = env as Record<string, unknown>;
  const on = COLONY_FLAGS.filter((name) => onForSome(vars[name]));
  for (const [name, isOn] of Object.entries(OTHER_FLAGS)) if (isOn(vars[name])) on.push(name);
  return on.sort();
}

/** Which build is serving and which flags are on, from the Worker's env. Odd or missing values become null. */
export function about(env: AboutEnv): About {
  const meta = env.CF_VERSION_METADATA;
  const commit = typeof env.FT_BUILD === "string" ? env.FT_BUILD.trim() : "";
  const id = typeof meta?.id === "string" ? meta.id.trim() : "";
  const tag = typeof meta?.tag === "string" ? meta.tag.trim() : "";
  const at = typeof meta?.timestamp === "string" ? Date.parse(meta.timestamp) : Number.NaN;
  return {
    service: "firetrident",
    commit: COMMIT.test(commit) ? commit : null,
    versionId: VERSION_ID.test(id) ? id : null,
    versionTag: PRINTABLE.test(tag) ? tag : null,
    deployedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    flags: flagsOn(env),
  };
}

/** The JSON response of GET /api/about, never cached, so a deploy shows at once. */
export function aboutResponse(env: AboutEnv): Response {
  return new Response(JSON.stringify(about(env)), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
