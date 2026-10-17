import { fmtInt } from "../format.ts";
import { RECORDING_NAME } from "../playback/recording.ts";
import { SPEEDS } from "../replay.ts";
import type { ColonyStore } from "../store.ts";

/**
 * The director's recipe scenes (script.json "rename" and "smuggle"): each plays its own recorded run, and the rename
 * scene's caption counts what that run shows.
 *
 * A scene that names a `recording` plays on that recording: when the page plays another run (or a live colony), the
 * director opens /c/<recording>?director=1&replay=1&recording=<recording>&scene=<id> instead, the recording answering
 * under the colony in the address bar (playback/recording.ts answerRead's alias). A scene's `speed` sets the replay's
 * speed there; without one the page's own carries over.
 */

/** What a scene says about the run it plays on. */
export interface SceneRun {
  id: string;
  /** The recording bundled with the page that the scene plays (packages/web/public/recordings/<name>.json.gz). */
  recording?: string;
  /** The replay's speed on that recording (1, 2, 4, 8 or 16). */
  speed?: number;
}

/** A scene's recording and speed from script.json, kept only when well-formed (a recording name, a replay speed). */
export function sceneRun(raw: Record<string, unknown>): Pick<SceneRun, "recording" | "speed"> {
  return {
    ...(typeof raw.recording === "string" && RECORDING_NAME.test(raw.recording) ? { recording: raw.recording } : {}),
    ...(typeof raw.speed === "number" && SPEEDS.includes(raw.speed) ? { speed: raw.speed } : {}),
  };
}

/**
 * The page a scene must open to play, or null when this page plays it already (or the scene names no recording).
 * `here` is the page's address (location). Keeps ?debug and the replay's delay; the speed is the scene's, else the page's.
 */
export function sceneHref(scene: SceneRun, here: { pathname: string; search: string }): string | null {
  if (!scene.recording) return null;
  const now = new URLSearchParams(here.search);
  if (/^\/c\/[^/]+/.test(here.pathname) && now.get("recording") === scene.recording && now.has("director")) return null;
  const q = new URLSearchParams({ director: "1", replay: "1", recording: scene.recording, scene: scene.id });
  const speed = scene.speed ?? Number(now.get("speed"));
  if (SPEEDS.includes(speed) && speed !== 1) q.set("speed", String(speed));
  for (const keep of ["delay", "debug"]) {
    const v = now.get(keep);
    if (v !== null) q.set(keep, v);
  }
  return `/c/${encodeURIComponent(scene.recording)}?${q.toString()}`;
}

/** "none goes back", "1 goes back", "3 go back". */
function backWords(n: number): string {
  return n === 0 ? "none goes back" : `${fmtInt(n)} ${n === 1 ? "goes" : "go"} back`;
}

/**
 * Caption values for a rename by recipe, from what the run has shown so far (live, or a replay up to its clock):
 * - {recipeFiles}: files the colony's landings without a proposal rewrote. A person's recipe lands as the trunk
 *   writer's own commits, which carry no proposal (so would a revert or an antibody; the recipe scene's colony has none).
 * - {recipeCommits}: those landings, as "3 commits".
 * - {recipeHeld}: the intents agents hold on files those landings rewrote, still open or settled since the first of them
 *   (each scene agent holds one intent).
 * - {recipeBack}: "none goes back", or how many changes went back.
 * - {recipeLanded}: changes that landed after the first of those landings, on files they rewrote.
 */
export function recipeFills(store: ColonyStore): Record<string, string> {
  const first = store.landings.findIndex((l) => l.proposalIds.length === 0);
  const batches = first < 0 ? [] : store.landings.slice(first).filter((l) => l.proposalIds.length === 0);
  const rewrote = new Set(batches.flatMap((l) => l.paths));
  const touches = (paths: readonly string[]): boolean => paths.some((p) => rewrote.has(p));
  const held = new Set<string>();
  for (const it of store.intents.values()) if ((it.status === "claimed" || it.status === "proposed") && touches(it.footprint)) held.add(it.id);
  let landed = 0;
  for (const l of first < 0 ? [] : store.landings.slice(first + 1)) {
    if (l.proposalIds.length === 0 || !touches(l.paths)) continue;
    for (const id of l.proposalIds) {
      landed++;
      const intent = store.proposals.get(id)?.intentId;
      if (intent) held.add(intent);
    }
  }
  let back = 0;
  for (const p of store.proposals.values()) {
    if (p.status !== "returned") continue;
    back++;
    if (touches(store.intents.get(p.intentId)?.footprint ?? [])) held.add(p.intentId);
  }
  return {
    recipeFiles: fmtInt(rewrote.size),
    recipeCommits: `${fmtInt(batches.length)} ${batches.length === 1 ? "commit" : "commits"}`,
    recipeHeld: fmtInt(held.size),
    recipeBack: backWords(back),
    recipeLanded: fmtInt(landed),
  };
}
