import type { ColonyEvent } from "@fire_trident/core";
import { useState } from "react";
import { clock, fmtFixed, fmtInt, shortId, shortSha } from "../format.ts";
import type { ColonyStore, LoggedEvent } from "../store.ts";
import { ACCENT, FIELD_COLOR, LAYER_COLOR } from "../theme.ts";
import { useThrottledVersion } from "../useStore.ts";
import { certCounts, certTitle } from "../certs.ts";

/** Changing direction: amendments, withdrawals, retracted rules, reverted landings and human directives. */
const DIRECTION_COLOR = "#c084fc";
const STATUS_COLOR = "#9fd8ff";
const TESTS_GREEN = "#6fd9a6";
const TESTS_RED = "#ff8d98";

/** Filter chips: a key, a label, a color, and the event types the chip covers. */
const FILTERS: ReadonlyArray<[key: string, label: string, color: string, types: ReadonlyArray<ColonyEvent["t"]>]> = [
  ["landing", "Landings", FIELD_COLOR.trail, ["landing"]],
  ["decision", "Decisions", LAYER_COLOR.reflex, ["decision"]],
  ["proposal", "Proposals", LAYER_COLOR.llm, ["proposal"]],
  ["intent", "Intents", "#7cc4ff", ["intent"]],
  ["direction", "Direction", DIRECTION_COLOR, ["amended", "withdrawn", "retracted", "reverted", "directive"]],
  ["status", "Status", STATUS_COLOR, ["status"]],
  ["certify", "Tests", TESTS_GREEN, ["certify"]],
  ["agent", "Agents", "#c9d4e5", ["agent"]],
  ["violations", "Rules", FIELD_COLOR.need, ["violations"]],
  ["sigma", "Sigma", FIELD_COLOR.danger, ["sigma"]],
  ["mark", "Marks", "#8b97a8", ["mark"]],
  ["metric", "Metrics", "#8b97a8", ["metric"]],
];

/** The chip that covers each event type. */
const CHIP_OF: ReadonlyMap<string, string> = new Map(FILTERS.flatMap(([key, , , types]) => types.map((t) => [t, key] as const)));

const DEFAULT_ON: ReadonlySet<string> = new Set(["landing", "decision", "proposal", "intent", "direction", "status", "violations", "sigma", "certify"]);

/** The events worth reading at a glance; routine status steps are hidden unless the viewer asks for everything. */
function notable(e: ColonyEvent): boolean {
  switch (e.t) {
    case "proposal":
      return e.status === "escalated" || e.status === "returned" || e.status === "rejected";
    case "intent":
      // A withdrawal has its own event with the reason.
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
    case "amended":
      return {
        tag: "amended",
        color: DIRECTION_COLOR,
        text: `r${e.revision} · ${(e.changed ?? []).join(", ")} changed · ${e.title}${e.returned ? ` · ${e.returned} sent back` : ""}`,
        mono: e.by,
        title: `${e.by}: ${e.reason}`,
      };
    case "withdrawn":
      return { tag: "withdrawn", color: FIELD_COLOR.failure, text: `${e.title} · ${e.reason}`, mono: e.by, title: `${e.by}: ${e.reason}` };
    case "retracted":
      return { tag: "retracted", color: FIELD_COLOR.failure, text: `rule ${shortId(e.ruleId)} · ${fmtInt(e.withdrawn)} intents withdrawn · ${e.reason}`, mono: e.by, title: e.reason };
    case "reverted": {
      const files = `${fmtInt(e.paths.length)} file${e.paths.length === 1 ? "" : "s"}`;
      const redo = e.redo.length > 0 ? ` · ${fmtInt(e.redo.length)} intent${e.redo.length === 1 ? "" : "s"} declared again` : "";
      return { tag: "reverted", color: FIELD_COLOR.failure, text: `${shortId(e.of)} undone · ${files}${redo} · ${e.reason}`, mono: e.by, title: `${e.by}: ${e.reason}` };
    }
    case "directive":
      return { tag: "directive", color: DIRECTION_COLOR, text: `${e.by} → ${store.agentName(e.agentId)}: “${e.message}”`, mono: e.via, title: e.message };
    case "status":
      return { tag: "status", color: STATUS_COLOR, text: `${store.agentName(e.agentId)}: ${e.note}`, title: e.note };
    case "certify": {
      const cert = { trunkSha: e.trunkSha, status: e.status, at: e.at, ...(e.counts ? { counts: e.counts } : {}), ...(e.failing ? { failing: e.failing } : {}), ...(e.detail ? { detail: e.detail } : {}) };
      if (e.status === "running") return { tag: "tests", color: "#ffb469", text: "running the project's tests", mono: shortSha(e.trunkSha) };
      if (e.status === "green") return { tag: "tests", color: TESTS_GREEN, text: `✓ ${certCounts(cert, "pass")}${e.reusedFrom ? " (same tested files)" : ""}`, mono: shortSha(e.trunkSha), title: certTitle(cert) };
      if (e.status === "red") return { tag: "tests", color: TESTS_RED, text: `✗ ${certCounts(cert)}: ${(e.failing ?? []).map((f) => f.name).slice(0, 3).join(", ")}`, mono: shortSha(e.trunkSha), title: certTitle(cert) };
      return { tag: "tests", color: "#8b97a8", text: `${e.status}${e.detail ? ` · ${e.detail}` : ""}`, mono: shortSha(e.trunkSha), title: e.detail };
    }
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
  const live = store.recentEvents((e) => on.has(CHIP_OF.get(e.t) ?? e.t) && (everything || notable(e)), 100);
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
        {FILTERS.map(([key, label, color, types]) => (
          <button key={key} type="button" className={`chip${on.has(key) ? " is-on" : ""}`} onClick={() => toggle(key)} aria-pressed={on.has(key)}>
            <i style={{ background: color }} />
            {label}
            <span className="chip-n">{fmtInt(types.reduce((n, t) => n + (store.typeCounts.get(t) ?? 0), 0))}</span>
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
