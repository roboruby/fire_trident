import type { IntentStatus } from "@fire_trident/core";
import { useEffect, useMemo, useState } from "react";
import { KIND_LABEL } from "../eventText.ts";
import { fmtInt, timeAgo } from "../format.ts";
import { REPEATED_RETURNS, type ColonyStore, type IntentView } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";
import { MovedBadge } from "./MovedBy.tsx";

type Segment = "open" | "claimed" | "landed" | "withdrawn" | "returned";
const SEGMENTS: readonly Segment[] = ["open", "claimed", "landed", "withdrawn", "returned"];

const SEGMENT_OF: Record<IntentStatus, Exclude<Segment, "returned"> | null> = { open: "open", claimed: "claimed", proposed: "claimed", landed: "landed", abandoned: null, withdrawn: "withdrawn" };
const LIMIT = 150;
const EMPTY: Record<Segment, string> = {
  open: "Nothing open. The colony is caught up.",
  claimed: "No one is working right now.",
  landed: "Nothing has landed yet.",
  withdrawn: "Nothing withdrawn.",
  returned: "No intent keeps coming back.",
};
const SEGMENT_TITLE: Partial<Record<Segment, string>> = {
  returned: `Intents whose changes came back ${REPEATED_RETURNS} or more times while this page was open`,
};

/**
 * Intents grouped by where they are: open (unclaimed), claimed (being worked or proposed), landed,
 * withdrawn (once there are any), and returned (intents whose changes keep coming back, once there
 * are any). An amended intent carries its revision; contests, agents' reports and repeated returns
 * carry a badge. `focus` (from the needs-you strip) opens a segment.
 */
export function IntentsTab({ store, onPick, focus = null }: { store: ColonyStore; onPick: (path: string | null) => void; focus?: { segment: string; at: number } | null }) {
  useThrottledVersion(store, 400);
  const focusAt = focus?.at ?? 0;
  const focusSegment = focus && (SEGMENTS as readonly string[]).includes(focus.segment) ? (focus.segment as Segment) : null;
  const [seg, setSeg] = useState<Segment>(() => focusSegment ?? "open");
  useEffect(() => {
    if (focusAt && focusSegment) setSeg(focusSegment);
  }, [focusAt, focusSegment]);
  const version = store.intentsVersion;
  const groups = useMemo(() => {
    const g: Record<Segment, IntentView[]> = { open: [], claimed: [], landed: [], withdrawn: [], returned: [] };
    for (const it of store.intents.values()) {
      const s = SEGMENT_OF[it.status];
      if (s) g[s].push(it);
    }
    g.open.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    g.claimed.sort((a, b) => b.updatedAt - a.updatedAt);
    g.landed.sort((a, b) => b.updatedAt - a.updatedAt);
    g.withdrawn.sort((a, b) => b.updatedAt - a.updatedAt);
    g.returned = store.repeatedReturns().map((r) => r.intent);
    return g;
    // The store mutates in place; intentsVersion is the change signal.
  }, [store, version]);
  const segments: Segment[] = ["open", "claimed", "landed"];
  if (groups.withdrawn.length > 0) segments.push("withdrawn");
  if (groups.returned.length > 0) segments.push("returned");
  const current: Segment = segments.includes(seg) ? seg : "open";
  const list = groups[current];
  const now = store.now();
  return (
    <div className="intents">
      <div className={`segments${segments.length > 3 ? " is-many" : ""}`} role="tablist" aria-label="Intents by status">
        {segments.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={current === s} className={`segment segment-${s}${current === s ? " is-on" : ""}`} onClick={() => setSeg(s)} title={SEGMENT_TITLE[s]}>
            <span className="segment-label">{s}</span>
            <span className="segment-n">{fmtInt(groups[s].length)}</span>
          </button>
        ))}
      </div>
      <ul className="intent-list" onMouseLeave={() => store.setHighlight([])}>
        {list.slice(0, LIMIT).map((it) => {
          const report = store.escalations.get(it.id);
          const open = report && !report.resolved ? report : null;
          const returns = store.returns.get(it.id)?.n ?? 0;
          // What beat its latest change, while the intent is still to do (the colony's movedBy).
          const moved = it.status !== "landed" && it.status !== "withdrawn" ? (store.returns.get(it.id)?.movedBy ?? null) : null;
          return (
            <li
              key={it.id}
              className={`intent intent-${it.status}${open ? " has-report" : ""}`}
              tabIndex={0}
              onMouseEnter={() => store.setHighlight(it.footprint)}
              onFocus={() => store.setHighlight(it.footprint)}
              onBlur={() => store.setHighlight([])}
              onClick={() => onPick(it.footprint[0] ?? null)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                // The row's own key: a replay's space-to-pause does not see it.
                e.preventDefault();
                e.stopPropagation();
                onPick(it.footprint[0] ?? null);
              }}
              title={it.withdrawnReason ? `Withdrawn: ${it.withdrawnReason}` : undefined}
            >
              <div className="intent-title">
                {it.revision > 1 ? (
                  <span className="rev-badge" title={`Amended ${it.revision - 1} time${it.revision === 2 ? "" : "s"}: uncommitted changes built on older revisions are stopped; one already committed is reported with its landing`}>
                    r{it.revision}
                  </span>
                ) : null}
                {it.title}
              </div>
              <div className="intent-meta">
                {it.source ? <span className={`src src-${it.source}`}>{it.source}</span> : null}
                {open ? (
                  <span className="ibadge ibadge-report" title={`${store.agentName(open.agentId)} reported: ${open.report}`}>
                    report · {KIND_LABEL[open.kind] ?? open.kind}
                  </span>
                ) : null}
                {it.contest && it.contest >= 2 ? (
                  <span className="ibadge ibadge-contest" title={`Contest: up to ${it.contest} agents build it at once, and the colony lands one of their changes`}>
                    contest ×{it.contest}
                  </span>
                ) : null}
                {returns >= REPEATED_RETURNS && it.status !== "landed" && it.status !== "withdrawn" ? (
                  <span className="ibadge ibadge-returned" title={store.returns.get(it.id)?.reason ?? "Returned to its agent"}>
                    returned {fmtInt(returns)}×
                  </span>
                ) : null}
                {moved ? <MovedBadge moved={moved} agentName={(id) => store.agentName(id)} /> : null}
                <span className="mono intent-path">{it.status === "withdrawn" && it.withdrawnReason ? it.withdrawnReason : (it.footprint[0] ?? "—")}</span>
                {it.status !== "withdrawn" && it.footprint.length > 1 ? <span className="intent-more">+{it.footprint.length - 1}</span> : null}
                <span className="intent-when">
                  {it.assignedTo && current !== "open" ? `${store.agentName(it.assignedTo)} · ` : ""}
                  {timeAgo(current === "open" ? it.createdAt : it.updatedAt, now)}
                </span>
              </div>
            </li>
          );
        })}
        {list.length > LIMIT ? <li className="more">+{fmtInt(list.length - LIMIT)} more</li> : null}
        {!list.length ? <li className="empty">{EMPTY[current]}</li> : null}
      </ul>
    </div>
  );
}
