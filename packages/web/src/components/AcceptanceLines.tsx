import type { AcceptanceRow } from "../acceptance.ts";
import { shortId } from "../format.ts";
import { FIELD_COLOR } from "../theme.ts";

/** The color of each verdict's chip: met as a trail, not met as a failure, unclear as a need. */
const VERDICT_COLOR: Readonly<Record<AcceptanceRow["verdict"], string>> = {
  met: FIELD_COLOR.trail,
  "not met": FIELD_COLOR.danger,
  unclear: FIELD_COLOR.need,
};

/**
 * Under a second opinion's decision (FT_QUOTED_ACCEPTANCE): each acceptance line with what counted for it and the
 * changed line quoted for it, so a person can check which line meets which criterion; a line stating an absence has no
 * such line, and is marked as met on the model's word; a line FireTrident checked itself in the files (the review view) is
 * marked checked by FireTrident, with what it found. Nothing when there are none.
 */
export function AcceptanceLines({ rows }: { rows: AcceptanceRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="dec-answer">
      {rows.map((r, i) => (
        <div className="lin-dir-row" key={`${r.place}-${i}`}>
          <span className="lin-chip" style={{ color: VERDICT_COLOR[r.verdict] }}>
            {r.verdict}
          </span>
          <b>{r.place}</b> {r.line}
          {r.landingId ? <span className="lin-dir-when"> · from landing {shortId(r.landingId)}</span> : null}
          {r.verdict === "met" && r.basis === "absence" ? (
            <span className="lin-dir-why">{"model's word (it states an absence, so there is no changed line to quote)"}</span>
          ) : r.verdict === "met" && r.basis === "checked" ? (
            <span className="lin-dir-why" title={r.path}>
              checked by FireTrident
              {r.quote ? <span className="mono">{`: ${r.path ? `${r.path}: ` : ""}${r.quote}`}</span> : null}
            </span>
          ) : r.verdict === "met" && r.quote ? (
            <span className="lin-dir-why mono" title={r.path}>
              {r.path ? `${r.path}: ` : ""}
              {r.quote}
            </span>
          ) : r.why ? (
            <span className="lin-dir-why">{r.why}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
