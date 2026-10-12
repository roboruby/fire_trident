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
      /** ?perf=1: a frame-time readout. */
      perf: boolean;
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
  const perf = flag(params, "perf");
  const m = pathname.match(/^\/c\/([^/]+)/);
  if (m?.[1]) {
    let colonyId = m[1];
    try {
      colonyId = decodeURIComponent(m[1]);
    } catch {
      // keep the raw segment
    }
    return { kind: "colony", colonyId, mock, director, perf };
  }
  if (mock || director) return { kind: "colony", colonyId: "demo", mock: true, director, perf };
  return { kind: "landing" };
}

/** Link to a colony page. */
export function colonyHref(colonyId: string, opts: { mock?: boolean } = {}): string {
  return `/c/${encodeURIComponent(colonyId)}${opts.mock ? "?mock=1" : ""}`;
}
