import { fmtInt } from "../format.ts";
import { needsYou, type Need } from "../needs.ts";
import type { ColonyStore } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";

/**
 * The "needs you" strip under the trunk bar: what needs a person right now (changes to review,
 * agents' reports, a red trunk, intents that keep coming back), each a button to the tab that shows
 * it. It renders nothing when nothing needs a person, and floats over the map, so it never moves
 * anything else on the page.
 */
export function NeedsYou({ store, onGo }: { store: ColonyStore; onGo: (need: Need) => void }) {
  useThrottledVersion(store, 500);
  if (!store.loaded) return null;
  const needs = needsYou(store);
  if (!needs.length) return null;
  return (
    <section className="needs" aria-label="What needs a person">
      <span className="needs-k">{store.replay ? "Needed a person" : "Needs you"}</span>
      {needs.map((n) => (
        <button key={n.key} type="button" className={`need need-${n.key}`} title={n.title} onClick={() => onGo(n)}>
          {n.count > 0 ? <b className="need-n">{fmtInt(n.count)}</b> : null}
          <span className="need-label">{n.label}</span>
        </button>
      ))}
    </section>
  );
}
