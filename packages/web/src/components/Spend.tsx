import { spendCapLine, spendDetail, spendParts, usdText, type ColonySpend } from "@fire_trident/core";
import { mechanicalLine } from "../spend.ts";

/**
 * The colony's model spend beside the funnel: what the model calls this platform made cost so far, that over each
 * landed intent, and the spend cap when a person set one (colony/spendcap.ts). The title gives it by layer and says the
 * prices are Workers AI list prices on their date (core/pricing.ts). Hidden when the colony made no model calls and has
 * no cap, or the server reports no spend. The cap shows as "$4.60 of $5.00 cap", its sentence in the title. Narrower
 * top bars have no room for the sentences (styles.css): below 1900 px the figure drops "of model calls this platform
 * made", and below 1460 px only a cap's short line stays; the title always has them in full.
 */
export function SpendNote({ spend }: { spend: ColonySpend | null }) {
  const parts = spendParts(spend);
  const cap = spendCapLine(spend?.cap);
  // The mechanical share: work that landed with no model call (recipes, review by reproduction), at $0.
  const mechanical = mechanicalLine(spend?.mechanical);
  if (!parts && !cap && !mechanical) return null;
  const state = spend?.cap?.state;
  // The figure and the words after it ("of model calls this platform made"), which narrow top bars leave to the title.
  const figure = parts && spend ? usdText(spend.usd) : null;
  return (
    <div className={`spend${cap ? " has-cap" : ""}${state && state !== "open" ? ` spend-cap-${state}` : ""}`} title={spendDetail(spend) || (cap ? `Spend cap: ${cap}.` : "")}>
      <div className="stat-k">Model spend</div>
      {parts && figure ? (
        <div className="spend-line spend-total">
          {figure}
          <span className="spend-scope">{parts.total.slice(figure.length)}</span>
        </div>
      ) : (
        <div className="spend-line spend-total">no model calls yet</div>
      )}
      {parts?.perIntent ? <div className="stat-sub spend-per">{parts.perIntent}</div> : null}
      {spend?.cap ? <div className="stat-sub spend-cap">{`${usdText(spend.cap.spentUsd)} of ${usdText(spend.cap.usd)} cap`}</div> : null}
      {mechanical ? <div className="stat-sub spend-mechanical">{mechanical}</div> : null}
    </div>
  );
}
