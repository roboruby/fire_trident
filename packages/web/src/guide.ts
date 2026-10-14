/**
 * The first-visit guide on the colony map: six short steps, each pointing at the part of the screen
 * it explains. Dismissing it is remembered in this browser; storage that is blocked only means the
 * guide shows again next visit.
 */

/** The part of the screen a step points at (the app root carries it as data-guide, and CSS rings that part). */
export type GuideTarget = "field" | "agents" | "lanes" | "trunk" | "funnel" | "tabs";

export interface GuideStep {
  target: GuideTarget;
  title: string;
  /** Labels as they read on screen are in backticks (`head`, `certified`). */
  text: string;
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    target: "field",
    title: "The map is the codebase",
    text: "Each tile is a file, sized by its bytes and grouped by directory. Its color is a signal left on it: amber need (work wanted), blue claim (an agent is on it), green trail (a change just landed), red where something failed. A need stays until its work lands; claims and trails fade.",
  },
  {
    target: "agents",
    title: "Dots are agents",
    text: "Agents choose work where needs are high and claims are low, so they spread out without a manager. Hover a file or a dot to see who is there, the model, what the agent says it is doing, and what it waits for.",
  },
  {
    target: "lanes",
    title: "Lanes land batches into trunk",
    text: "Each region of the code has a lane that batches the changes that do not conflict and whose reads are still current, and one trunk writer commits each batch and pushes them together. Each spark is a change flying into trunk. A change whose reads went stale goes back to its agent.",
  },
  {
    target: "trunk",
    title: "The trunk bar",
    text: "`head` is the newest commit, and ✓ or ✗ is that commit's own tests, run after it landed. `certified` is the newest commit on which every test file that could run passed and no test that passed before was lost. A failing trunk becomes a repair intent, and a repair counts only when its tests pass.",
  },
  {
    target: "funnel",
    title: "The reflex arc",
    text: "Every proposal is settled by the cheapest stage that is sure: a deterministic proof, then reflex models, then an LLM, then a person. Each number counts the proposals that stage settled.",
  },
  {
    target: "tabs",
    title: "The tabs",
    text: "`Events` is the live log. `Intents` is the work by what asked for it, then by region. `Review` is what needs a person: changes shown with their code, and agents' reports. `Why` is the lineage of any file you click. Keys 1 to 4 switch tabs, and the strip under the trunk bar counts what needs you.",
  },
];

const KEY = "ft.guide";
/** Dismissed on this page when storage is blocked. */
let dismissed = false;

/** Whether this browser dismissed the guide before. */
export function guideSeen(): boolean {
  if (dismissed) return true;
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    return false;
  }
}

/** Remember that the guide was dismissed (in this browser; for this page only when storage is blocked). */
export function rememberGuide(): void {
  dismissed = true;
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    // Storage blocked: the guide shows again on the next visit.
  }
}

/**
 * Whether the guide opens with the page: never on the recording stage (?director=1), on a link that
 * opens straight onto a file's lineage (?path=) or a timed replay start (?delay=); ?guide=1 and
 * ?guide=0 force it either way; otherwise only until it was dismissed once.
 */
export function guideAtStart(search: string, director: boolean, seen: boolean): boolean {
  if (director) return false;
  const params = new URLSearchParams(search);
  const forced = params.get("guide");
  if (forced === "0" || forced === "false") return false;
  if (forced === "1" || forced === "true") return true;
  if (params.has("path") || params.has("delay")) return false;
  return !seen;
}
