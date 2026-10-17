import { useEffect } from "react";
import { TridentMark } from "../components/TopBar.tsx";
import { REPO } from "../landing/questions.ts";
import { ARTIFACTS_LESSONS, GROUPS, LIMITS, STATUS_LABEL, type Limit } from "./limits.ts";
import "../landing/landing.css";
import "./limits.css";

/** One limit: what you cannot do, then why, what to do instead, its status, and where to see it. */
export function LimitRow({ limit }: { limit: Limit }) {
  const c = limit.check;
  return (
    <article className="lm-row" id={`lm-${limit.id}`}>
      <h3 className="lm-cannot">{limit.cannot}</h3>
      <dl className="lm-dl">
        <dt>Why</dt>
        <dd>{limit.why}</dd>
        <dt>Instead</dt>
        <dd>{limit.instead}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`lm-status lm-status-${limit.status}`}>{STATUS_LABEL[limit.status]}</span>
        </dd>
        <dt>See it</dt>
        <dd className="lm-check">
          {"href" in c ? (
            <a href={c.href}>{c.label} →</a>
          ) : (
            <>
              <span className="lm-check-k">{c.label}:</span> <code className="lm-cmd">{c.command}</code>
            </>
          )}
        </dd>
      </dl>
    </article>
  );
}

/** The limits page (/limits): the rows where a team's forge does better first, then where a colony stops, then what Artifacts taught us. */
export function Limits() {
  useEffect(() => {
    document.title = "Limits · FireTrident";
  }, []);
  return (
    <div className="landing lm-page">
      <header className="l-nav">
        <a className="l-brand" href="/">
          <TridentMark size={26} />
          <span>FireTrident</span>
        </a>
        <nav className="l-links">
          <a href="/#axes">Judging axes</a>
          <a href="/#take-back">Take the work back</a>
          <a href="#artifacts">Artifacts</a>
          <a className="l-gh" href={REPO} target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>
      </header>

      <section className="l-section lm-intro">
        <div className="l-kicker">Limits</div>
        <h1 className="l-h2 lm-h1">What FireTrident cannot do yet.</h1>
        <p className="l-section-lede">
          Each row says what you cannot do, why, what to do instead, and whether it is planned, waits on Cloudflare, or is not scheduled, with a page or a command that shows it. The rows where a team&apos;s current forge does better come first.
        </p>
      </section>

      {GROUPS.map((g) => (
        <section className="l-section" id={g.id} key={g.id}>
          <div className="l-section-head">
            <h2 className="l-h2">{g.title}</h2>
            <p className="l-section-lede">{g.lede}</p>
          </div>
          <div className="lm-rows">
            {LIMITS.filter((l) => l.group === g.id).map((l) => (
              <LimitRow limit={l} key={l.id} />
            ))}
          </div>
        </section>
      ))}

      <section className="l-section" id="artifacts">
        <div className="l-section-head">
          <div className="l-kicker">Built on Artifacts</div>
          <h2 className="l-h2">What Artifacts taught us.</h2>
          <p className="l-section-lede">
            Measured in a spike against the live service before the first line of the trunk writer (<a href={`${REPO}/blob/main/spike/RESULTS.md`}>spike/RESULTS.md</a>), each with what the code does about it.
          </p>
        </div>
        <div className="lm-lessons">
          {ARTIFACTS_LESSONS.map((x) => (
            <article className="lm-lesson" id={`lm-${x.id}`} key={x.id}>
              <h3 className="lm-lesson-title">{x.title}</h3>
              <p>{x.finding}</p>
              <p className="lm-work">
                <b>Workaround.</b> {x.workaround}
              </p>
            </article>
          ))}
        </div>
      </section>

      <footer className="l-foot">
        <div className="l-foot-brand">
          <TridentMark size={20} />
          <span>FireTrident</span>
          <span className="l-foot-muted">MIT licensed</span>
        </div>
        <nav className="l-foot-links">
          <a href="/">Home</a>
          <a href={`${REPO}#honest-limits`} target="_blank" rel="noreferrer">
            The README&apos;s honest limits
          </a>
          <a href="/c/hono?replay=1">Replay the Hono run</a>
        </nav>
      </footer>
    </div>
  );
}
