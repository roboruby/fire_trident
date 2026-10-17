/** Which page to show, from the address bar. */
export type Route =
  | { kind: "landing" }
  /** "/limits": what FireTrident cannot do yet, why, what to do instead, and its status (limits/Limits.tsx). */
  | { kind: "limits" }
  /** /connect: connect your agent, for one colony with ?colony=<id> (null without one; the page checks the id). */
  | { kind: "connect"; colonyId: string | null }
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
      /** ?tour=1: a two-minute tour of the finished run (tour/tours.ts), on its replay; never with ?mock or ?director. */
      tour: boolean;
      /** ?tour=<id>: another colony's tour script to play on this one (a preview run of the same demo); null for the colony's own. */
      tourScript: string | null;
      /**
       * ?recording=<name>: play a recorded run with no network, from recordings/<name>.json.gz (or .json) bundled with
       * the page (playback/recording.ts); an empty value offers to pick or drop a recording file. Implies a replay; null otherwise.
       */
      recording: string | null;
    };

function flag(params: URLSearchParams, key: string): boolean {
  const v = params.get(key);
  return v !== null && v !== "0" && v !== "false";
}

/**
 * "/" is the landing page; "/c/:colonyId" is one colony; "/limits" is the limits page; "/connect" connects an agent
 * (?colony=<id>). The old shortcuts "/?mock=1" and "/?director=1" still open the simulator colony.
 */
export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  if (/^\/connect\/?$/.test(pathname)) return { kind: "connect", colonyId: params.get("colony")?.trim() || null };
  const mock = flag(params, "mock");
  const director = flag(params, "director");
  const debug = flag(params, "debug");
  const replayRaw = params.get("replay");
  const num = (key: string, fallback: number): number => {
    const v = Number(params.get(key));
    return params.has(key) && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const source: "auto" | "recorded" | "reconstructed" = replayRaw === "recorded" || replayRaw === "reconstructed" ? replayRaw : "auto";
  // A tour plays the finished run's record, so it implies a replay.
  const tour = !mock && !director && flag(params, "tour");
  // ?tour=1 (or true, on, yes) is the colony's own tour; any other value names another colony's tour script.
  const tourRaw = params.get("tour") ?? "";
  const tourScript = tour && !/^(1|true|on|yes)$/i.test(tourRaw) ? tourRaw : null;
  // A recording is a finished run played without the network, so it implies a replay too.
  const recording = !mock && params.has("recording") ? (params.get("recording") ?? "").trim() : null;
  const replay = !mock && (flag(params, "replay") || tour || recording !== null) ? { source, speed: num("speed", 1), offsetS: num("t", 0), delayS: num("delay", 0) } : null;
  const m = pathname.match(/^\/c\/([^/]+)/);
  if (m?.[1]) {
    let colonyId = m[1];
    try {
      colonyId = decodeURIComponent(m[1]);
    } catch {
      // keep the raw segment
    }
    return { kind: "colony", colonyId, mock, director, debug, replay, tour, tourScript, recording };
  }
  if (mock || director) return { kind: "colony", colonyId: "demo", mock: true, director, debug, replay: null, tour: false, tourScript: null, recording: null };
  if (/^\/limits\/?$/.test(pathname)) return { kind: "limits" };
  return { kind: "landing" };
}

/**
 * Link to a colony page (live, the simulator, a replay of its finished run, or the tour of that replay: `tour: true` for its own, a name for another colony's script).
 * `recording` plays the replay or the tour from a recording bundled with the page, with no network (?recording=<name>).
 */
export function colonyHref(colonyId: string, opts: { mock?: boolean; replay?: boolean; tour?: boolean | string; recording?: string } = {}): string {
  const tour = typeof opts.tour === "string" && opts.tour ? `?tour=${encodeURIComponent(opts.tour)}` : opts.tour ? "?tour=1" : "";
  const href = `/c/${encodeURIComponent(colonyId)}${opts.mock ? "?mock=1" : tour || (opts.replay || opts.recording ? "?replay=1" : "")}`;
  return opts.recording && !opts.mock ? `${href}&recording=${encodeURIComponent(opts.recording)}` : href;
}
