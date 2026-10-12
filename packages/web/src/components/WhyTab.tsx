import type { Rule } from "@fire_trident/core";
import { useEffect, useState } from "react";
import type { Backend, WhyEntry } from "../api.ts";
import { basename, dirname, fmtFixed, fmtInt, shortId, shortSha, timeAgo } from "../format.ts";
import type { ColonyStore } from "../store.ts";
import { FIELD_COLOR, KINDS, LAYER_COLOR, intensity, KIND_INDEX } from "../theme.ts";
import { useThrottledVersion } from "../useStore.ts";

interface WhyState {
  path: string;
  entries: WhyEntry[] | null;
  error: string | null;
  loading: boolean;
}

/** Lineage of one file: each landing that touched it, back through intent, agent, decisions, and evidence. */
export function WhyTab({ store, backend }: { store: ColonyStore; backend: Backend }) {
  useThrottledVersion(store, 400);
  const path = store.selectedPath;
  const [state, setState] = useState<WhyState | null>(null);

  // Refetch when a new landing touches this path.
  let touchedBy = "";
  if (path) {
    for (let i = store.landings.length - 1, n = 0; i >= 0 && n < 40; i--, n++) {
      const l = store.landings[i];
      if (l && l.paths.includes(path)) {
        touchedBy = l.id;
        break;
      }
    }
  }

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState((s) => ({ path, entries: s?.path === path ? s.entries : null, error: null, loading: true }));
    backend
      .why(path)
      .then((entries) => {
        if (!cancelled) setState({ path, entries, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ path, entries: null, error: err instanceof Error ? err.message : "lineage unavailable", loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [path, backend, touchedBy]);

  if (!path) {
    return (
      <div className="why">
        <div className="empty-big">
          <div className="empty-title">Every change remembers why</div>
          <div>Click any file on the map to trace the commits that shaped it: the intent behind each one, the agent and model that wrote it, the decisions on the way, and the evidence it landed with.</div>
        </div>
      </div>
    );
  }

  const values = store.fieldValues(path);
  const current = state?.path === path ? state : null;
  return (
    <div className="why">
      <div className="why-head">
        <div className="k">Lineage of</div>
        <div className="why-path mono">
          <span className="why-dir">{dirname(path)}</span>
          {basename(path)}
        </div>
        <div className="why-field">
          {KINDS.map((kind) => (
            <div className={`wf${values[kind] > 0.005 ? "" : " zero"}`} key={kind} title={`${kind} ${fmtFixed(values[kind])}`}>
              <span className="wf-k">{kind}</span>
              <span className="wf-bar">
                <b style={{ width: `${Math.round(intensity(values[kind], KIND_INDEX[kind]) * 100)}%`, background: FIELD_COLOR[kind] }} />
              </span>
            </div>
          ))}
        </div>
        <button type="button" className="link" onClick={() => store.select(null)}>
          Clear selection
        </button>
      </div>
      {current?.error ? <div className="alert">Couldn't load lineage: {current.error}</div> : null}
      {!current?.entries && !current?.error ? (
        <div className="skeleton">
          <i />
          <i />
          <i />
        </div>
      ) : null}
      {current?.entries && !current.entries.length ? (
        <div className="empty-big">
          <div className="empty-title">No landings yet</div>
          <div>Nothing the colony landed has touched this file so far.</div>
        </div>
      ) : null}
      <div className="lineage">{current?.entries?.map((e) => <LineageEntry key={e.landing.id} entry={e} path={path} rules={store.rules} />)}</div>
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;
}

function LineageEntry({ entry, path, rules }: { entry: WhyEntry; path: string; rules: ReadonlyMap<string, Rule> }) {
  const { landing, note } = entry;
  const proposals = note?.proposals ?? [];
  const relevant = proposals.filter((p) => p.writeSet?.some((w) => w.path === path));
  const shown = relevant.length ? relevant : proposals;
  const others = proposals.length - shown.length;
  return (
    <article className="lin">
      <div className="lin-commit">
        <span className="node node-commit" />
        <span className="lin-k">Commit</span>
        <span className="mono lin-sha" title={landing.trunkSha}>
          {shortSha(landing.trunkSha)}
        </span>
        <span className="lin-when">{timeAgo(landing.at)}</span>
        <span className="lin-size">
          {plural(landing.proposalIds?.length ?? proposals.length, "proposal")} · {plural(landing.paths?.length ?? 0, "file")}
        </span>
      </div>
      {shown.map((p) => (
        <div className="lin-chain" key={p.id}>
          <div className="lin-step">
            <span className="node node-intent" />
            <div className="lin-body">
              <div className="lin-k">
                Intent
                {p.intent.ruleId ? (
                  <span className="lin-rule" title={p.intent.ruleId}>
                    rule · {rules.get(p.intent.ruleId)?.description ?? p.intent.ruleId}
                  </span>
                ) : null}
              </div>
              <div className="lin-title">{p.intent.title}</div>
              {p.intent.why ? <div className="lin-why">{p.intent.why}</div> : null}
              {p.intent.parentId ? <div className="lin-parent mono">follows {shortId(p.intent.parentId)}</div> : null}
            </div>
          </div>
          <div className="lin-step">
            <span className="node node-agent" />
            <div className="lin-body">
              <div className="lin-k">Agent</div>
              <div className="lin-agent">
                <span className="mono">{p.agentId}</span>
                <span className={`kind kind-${p.agentKind}`}>{p.agentKind}</span>
                {p.model ? <span className="mono lin-model">{p.model}</span> : null}
              </div>
            </div>
          </div>
          <div className="lin-step">
            <span className="node node-decision" />
            <div className="lin-body">
              <div className="lin-k">Decisions</div>
              {p.decisions?.length ? (
                p.decisions.map((d, i) => (
                  <div className="dec" key={i}>
                    <span className="dec-layer" style={{ color: LAYER_COLOR[d.layer], borderColor: LAYER_COLOR[d.layer] }}>
                      {d.layer}
                    </span>
                    <span className="dec-what">
                      {d.kind} → {d.action}
                    </span>
                    <span className="dec-bar">
                      <b style={{ width: `${Math.round(d.p * 100)}%`, background: LAYER_COLOR[d.layer] }} />
                    </span>
                    <span className="mono dec-p">{d.p.toFixed(2)}</span>
                  </div>
                ))
              ) : (
                <div className="lin-muted">No uncertain calls. It went straight through.</div>
              )}
            </div>
          </div>
          <div className="lin-step lin-last">
            <span className="node node-evidence" />
            <div className="lin-body">
              <div className="lin-k">Evidence</div>
              <div className="checks">
                {(p.evidence?.checks ?? []).map((c) => (
                  <span key={c.name} className={`check ${c.ok ? "check-ok" : "check-bad"}`} title={c.detail}>
                    {c.ok ? "✓" : "✕"} {c.name} <span className="check-ms">{(c.ms / 1000).toFixed(1)}s</span>
                  </span>
                ))}
              </div>
              {p.evidence?.residual?.length ? (
                <div className="lin-residual">
                  residual <span className="mono">{p.evidence.residual.join(", ")}</span>
                </div>
              ) : null}
              {p.evidence?.notVerified ? <div className="lin-nv">Not verified: {p.evidence.notVerified}</div> : null}
              <div className="lin-muted">
                wrote {plural(p.writeSet?.length ?? 0, "file")} · read {plural(p.readSet?.length ?? 0, "file")}
              </div>
            </div>
          </div>
        </div>
      ))}
      {others > 0 ? (
        <div className="lin-others">
          +{others} other {others === 1 ? "proposal" : "proposals"} landed in this commit
        </div>
      ) : null}
    </article>
  );
}
