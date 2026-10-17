import { useEffect, useState } from "react";
import { splitRows, valueNumber, type DecidesReport, type LandingConfirmation } from "@fire_trident/core";
import { presetName, readDecides, splitSummary, type DecidesState } from "../decides.ts";
import { fmtInt } from "../format.ts";
import "./decides.css";

/**
 * How a colony decides, read-only (decides.ts, core/decides.ts): a line in the first screen's target panel, the card
 * (the preset the colony's decide policy equals or how it differs, what it lets land without a person, the last 30 days
 * of landed changes by what confirmed them, the four presets and the settings), and each landing card's confirming rule
 * with the values it used. Nothing here changes the policy: that stays an admin action through the policy route.
 */

/** How often a live page reads the report again (the policy changes rarely; the split moves with landings). */
const REFRESH_MS = 60_000;

/** The colony's report, read when the page opens and every minute on a live page (an answer that fails keeps the last one). */
export function useDecides(colonyId: string, mode: "live" | "mock" | "replay"): DecidesState {
  const [d, setD] = useState<DecidesState>({ state: "loading" });
  useEffect(() => {
    let live = true;
    const read = () => {
      if (typeof document !== "undefined" && document.hidden && mode === "live") return;
      void readDecides(colonyId, mode).then((next) => {
        if (live) setD((cur) => (next.state === "unknown" && cur.state === "loaded" ? cur : next));
      });
    };
    read();
    const timer = mode === "live" ? window.setInterval(read, REFRESH_MS) : 0;
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [colonyId, mode]);
  return d;
}

/** A setting's value as the card writes it. */
function setting(v: number | boolean): string {
  return typeof v === "boolean" ? (v ? "on" : "off") : valueNumber(v);
}

/** The target panel's row: the preset and the 30-day split in one line, or why it is not known. */
export function DecidesRow({ d }: { d: DecidesState }) {
  return (
    <>
      <dt>Decides</dt>
      <dd title={d.state === "loaded" ? `${d.report.lets}\n${d.report.always}` : undefined}>
        {d.state === "loading" ? (
          <span className="fs-none">reading how it decides…</span>
        ) : d.state === "unknown" ? (
          <span className="fs-none">not known: {d.why}</span>
        ) : (
          <>
            <b className={d.report.preset === "custom" ? "dc-custom" : undefined}>{presetName(d.report)}</b>
            <span className="fs-dim"> · {splitSummary(d.report)}</span>
          </>
        )}
      </dd>
    </>
  );
}

/** The split as a bar and a legend: each kind's count and share of the changes that landed in the window. */
export function SplitBar({ report }: { report: DecidesReport }) {
  const rows = splitRows(report.split);
  const s = report.split;
  return (
    <div className="dc-split">
      <div className="dc-split-head">
        Last {s.days} days: <b>{fmtInt(s.total)}</b> {s.total === 1 ? "change" : "changes"} landed
      </div>
      {s.total > 0 ? (
        <div className="dc-bar" role="img" aria-label={rows.map((r) => `${r.label} ${r.count} (${r.percent}%)`).join(", ")}>
          {rows
            .filter((r) => r.count > 0)
            .map((r) => (
              <i key={r.kind} className={`dc-seg is-${r.kind}`} style={{ flexGrow: r.count }} title={`${r.label}: ${fmtInt(r.count)} (${r.percent}%)`} />
            ))}
        </div>
      ) : null}
      <ul className="dc-legend">
        {rows.map((r) => (
          <li key={r.kind} className={`is-${r.kind}${r.count === 0 ? " is-zero" : ""}`}>
            <span className="dc-dot" aria-hidden="true" />
            {r.label} <b>{fmtInt(r.count)}</b>
            {s.total > 0 ? <span className="dc-pct">{r.percent}%</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The card: the preset, what it lets land without a person, the split, then (opened) the four presets and the settings. */
export function DecidesCard({ d, colonyId }: { d: DecidesState; colonyId: string }) {
  if (d.state !== "loaded") {
    return (
      <section className="dc is-empty" aria-label="How this colony decides">
        <div className="dc-head">
          <span className="dc-k">How this colony decides</span>
        </div>
        <p className="dc-dim">{d.state === "loading" ? "Reading the colony's decide policy…" : `Not known: ${d.why}.`}</p>
      </section>
    );
  }
  const r = d.report;
  const custom = r.preset === "custom";
  const current = custom ? null : r.preset;
  return (
    <section className="dc" aria-label="How this colony decides">
      <div className="dc-head">
        <span className="dc-k">How this colony decides</span>
        <span className={`dc-preset${custom ? " is-custom" : ""}`}>{presetName(r)}</span>
      </div>
      {r.reviewing ? null : <p className="dc-warn">Review is off now: changes go to their lanes without the gate, except those a protected path or tests before landing hold.</p>}
      <p className="dc-lets">{r.lets}</p>
      {custom && r.differs.length > 0 ? (
        <ul className="dc-differs" aria-label="Where the policy differs from the nearest preset">
          {r.differs.map((x) => (
            <li key={x.field}>
              {x.label} <b>{setting(x.value)}</b> <span className="dc-dim">(preset {setting(x.preset)})</span>
            </li>
          ))}
        </ul>
      ) : null}
      <SplitBar report={r} />
      {/* The audit sample (worker colony/audit.ts): what people found when they looked at landings without a person. */}
      {r.audit ? (
        <p className="dc-audit">
          {r.audit.line}
          {r.audit.canaries && r.audit.canaries !== "canaries off" ? <span className="dc-dim"> · {r.audit.canaries}</span> : null}
        </p>
      ) : null}
      <details className="dc-more">
        <summary>The four presets and this colony&apos;s settings</summary>
        <ol className="dc-presets">
          {r.presets.map((p) => (
            <li key={p.name} className={p.name === current ? "is-current" : p.name === r.nearest && custom ? "is-nearest" : undefined}>
              <b>{p.label}</b>
              {p.name === current ? <span className="dc-tag">this colony</span> : p.name === r.nearest && custom ? <span className="dc-tag">nearest</span> : null}
              <span className="dc-lets-small">{p.lets}</span>
            </li>
          ))}
        </ol>
        <dl className="dc-settings">
          {r.settings.map((x) => (
            <div key={x.field} className={r.differs.some((y) => y.field === x.field) ? "is-diff" : undefined}>
              <dt>{x.label}</dt>
              <dd className="mono">{setting(x.value)}</dd>
            </div>
          ))}
          <div>
            <dt>protected paths</dt>
            <dd className="mono">{fmtInt(r.protectedPaths)}</dd>
          </div>
          <div>
            <dt>danger classes allowed</dt>
            <dd className="mono">{fmtInt(r.dangerAllow)}</dd>
          </div>
        </dl>
        <p className="dc-dim">{r.always}</p>
        <p className="dc-dim">
          This card only reads. An admin changes the policy through <span className="mono">POST /api/colonies/{colonyId}/decide/policy</span>, which takes a preset&apos;s values.
        </p>
      </details>
    </section>
  );
}

/** A preset's name as a chip reads it ("central-development" reads "central development"). */
function presetWords(name: string): string {
  return name.replace(/-/g, " ");
}

/** A landing card's line: the rule that confirmed it with the values it used, and the colony's preset when the gate decided. */
export function ConfirmedLine({ c }: { c: LandingConfirmation }) {
  const presets = [...new Set(c.changes.map((x) => x.preset).filter((p): p is string => typeof p === "string" && p !== ""))];
  return (
    <div className={`confirmed is-${c.kind}`}>
      <span className="confirmed-k">Confirmed</span>
      <span className="confirmed-text">{c.text}</span>
      {presets.length === 1 ? (
        <span className="confirmed-preset" title="The preset the colony's decide policy equalled when the gate decided">
          {presetWords(presets[0]!)}
        </span>
      ) : null}
    </div>
  );
}

/** The card folded to one line (the Why tab, above its landing cards): the preset and the split; opened, the whole card. */
export function DecidesFold({ d, colonyId }: { d: DecidesState; colonyId: string }) {
  if (d.state !== "loaded") return null;
  return (
    <details className="dc-fold">
      <summary>
        <span className="dc-k">Decides</span> <b className={d.report.preset === "custom" ? "dc-custom" : undefined}>{presetName(d.report)}</b>
        <span className="dc-dim"> · {splitSummary(d.report)}</span>
      </summary>
      <DecidesCard d={d} colonyId={colonyId} />
    </details>
  );
}
