import { useEffect, useState } from "react";
import { readTrunkHealth, type TrunkHealthState, type TrunkHealthView } from "../trunkhealth.ts";
import "./trunkhealth.css";

/**
 * Trunk health in the first screen's Certified row (trunkhealth.ts): what certifying after landing cost the colony, one
 * line, with the rest in its title. Read when the page opens and every minute on a live page; nothing shows until the
 * server answers, and a server with no report shows nothing.
 */

/** How often a live page reads it again. */
const REFRESH_MS = 60_000;

/** The colony's trunk health (an answer that fails keeps the last one). */
export function useTrunkHealth(colonyId: string, mode: "live" | "mock" | "replay"): TrunkHealthState {
  const [h, setH] = useState<TrunkHealthState>({ state: "loading" });
  useEffect(() => {
    let live = true;
    const read = () => {
      if (typeof document !== "undefined" && document.hidden && mode === "live") return;
      void readTrunkHealth(colonyId, mode).then((next) => {
        if (live) setH((cur) => (next.state === "unknown" && cur.state === "loaded" ? cur : next));
      });
    };
    read();
    const timer = mode === "live" ? window.setInterval(read, REFRESH_MS) : 0;
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [colonyId, mode]);
  return h;
}

/** The line: the numbers when certification judged trunk (red while it is red now), else why there are none. */
export function TrunkHealthLine({ health }: { health: TrunkHealthView }) {
  const cls = `fs-health${health.measured ? "" : " fs-none"}${health.red ? " is-red" : ""}`;
  return (
    <div className={cls} title={health.detail.join("\n") || undefined}>
      {health.text}
    </div>
  );
}
