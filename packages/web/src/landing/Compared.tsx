import { COMPARED, LEDGER_HREF, MEASURED_TITLE, STATE_LABEL, resultsHref, type Comparison } from "./compared.ts";

/** One mechanism: what it moves, the value without it and with it, where it was measured, and its run. */
function Row({ row }: { row: Comparison }) {
  return (
    <article className={`cm-row cm-${row.verdict}`} id={`cm-${row.id}`}>
      <div className="cm-k">
        <h3 className="cm-name">{row.mechanism}</h3>
        <div className={`cm-state cm-state-${row.state}`}>
          <span>{STATE_LABEL[row.state]}</span>
          {row.flag ? <code className="cm-flag">{row.flag}</code> : <span className="cm-flag">built in</span>}
        </div>
        <p className="cm-metric">{row.metric}</p>
      </div>
      <div className="cm-v cm-off">
        <div className="cm-vk">Without</div>
        <div className="cm-val">{row.off}</div>
      </div>
      <div className="cm-v cm-on">
        <div className="cm-vk">With</div>
        <div className="cm-val">{row.on}</div>
      </div>
      <div className="cm-tail">
        <p className="cm-note">{row.note}</p>
        <div className="cm-foot">
          <span className={`cm-label cm-label-${row.label}`} title={MEASURED_TITLE[row.label]}>
            {row.label}
          </span>
          <a className="cm-link" href={resultsHref(row.folder)} target="_blank" rel="noreferrer">
            results/{row.folder} →
          </a>
        </div>
      </div>
    </article>
  );
}

/** The landing page's "with and without" panel (compared.ts), after how it works. */
export function Compared() {
  return (
    <section className="l-section" id="compared">
      <div className="l-section-head">
        <div className="l-kicker">With and without</div>
        <h2 className="l-h2">What each mechanism buys, and what it costs.</h2>
        <p className="l-section-lede">
          Each row is one mechanism measured without it and with it, and links to its run. A mechanism is a switch in a deployment&apos;s config, set by whoever runs that deployment, so it is the same for
          everyone on firetrident.com and yours to set on your own copy; nothing here is set per user. The{" "}
          <a href={LEDGER_HREF} target="_blank" rel="noreferrer">
            full ledger
          </a>{" "}
          has every switch, including the ones that cost more than they earn.
        </p>
      </div>
      <div className="cm">
        {COMPARED.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </div>
    </section>
  );
}
