/**
 * The hard timeout per beat of the director (?director=1): a scene that is still waiting for what it shows (a file to
 * select, such as a landing that has not appeared; a camera target that is not on the map; a read on screen that has not
 * answered; the data its `requires` names) when its limit runs out moves on to the next scene by itself, and the console
 * says why. A scene whose content is all there holds for the presenter as before. Live colonies and replays get the same
 * limit, so a slow model call never stalls a talk. Holding a beat (space) stops its clock.
 */

/** How long a beat may wait for what it shows, unless its scene sets `maxMs`. */
export const BEAT_MAX_MS = 30_000;

/** How often a beat looks again at what it waits for. */
export const BEAT_POLL_MS = 250;

/** The longest scene `scene` may wait: its own `maxMs`, else BEAT_MAX_MS. */
export function beatLimit(scene: { maxMs?: number }): number {
  return typeof scene.maxMs === "number" && Number.isFinite(scene.maxMs) && scene.maxMs > 0 ? scene.maxMs : BEAT_MAX_MS;
}

/** What a scene's `requires` names, as the end of "the colony has no … yet". */
const REQUIRED: Readonly<Record<string, string>> = {
  vaccine: "vaccination result",
  landing: "landing",
  review: "change waiting for review",
  sigma: "sigma of 0.85 or more",
  direction: "change of direction",
  mcp: "landing from an outside agent",
};

/** What a beat still waits for, as Director sees it. Null (or false) for each thing that is there. */
export interface BeatState {
  /** The scene's `requires`, when the colony does not have it. */
  requires?: string | null;
  /** The scene's `select` targets, when none of them names a file yet. */
  select?: readonly string[] | null;
  /** The scene's `focus` targets, when none of them is on the map yet. */
  focus?: readonly string[] | null;
  /** A read shown on screen (the Why tab's lineage) has not answered. */
  reading?: boolean;
}

/** The clauses for what a beat still waits for, in plain words; empty when it waits for nothing. */
export function beatWaits(state: BeatState): string[] {
  const out: string[] = [];
  if (state.requires) out.push(`the colony has no ${REQUIRED[state.requires] ?? state.requires} yet`);
  if (state.select?.length) out.push(`no file to select yet (${state.select.join(", ")})`);
  if (state.focus?.length) out.push(`the camera's target is not on the map yet (${state.focus.join(", ")})`);
  if (state.reading) out.push("the Why tab's read has not answered");
  return out;
}

/** The console line for a beat that moved on by itself. */
export function moveOnLine(index: number, total: number, id: string, limitMs: number, waits: readonly string[]): string {
  const s = Math.round(limitMs / 100) / 10;
  return `Director: scene ${index + 1}/${total} "${id}" waited ${s} s and moved on: ${waits.join("; ")}. Space holds a beat; → moves on by hand.`;
}

/** What watchBeat needs. */
export interface BeatWatch {
  /** When the beat began, on the `now` clock (a hold moves it later). */
  from: number;
  /** The beat's limit (beatLimit). */
  limitMs: number;
  now: () => number;
  /** What the beat still waits for now (beatWaits); it may also retry what it waits for. */
  probe: () => string[];
  /** Called once, with what was still awaited, when the limit ran out with something awaited. */
  onExpire: (waits: string[]) => void;
  every?: number;
}

/**
 * Watch one beat: every `every` ms ask `probe` what it still waits for; once `limitMs` has passed since `from` and
 * something is still awaited, stop and call `onExpire` with it. A beat that waits for nothing is never moved on.
 * Returns the function that stops watching (a new scene, a hold, a key press).
 */
export function watchBeat(w: BeatWatch): () => void {
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    const waits = w.probe();
    if (!waits.length || w.now() - w.from < w.limitMs) return;
    done = true;
    clearInterval(timer);
    w.onExpire(waits);
  }, w.every ?? BEAT_POLL_MS);
  return () => {
    done = true;
    clearInterval(timer);
  };
}
