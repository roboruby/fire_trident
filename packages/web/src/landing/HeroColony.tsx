import { useEffect, useState } from "react";
import { AnimatedNumber } from "../components/AnimatedNumber.tsx";
import { fmtInt } from "../format.ts";
import { ColonyMap } from "../map/ColonyMap.tsx";
import { MockBackend } from "../mock.ts";
import { colonyHref } from "../route.ts";
import { ColonyStore } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";

/** The hero's moving picture: the built-in simulator, running in a framed window, labeled as a simulation. */
export function HeroColony() {
  const [{ store, backend }] = useState(() => {
    const s = new ColonyStore("demo");
    return { store: s, backend: new MockBackend("demo", { files: 0, agents: 48, speed: 1.4, seed: 11 }) };
  });
  useEffect(() => {
    backend.start(store);
    return () => backend.stop();
  }, [backend, store]);
  useThrottledVersion(store, 300);
  const total = store.violations.total;
  return (
    <figure className="hc">
      <div className="hc-bar">
        <span className="hc-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="hc-pill">Simulator</span>
        <span className="hc-name mono">{store.colony?.name ?? "demo"}</span>
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
        A simulated colony of {fmtInt(store.agentsActive())} agents running in this page. Each tile is a file; the sparks are commits landing on trunk.{" "}
        <a href={colonyHref("demo", { mock: true })}>Open it full screen</a>
      </figcaption>
    </figure>
  );
}
