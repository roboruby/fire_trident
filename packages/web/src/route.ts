/** Which page to show, from the address bar. */
export type Route =
  | { kind: "landing" }
  | {
      kind: "colony";
      colonyId: string;
      /** ?mock=1: the built-in simulator instead of the API. */
      mock: boolean;
      /** ?director=1: the 1920×1080 recording stage with captions from director/script.json. */
      director: boolean;
      /** ?debug=1: developer aids (the frame-time and events-per-second readout). Off for everyone else. */
      debug: boolean;
      /**
       * ?replay=1: replay the colony's finished run from its record (?replay=reconstructed or
       * ?replay=recorded picks the source), at ?speed=1|2|4|8|16, from ?t=<seconds> into the run,
       * after waiting ?delay=<seconds>. Null for the live view.
       */
      replay: { source: "auto" | "recorded" | "reconstructed"; speed: number; offsetS: number; delayS: number } | null;
    };

function flag(params: URLSearchParams, key: string): boolean {
  const v = params.get(key);
  return v !== null && v !== "0" && v !== "false";
}

/**
 * "/" is the landing page; "/c/:colonyId" is one colony. The old shortcuts "/?mock=1"
 * and "/?director=1" still open the simulator colony.
 */
export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const mock = flag(params, "mock");
  const director = flag(params, "director");
  const debug = flag(params, "debug");
  const replayRaw = params.get("replay");
  const num = (key: string, fallback: number): number => {
    const v = Number(params.get(key));
    return params.has(key) && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const source: "auto" | "recorded" | "reconstructed" = replayRaw === "recorded" || replayRaw === "reconstructed" ? replayRaw : "auto";
  const replay = !mock && flag(params, "replay") ? { source, speed: num("speed", 1), offsetS: num("t", 0), delayS: num("delay", 0) } : null;
  const m = pathname.match(/^\/c\/([^/]+)/);
  if (m?.[1]) {
    let colonyId = m[1];
    try {
      colonyId = decodeURIComponent(m[1]);
    } catch {
      // keep the raw segment
    }
    return { kind: "colony", colonyId, mock, director, debug, replay };
  }
  if (mock || director) return { kind: "colony", colonyId: "demo", mock: true, director, debug, replay: null };
  return { kind: "landing" };
}

/** Link to a colony page (live, the simulator, or a replay of its finished run). */
export function colonyHref(colonyId: string, opts: { mock?: boolean; replay?: boolean } = {}): string {
  return `/c/${encodeURIComponent(colonyId)}${opts.mock ? "?mock=1" : opts.replay ? "?replay=1" : ""}`;
}
