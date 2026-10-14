import { useEffect, useState } from "react";
import { useAbout } from "../about.ts";
import { loadColonies, type ColonyCard } from "../colonies.ts";
import { BuildTag } from "../components/BuildTag.tsx";
import { TridentMark } from "../components/TopBar.tsx";
import { fmtInt, timeAgo } from "../format.ts";
import { colonyHref } from "../route.ts";
import { Exceptions } from "./Exceptions.tsx";
import { HeroColony } from "./HeroColony.tsx";
import { LiveColonies, rankColonies, statusOf } from "./LiveColonies.tsx";
import { Prongs } from "./Prongs.tsx";
import { Questions } from "./Questions.tsx";
import { Results } from "./Results.tsx";
import { RunIt, SERVER } from "./RunIt.tsx";
import "./landing.css";

const REPO = "https://github.com/roboruby/fire_trident";
const DOCS = `${REPO}/blob/main/docs/ARCHITECTURE.md`;
const POLL_MS = 5000;

/** Live colony cards, refreshed every few seconds (?colonies=a,b overrides the server's list). */
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

/** One line of real numbers from the first live colony, under the hero's buttons. */
function Proof({ card }: { card: ColonyCard | undefined }) {
  if (!card || card.error) return null;
  const landed = card.counters.get("landedintents") ?? card.counters.get("intentslanded");
  const landings = card.counters.get("landings");
  const v = card.violations;
  const parts: string[] = [];
  if (v !== null) parts.push(v === 0 ? "every rule satisfied" : `${fmtInt(v)} violations left`);
  if (landed !== undefined) parts.push(`${fmtInt(landed)} intents landed`);
  if (landings !== undefined) parts.push(`${fmtInt(landings)} commits`);
  if (card.lastLandingAt) parts.push(`last landing ${timeAgo(card.lastLandingAt)}`);
  if (!parts.length) return null;
  return (
    <a className="l-proof" href={colonyHref(card.id)}>
      <i />
      <span className="mono">{card.name}</span>
      <span>{parts.join(" · ")}</span>
    </a>
  );
}

/** The colony the hero button opens when nothing is working right now. */
const SHOWCASE_ID = "hono";

/** The landing page: what FireTrident is, the colonies running now, how it works, and how to run it. */
export function Landing() {
  const cards = useColonies();
  const about = useAbout();
  useEffect(() => {
    document.title = "FireTrident · A colony, not a queue";
  }, []);
  const ranked = cards ? rankColonies(cards) : null;
  const first = ranked?.find((c) => !c.error);
  // A colony at work right now comes first; otherwise the showcase run, replayed from its record.
  const live = first && statusOf(first) === "working" ? first : undefined;
  const showcase = cards?.find((c) => c.id === SHOWCASE_ID && !c.error);
  const hero = live ?? showcase ?? first;
  const heroHref = live ? colonyHref(live.id) : showcase ? colonyHref(showcase.id, { replay: true }) : first ? colonyHref(first.id) : colonyHref("demo", { mock: true });
  const heroLabel = live ? "Watch a live colony" : showcase ? "Watch the Hono run" : "Watch a colony";
  // The tour tells the showcase run from its record: offered while the colonies load and whenever the showcase is there.
  const tourable = cards === null || !!showcase;
  return (
    <div className="landing">
      <div className="l-glow" aria-hidden="true" />
      <header className="l-nav">
        <a className="l-brand" href="/">
          <TridentMark size={26} />
          <span>FireTrident</span>
        </a>
        <nav className="l-links">
          <a href="#results">Results</a>
          <a href="#colonies">Colonies</a>
          <a href="#how">How it works</a>
          <a href="#run">Run it</a>
          <a href={DOCS} target="_blank" rel="noreferrer">
            Docs
          </a>
          <a className="l-gh" href={REPO} target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>
      </header>

      <section className="l-hero">
        <div className="l-hero-copy">
          <div className="l-eyebrow">Git for coding agents · Cloudflare Workers + Artifacts</div>
          <h1 className="l-h1">A colony, not a queue.</h1>
          <p className="l-lede">Thousands of coding agents share one repository by reading signals left on the code instead of waiting in a merge queue, and every change they land records why it was made.</p>
          <div className="l-ctas">
            {tourable ? (
              <a className="l-btn l-btn-primary" href={colonyHref(SHOWCASE_ID, { tour: true })} title="Two minutes through a finished run, told from its own record">
                Take the tour
              </a>
            ) : null}
            <a className={`l-btn${tourable ? "" : " l-btn-primary"}`} href={heroHref}>
              {heroLabel}
            </a>
            <a className="l-btn" href={colonyHref("demo", { mock: true })}>
              Open the simulator
            </a>
          </div>
          <Proof card={hero} />
        </div>
        <div className="l-hero-viz">
          <HeroColony />
        </div>
      </section>

      <Results />

      <Questions />

      <section className="l-section" id="colonies">
        <div className="l-section-head">
          <div className="l-kicker">Running now</div>
          <h2 className="l-h2">Live colonies</h2>
          <p className="l-section-lede">Real repositories in Artifacts, remodeled by agents on {SERVER.replace("https://", "")}. Counters update as they work.</p>
        </div>
        <LiveColonies cards={ranked} />
      </section>

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

      <Exceptions />

      <section className="l-section" id="run">
        <div className="l-section-head">
          <div className="l-kicker">Run it</div>
          <h2 className="l-h2">One command to a colony.</h2>
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
        <div className="l-foot-built">Built on Cloudflare Workers, Durable Objects, Artifacts, Workflows and Workers AI.</div>
        <nav className="l-foot-links">
          <a href={REPO} target="_blank" rel="noreferrer">
            github.com/roboruby/fire_trident
          </a>
          <a href={DOCS} target="_blank" rel="noreferrer">
            Architecture
          </a>
          <a href={colonyHref("demo", { mock: true })}>Simulator</a>
        </nav>
      </footer>
    </div>
  );
}
