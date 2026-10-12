import type { Colony, FileVersion, LineageNote, Rule } from "@fire_trident/core";
import { useEffect, useState } from "react";
import type { Backend, WhyEntry } from "../api.ts";
import { basename, dirname, fmtFixed, fmtInt, fmtMs, plural, shortId, shortSha, timeAgo } from "../format.ts";
import type { ColonyStore } from "../store.ts";
import { FIELD_COLOR, KINDS, LAYER_COLOR, intensity, KIND_INDEX } from "../theme.ts";
import { decisionsFromChecks } from "../decisions.ts";
import { useThrottledVersion } from "../useStore.ts";

type NoteProposal = LineageNote["proposals"][number];

interface WhyState {
  path: string;
  entries: WhyEntry[] | null;
  error: string | null;
  loading: boolean;
}

/**
 * A web link to a trunk commit when the colony advertises one (a `commitUrl` template with
 * {sha}, or a browsable mirror). Artifacts remotes are git endpoints, not pages, so most
 * colonies have none and the commit is shown on the map instead.
 */
function commitLink(colony: Colony | null, sha: string): string | null {
  const c = colony as (Colony & { commitUrl?: unknown; mirror?: unknown; web?: unknown }) | null;
  if (!c || !sha) return null;
  if (typeof c.commitUrl === "string" && c.commitUrl.includes("{sha}")) return c.commitUrl.replace("{sha}", sha);
  const mirror = c.mirror as { web?: unknown; url?: unknown } | string | undefined;
  const web = typeof mirror === "string" ? mirror : typeof mirror?.web === "string" ? mirror.web : typeof c.web === "string" ? c.web : null;
  return web && /^https:\/\//.test(web) ? `${web.replace(/\.git$/, "").replace(/\/$/, "")}/commit/${sha}` : null;
}

/** Copies a link that reopens this colony on this file's lineage (?path=). */
function CopyLink({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    const url = `${location.origin}${location.pathname}?path=${encodeURIComponent(path)}`;
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      })
      .catch(() => undefined);
  };
  return (
    <button type="button" className="link" onClick={copy} title="Copy a link to this file's lineage">
      {done ? "Link copied" : "Copy link"}
    </button>
  );
}

/** Lineage of one file: each landing that touched it, back through intent, rule, agent, decisions, and evidence. */
export function WhyTab({ store, backend, director = false }: { store: ColonyStore; backend: Backend; director?: boolean }) {
  useThrottledVersion(store, 400);
  const path = store.selectedPath;
  const [state, setState] = useState<WhyState | null>(null);

  // Refetch when a new landing touches this path.
  const touchedBy = path ? (store.lastLandingOn(path)?.id ?? "") : "";

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState((s) => ({ path, entries: s?.path === path ? s.entries : null, error: null, loading: true }));
    backend
      .why(path)
      .then((entries) => {
        const sorted = [...entries].sort((a, b) => (b.landing?.at ?? 0) - (a.landing?.at ?? 0));
        if (!cancelled) setState({ path, entries: sorted, error: null, loading: false });
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
          <div>Click any file on the map to trace the commits that shaped it: the intent behind each one, the rule and who approved it, the agent and model that wrote it, the decisions on the way, and the evidence it landed with.</div>
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
        {director ? null : (
          <div className="why-actions">
            <button type="button" className="link" onClick={() => store.select(null)}>
              Clear selection
            </button>
            <CopyLink path={path} />
          </div>
        )}
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
      <div className="lineage">
        {current?.entries?.map((e, i) => (
          <LineageEntry key={e.landing.id} entry={e} path={path} store={store} newest={i === 0} />
        ))}
      </div>
    </div>
  );
}

function LineageEntry({ entry, path, store, newest }: { entry: WhyEntry; path: string; store: ColonyStore; newest: boolean }) {
  const { landing, note } = entry;
  const proposals = note?.proposals ?? [];
  const relevant = proposals.filter((p) => p.writeSet?.some((w) => w.path === path));
  const shown = relevant.length ? relevant : proposals;
  const others = proposals.length - shown.length;
  const [copied, setCopied] = useState(false);
  const href = commitLink(store.colony, landing.trunkSha);
  const paths = landing.paths ?? [];
  const onMap = store.highlight.length > 0 && store.highlight.length === paths.length && paths.every((p) => store.highlight.includes(p));
  const copy = () => {
    navigator.clipboard
      ?.writeText(landing.trunkSha)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => undefined);
  };
  return (
    <article className={`lin${newest ? " is-newest" : ""}`}>
      <div className="lin-commit">
        <span className="node node-commit" />
        <span className="lin-k">Commit</span>
        {href ? (
          <a className="mono lin-sha" href={href} target="_blank" rel="noreferrer" title={landing.trunkSha}>
            {shortSha(landing.trunkSha)}
          </a>
        ) : (
          <button type="button" className="mono lin-sha lin-sha-btn" title={`${landing.trunkSha}\nClick to copy`} onClick={copy}>
            {copied ? "copied" : shortSha(landing.trunkSha)}
          </button>
        )}
        {landing.parentSha ? <span className="mono lin-parent-sha" title={`parent ${landing.parentSha}`}>← {shortSha(landing.parentSha)}</span> : null}
        <span className="lin-when">{timeAgo(landing.at)}</span>
        <button
          type="button"
          className={`lin-map${onMap ? " is-on" : ""}`}
          onClick={() => store.setHighlight(onMap ? [] : paths)}
          title="Outline every file this commit changed"
          disabled={!paths.length}
        >
          {plural(paths.length, "file")} · {plural(landing.proposalIds?.length ?? proposals.length, "proposal")}
        </button>
      </div>
      {shown.map((p) => (
        <ProposalChain key={p.id} p={p} path={path} store={store} />
      ))}
      {others > 0 ? (
        <div className="lin-others">
          +{others} other {others === 1 ? "proposal" : "proposals"} landed in this commit
        </div>
      ) : null}
    </article>
  );
}

/** Lowercase, collapsed whitespace, no trailing period: for spotting a line the title already says. */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();

/** The why text, with "Hint:" lines set apart and lines the title already says left out. */
function WhyText({ text, title }: { text: string; title: string }) {
  const said = norm(title);
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !said.includes(norm(l)));
  return (
    <div className="lin-why">
      {lines.map((line, i) => {
        const hint = /^hint:\s*/i.exec(line);
        if (hint) {
          return (
            <div className="lin-hint" key={i}>
              <span className="lin-hint-k">Hint</span>
              {line.slice(hint[0].length)}
            </div>
          );
        }
        return (
          <div className={i === 0 ? "lin-why-lead" : "lin-why-more"} key={i}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

function RuleLine({ rule, ruleId, named }: { rule: Rule | undefined; ruleId: string; named: boolean }) {
  if (!rule) {
    return (
      <div className="lin-body">
        <div className="lin-k">Rule</div>
        <div className="lin-rule-name mono">{shortId(ruleId)}</div>
      </div>
    );
  }
  return (
    <div className="lin-body">
      <div className="lin-k">Rule</div>
      {named ? null : <div className="lin-rule-name">{rule.description}</div>}
      <div className="lin-rule-meta">
        <span className="lin-chip">{rule.kind}</span>
        <span>
          approved by <b className="lin-approver">{rule.approvedBy || "unknown"}</b>
        </span>
        {rule.createdAt ? <span>{timeAgo(rule.createdAt)}</span> : null}
      </div>
    </div>
  );
}

/** Write set against read set: base blob → new blob for each written file. */
function BlobSets({ writeSet, readSet, path }: { writeSet: FileVersion[]; readSet: FileVersion[]; path: string }) {
  const [all, setAll] = useState(false);
  const read = new Map(readSet.map((r) => [r.path, r.blob]));
  const writes = [...writeSet].sort((a, b) => (a.path === path ? -1 : b.path === path ? 1 : a.path.localeCompare(b.path)));
  const reads = [...readSet].sort((a, b) => (a.path === path ? -1 : b.path === path ? 1 : a.path.localeCompare(b.path)));
  const LIMIT = 5;
  const w = all ? writes : writes.slice(0, LIMIT);
  const r = all ? reads : reads.slice(0, LIMIT);
  const hidden = writes.length - w.length + (reads.length - r.length);
  return (
    <div className="blobs">
      <div className="blobs-k">
        Wrote <span>{fmtInt(writeSet.length)}</span>
      </div>
      {w.map((f) => {
        const base = read.get(f.path);
        return (
          <div className={`blob${f.path === path ? " is-this" : ""}`} key={`w:${f.path}`} title={`${f.path}\n${base ?? "new"} → ${f.blob ?? "deleted"}`}>
            <span className="blob-path mono">{f.path}</span>
            <span className="blob-ids mono">
              {base ? <span className="blob-old">{shortSha(base)}</span> : <span className="blob-new">new</span>}
              <span className="blob-arrow">→</span>
              {f.blob ? <span className="blob-cur">{shortSha(f.blob)}</span> : <span className="blob-del">deleted</span>}
            </span>
          </div>
        );
      })}
      <div className="blobs-k">
        Read <span>{fmtInt(readSet.length)}</span>
        <em>validated against trunk at landing</em>
      </div>
      {r.map((f) => (
        <div className={`blob${f.path === path ? " is-this" : ""}`} key={`r:${f.path}`} title={`${f.path}\n${f.blob ?? "absent"}`}>
          <span className="blob-path mono">{f.path}</span>
          <span className="blob-ids mono">{f.blob ? shortSha(f.blob) : "absent"}</span>
        </div>
      ))}
      {hidden > 0 ? (
        <button type="button" className="link blob-more" onClick={() => setAll(true)}>
          Show {fmtInt(hidden)} more
        </button>
      ) : null}
    </div>
  );
}

function ProposalChain({ p, path, store }: { p: NoteProposal; path: string; store: ColonyStore }) {
  const ruleId = p.intent?.ruleId;
  const checks = p.evidence?.checks ?? [];
  // Recorded decisions, else the chain the reflex and LLM layers wrote into the evidence.
  const recorded = p.decisions ?? [];
  const decisions = recorded.length ? recorded : decisionsFromChecks(p.evidence?.checks);
  const residual = p.evidence?.residual ?? [];
  const agentName = store.agentName(p.agentId);
  const title = p.intent?.title ?? "Untitled intent";
  const rule = ruleId ? store.rules.get(ruleId) : undefined;
  // Rule intents are titled "<rule> in <path>": the rule step then needs only who approved it.
  const named = !!rule?.description && norm(title).includes(norm(rule.description));
  return (
    <div className="lin-chain">
      <div className="lin-step">
        <span className="node node-intent" />
        <div className="lin-body">
          <div className="lin-k">
            Intent
            {p.intent?.parentId ? <span className="lin-parent mono">follows {shortId(p.intent.parentId)}</span> : null}
          </div>
          <div className="lin-title">{title}</div>
          {p.intent?.why ? <WhyText text={p.intent.why} title={title} /> : null}
        </div>
      </div>
      {ruleId ? (
        <div className="lin-step">
          <span className="node node-rule" />
          <RuleLine rule={rule} ruleId={ruleId} named={named} />
        </div>
      ) : null}
      <div className="lin-step">
        <span className="node node-agent" />
        <div className="lin-body">
          <div className="lin-k">Agent</div>
          <div className="lin-agent">
            <span className="mono lin-agent-name" title={p.agentId}>
              {agentName}
            </span>
            <span className={`kind kind-${p.agentKind}`}>{p.agentKind}</span>
          </div>
          {p.model ? <div className="mono lin-model">{p.model}</div> : null}
        </div>
      </div>
      <div className="lin-step">
        <span className="node node-decision" />
        <div className="lin-body">
          <div className="lin-k">Decisions</div>
          {decisions.length ? (
            decisions.map((d, i) => {
              const color = LAYER_COLOR[d.layer] ?? "#8b97a8";
              const has = Number.isFinite(d.p);
              const pv = has ? Math.max(0, Math.min(1, d.p)) : 0;
              return (
                <div className="dec" key={i}>
                  <span className="dec-layer" style={{ color, borderColor: color }}>
                    {d.layer}
                  </span>
                  <span className="dec-what">
                    {d.kind} → <b>{d.action}</b>
                  </span>
                  <span className="dec-bar">{has ? <b style={{ width: `${Math.round(pv * 100)}%`, background: color }} /> : null}</span>
                  <span className="mono dec-p">{has ? `p ${pv.toFixed(2)}` : ""}</span>
                </div>
              );
            })
          ) : (
            <div className="lin-muted">No decisions were recorded with this change.</div>
          )}
        </div>
      </div>
      <div className="lin-step">
        <span className="node node-evidence" />
        <div className="lin-body">
          <div className="lin-k">Evidence</div>
          {checks.length ? (
            <div className="evid">
              {checks.map((c, i) => (
                <div className={`evid-row ${c.ok ? "is-ok" : "is-bad"}`} key={`${c.name}-${i}`}>
                  <span className="evid-mark">{c.ok ? "✓" : "✕"}</span>
                  <span className="evid-name" title={c.name}>
                    {c.name.replace(path, basename(path))}
                  </span>
                  <span className="evid-ms mono">{fmtMs(c.ms)}</span>
                  {c.detail ? <span className="evid-detail">{c.detail}</span> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="lin-muted">No checks recorded.</div>
          )}
          {residual.length ? (
            <div className="lin-residual">
              <span className="lin-chip lin-chip-need">residual</span>
              <span className="mono">{residual.join(", ")}</span>
            </div>
          ) : null}
          {p.evidence?.notVerified ? (
            <div className="nv">
              <span className="nv-k">Not verified</span>
              <span className="nv-text">{p.evidence.notVerified}</span>
            </div>
          ) : null}
          {p.evidence?.previewUrl ? (
            <a className="link lin-preview" href={p.evidence.previewUrl} target="_blank" rel="noreferrer">
              Preview
            </a>
          ) : null}
        </div>
      </div>
      <div className="lin-step lin-last">
        <span className="node node-sets" />
        <div className="lin-body">
          <BlobSets writeSet={p.writeSet ?? []} readSet={p.readSet ?? []} path={path} />
        </div>
      </div>
    </div>
  );
}
