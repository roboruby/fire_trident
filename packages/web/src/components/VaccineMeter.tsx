import { fmtInt, fmtPct } from "../format.ts";
import type { Vaccination } from "../store.ts";
import { ROUTED_LABEL } from "../vaccineRouting.ts";

/**
 * The vaccination meter: the share of deliberately seeded bad changes review routed away from landing,
 * with its 95% interval, plus the antibodies learned from rejections. Renders whatever the colony
 * reports. The share counts both the changes a model or a check returned and the ones sent to a person
 * (whose own catch is not measured), so it is called routing, not recall (vaccineRouting.ts); when the
 * colony reports the split, the two are shown apart, on the ring and in words.
 */
export function VaccineMeter({ v, compact = false }: { v: Vaccination; compact?: boolean }) {
  const recall = v.recall;
  const r = compact ? 17 : 22;
  const size = r * 2 + 8;
  const len = 2 * Math.PI * r;
  const frac = recall === null ? 0 : Math.max(0, Math.min(1, recall));
  const tone = recall === null ? "none" : recall >= 0.9 ? "good" : recall >= 0.7 ? "warm" : "bad";
  const split = v.escalated !== null && v.returned !== null ? { escalated: v.escalated, returned: v.returned } : null;
  const n = v.seeded !== null && v.seeded > 0 ? v.seeded : null;
  // With the split, the ring's solid part is what a model or a check returned; the rest of the catch went to a person.
  const solid = split && n ? Math.min(1, split.returned / n) : frac;
  const person = split && n ? Math.max(0, Math.min(1 - solid, split.escalated / n)) : 0;
  const routed = v.caught !== null && v.seeded !== null ? `routed ${fmtInt(Math.min(v.caught, v.seeded))} of ${fmtInt(v.seeded)}` : null;
  const ci = v.low !== null && v.high !== null ? `95% CI ${Math.round(v.low * 100)}–${Math.round(v.high * 100)}%` : null;
  const antibodies = v.antibodies !== null ? `${fmtInt(v.antibodies)} ${v.antibodies === 1 ? "antibody" : "antibodies"}${v.hits !== null ? ` · ${fmtInt(v.hits)} caught` : ""}` : v.hits !== null ? `${fmtInt(v.hits)} caught by antibodies` : null;
  const line = split ? `${fmtInt(split.returned)} returned · ${fmtInt(split.escalated)} to a person` : routed;
  const sub = split && n ? [`of ${fmtInt(n)}`, ci].filter(Boolean).join(" · ") : (ci ?? antibodies ?? "");
  const title = [
    split
      ? "Vaccination: review is tested with sealed, deliberately bad changes. The share routed away from landing counts both kinds below: returned by a model or a check, and sent to a person."
      : "Vaccination: review is tested with sealed, deliberately bad changes. The share is how many review routed away from landing.",
    routed,
    split ? `Returned by a model or a check: ${fmtInt(split.returned)}.` : null,
    split ? `Sent to a person: ${fmtInt(split.escalated)}. Whether the person would catch them is not measured.` : null,
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
          style={{ strokeDasharray: len, strokeDashoffset: len * (1 - solid), transform: "rotate(-90deg)", transformOrigin: "50% 50%" }}
        />
        {person > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            className="vaccine-fill vaccine-fill-person"
            style={{ strokeDasharray: len, strokeDashoffset: len * (1 - person), transform: `rotate(${-90 + 360 * solid}deg)`, transformOrigin: "50% 50%" }}
          />
        ) : null}
        <text x="50%" y="50%" className="vaccine-pct" dominantBaseline="central" textAnchor="middle">
          {recall === null ? "–" : fmtPct(recall)}
        </text>
      </svg>
      <div className="vaccine-text">
        <div className="stat-k">{ROUTED_LABEL}</div>
        <div className="vaccine-line">{line ?? (recall !== null ? "on seeded bad changes" : "no seeded changes yet")}</div>
        <div className="vaccine-sub">{sub}</div>
      </div>
    </div>
  );
}
