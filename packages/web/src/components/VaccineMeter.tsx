import { fmtInt, fmtPct } from "../format.ts";
import type { Vaccination } from "../store.ts";

/**
 * The vaccination meter: recall of review on deliberately seeded bad changes, with its 95%
 * interval, plus the antibodies learned from rejections. Renders whatever the colony reports.
 */
export function VaccineMeter({ v, compact = false }: { v: Vaccination; compact?: boolean }) {
  const recall = v.recall;
  const r = compact ? 17 : 22;
  const size = r * 2 + 8;
  const len = 2 * Math.PI * r;
  const frac = recall === null ? 0 : Math.max(0, Math.min(1, recall));
  const tone = recall === null ? "none" : recall >= 0.9 ? "good" : recall >= 0.7 ? "warm" : "bad";
  const caught = v.caught !== null && v.seeded !== null ? `caught ${fmtInt(Math.min(v.caught, v.seeded))} of ${fmtInt(v.seeded)}` : null;
  const ci = v.low !== null && v.high !== null ? `95% CI ${Math.round(v.low * 100)}–${Math.round(v.high * 100)}%` : null;
  const antibodies = v.antibodies !== null ? `${fmtInt(v.antibodies)} ${v.antibodies === 1 ? "antibody" : "antibodies"}${v.hits !== null ? ` · ${fmtInt(v.hits)} caught` : ""}` : v.hits !== null ? `${fmtInt(v.hits)} caught by antibodies` : null;
  const title = [
    "Vaccination: review is tested with sealed, deliberately bad changes. Recall is the share it caught.",
    caught,
    ci,
    antibodies,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className={`vaccine vaccine-${tone}${compact ? " is-compact" : ""}`} title={title}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="vaccine-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="vaccine-fill"
          style={{ strokeDasharray: len, strokeDashoffset: len * (1 - frac), transform: "rotate(-90deg)", transformOrigin: "50% 50%" }}
        />
        <text x="50%" y="50%" className="vaccine-pct" dominantBaseline="central" textAnchor="middle">
          {recall === null ? "–" : fmtPct(recall)}
        </text>
      </svg>
      <div className="vaccine-text">
        <div className="stat-k">Vaccine recall</div>
        <div className="vaccine-line">{caught ?? (recall !== null ? "on seeded bad changes" : "no seeded changes yet")}</div>
        <div className="vaccine-sub">{ci ?? antibodies ?? ""}</div>
      </div>
    </div>
  );
}
