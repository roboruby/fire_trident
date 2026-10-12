import { useCallback, useEffect, useState } from "react";
import { HttpBackend, saveToken, type Backend } from "./api.ts";
import { SidePanel, TABS, type Tab } from "./components/SidePanel.tsx";
import { TopBar, TridentMark } from "./components/TopBar.tsx";
import { ColonyMap } from "./map/ColonyMap.tsx";
import { MockBackend, mockOptionsFrom } from "./mock.ts";
import { ColonyStore } from "./store.ts";
import { useThrottledVersion } from "./useStore.ts";

interface Boot {
  store: ColonyStore;
  backend: Backend;
}

/** Colony id from /c/:colonyId (default "demo"), and the backend: the API, or the simulator with ?mock=1. */
function boot(): Boot {
  const m = location.pathname.match(/^\/c\/([^/]+)/);
  const colonyId = m?.[1] ? decodeURIComponent(m[1]) : "demo";
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  if (token) {
    // Keep the token in this browser, never in the address bar (or a screen recording).
    saveToken(token);
    params.delete("token");
    const rest = params.toString();
    history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  }
  const mock = params.get("mock");
  const useMock = mock !== null && mock !== "0" && mock !== "false";
  const store = new ColonyStore(colonyId);
  const backend: Backend = useMock ? new MockBackend(colonyId, mockOptionsFrom(params)) : new HttpBackend(colonyId);
  // Dev builds expose the store for inspection from the console; production builds do not.
  if (import.meta.env.DEV) (window as unknown as { ftStore?: ColonyStore }).ftStore = store;
  return { store, backend };
}

function StatusOverlay({ store }: { store: ColonyStore }) {
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
        <div className="overlay-title">{store.conn === "error" ? "Can't reach the colony" : `Connecting to ${store.colonyId}`}</div>
        <div className="overlay-text">{store.conn === "error" ? `${store.error ?? ""} Retrying${retryIn ? ` in ${retryIn}s` : ""}.` : "Loading the snapshot and opening the live stream."}</div>
        {store.conn === "error" ? (
          <a className="btn btn-approve" href={`${location.pathname}?mock=1`}>
            Open the simulator instead
          </a>
        ) : (
          <i className="spin" />
        )}
      </div>
    </div>
  );
}

/** FireTrident: one colony, live. */
export function App() {
  const [{ store, backend }] = useState(boot);
  const [tab, setTab] = useState<Tab>("events");

  useEffect(() => {
    backend.start(store);
    return () => backend.stop();
  }, [backend, store]);

  const pick = useCallback(
    (path: string | null) => {
      store.select(path);
      if (path) setTab("why");
    },
    [store],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        store.select(null);
        store.setHighlight([]);
        return;
      }
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      const next = TABS[idx];
      if (next) setTab(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  useThrottledVersion(store, 2000);
  const name = store.colony?.name;
  useEffect(() => {
    document.title = name ? `${name} · FireTrident` : "FireTrident";
  }, [name]);

  return (
    <div className="app">
      <TopBar store={store} />
      <main className="main">
        <div className="map-col">
          <ColonyMap store={store} onPick={pick} />
          <StatusOverlay store={store} />
        </div>
        <SidePanel store={store} backend={backend} tab={tab} onTab={setTab} onPick={pick} />
      </main>
    </div>
  );
}
