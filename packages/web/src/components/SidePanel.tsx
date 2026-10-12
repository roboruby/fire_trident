import type { Backend } from "../api.ts";
import { fmtInt } from "../format.ts";
import type { ColonyStore } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";
import { EventsTab } from "./EventsTab.tsx";
import { IntentsTab } from "./IntentsTab.tsx";
import { ReviewTab } from "./ReviewTab.tsx";
import { WhyTab } from "./WhyTab.tsx";

export type Tab = "events" | "intents" | "review" | "why";
export const TABS: readonly Tab[] = ["events", "intents", "review", "why"];

const LABEL: Record<Tab, string> = { events: "Events", intents: "Intents", review: "Review", why: "Why" };

interface Props {
  store: ColonyStore;
  backend: Backend;
  tab: Tab;
  onTab: (t: Tab) => void;
  onPick: (path: string | null) => void;
}

/** The side panel: the event log, intents, the human review queue, and lineage. */
export function SidePanel({ store, backend, tab, onTab, onPick }: Props) {
  useThrottledVersion(store, 300);
  const badge: Record<Tab, number> = {
    events: 0,
    intents: store.intentsByStatus.open,
    review: store.escalated,
    why: 0,
  };
  return (
    <aside className="side">
      <nav className="tabs" role="tablist">
        {TABS.map((t, i) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? " is-on" : ""}`} onClick={() => onTab(t)} title={`${LABEL[t]} (${i + 1})`}>
            {LABEL[t]}
            {badge[t] > 0 ? <span className={`tab-badge${t === "review" ? " tab-badge-hot" : ""}`}>{fmtInt(badge[t])}</span> : null}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === "events" ? <EventsTab store={store} /> : null}
        {tab === "intents" ? <IntentsTab store={store} onPick={onPick} /> : null}
        {tab === "review" ? <ReviewTab store={store} backend={backend} /> : null}
        {tab === "why" ? <WhyTab store={store} backend={backend} /> : null}
      </div>
    </aside>
  );
}
