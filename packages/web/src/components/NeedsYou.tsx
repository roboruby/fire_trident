import { useState } from "react";
import { clock, fmtInt, timeAgo } from "../format.ts";
import { STUCK_DO, needsYou, stuckTarget, type Need } from "../needs.ts";
import type { ColonyStore, StuckView } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";

/**
 * The "needs you" strip under the trunk bar: what needs a person right now (changes to review,
 * agents' reports, a red trunk, intents that keep coming back, stuck work), each a button to the tab
 * that shows it. Stuck work opens a list instead: each item, how long it has been stuck, and a button
 * that goes where a person deals with it. It renders nothing when nothing needs a person, and floats
 * over the map, so it never moves anything else on the page.
 */
export function NeedsYou({ store, onGo }: { store: ColonyStore; onGo: (need: Need) => void }) {
  useThrottledVersion(store, 500);
  const [open, setOpen] = useState(false);
  if (!store.loaded) return null;
  const needs = needsYou(store);
  if (!needs.length) return null;
  const stuck = needs.find((n) => n.key === "stuck");
  return (
    <section className="needs" aria-label="What needs a person">
      <span className="needs-k">{store.replay ? "Needed a person" : "Needs you"}</span>
      {needs.map((n) =>
        n.key === "stuck" ? (
          <button key={n.key} type="button" className={`need need-stuck${open ? " is-open" : ""}`} title={n.title} aria-expanded={open} onClick={() => setOpen(!open)}>
            {n.count > 0 ? <b className="need-n">{fmtInt(n.count)}</b> : null}
            <span className="need-label">{n.label}</span>
            <span className="need-caret" aria-hidden="true">
              {open ? "▴" : "▾"}
            </span>
          </button>
        ) : (
          <button key={n.key} type="button" className={`need need-${n.key}`} title={n.title} onClick={() => onGo(n)}>
            {n.count > 0 ? <b className="need-n">{fmtInt(n.count)}</b> : null}
            <span className="need-label">{n.label}</span>
          </button>
        ),
      )}
      {stuck && open ? <StuckList store={store} need={stuck} onGo={onGo} /> : null}
    </section>
  );
}

/** The stuck items under the strip: how long, what is stuck (agents' words, as text), and what to do. */
export function StuckList({ store, need, onGo }: { store: ColonyStore; need: Need; onGo: (need: Need) => void }) {
  const items = need.items ?? [];
  const more = Math.max(0, need.count - items.length);
  const now = store.now();
  const go = (s: StuckView) => {
    const target = stuckTarget(store, s);
    if (target.path) store.select(target.path);
    onGo({ key: "stuck", count: 0, label: STUCK_DO[s.action].label, title: s.text, tab: target.tab, ...(target.focus ? { focus: target.focus } : {}) });
  };
  return (
    <ul className="stuck-list" aria-label="Stuck work">
      {items.map((s) => (
        <li key={s.key} className={`stuck stuck-${s.kind}`}>
          <span className="stuck-age mono" title={`Stuck since ${clock(s.since)}`}>
            {timeAgo(s.since, now).replace(/ ago$/, "")}
          </span>
          <span className="stuck-text">{s.text}</span>
          <button type="button" className="stuck-do" onClick={() => go(s)}>
            {STUCK_DO[s.action].label}
          </button>
        </li>
      ))}
      {more > 0 ? <li className="stuck-more">{fmtInt(more)} more: ft status lists them</li> : null}
    </ul>
  );
}
