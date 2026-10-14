import { PRICE_DATE, SPEND_LAYERS } from "@fire_trident/core";
import type { ColonySpend, ModelSpend, SpendLayer } from "@fire_trident/core";

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
  };
}
