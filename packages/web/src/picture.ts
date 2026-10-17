import type { RecordedEvent } from "@fire_trident/core";

/**
 * The picture panel of a replay (components/Picture.tsx): for a colony whose trunk has mosaic.json at its root (the
 * mosaic demo, demo/mosaic and scripts/mosaic.rb), the grid that file held at the replay's newest landing of it. The
 * file is read through the sandboxed preview route, GET /api/colonies/:id/preview/<commit>/mosaic.json, which serves
 * public colonies only; scripts/record_colony.ts keeps that read for every landing of the file, so a recording draws
 * the picture with no network. Everything a colony's file says is read defensively: a color is drawn only when it is a
 * hex color, and the grid is capped at MAX_SIDE tiles a side.
 */

/** The file the panel draws, at the root of the colony's trunk. */
export const PICTURE_FILE = "mosaic.json";
/** Most rows or columns the panel draws. */
export const MAX_SIDE = 64;

/** One tile: where it is and its color (null: still empty). */
export interface PictureTile {
  r: number;
  c: number;
  color: string | null;
}

/** A version of mosaic.json, as the panel draws it: every tile of the grid, row by row. */
export interface Picture {
  rows: number;
  cols: number;
  tiles: PictureTile[];
  filled: number;
}

/** A landing as far as the panel needs it (store LandingView, a landing event). */
export interface PictureLanding {
  id: string;
  trunkSha: string;
  paths: readonly string[];
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SHA = /^[0-9a-f]{40}$/;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const side = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= MAX_SIDE ? x : null);
const index = (x: unknown, n: number): number | null => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x < n ? x : null);

/**
 * A mosaic.json answer as a picture, or null when it is not one: an object whose `tiles` list holds { r, c, color }
 * entries. `rows` and `cols` come from the file, else from the largest tile position; a tile outside the grid is left
 * out, a later tile at the same place wins, a color that is not a hex color draws as empty, and a place no tile names is
 * empty.
 */
export function parsePicture(raw: unknown): Picture | null {
  if (!isObj(raw) || !Array.isArray(raw.tiles)) return null;
  const listed = raw.tiles.filter(isObj);
  const most = (key: "r" | "c"): number => listed.reduce((m, t) => (typeof t[key] === "number" && Number.isInteger(t[key]) ? Math.max(m, (t[key] as number) + 1) : m), 0);
  const rows = side(raw.rows) ?? side(most("r"));
  const cols = side(raw.cols) ?? side(most("c"));
  if (rows === null || cols === null) return null;
  const colors: Array<string | null> = new Array<string | null>(rows * cols).fill(null);
  for (const t of listed) {
    const r = index(t.r, rows);
    const c = index(t.c, cols);
    if (r === null || c === null) continue;
    colors[r * cols + c] = typeof t.color === "string" && HEX.test(t.color.trim()) ? t.color.trim().toLowerCase() : null;
  }
  const tiles = colors.map((color, i) => ({ r: Math.floor(i / cols), c: i % cols, color }));
  return { rows, cols, tiles, filled: tiles.filter((t) => t.color !== null).length };
}

/** The newest of `landings` (oldest first) that changed the picture file and names its commit; null when none did. */
export function pictureLanding<T extends PictureLanding>(landings: readonly T[]): T | null {
  for (let i = landings.length - 1; i >= 0; i--) {
    const l = landings[i];
    if (l && SHA.test(l.trunkSha) && Array.isArray(l.paths) && l.paths.includes(PICTURE_FILE)) return l;
  }
  return null;
}

/** Whether a colony's files or landings name the picture file at the root of its trunk. */
export function hasPicture(files: ReadonlyArray<{ path: string }>, landings: readonly PictureLanding[]): boolean {
  return files.some((f) => f.path === PICTURE_FILE) || pictureLanding(landings) !== null;
}

/** Every commit of a run that changed the picture file, oldest first, from its event record (landings and reverts). */
export function pictureCommits(events: readonly RecordedEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if ((e.t === "landing" || e.t === "reverted") && Array.isArray(e.paths) && e.paths.includes(PICTURE_FILE) && SHA.test(e.trunkSha) && !out.includes(e.trunkSha)) out.push(e.trunkSha);
  }
  return out;
}

/** The read of the picture file at one commit, under the colony's API (the preview route). */
export function picturePath(colonyId: string, trunkSha: string): string {
  return `/api/colonies/${encodeURIComponent(colonyId)}/preview/${trunkSha}/${PICTURE_FILE}`;
}

/** Pictures read, by colony and commit: a commit's file never changes, so each is read once per page. */
const read = new Map<string, Promise<Picture>>();

/**
 * The picture at commit `trunkSha` (GET the preview route; a recording answers it with no network). Throws an Error with
 * a sentence when the read fails or the file is not a grid. A failed read is asked again the next time.
 */
export function fetchPicture(colonyId: string, trunkSha: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<Picture> {
  const key = `${colonyId}\n${trunkSha}`;
  const kept = read.get(key);
  if (kept) return kept;
  const asked = readPicture(colonyId, trunkSha, fetcher);
  read.set(key, asked);
  asked.catch(() => read.delete(key));
  return asked;
}

async function readPicture(colonyId: string, trunkSha: string, fetcher: typeof fetch): Promise<Picture> {
  let res: Response;
  try {
    res = await fetcher(picturePath(colonyId, trunkSha), { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`The colony API could not be reached (${e instanceof Error ? e.message : "network error"}).`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const said = isObj(body) && typeof body.error === "string" && body.error.trim() ? body.error.trim().slice(0, 300) : `The server answered ${res.status}.`;
    throw new Error(/[.!?]$/.test(said) ? said : `${said}.`);
  }
  const picture = parsePicture(body);
  if (!picture) throw new Error(`${PICTURE_FILE} at ${trunkSha.slice(0, 7)} is not a grid of tiles.`);
  return picture;
}
