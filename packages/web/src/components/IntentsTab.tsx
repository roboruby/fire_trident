import type { IntentStatus } from "@fire_trident/core";
import { useMemo, useState } from "react";
import { fmtInt, timeAgo } from "../format.ts";
import type { ColonyStore, IntentView } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";

type Segment = "open" | "claimed" | "landed" | "withdrawn";

const SEGMENT_OF: Record<IntentStatus, Segment | null> = { open: "open", claimed: "claimed", proposed: "claimed", landed: "landed", abandoned: null, withdrawn: "withdrawn" };
const LIMIT = 150;
const EMPTY: Record<Segment, string> = {
  open: "Nothing open. The colony is caught up.",
  claimed: "No one is working right now.",
  landed: "Nothing has landed yet.",
  withdrawn: "Nothing withdrawn.",
};

/**
 * Intents grouped by where they are: open (unclaimed), claimed (being worked or proposed), landed,
 * and withdrawn (shown once there are any). An amended intent carries its revision as a badge.
 */
export function IntentsTab({ store, onPick }: { store: ColonyStore; onPick: (path: string | null) => void }) {
  useThrottledVersion(store, 400);
  const [seg, setSeg] = useState<Segment>("open");
  const version = store.intentsVersion;
  const groups = useMemo(() => {
    const g: Record<Segment, IntentView[]> = { open: [], claimed: [], landed: [], withdrawn: [] };
    for (const it of store.intents.values()) {
      const s = SEGMENT_OF[it.status];
      if (s) g[s].push(it);
    }
    g.open.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    g.claimed.sort((a, b) => b.updatedAt - a.updatedAt);
    g.landed.sort((a, b) => b.updatedAt - a.updatedAt);
    g.withdrawn.sort((a, b) => b.updatedAt - a.updatedAt);
    return g;
    // The store mutates in place; intentsVersion is the change signal.
  }, [store, version]);
  const segments: Segment[] = groups.withdrawn.length > 0 ? ["open", "claimed", "landed", "withdrawn"] : ["open", "claimed", "landed"];
  const current: Segment = segments.includes(seg) ? seg : "open";
  const list = groups[current];
  const now = store.now();
  return (
    <div className="intents">
      <div className="segments" role="tablist">
        {segments.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={current === s} className={`segment segment-${s}${current === s ? " is-on" : ""}`} onClick={() => setSeg(s)}>
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
            title={it.withdrawnReason ? `Withdrawn: ${it.withdrawnReason}` : undefined}
          >
            <div className="intent-title">
              {it.revision > 1 ? (
                <span className="rev-badge" title={`Amended ${it.revision - 1} time${it.revision === 2 ? "" : "s"}: work on older revisions never lands`}>
                  r{it.revision}
                </span>
              ) : null}
              {it.title}
            </div>
            <div className="intent-meta">
              {it.source ? <span className={`src src-${it.source}`}>{it.source}</span> : null}
              <span className="mono intent-path">{it.status === "withdrawn" && it.withdrawnReason ? it.withdrawnReason : (it.footprint[0] ?? "—")}</span>
              {it.status !== "withdrawn" && it.footprint.length > 1 ? <span className="intent-more">+{it.footprint.length - 1}</span> : null}
              <span className="intent-when">
                {it.assignedTo && current !== "open" ? `${store.agentName(it.assignedTo)} · ` : ""}
                {timeAgo(current === "open" ? it.createdAt : it.updatedAt, now)}
              </span>
            </div>
          </li>
        ))}
        {list.length > LIMIT ? <li className="more">+{fmtInt(list.length - LIMIT)} more</li> : null}
        {!list.length ? <li className="empty">{EMPTY[current]}</li> : null}
      </ul>
    </div>
  );
}
