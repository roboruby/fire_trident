import { spendDetail, spendParts, type ColonySpend } from "@fire_trident/core";

/**
 * The colony's model spend beside the funnel: what its model calls cost so far and that over each landed intent. The
 * title gives it by layer and says the prices are Workers AI list prices on their date (core/pricing.ts). Hidden when
 * the colony made no model calls, or the server reports no spend.
 */
export function SpendNote({ spend }: { spend: ColonySpend | null }) {
  const parts = spendParts(spend);
  if (!parts) return null;
  return (
    <div className="spend" title={spendDetail(spend)}>
      <div className="stat-k">Model spend</div>
      <div className="spend-line">{parts.total}</div>
      {parts.perIntent ? <div className="stat-sub">{parts.perIntent}</div> : null}
    </div>
  );
}
