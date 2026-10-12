import type { ColonyEvent } from "@fire_trident/core";
import { useState } from "react";
import { clock, fmtFixed, fmtInt, shortId, shortSha } from "../format.ts";
import type { ColonyStore, LoggedEvent } from "../store.ts";
import { ACCENT, FIELD_COLOR, LAYER_COLOR } from "../theme.ts";
import { useThrottledVersion } from "../useStore.ts";

const FILTERS: ReadonlyArray<[type: ColonyEvent["t"], label: string, color: string]> = [
  ["landing", "Landings", FIELD_COLOR.trail],
  ["decision", "Decisions", LAYER_COLOR.reflex],
  ["proposal", "Proposals", LAYER_COLOR.llm],
  ["intent", "Intents", "#7cc4ff"],
  ["agent", "Agents", "#c9d4e5"],
  ["violations", "Rules", FIELD_COLOR.need],
  ["sigma", "Sigma", FIELD_COLOR.danger],
  ["mark", "Marks", "#8b97a8"],
  ["metric", "Metrics", "#8b97a8"],
];

const DEFAULT_ON: ReadonlySet<string> = new Set(["landing", "decision", "proposal", "intent", "violations", "sigma"]);

/** The events worth reading at a glance; routine status steps are hidden unless the viewer asks for everything. */
function notable(e: ColonyEvent): boolean {
  switch (e.t) {
    case "proposal":
      return e.status === "escalated" || e.status === "returned" || e.status === "rejected";
    case "intent":
      return e.status === "open" || e.status === "claimed" || e.status === "abandoned";
    case "sigma":
      return e.sigma > 1;
    default:
      return true;
  }
}

interface Line {
  tag: string;
  color: string;
  text: string;
  mono?: string;
  title?: string;
}

const PROPOSAL_COLOR: Record<string, string> = {
  escalated: ACCENT,
  returned: FIELD_COLOR.failure,
  rejected: FIELD_COLOR.danger,
  landed: FIELD_COLOR.trail,
};

/** One readable line per event. */
function describe(le: LoggedEvent, store: ColonyStore): Line {
  const e = le.ev;
  switch (e.t) {
    case "agent":
      return { tag: e.kind === "external" ? "visitor" : "agent", color: e.kind === "external" ? "#7fe6ff" : "#c9d4e5", text: `${store.agentName(e.agentId)} ${e.state}`, mono: e.paths?.[0] };
    case "mark":
      return { tag: e.kind, color: FIELD_COLOR[e.kind], text: `${e.kind} ${fmtFixed(e.value)}`, mono: e.path };
    case "intent":
      return { tag: "intent", color: "#7cc4ff", text: `${e.status} · ${e.title}`, title: e.title };
    case "proposal": {
      const title = store.intents.get(e.intentId)?.title;
      const text = e.reason ? `${e.status} · ${e.reason}` : `${e.status}${title ? ` · ${title}` : ""}`;
      return { tag: "proposal", color: PROPOSAL_COLOR[e.status] ?? LAYER_COLOR.llm, text, mono: shortId(e.proposalId), title: e.reason ?? title };
    }
    case "landing":
      return {
        tag: "landing",
        color: FIELD_COLOR.trail,
        text: `${e.proposalIds.length} ${e.proposalIds.length === 1 ? "proposal" : "proposals"} · ${e.paths.length} ${e.paths.length === 1 ? "file" : "files"}`,
        mono: `→ ${shortSha(e.trunkSha)}`,
      };
    case "decision":
      if (e.kind === "antibody") return { tag: "antibody", color: "#ff7aa8", text: `${e.action} · learned from a rejection`, mono: `p ${fmtFixed(e.p)}` };
      return { tag: e.layer, color: LAYER_COLOR[e.layer] ?? "#8b97a8", text: `${e.kind} → ${e.action}`, mono: `p ${fmtFixed(e.p)}` };
    case "sigma":
      return { tag: "sigma", color: e.sigma > 1 ? FIELD_COLOR.danger : "#8b97a8", text: `σ ${fmtFixed(e.sigma)} in ${e.region}${e.sigma > 1 ? " · governor engaged" : ""}` };
    case "violations": {
      const d = le.delta ?? 0;
      return { tag: "rules", color: FIELD_COLOR.need, text: `${fmtInt(e.total)} violations remaining`, mono: d ? `${d > 0 ? "+" : "−"}${fmtInt(Math.abs(d))}` : undefined };
    }
    case "metric":
      return { tag: "metric", color: "#8b97a8", text: `${e.name} = ${fmtFixed(e.value)}` };
    default:
      return { tag: String((e as { t?: unknown }).t ?? "event"), color: "#8b97a8", text: "" };
  }
}

/** The live event log: newest first, color-coded, filterable; pauses while the pointer is over it. */
export function EventsTab({ store, director = false }: { store: ColonyStore; director?: boolean }) {
  useThrottledVersion(store, 250);
  const [on, setOn] = useState<ReadonlySet<string>>(DEFAULT_ON);
  const [frozen, setFrozen] = useState<LoggedEvent[] | null>(null);
  const [everything, setEverything] = useState(false);
  const live = store.recentEvents((e) => on.has(e.t) && (everything || notable(e)), 100);
  const rows = frozen ?? live;
  const toggle = (t: string) => {
    const next = new Set(on);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setOn(next);
    setFrozen(null);
  };
  return (
    <div className="events">
      {director ? null : (
      <div className="chips">
        {FILTERS.map(([t, label, color]) => (
          <button key={t} type="button" className={`chip${on.has(t) ? " is-on" : ""}`} onClick={() => toggle(t)} aria-pressed={on.has(t)}>
            <i style={{ background: color }} />
            {label}
            <span className="chip-n">{fmtInt(store.typeCounts.get(t) ?? 0)}</span>
          </button>
        ))}
      </div>
      )}
      {director ? null : (
      <div className="events-status">
        <span>{frozen ? "Paused while you read" : everything ? "Live · every event" : "Live · notable events"}</span>
        <button type="button" className="link" onClick={() => setEverything(!everything)}>
          {everything ? "Notable only" : "Show every event"}
        </button>
      </div>
      )}
      <ol className="events-list" onMouseEnter={() => setFrozen(live)} onMouseLeave={() => setFrozen(null)}>
        {rows.map((le) => {
          const line = describe(le, store);
          return (
            <li key={le.seq} className={`ev${le.history ? " is-history" : ""}`} title={le.history ? `Before this page opened · ${line.title ?? line.text}` : (line.title ?? line.text)}>
              <span className="ev-time mono">{clock(le.ev.at)}</span>
              <span className="ev-tag" style={{ color: line.color }}>
                <i style={{ background: line.color }} />
                {line.tag}
              </span>
              <span className="ev-text">{line.text}</span>
              {line.mono ? <span className="ev-mono mono">{line.mono}</span> : null}
            </li>
          );
        })}
        {!rows.length ? <li className="empty">Waiting for the colony to move…</li> : null}
      </ol>
    </div>
  );
}
