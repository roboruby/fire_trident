import type { ColonySpend } from "@fire_trident/core";

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
