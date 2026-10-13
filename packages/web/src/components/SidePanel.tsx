import type { Ref } from "react";
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

/** Where the needs-you strip sent the panel: a tab, and the Events chip or Intents segment to open it on. */
export interface PanelFocus {
  tab: Tab;
  chip?: string;
  segment?: string;
  /** When it was asked for (a repeat click asks again). */
  at: number;
}

const LABEL: Record<Tab, string> = { events: "Events", intents: "Intents", review: "Review", why: "Why" };

interface Props {
  store: ColonyStore;
  backend: Backend;
  tab: Tab;
  onTab: (t: Tab) => void;
  onPick: (path: string | null) => void;
  /** Director mode: the panel is a drawer over the map, without developer controls. */
  director?: boolean;
  open?: boolean;
  focus?: PanelFocus | null;
  panelRef?: Ref<HTMLElement>;
}

/** The side panel: the event log, intents, the human review queue, and lineage. */
export function SidePanel({ store, backend, tab, onTab, onPick, director = false, open = true, focus = null, panelRef }: Props) {
  useThrottledVersion(store, 300);
  const badge: Record<Tab, number> = {
    events: 0,
    intents: store.intentsByStatus.open,
    review: store.reviewQueue() + store.openEscalations().length,
    why: 0,
  };
  const chip = focus?.tab === "events" && focus.chip ? { chip: focus.chip, at: focus.at } : null;
  const segment = focus?.tab === "intents" && focus.segment ? { segment: focus.segment, at: focus.at } : null;
  return (
    <aside ref={panelRef} className={`side${director ? " is-director" : ""}${open ? " is-open" : " is-closed"}`} aria-hidden={!open}>
      <nav className="tabs" role="tablist" aria-label="Colony panels">
        {TABS.map((t, i) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? " is-on" : ""}`} onClick={() => onTab(t)} title={`${LABEL[t]} (${i + 1})`}>
            {LABEL[t]}
            {badge[t] > 0 ? <span className={`tab-badge${t === "review" ? " tab-badge-hot" : ""}`}>{fmtInt(badge[t])}</span> : null}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === "events" ? <EventsTab store={store} director={director} focus={chip} /> : null}
        {tab === "intents" ? <IntentsTab store={store} onPick={onPick} focus={segment} /> : null}
        {tab === "review" ? <ReviewTab store={store} backend={backend} director={director} /> : null}
        {tab === "why" ? <WhyTab store={store} backend={backend} director={director} /> : null}
      </div>
    </aside>
  );
}
