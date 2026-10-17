/**
 * The colony's root commit as the web app reads it (GET /api/colonies/:id/root, trunk/root.ts): the first commit of its
 * trunk, first parent from the tip, which the trunk writer keeps from its first read on. A clone is pinned to it with
 * `scripts/verify_note.mjs --colony <root>` (or `ft verify --all --colony <root>`): a clone of another colony, or a
 * history rewritten from its first commit, then fails. Read defensively and once per colony for the page's life.
 */

/** A colony's root commit and whether it is the oldest commit an import kept (the source's older history is not on trunk). */
export interface ColonyRoot {
  sha: string;
  shallow: boolean;
}

/** The root in GET /root's answer, or null when the answer holds none (a server that could not read it, or an odd answer). */
export function rootOf(answer: unknown): ColonyRoot | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const a = answer as { rootSha?: unknown; shallow?: unknown };
  return typeof a.rootSha === "string" && /^[0-9a-f]{40}$/.test(a.rootSha) ? { sha: a.rootSha, shallow: a.shallow === true } : null;
}

/** What hovering the root says: what it is, and the command that pins a clone to it. */
export function rootTitle(root: ColonyRoot): string {
  const what = root.shallow
    ? "the oldest commit of its trunk: the import kept the newest commits of its source, and this is the first of them"
    : "the first commit of its trunk, first parent from the tip";
  return `This colony's root commit, ${root.sha}: ${what}. Pin a clone of the colony to it: node verify_note.mjs --all --colony ${root.sha} (or ft verify --all --colony ${root.sha}) fails on any other history.`;
}

const asked = new Map<string, Promise<ColonyRoot | null>>();

/** The colony's root (GET /api/colonies/:id/root): kept once found; a read that fails or finds none is asked again next time. */
export function fetchRoot(colonyId: string): Promise<ColonyRoot | null> {
  const kept = asked.get(colonyId);
  if (kept) return kept;
  const ask = fetch(`/api/colonies/${encodeURIComponent(colonyId)}/root`, { headers: { accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then(rootOf, () => null);
  asked.set(colonyId, ask);
  ask.then((root) => {
    if (!root) asked.delete(colonyId);
  });
  return ask;
}
