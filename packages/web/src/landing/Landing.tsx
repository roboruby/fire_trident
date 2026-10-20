import { useEffect, useState } from "react";
import { useAbout } from "../about.ts";
import { loadColonies, type ColonyCard } from "../colonies.ts";
import { BuildTag } from "../components/BuildTag.tsx";
import { ARCHITECTURE, REPO, SiteNav } from "../components/SiteNav.tsx";
import { TridentMark } from "../components/TopBar.tsx";
import { fmtInt } from "../format.ts";
import { colonyHref } from "../route.ts";
import { PITCH, PITCH_MORE } from "./axes.ts";
import { Compared } from "./Compared.tsx";
import { Exceptions } from "./Exceptions.tsx";
import { HeroColony } from "./HeroColony.tsx";
import { rankColonies, statusOf } from "./LiveColonies.tsx";
import { Prongs } from "./Prongs.tsx";
import { Questions } from "./Questions.tsx";
import { Results } from "./Results.tsx";
import { RunIt } from "./RunIt.tsx";
import { TakeBack } from "./TakeBack.tsx";
import { TryIt } from "./TryIt.tsx";
import "./landing.css";

/** The colony cards refresh this often: enough to notice a colony at work, without a stream of reads. */
const POLL_MS = 60_000;

/** The colony cards (?colonies=a,b overrides the server's list), refreshed now and then. */
function useColonies(): ColonyCard[] | null {
  const [cards, setCards] = useState<ColonyCard[] | null>(null);
  useEffect(() => {
    const only = new URLSearchParams(location.search).get("colonies");
    const ids = only
      ? only
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    let timer = 0;
    let ctl: AbortController | null = null;
    let stopped = false;
    const tick = async () => {
      ctl = new AbortController();
      try {
        const next = await loadColonies({ ...(ids ? { ids } : {}), signal: ctl.signal });
        if (!stopped) setCards(next);
      } catch {
        if (!stopped) setCards((cur) => cur ?? []);
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), document.hidden ? POLL_MS * 4 : POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ctl?.abort();
    };
  }, []);
  return cards;
}

/** One line of real numbers from the showcase colony (or a colony at work right now), under the hero's buttons. */
function Proof({ card }: { card: ColonyCard | undefined }) {
  if (!card || card.error) return null;
  const landed = card.counters.get("landedintents") ?? card.counters.get("intentslanded");
  const landings = card.counters.get("landings");
  const v = card.violations;
  const parts: string[] = [];
  if (v !== null) parts.push(v === 0 ? "every rule satisfied" : `${fmtInt(v)} violations left`);
  if (landed !== undefined) parts.push(`${fmtInt(landed)} intents landed`);
  if (landings !== undefined) parts.push(`${fmtInt(landings)} commits`);
  if (!parts.length) return null;
  return (
    <a className="l-proof" href={colonyHref(card.id)}>
      <i />
      <span className="mono">{card.name}</span>
      <span>{parts.join(" · ")}</span>
    </a>
  );
}

/** The run the hero shows, plays and links: the Hono run on production. */
const SHOWCASE_ID = "hono";

/** The landing page: what FireTrident is, the questions it answers, the runs on production, how it works, and how to run it. */
export function Landing() {
  const cards = useColonies();
  const about = useAbout();
  useEffect(() => {
    document.title = "FireTrident · A colony, not a queue";
  }, []);
  const ranked = cards ? rankColonies(cards) : null;
  const first = ranked?.find((c) => !c.error);
  // A colony at work right now is worth a button of its own; otherwise the hero's run, full screen.
  const live = first && statusOf(first) === "working" ? first : undefined;
  const showcase = cards?.find((c) => c.id === SHOWCASE_ID && !c.error);
  const hero = showcase ?? live ?? first;
  const replayHref = colonyHref(SHOWCASE_ID, { replay: true });
  // The tour tells the showcase run from its record: offered while the colonies load and whenever the showcase is there.
  const tourable = cards === null || !!showcase;
  return (
    <div className="landing">
      <div className="l-glow" aria-hidden="true" />
      <SiteNav />

      <section className="l-hero">
        <div className="l-hero-copy">
          <div className="l-eyebrow">Git for coding agents · Cloudflare Workers + Artifacts</div>
          <h1 className="l-h1">A colony, not a queue.</h1>
          <p className="l-lede">Coding agents share one repository by reading signals left on the code instead of waiting in a merge queue, and every change they land records why it was made.</p>
          {/* The pitch (axes.ts): a colony sits beside the team's codebase; the certified work goes back as a branch (TakeBack.tsx). */}
          <p className="l-pitch">
            <b>{PITCH}</b> {PITCH_MORE}
          </p>
          <div className="l-ctas">
            {tourable ? (
              <a className="l-btn l-btn-primary" href={colonyHref(SHOWCASE_ID, { tour: true })} title="Two minutes through the Hono run, told from its own record">
                Take the tour
              </a>
            ) : null}
            {live ? (
              <a className="l-btn" href={colonyHref(live.id)}>
                Watch a live colony
              </a>
            ) : (
              <a className={`l-btn${tourable ? "" : " l-btn-primary"}`} href={replayHref}>
                Open the full replay
              </a>
            )}
          </div>
          <Proof card={hero} />
        </div>
        <div className="l-hero-viz">
          <HeroColony />
        </div>
      </section>

      <Questions />

      <Results />

      <section className="l-section" id="how">
        <div className="l-section-head">
          <div className="l-kicker">How it works</div>
          <h2 className="l-h2">Declare the shape. The colony converges.</h2>
          <p className="l-section-lede">
            A person writes an architecture rule. Every violation becomes a need on the code, and agents work it down to zero through four mechanisms borrowed from systems that coordinate millions of individuals with no manager.
          </p>
        </div>
        <Prongs />
      </section>

      <Compared />

      <Exceptions />

      <TryIt />

      <TakeBack />

      <section className="l-section" id="run">
        <div className="l-section-head">
          <div className="l-kicker">Run it</div>
          <h2 className="l-h2">One command to a colony.</h2>
          <p className="l-section-lede">
            Read any colony here without a token, or run your own deployment and import a repository. The <a href={colonyHref("demo", { mock: true })}>simulator</a> runs a colony in your browser, with
            no server at all.
          </p>
        </div>
        <RunIt />
      </section>

      <footer className="l-foot">
        <div className="l-foot-brand">
          <TridentMark size={20} />
          <span>FireTrident</span>
          <span className="l-foot-muted">MIT licensed</span>
          <BuildTag about={about} />
        </div>
        <div className="l-foot-built">Built on Cloudflare Workers, Durable Objects, Artifacts and Workers AI.</div>
        <nav className="l-foot-links">
          <a href={REPO} target="_blank" rel="noreferrer">
            github.com/roboruby/fire_trident
          </a>
          <a href={ARCHITECTURE}>Architecture</a>
          <a href={colonyHref("demo", { mock: true })}>Simulator</a>
          <a href="/limits">Limits</a>
        </nav>
      </footer>
    </div>
  );
}
