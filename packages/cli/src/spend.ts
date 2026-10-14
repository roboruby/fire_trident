import type { ColonySpend, IntentSpend, SpendLayer } from "@fire_trident/core";

/**
 * The spend line of `ft status`: what the colony's model calls cost so far, as the colony priced them (`spend` on GET
 * /api/colonies/:id). The published CLI carries no runtime code from the core package, so this mirrors core/pricing.ts
 * (usdText and spendLine); test/spend.test.ts holds the two to the same text.
 */

/** A whole, non-negative token count (anything else reads as 0). */
function tokens(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Dollars as FireTrident shows them: four decimals below one cent, three below a dollar, else two ("$0.0002", "$0.042", "$1.25"). */
export function usdText(usd: number): string {
  const v = typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : 0;
  return `$${v.toFixed(v < 0.01 ? 4 : v < 1 ? 3 : 2)}`;
}

/** "$0.042 of model calls · $0.0001 a landed intent" (without the second half when no intent landed), or null when the colony made no model calls or reports no spend. */
export function spendLine(spend: ColonySpend | null | undefined): string | null {
  if (!spend || typeof spend.usd !== "number" || !spend.tokens || tokens(spend.tokens.input) + tokens(spend.tokens.output) === 0) return null;
  const some = Object.keys(spend.unpriced ?? {}).length > 0 ? " (some unpriced)" : "";
  const total = `${usdText(spend.usd)} of model calls${some}`;
  const per = spend.perLandedIntent;
  return typeof per === "number" && Number.isFinite(per) ? `${total} · ${usdText(per)} a landed intent` : total;
}

/** True when any token was counted for the intent (the server sends `spend` on GET /intents/:iid only then; a reply from an older server has none). */
function spentOnIntent(spend: IntentSpend | null | undefined): spend is IntentSpend {
  return !!spend && typeof spend.usd === "number" && !!spend.tokens && tokens(spend.tokens.input) + tokens(spend.tokens.output) > 0;
}

/** "$0.0004 of model calls" (with " (some unpriced)" when a model had no list price), or null when nothing was counted for the intent. */
export function intentSpendLine(spend: IntentSpend | null | undefined): string | null {
  if (!spentOnIntent(spend)) return null;
  const some = Object.keys(spend.unpriced ?? {}).length > 0 ? " (some unpriced)" : "";
  return `${usdText(spend.usd)} of model calls${some}`;
}

/** The layers in the order every report lists them, as core/pricing.ts reads them in a sentence. */
const LAYERS: ReadonlyArray<[SpendLayer, string]> = [
  ["agents", "agents"],
  ["review", "review"],
  ["judge", "contest judge"],
  ["resolver", "conflict resolver"],
  ["other", "other"],
];

/**
 * The intent's spend by layer with each layer's calls, its tokens and where the prices come from, in one sentence, as
 * core/pricing.ts intentSpendDetail writes it. Empty when nothing was counted for the intent.
 */
export function intentSpendDetail(spend: IntentSpend | null | undefined): string {
  if (!spentOnIntent(spend)) return "";
  const n = (x: number): string => tokens(x).toLocaleString("en-US");
  const parts: string[] = [];
  for (const [l, text] of LAYERS) {
    const usd = typeof spend.byLayer?.[l] === "number" && spend.byLayer[l] > 0 ? spend.byLayer[l] : 0;
    const calls = tokens(spend.calls?.[l]);
    if (calls === 0 && !(usd > 0)) continue;
    parts.push(`${text} ${usdText(usd)} in ${n(calls)} call${calls === 1 ? "" : "s"}`);
  }
  const unpriced = Object.keys(spend.unpriced ?? {}).length > 0 ? "; some tokens had no list price and count in no dollar sum" : "";
  const date = typeof spend.priceDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(spend.priceDate) ? ` on ${spend.priceDate}` : "";
  return `${parts.length ? `${parts.join(", ")}; ` : ""}${n(spend.tokens.input)} input and ${n(spend.tokens.output)} output tokens at Workers AI list prices${date}${unpriced}.`;
}
