import type { CheckResult, Colony, Direction, FileVersion, LineageNote, NoteDecision, Rule } from "@fire_trident/core";
import { decisionSpeaker, landingAnswerable, landingConfirmed, speaker } from "@fire_trident/core";
import { useEffect, useState } from "react";
import { agentsOn, waitingWhy } from "../agents.ts";
import type { Backend, WhyEntry } from "../api.ts";
import { basename, dirname, fmtFixed, fmtInt, plural, shortId, shortSha, timeAgo } from "../format.ts";
import type { ColonyStore } from "../store.ts";
import { FIELD_COLOR, KINDS, LAYER_COLOR, intensity, KIND_INDEX } from "../theme.ts";
import { decisionsFromChecks, type DecisionStep } from "../decisions.ts";
import { alternativesOf, provenanceOf, revalidatedOf, type Alternative, type ProvenanceView, type Revalidation } from "../lineage.ts";
import { useThrottledVersion } from "../useStore.ts";
import { certCounts, certTitle } from "../certs.ts";
import { NoteBar } from "./NoteSeal.tsx";
import { acceptanceOf } from "../acceptance.ts";
import { AcceptanceLines } from "./AcceptanceLines.tsx";
import { AnswerableLine, EvidenceList, SaidBy } from "./SaidBy.tsx";
import { LandingTestsRow } from "./TestsRow.tsx";
import { AUTO_ROWS } from "../tests.ts";
import { ConfirmedLine, DecidesFold, useDecides } from "./Decides.tsx";

type NoteProposal = LineageNote["proposals"][number];

interface WhyState {
  path: string;
  line: number | null;
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

/** Copies a link that reopens this colony on this file's lineage (?path=, and &line= when a line is selected). */
function CopyLink({ path, line }: { path: string; line: number | null }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    const url = `${location.origin}${location.pathname}?path=${encodeURIComponent(path)}${line ? `&line=${line}` : ""}`;
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
  const line = path ? store.selectedLine : null;
  const [state, setState] = useState<WhyState | null>(null);
  // How the colony decides (Decides.tsx), folded above the landing cards.
  const decides = useDecides(store.colonyId, backend.mode);

  // Refetch when a new landing touches this path.
  const touchedBy = path ? (store.lastLandingOn(path)?.id ?? "") : "";

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState((s) => ({ path, line, entries: s?.path === path && s.line === line ? s.entries : null, error: null, loading: true }));
    backend
      .why(path, line ?? undefined)
      .then((entries) => {
        // For a line, the server puts the landing that wrote it first when it finds one: keep its order.
        const sorted = line ? [...entries] : [...entries].sort((a, b) => (b.landing?.at ?? 0) - (a.landing?.at ?? 0));
        if (!cancelled) setState({ path, line, entries: sorted, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ path, line, entries: null, error: err instanceof Error ? err.message : "lineage unavailable", loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [path, line, backend, touchedBy]);

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
  const current = state?.path === path && state.line === line ? state : null;
  const here = agentsOn(store, path, 3);
  // As `ft why` reads it: the server only moves the line's landing ahead of newer ones, so a newer one after the first means it did.
  const first = current?.entries?.[0]?.landing?.at ?? 0;
  const owner = !!line && !!current?.entries?.slice(1).some((e) => (e.landing?.at ?? 0) > first);
  return (
    <div className="why">
      <div className="why-head">
        <div className="k">Lineage of</div>
        <div className="why-path mono">
          <span className="why-dir">{dirname(path)}</span>
          {basename(path)}
          {line ? <span className="why-line">:{line}</span> : null}
        </div>
        {line && current?.entries?.length ? (
          <div className="why-order">{owner ? `The landing that wrote line ${line} comes first, then the newest.` : `Line ${line}: the landings that changed this file, newest first.`}</div>
        ) : null}
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
        {here.total ? (
          <div className="why-agents">
            <div className="k">On this file now</div>
            {here.list.map((a) => {
              const waits = waitingWhy(store, a);
              return (
                <div className="why-agent" key={a.id}>
                  <span className="mono why-agent-name">{a.name}</span>
                  <span className={`tip-state tip-state-${a.state}`}>{a.state}</span>
                  {a.model ? <span className="mono why-agent-model">{a.model}</span> : null}
                  {a.note ? <span className="why-agent-note">“{a.note}”</span> : null}
                  {waits ? <span className="why-agent-why">{waits}</span> : null}
                </div>
              );
            })}
            {here.total > here.list.length ? <div className="why-agent-more">and {fmtInt(here.total - here.list.length)} more</div> : null}
          </div>
        ) : null}
        {director ? null : (
          <div className="why-actions">
            <button type="button" className="link" onClick={() => store.select(null)}>
              Clear selection
            </button>
            <CopyLink path={path} line={line} />
          </div>
        )}
      </div>
      <DecidesFold d={decides} colonyId={store.colony?.id ?? store.colonyId} />
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
          <LineageEntry key={e.landing.id} entry={e} path={path} store={store} newest={i === 0} backend={backend} tests={i < AUTO_ROWS} />
        ))}
      </div>
    </div>
  );
}

function LineageEntry({ entry, path, store, newest, backend, tests }: { entry: WhyEntry; path: string; store: ColonyStore; newest: boolean; backend: Backend; tests: boolean }) {
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
        <LineageCert store={store} sha={landing.trunkSha} note={note?.certification} />
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
      {/* The note's integrity badge and this landing's change to the file (NoteSeal.tsx); keyed so another file starts closed. */}
      <NoteBar key={path} backend={backend} landingId={landing.id} path={path} />
      {/* Who answers for this landing, from its whole note (core/answerable.ts). */}
      <AnswerableLine a={landingAnswerable(note)} />
      {/* The rule that confirmed it, with the values it used (core/decides.ts). */}
      <ConfirmedLine c={landingConfirmed(note)} />
      {/* Its tests at its base against the certified commit (TestsRow.tsx): read as the card opens for the newest, on a click for the rest. */}
      <LandingTestsRow backend={backend} landingId={landing.id} auto={tests} />
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

/** This commit's own tests (trunk certification), live from the store or from its lineage note. */
function LineageCert({ store, sha, note }: { store: ColonyStore; sha: string; note: LineageNote["certification"] }) {
  const live = store.certs.get(sha);
  const cert = live ?? (note ? { ...note, trunkSha: sha, at: note.finishedAt ?? 0 } : undefined);
  if (!cert || (cert.status !== "green" && cert.status !== "red")) return null;
  const green = cert.status === "green";
  return (
    <span className={`lin-cert ${green ? "is-green" : "is-red"}`} title={certTitle(cert)}>
      {green ? "✓" : "✗"} {certCounts(cert)}
    </span>
  );
}

/** Lowercase, collapsed whitespace, no trailing punctuation (rule intent titles drop it too): for spotting a line the title already says. */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/[\s.,;:!?…]+$/u, "").trim();

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

/** The direction a change was built under: the intent revision, its amendments, the human directives, the agent's note. */
function DirectionStep({ d }: { d: Direction }) {
  const revisions = Array.isArray(d.revisions) ? d.revisions : [];
  const directives = Array.isArray(d.directives) ? d.directives : [];
  return (
    <div className="lin-step">
      <span className="node node-direction" />
      <div className="lin-body">
        <div className="lin-k">Direction</div>
        <div className="lin-dir">
          Built on <span className="rev-badge">r{d.intentRevision}</span>
          {revisions.length ? `amended ${plural(revisions.length, "time")}` : "the intent as first declared"}
        </div>
        {revisions.map((r) => (
          <div className="lin-dir-row" key={`r${r.revision}`} title={r.reason}>
            <span className="lin-chip">r{r.revision}</span>
            {(r.changed ?? []).join(", ")} changed by <b>{r.by}</b> {r.at ? <span className="lin-dir-when">{timeAgo(r.at)}</span> : null}
            <SaidBy s={decisionSpeaker({ layer: "human", by: r.by })} />
            <span className="lin-dir-why">“{r.reason}”</span>
          </div>
        ))}
        {directives.map((g) => (
          <div className="lin-dir-row" key={g.id} title={g.message}>
            <span className="lin-chip lin-chip-dir">directive</span>
            <span className="lin-dir-why">“{g.message}”</span> from <b>{g.by}</b> {g.at ? <span className="lin-dir-when">{timeAgo(g.at)}</span> : null}
            <SaidBy s={decisionSpeaker({ layer: "human", by: g.by })} />
          </div>
        ))}
        {d.note ? (
          <div className="lin-dir-note">
            <SaidBy s={speaker("agent")} /> Agent said: “{d.note}”
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Contest mode: the other attempts at the same intent, and why each lost to this one. */
function ContestStep({ alternatives, store }: { alternatives: Alternative[]; store: ColonyStore }) {
  return (
    <div className="lin-step">
      <span className="node node-contest" />
      <div className="lin-body">
        <div className="lin-k">Contest</div>
        <div className="lin-dir">
          Chosen over {plural(alternatives.length, "other attempt")} at the same intent
        </div>
        {alternatives.map((a, i) => (
          <div className="lin-dir-row" key={`${a.proposalId}:${i}`}>
            <span className="lin-chip lin-chip-contest" title={a.proposalId}>
              {a.proposalId ? shortId(a.proposalId) : "attempt"}
            </span>
            <b>{a.agentId ? store.agentName(a.agentId) : "an agent"}</b>
            {a.model ? <span className="mono lin-dir-when lin-alt-model">{a.model}</span> : null}
            {a.reason ? <span className="lin-dir-why">{a.reason}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Assumption revalidation: files that changed after this change read them, and the imported names that still held. */
function RevalidatedStep({ items }: { items: Revalidation[] }) {
  return (
    <div className="lin-step">
      <span className="node node-revalidated" />
      <div className="lin-body">
        <div className="lin-k">Revalidated</div>
        <div className="lin-dir">Landed although {items.length === 1 ? "a file it read" : "files it read"} changed: what it imports still holds</div>
        {items.map((r) => (
          <div className="lin-dir-row" key={r.path}>
            <span className="mono">{r.path}</span>{" "}
            <span className="mono lin-dir-when">
              {r.read ? shortSha(r.read) : "absent"} → {r.landedOn ? shortSha(r.landedOn) : "deleted"}
            </span>
            <span className="lin-dir-why">{r.names.length ? `Still exported: ${r.names.join(", ")}` : "It imports nothing from this file."}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** How the author and model of a change are known: observed by FireTrident, or declared by the agent (the note's provenance). */
function ProvenanceLine({ v }: { v: ProvenanceView }) {
  return (
    <div className={`lin-prov is-${v.level}`}>
      <span className="lin-prov-label">{v.label}</span>
      {v.detail ? <span className="lin-prov-detail">{v.detail}</span> : null}
      <span className="lin-prov-author">{v.author}</span>
    </div>
  );
}

/** The deterministic proof's verdict when it decided alone (from the evidence's gate check), else null. */
function deterministicStep(checks: readonly CheckResult[]): { action: string; detail?: string } | null {
  const gate = checks.find((c) => c.name === "gate");
  const m = gate?.detail ? /→ (\S+) by (\S+)/.exec(gate.detail) : null;
  if (!m || m[2] !== "deterministic") return null;
  const proof = checks.find((c) => c.name.startsWith("deterministic"));
  return { action: m[1] ?? "land", ...(proof?.detail ? { detail: proof.detail } : {}) };
}

function ProposalChain({ p, path, store }: { p: NoteProposal; path: string; store: ColonyStore }) {
  const ruleId = p.intent?.ruleId;
  const checks = p.evidence?.checks ?? [];
  // Recorded decisions, else the chain the reflex and LLM layers wrote into the evidence.
  const recorded: Array<NoteDecision | DecisionStep> = p.decisions ?? [];
  const decisions = recorded.length ? recorded : decisionsFromChecks(p.evidence?.checks);
  const proof = deterministicStep(checks);
  const direction = p.evidence?.direction;
  const alternatives = alternativesOf(p);
  const revalidated = revalidatedOf(p);
  const provenance = provenanceOf(p);
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
      {direction && typeof direction.intentRevision === "number" ? <DirectionStep d={direction} /> : null}
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
          {provenance ? <ProvenanceLine v={provenance} /> : null}
        </div>
      </div>
      {alternatives.length ? <ContestStep alternatives={alternatives} store={store} /> : null}
      <div className="lin-step">
        <span className="node node-decision" />
        <div className="lin-body">
          <div className="lin-k">Decisions</div>
          {proof ? (
            <div className="dec" title={proof.detail}>
              <span className="dec-layer" style={{ color: FIELD_COLOR.trail, borderColor: FIELD_COLOR.trail }}>
                proof
              </span>
              <span className="dec-what">
                deterministic → <b>{proof.action}</b> <SaidBy s={decisionSpeaker({ layer: "proof" })} />
              </span>
              <span className="dec-bar">
                <b style={{ width: "100%", background: FIELD_COLOR.trail }} />
              </span>
              <span className="mono dec-p">no model</span>
            </div>
          ) : null}
          {decisions.length ? (
            decisions.map((d, i) => {
              const color = LAYER_COLOR[d.layer] ?? "#8b97a8";
              const has = Number.isFinite(d.p);
              const pv = has ? Math.max(0, Math.min(1, d.p)) : 0;
              const note = d as NoteDecision;
              return (
                <div key={i}>
                  <div className="dec" title={note.question}>
                    <span className="dec-layer" style={{ color, borderColor: color }}>
                      {d.layer}
                    </span>
                    <span className="dec-what">
                      {d.kind} → <b>{d.action}</b> <SaidBy s={decisionSpeaker(note)} />
                    </span>
                    <span className="dec-bar">{has ? <b style={{ width: `${Math.round(pv * 100)}%`, background: color }} /> : null}</span>
                    <span className="mono dec-p">{has ? `p ${pv.toFixed(2)}` : ""}</span>
                  </div>
                  {note.answer ? <div className="dec-answer">{note.answer}</div> : null}
                  <AcceptanceLines rows={acceptanceOf(note)} />
                </div>
              );
            })
          ) : proof ? null : (
            <div className="lin-muted">No decisions were recorded with this change.</div>
          )}
        </div>
      </div>
      <div className="lin-step">
        <span className="node node-evidence" />
        <div className="lin-body">
          <div className="lin-k">Evidence</div>
          {/* Who said each line (core/answerable.ts): FireTrident's checks first, then models, then the agent's claims. */}
          <div className="evid">
            <EvidenceList evidence={p.evidence} path={path} />
          </div>
          {p.evidence?.previewUrl ? (
            <span className="lin-preview-row">
              <a className="link lin-preview" href={p.evidence.previewUrl} target="_blank" rel="noreferrer">
                Preview
              </a>{" "}
              <SaidBy s={speaker("agent")} />
            </span>
          ) : null}
        </div>
      </div>
      {revalidated.length ? <RevalidatedStep items={revalidated} /> : null}
      <div className="lin-step lin-last">
        <span className="node node-sets" />
        <div className="lin-body">
          <BlobSets writeSet={p.writeSet ?? []} readSet={p.readSet ?? []} path={path} />
        </div>
      </div>
    </div>
  );
}
