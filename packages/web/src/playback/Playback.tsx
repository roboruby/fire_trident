import { useCallback, useEffect, useState, type DragEvent } from "react";
import { App } from "../App.tsx";
import { TridentMark } from "../components/TopBar.tsx";
import { colonyHref, type Route } from "../route.ts";
import { installRecording, loadBundledRecording, readRecording, type Recording } from "./recording.ts";

type ColonyRoute = Extract<Route, { kind: "colony" }>;

type State = { kind: "loading"; what: string } | { kind: "pick"; error: string | null } | { kind: "ready" };

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

/**
 * ?recording=<name> (playback/recording.ts): load the recording bundled with the page, or one picked or dropped here,
 * answer the page's reads from it, then show the colony as a replay, the director and the tour included. Nothing under
 * /api goes over the network from then on. When there is no name, or the bundled one cannot be read, it says why and
 * offers to pick or drop a file.
 */
export function Playback({ route }: { route: ColonyRoute }) {
  const name = route.recording ?? "";
  const [state, setState] = useState<State>(() => (name ? { kind: "loading", what: name } : { kind: "pick", error: null }));
  const [over, setOver] = useState(false);

  const play = useCallback(
    (rec: Recording) => {
      installRecording(rec, { alias: route.colonyId });
      // The tour's code loads on demand: fetch it now, while the page can still reach its own files.
      if (route.tour) void import("../tour/Tour.tsx").catch(() => undefined);
      setState({ kind: "ready" });
    },
    [route],
  );

  useEffect(() => {
    if (!name) return;
    let live = true;
    loadBundledRecording(name).then(
      (rec) => {
        if (live) play(rec);
      },
      (e: unknown) => {
        if (live) setState({ kind: "pick", error: messageOf(e, "The recording could not be read.") });
      },
    );
    return () => {
      live = false;
    };
  }, [name, play]);

  const open = (file: File | undefined) => {
    if (!file) return;
    setState({ kind: "loading", what: file.name });
    file
      .arrayBuffer()
      .then((bytes) => readRecording(bytes))
      .then(play, (e: unknown) => setState({ kind: "pick", error: `${file.name}: ${messageOf(e, "it could not be read.")}` }));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (state.kind === "pick") open(e.dataTransfer.files[0]);
  };

  if (state.kind === "ready") return <App route={route} />;
  const loading = state.kind === "loading";
  return (
    <div
      className="overlay"
      style={{ position: "fixed" }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!loading) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="overlay-card" style={over ? { outline: "1px dashed var(--text-3)", outlineOffset: 8, borderRadius: 12 } : undefined}>
        <TridentMark size={44} />
        <div className="overlay-title">{loading ? `Loading the recording ${state.what}` : "Play a recording"}</div>
        <div className="overlay-text">
          {loading
            ? "Once it is loaded, the replay plays with no network."
            : `${state.error ? `${state.error} ` : ""}Pick or drop a recording file (scripts/record_colony.ts writes one) to replay its run with no network.`}
        </div>
        {loading ? (
          <i className="spin" />
        ) : (
          <div className="overlay-actions">
            <label className="btn btn-approve">
              Pick a recording
              <input type="file" accept=".json,.gz,application/json,application/gzip" hidden onChange={(e) => open(e.target.files?.[0])} />
            </label>
            <a className="btn" href={colonyHref(route.colonyId, { replay: true })}>
              Replay over the network
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
