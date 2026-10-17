import { PRICE_DATE, SPEND_LAYERS } from "@fire_trident/core";
import type { ColonySpend, Id, IntentSpendBrief, ModelSpend, SpendCap, SpendLayer } from "@fire_trident/core";

/**
 * A colony's model spend as the server reports it (`spend` on GET /api/colonies/:id and /metrics), read defensively:
 * the reply crosses the network as plain JSON, and an older server sends none. The top bar and the landing page's
 * result cards show it through core/pricing.ts (spendLine, spendDetail).
 */

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Token counts by model from a record of `{ input, output }` (anything else left out). */
function tokensByModel(raw: unknown): Record<string, { input: number; output: number }> {
  return Object.fromEntries(
    Object.entries(isObj(raw) ? raw : {})
      .filter((e): e is [string, Record<string, unknown>] => isObj(e[1]))
      .map(([m, t]) => [m, { input: num(t.input), output: num(t.output) }]),
  );
}

/** The colony's spend cap in `raw` (`spend.cap`, colony/spendcap.ts), or null when there is none or it does not read as one. */
export function parseSpendCap(raw: unknown): SpendCap | null {
  if (!isObj(raw) || typeof raw.usd !== "number" || !Number.isFinite(raw.usd) || !(raw.usd > 0)) return null;
  const state = raw.state === "review-only" || raw.state === "spent" ? raw.state : "open";
  return {
    usd: raw.usd,
    reviewReserveUsd: num(raw.reviewReserveUsd),
    spentUsd: num(raw.spentUsd),
    inFlightUsd: num(raw.inFlightUsd),
    state,
    setBy: typeof raw.setBy === "string" ? raw.setBy.slice(0, 100) : "",
    setAt: num(raw.setAt),
  };
}

/** The spend report in `raw`, or null when there is none (an older server, a mock or a replay). */
export function parseSpend(raw: unknown): ColonySpend | null {
  if (!isObj(raw) || typeof raw.usd !== "number" || !Number.isFinite(raw.usd) || !isObj(raw.tokens)) return null;
  const layers = isObj(raw.byLayer) ? raw.byLayer : {};
  const byLayer = Object.fromEntries(SPEND_LAYERS.map((l) => [l, num(layers[l])])) as Record<SpendLayer, number>;
  // Object.fromEntries defines own properties, so no model id can reach a prototype.
  const byModel: Record<string, ModelSpend> = Object.fromEntries(
    Object.entries(isObj(raw.byModel) ? raw.byModel : {})
      .filter((e): e is [string, Record<string, unknown>] => isObj(e[1]))
      .map(([m, t]) => [m, { input: num(t.input), output: num(t.output), usd: typeof t.usd === "number" && Number.isFinite(t.usd) ? t.usd : null }]),
  );
  const per = raw.perLandedIntent;
  const unread = num(raw.agentsUnread);
  const cap = parseSpendCap(raw.cap);
  return {
    usd: num(raw.usd),
    byLayer,
    perLandedIntent: typeof per === "number" && Number.isFinite(per) ? per : null,
    landedIntents: num(raw.landedIntents),
    tokens: { input: num(raw.tokens.input), output: num(raw.tokens.output) },
    byModel,
    unpriced: tokensByModel(raw.unpriced),
    priceDate: typeof raw.priceDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.priceDate) ? raw.priceDate : PRICE_DATE,
    ...(unread > 0 ? { agentsUnread: unread } : {}),
    ...(cap ? { cap } : {}),
  };
}

/** An intent's spend in its short form (IntentSpendBrief), read defensively, or null when `raw` is not one. */
export function parseIntentSpendBrief(raw: unknown): IntentSpendBrief | null {
  if (!isObj(raw) || typeof raw.usd !== "number" || !Number.isFinite(raw.usd) || !isObj(raw.tokens)) return null;
  const layers = isObj(raw.byLayer) ? raw.byLayer : {};
  const byLayer: IntentSpendBrief["byLayer"] = {};
  for (const l of SPEND_LAYERS) {
    const v = layers[l];
    if (isObj(v)) byLayer[l] = { usd: num(v.usd), calls: Math.floor(num(v.calls)) };
  }
  const out: IntentSpendBrief = { usd: num(raw.usd), byLayer, tokens: { input: num(raw.tokens.input), output: num(raw.tokens.output) } };
  if (raw.unpriced === true) out.unpriced = true;
  return out;
}

/**
 * The spend per intent in `raw` (`intentSpend` on GET /api/colonies/:id and /metrics), by intent id, or null when there
 * is none (a server without it, a colony that counts nothing per intent, a mock or a replay). Entries that do not read
 * as an intent's spend are left out.
 */
export function parseIntentSpendMap(raw: unknown): Map<Id, IntentSpendBrief> | null {
  if (!isObj(raw)) return null;
  const out = new Map<Id, IntentSpendBrief>();
  for (const [id, v] of Object.entries(raw)) {
    const brief = parseIntentSpendBrief(v);
    if (brief) out.set(id, brief);
  }
  return out;
}
