import type { IntentStatus } from "@fire_trident/core";
import { useMemo, useState } from "react";
import { fmtInt, timeAgo } from "../format.ts";
import type { ColonyStore, IntentView } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";

type Segment = "open" | "claimed" | "landed";

const SEGMENT_OF: Record<IntentStatus, Segment | null> = { open: "open", claimed: "claimed", proposed: "claimed", landed: "landed", abandoned: null };
const LIMIT = 150;

/** Intents grouped by where they are: open (unclaimed), claimed (being worked or proposed), landed. */
export function IntentsTab({ store, onPick }: { store: ColonyStore; onPick: (path: string | null) => void }) {
  useThrottledVersion(store, 400);
  const [seg, setSeg] = useState<Segment>("open");
  const version = store.intentsVersion;
  const groups = useMemo(() => {
    const g: Record<Segment, IntentView[]> = { open: [], claimed: [], landed: [] };
    for (const it of store.intents.values()) {
      const s = SEGMENT_OF[it.status];
      if (s) g[s].push(it);
    }
    g.open.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    g.claimed.sort((a, b) => b.updatedAt - a.updatedAt);
    g.landed.sort((a, b) => b.updatedAt - a.updatedAt);
    return g;
    // The store mutates in place; intentsVersion is the change signal.
  }, [store, version]);
  const list = groups[seg];
  const now = Date.now();
  return (
    <div className="intents">
      <div className="segments" role="tablist">
        {(["open", "claimed", "landed"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={seg === s} className={`segment segment-${s}${seg === s ? " is-on" : ""}`} onClick={() => setSeg(s)}>
            <span className="segment-label">{s}</span>
            <span className="segment-n">{fmtInt(groups[s].length)}</span>
          </button>
        ))}
      </div>
      <ul className="intent-list" onMouseLeave={() => store.setHighlight([])}>
        {list.slice(0, LIMIT).map((it) => (
          <li
            key={it.id}
            className={`intent intent-${it.status}`}
            onMouseEnter={() => store.setHighlight(it.footprint)}
            onClick={() => onPick(it.footprint[0] ?? null)}
          >
            <div className="intent-title">{it.title}</div>
            <div className="intent-meta">
              {it.source ? <span className={`src src-${it.source}`}>{it.source}</span> : null}
              <span className="mono intent-path">{it.footprint[0] ?? "—"}</span>
              {it.footprint.length > 1 ? <span className="intent-more">+{it.footprint.length - 1}</span> : null}
              <span className="intent-when">
                {it.assignedTo && seg !== "open" ? `${store.agentName(it.assignedTo)} · ` : ""}
                {timeAgo(seg === "open" ? it.createdAt : it.updatedAt, now)}
              </span>
            </div>
          </li>
        ))}
        {list.length > LIMIT ? <li className="more">+{fmtInt(list.length - LIMIT)} more</li> : null}
        {!list.length ? <li className="empty">{seg === "open" ? "Nothing open. The colony is caught up." : seg === "claimed" ? "No one is working right now." : "Nothing has landed yet."}</li> : null}
      </ul>
    </div>
  );
}
