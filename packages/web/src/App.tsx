import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HttpBackend, saveToken, type Backend } from "./api.ts";
import { Guide } from "./components/Guide.tsx";
import { NeedsYou } from "./components/NeedsYou.tsx";
import { PerfReadout } from "./components/PerfReadout.tsx";
import { ReplayBar } from "./components/ReplayBar.tsx";
import { SidePanel, TABS, type PanelFocus, type Tab } from "./components/SidePanel.tsx";
import { TopBar, TridentMark } from "./components/TopBar.tsx";
import { Director } from "./director/Director.tsx";
import { guideAtStart, guideSeen, rememberGuide, type GuideTarget } from "./guide.ts";
import { ColonyMap } from "./map/ColonyMap.tsx";
import type { MapRenderer } from "./map/renderer.ts";
import { MockBackend, mockOptionsFrom } from "./mock.ts";
import type { Need } from "./needs.ts";
import { ReplayBackend } from "./replay.ts";
import { colonyHref, type Route } from "./route.ts";
import { ColonyStore } from "./store.ts";
import { useThrottledVersion } from "./useStore.ts";

/** Under 900 px the panel stacks under the map: a pick or a strip click scrolls down to it. */
const NARROW = "(max-width: 900px)";

type ColonyRoute = Extract<Route, { kind: "colony" }>;

interface Boot {
  store: ColonyStore;
  backend: Backend;
}

/** The store and the backend for this page: the API, or the simulator with ?mock=1. */
function boot(route: ColonyRoute): Boot {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  if (token) {
    // Keep the token in this browser, never in the address bar (or a screen recording).
    saveToken(token);
    params.delete("token");
    const rest = params.toString();
    history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  }
  const store = new ColonyStore(route.colonyId);
  const backend: Backend = route.mock
    ? new MockBackend(route.colonyId, mockOptionsFrom(params))
    : route.replay
      ? new ReplayBackend(route.colonyId, route.replay)
      : new HttpBackend(route.colonyId);
  // Dev builds (and ?debug=1) expose the store for inspection from the console.
  if (import.meta.env.DEV || route.debug) (window as unknown as { ftStore?: ColonyStore }).ftStore = store;
  return { store, backend };
}

function StatusOverlay({ store, mockHref, replay }: { store: ColonyStore; mockHref: string; replay: boolean }) {
  useThrottledVersion(store, 500);
  if (store.loaded && store.conn !== "error" && store.conn !== "reconnecting") return null;
  if (store.loaded) {
    return (
      <div className="banner">
        <i className="spin" />
        {store.conn === "error" ? (store.error ?? "The colony API is unreachable.") : `Live stream interrupted. Reconnecting…${store.error ? ` ${store.error}` : ""}`}
      </div>
    );
  }
  const retryIn = store.retryAt ? Math.max(0, Math.ceil((store.retryAt - Date.now()) / 1000)) : 0;
  return (
    <div className="overlay">
      <div className="overlay-card">
        <TridentMark size={44} />
        <div className="overlay-title">{store.conn === "error" ? (replay ? "Can't replay this colony" : "Can't reach the colony") : replay ? `Replaying ${store.colonyId}` : `Connecting to ${store.colonyId}`}</div>
        <div className="overlay-text">
          {store.conn === "error"
            ? replay
              ? (store.error ?? "")
              : `${store.error ?? ""} Retrying${retryIn ? ` in ${retryIn}s` : ""}.`
            : (store.loadingText ?? "Loading the snapshot and opening the live stream.")}
        </div>
        {store.conn === "error" ? (
          <div className="overlay-actions">
            {replay ? (
              <a className="btn btn-approve" href={colonyHref(store.colonyId)}>
                Open the live colony
              </a>
            ) : (
              <a className="btn btn-approve" href={mockHref}>
                Open the simulator
              </a>
            )}
            <a className="btn" href="/">
              All colonies
            </a>
          </div>
        ) : (
          <i className="spin" />
        )}
      </div>
    </div>
  );
}

/** Director mode records at exactly 1920×1080: a fixed stage, letterboxed and scaled to fit other windows. */
const STAGE_W = 1920;
const STAGE_H = 1080;

function Stage({ on, children }: { on: boolean; children: ReactNode }) {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    if (!on) return;
    document.documentElement.classList.add("is-director");
    const fit = () => setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H) || 1);
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      document.documentElement.classList.remove("is-director");
    };
  }, [on]);
  if (!on) return <>{children}</>;
  const left = Math.max(0, (window.innerWidth - STAGE_W * scale) / 2);
  const top = Math.max(0, (window.innerHeight - STAGE_H * scale) / 2);
  return (
    <div className="stage-outer">
      <div className="stage" style={{ width: STAGE_W, height: STAGE_H, transform: `translate(${left}px, ${top}px) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

/** FireTrident: one colony, live. */
export function App({ route }: { route: ColonyRoute }) {
  const [{ store, backend }] = useState(() => boot(route));
  const [tab, setTab] = useState<Tab>("events");
  const [renderer, setRenderer] = useState<MapRenderer | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const director = route.director;
  const [guideOpen, setGuideOpen] = useState(() => guideAtStart(location.search, director, guideSeen()));
  const [guideTarget, setGuideTarget] = useState<GuideTarget | null>(null);
  const [focus, setFocus] = useState<PanelFocus | null>(null);
  const side = useRef<HTMLElement>(null);
  const revealPanel = useCallback(() => {
    if (window.matchMedia?.(NARROW).matches) side.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    backend.start(store);
    return () => backend.stop();
  }, [backend, store]);

  // ?path=<file> opens straight onto that file's lineage (a shareable link to why a file is the way it is).
  useEffect(() => {
    const path = new URLSearchParams(location.search).get("path");
    if (!path || director) return;
    const unsubscribe = store.subscribe(() => {
      if (!store.loaded) return;
      unsubscribe();
      store.select(path);
      setTab("why");
    });
    return unsubscribe;
  }, [store, director]);

  const pick = useCallback(
    (path: string | null) => {
      store.select(path);
      if (!path) return;
      setTab("why");
      if (!director) revealPanel();
    },
    [store, director, revealPanel],
  );

  // Choosing a tab by hand forgets where the needs-you strip last pointed.
  const chooseTab = useCallback((t: Tab) => {
    setFocus(null);
    setTab(t);
  }, []);

  // The needs-you strip opens the tab that shows what it counts.
  const go = useCallback(
    (need: Need) => {
      setTab(need.tab);
      setFocus({ tab: need.tab, ...(need.tab === "events" && need.focus ? { chip: need.focus } : {}), ...(need.tab === "intents" && need.focus ? { segment: need.focus } : {}), at: Date.now() });
      revealPanel();
    },
    [revealPanel],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        store.select(null);
        store.setHighlight([]);
        setGuideOpen((open) => {
          if (open) rememberGuide();
          return false;
        });
        return;
      }
      if (director) return;
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      const next = TABS[idx];
      if (next) chooseTab(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, director, chooseTab]);

  useThrottledVersion(store, 2000);
  const name = store.colony?.name;
  const replaying = !!route.replay;
  useEffect(() => {
    document.title = name ? `${name}${replaying ? " · Replay" : ""} · FireTrident` : "FireTrident";
  }, [name, replaying]);

  const mockHref = `/c/${encodeURIComponent(route.colonyId)}?mock=1`;
  const showGuide = guideOpen && !director && store.loaded;
  return (
    <Stage on={director}>
      <div className={`app${director ? " is-director" : ""}`} data-guide={showGuide && guideTarget ? guideTarget : undefined}>
        <TopBar store={store} director={director} mock={route.mock} />
        <main className="main">
          <div className="map-col">
            <ColonyMap store={store} onPick={pick} onRenderer={setRenderer} director={director} onGuide={director ? undefined : () => setGuideOpen(true)} />
            {director ? null : <NeedsYou store={store} onGo={go} />}
            {backend instanceof ReplayBackend && !director ? <ReplayBar backend={backend} colonyId={route.colonyId} /> : null}
            {showGuide ? <Guide onTarget={setGuideTarget} onClose={() => setGuideOpen(false)} lifted={backend instanceof ReplayBackend} /> : null}
            <StatusOverlay store={store} mockHref={mockHref} replay={!!route.replay} />
          </div>
          <SidePanel store={store} backend={backend} tab={tab} onTab={chooseTab} onPick={pick} director={director} open={!director || panelOpen} focus={focus} panelRef={side} />
          {director ? <Director store={store} backend={backend} renderer={renderer} onTab={setTab} onPanel={setPanelOpen} panelOpen={panelOpen} /> : null}
        </main>
        {route.debug ? <PerfReadout store={store} renderer={renderer} /> : null}
      </div>
    </Stage>
  );
}
