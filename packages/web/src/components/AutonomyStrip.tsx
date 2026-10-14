import { useEffect, useRef, useState } from "react";
import type { Backend } from "../api.ts";
import { autonomyView, parseAutonomy, regionName, type AutonomyReport } from "../autonomy.ts";

/** Regions listed before the strip folds the rest away. */
export const AUTONOMY_SHOWN = 5;
/** How often the strip reads the immune report again while the page is visible (the metrics poll's pace). */
const REFRESH_MS = 30_000;
/** How long after a review change (a decision, an escalation) the strip reads it again. */
const SETTLE_MS = 600;

/**
 * Earned autonomy per region: how many regions earned it, then each region's standing, the latest to move first, folded
 * past AUTONOMY_SHOWN regions; an empty state that says what earns it when nothing has been reviewed.
 */
export function AutonomyStripView({ report, now, open = false, onToggle }: { report: AutonomyReport; now: number; open?: boolean; onToggle?: () => void }) {
  const view = autonomyView(report, now);
  const rows = open ? view.rows : view.rows.slice(0, AUTONOMY_SHOWN);
  const folded = view.rows.length - AUTONOMY_SHOWN;
  return (
    <section className="autonomy" aria-label="Earned autonomy">
      <div className="autonomy-title">{view.headline}</div>
      {view.off ? <div className="autonomy-off">{view.off}</div> : null}
      {view.empty ? <div className="autonomy-sub">{view.empty}</div> : null}
      {rows.length ? (
        <ul className="autonomy-list">
          {rows.map((r) => (
            <li className="autonomy-row" key={r.region}>
              <span className="mono autonomy-region" title={r.region === "." ? "Files at the top of the repository" : undefined}>
                {regionName(r.region)}
              </span>
              <span className={`autonomy-badge is-${r.state}`}>{r.badge}</span>
              <span className="autonomy-text" title={r.proposalId}>
                {r.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {folded > 0 && onToggle ? (
        <button type="button" className="autonomy-more" aria-expanded={open} onClick={onToggle}>
          {open ? `Show the latest ${AUTONOMY_SHOWN}` : `Show all ${view.rows.length} regions`}
        </button>
      ) : null}
      <div className="autonomy-sub">{view.explain}</div>
    </section>
  );
}

/**
 * The strip on the Review tab, read from the colony's immune report (public: no token needed). Nothing where the backend
 * cannot read one (the simulator, a replay) or before the first answer; a failed read keeps the last one shown.
 */
export function AutonomyStrip({ backend, refresh }: { backend: Backend; refresh: number }) {
  const [report, setReport] = useState<AutonomyReport | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (typeof backend.immune !== "function") return;
    let live = true;
    backend.immune().then(
      (raw) => {
        if (!live) return;
        const next = parseAutonomy(raw);
        if (next) setReport(next);
        setNow(Date.now());
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [backend, round]);

  // Earning moves with landings: read again on a timer while the page is visible.
  useEffect(() => {
    if (typeof backend.immune !== "function") return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setRound((r) => r + 1);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [backend]);

  // Revocations move with review: an escalation or a person's decision reads it again soon.
  const seen = useRef(refresh);
  useEffect(() => {
    if (refresh === seen.current) return;
    seen.current = refresh;
    const timer = window.setTimeout(() => setRound((r) => r + 1), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  if (!report) return null;
  return <AutonomyStripView report={report} now={now} open={open} onToggle={() => setOpen((o) => !o)} />;
}
