import { AXES } from "./axes.ts";
import { Code } from "./RunIt.tsx";
import "./judges.css";

/**
 * "How FireTrident answers the judging axes": five rows, each the mechanism in one sentence and a live replay, an
 * in-browser scene or a command that checks it (axes.ts; docs/mechanisms.md carries the same table).
 */
export function Axes() {
  return (
    <section className="l-section" id="axes">
      <div className="l-section-head">
        <div className="l-kicker">The judging axes</div>
        <h2 className="l-h2">How FireTrident answers the judging axes.</h2>
        <p className="l-section-lede">
          One mechanism per axis, in one sentence, and a way to check it yourself: a replay of a real run, a scene that runs the check in your browser, or a command. What it cannot do yet is on <a href="/limits">the limits page</a>.
        </p>
      </div>
      <div className="ax" role="table" aria-label="How FireTrident answers the judging axes">
        <div className="ax-row ax-headrow" role="row">
          <span role="columnheader">Axis</span>
          <span role="columnheader">How FireTrident answers it</span>
          <span role="columnheader">Check it</span>
        </div>
        {AXES.map((a) => (
          <div className="ax-row" role="row" id={`ax-${a.id}`} key={a.id}>
            <h3 className="ax-axis" role="rowheader">
              {a.axis}
            </h3>
            <p className="ax-mech" role="cell">
              {a.mechanism}
            </p>
            <div className="ax-check" role="cell">
              {"href" in a.check ? (
                <a className="ax-link" href={a.check.href}>
                  {a.check.label} →
                </a>
              ) : (
                <>
                  <span className="ax-check-k">{a.check.label}</span>
                  <Code label="shell" text={a.check.command} />
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
