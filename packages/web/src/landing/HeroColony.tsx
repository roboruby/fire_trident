import { useEffect, useState } from "react";
import { AnimatedNumber } from "../components/AnimatedNumber.tsx";
import { fmtInt } from "../format.ts";
import { ColonyMap } from "../map/ColonyMap.tsx";
import { MockBackend } from "../mock.ts";
import { loadBundledRecording, recordingFetch, type Recording } from "../playback/recording.ts";
import { ReplayBackend } from "../replay.ts";
import { colonyHref } from "../route.ts";
import { ColonyStore } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";

/** The run the hero plays: the Hono run on production, from the recording bundled with the page (public/recordings/hono.json.gz). */
export const HERO_RECORDING = "hono";
/** The repository that run remodeled, as the hero's bar names it. */
export const HERO_SOURCE = "github.com/honojs/hono";
/** The replay's speed: the run plays as it happened, a minute of motion before it starts over. */
export const HERO_SPEED = 1;
/** The pause at the end of the run before it starts over. */
const LOOP_PAUSE_MS = 2_500;

type Source = { kind: "replay"; store: ColonyStore; backend: ReplayBackend } | { kind: "simulator"; store: ColonyStore; backend: MockBackend };

/** The built-in simulator, for a page whose recording cannot be read (labeled as a simulation). */
function simulator(): Source {
  const store = new ColonyStore("demo");
  return { kind: "simulator", store, backend: new MockBackend("demo", { files: 0, agents: 48, speed: 1.4, seed: 11 }) };
}

/** The Hono run from its record: every read the replay makes is answered from the recording, nothing goes over the network. */
function replay(rec: Recording): Source {
  const origin = typeof location !== "undefined" && location.origin && location.origin !== "null" ? location.origin : "http://recording.invalid";
  const fetcher = recordingFetch(rec, { fallback: (input, init) => fetch(input, init), origin, alias: HERO_RECORDING });
  const store = new ColonyStore(HERO_RECORDING);
  return { kind: "replay", store, backend: new ReplayBackend(HERO_RECORDING, { source: "recorded", speed: HERO_SPEED, fetch: fetcher }) };
}

/**
 * The hero's moving picture: the Hono run on production, played back from its record in a framed window and looped,
 * so the picture, the button beside it and the line of numbers under it are all the same run. The simulator stands in
 * only when the recording cannot be read, and says so.
 */
export function HeroColony() {
  const [source, setSource] = useState<Source | null>(null);
  const [placeholder] = useState(() => new ColonyStore(HERO_RECORDING));
  useEffect(() => {
    let live = true;
    loadBundledRecording(HERO_RECORDING).then(
      (rec) => {
        if (live) setSource(replay(rec));
      },
      () => {
        if (live) setSource(simulator());
      },
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!source) return;
    const { store, backend } = source;
    backend.start(store);
    let timer = 0;
    const off =
      source.kind === "replay"
        ? source.backend.subscribe(() => {
            if (!source.backend.state.ended || timer) return;
            timer = window.setTimeout(() => {
              timer = 0;
              source.backend.setPaused(false);
            }, LOOP_PAUSE_MS);
          })
        : () => undefined;
    return () => {
      off();
      window.clearTimeout(timer);
      backend.stop();
    };
  }, [source]);
  const store = source?.store ?? placeholder;
  useThrottledVersion(store, 300);
  const replaying = source === null || source.kind === "replay";
  const total = store.violations.total;
  return (
    <figure className="hc">
      <div className="hc-bar">
        <span className="hc-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={`hc-pill${replaying ? " is-replay" : ""}`}>{replaying ? "Replay" : "Simulator"}</span>
        <span className="hc-name mono">{replaying ? `${HERO_RECORDING} · ${HERO_SOURCE}` : (store.colony?.name ?? "demo")}</span>
        <span className="hc-stats">
          <span className="hc-stat">
            <b className={total === 0 && store.loaded ? "is-clean" : ""}>
              <AnimatedNumber value={total} duration={700} />
            </b>
            violations
          </span>
          <span className="hc-stat">
            <b>
              <AnimatedNumber value={store.agentsWorking()} duration={400} />
            </b>
            working
          </span>
          <span className="hc-stat">
            <b>
              <AnimatedNumber value={Math.round(store.landingsPerMin())} duration={400} />
            </b>
            landings / min
          </span>
        </span>
      </div>
      <div className="hc-map">
        <ColonyMap store={store} onPick={() => undefined} compact />
      </div>
      <figcaption className="hc-cap">
        {replaying ? (
          <>
            The Hono run on production, played back from its record: 80 agents took 958 violations of one rule to zero in 62 s. Each tile is a file; the sparks are commits landing on trunk.{" "}
            <a href={colonyHref(HERO_RECORDING, { replay: true })}>Open the full replay</a>
          </>
        ) : (
          <>
            A simulated colony of {fmtInt(store.agentsActive())} agents running in this page. Each tile is a file; the sparks are commits landing on trunk.{" "}
            <a href={colonyHref("demo", { mock: true })}>Open it full screen</a>
          </>
        )}
      </figcaption>
    </figure>
  );
}
