import type { DecisionLayer, Proposal } from "@fire_trident/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpError, readReviewer, readToken, type Backend, type ReviewDecision } from "../api.ts";
import { fmtInt, fmtPct, plural, shortId, timeAgo } from "../format.ts";
import { reviewOf } from "../review.ts";
import type { ColonyStore, DecisionView } from "../store.ts";
import { LAYER_COLOR } from "../theme.ts";
import { decisionsFromChecks } from "../decisions.ts";
import { useThrottledVersion } from "../useStore.ts";
import { EscalationCard } from "./EscalationCard.tsx";
import { ReviewChange } from "./ReviewChange.tsx";
import { TokenForm } from "./TokenForm.tsx";
import { VaccineMeter } from "./VaccineMeter.tsx";
import { MovedByList } from "./MovedBy.tsx";
import { MergeHold } from "./MergeHold.tsx";
import { mergeHoldOf } from "../mergehold.ts";
import { cleanContested, cleanMoved } from "../moved.ts";
import { AutonomyStrip } from "./AutonomyStrip.tsx";
import { EvidenceChips } from "./SaidBy.tsx";
import { ReviewTests } from "./ReviewTests.tsx";
import { testsPending } from "../reviewtests.ts";
import { LifecycleStrip } from "./Lifecycle.tsx";
import { lifecycleHref, reviewLifecycle } from "../lifecycle.ts";

const NONE: readonly string[] = [];

/** What happened, said back to the reviewer. */
function doneText(decision: ReviewDecision, agent: string): string {
  if (decision === "approve") return "Approved. It rejoins its lane and lands on the next cycle.";
  if (decision === "return") return `Returned to ${agent} with your reason as feedback.`;
  return "Rejected. Your reason is now an antibody: later changes to these paths are screened for it without a human.";
}

interface Antibody {
  id: string;
  question: string;
}

/** The reflex layer's evidence check ("reflex: <model>"), whose detail lists confidence, risk, and matched antibodies. */
function reflexCheck(p: Proposal) {
  return p.evidence?.checks?.find((c) => /^reflex:/i.test(c.name));
}

/** Antibodies a review item says it matched, in whatever shape the server sends, else from the reflex check's detail. */
function matchedAntibodies(p: Proposal): Antibody[] {
  const raw = (p as Proposal & { antibodies?: unknown }).antibodies ?? (p.evidence as Proposal["evidence"] & { antibodies?: unknown })?.antibodies;
  if (!Array.isArray(raw)) {
    // "...; antibodies ab_12 0.91!, ab_7 0.40" — "!" marks a match over the antibody's threshold.
    const m = /antibodies\s+([^;]+)/.exec(reflexCheck(p)?.detail ?? "");
    if (!m?.[1]) return [];
    return m[1]
      .split(",")
      .map((tok) => /^(\S+)\s+([0-9.]+)(!?)$/.exec(tok.trim()))
      .filter((x): x is RegExpExecArray => x !== null)
      .map((x) => ({ id: x[1] ?? "", question: `${x[1]} · p ${x[2]}${x[3] ? " · over its threshold" : ""}` }));
  }
  return raw
    .map((a, i): Antibody | null => {
      if (typeof a === "string") return { id: String(i), question: a };
      if (a && typeof a === "object") {
        const o = a as { id?: unknown; question?: unknown; description?: unknown };
        const q = typeof o.question === "string" ? o.question : typeof o.description === "string" ? o.description : null;
        return q ? { id: typeof o.id === "string" ? o.id : String(i), question: q } : null;
      }
      return null;
    })
    .filter((a): a is Antibody => a !== null);
}

/** The decisions made on a proposal so far: from the item itself, else from the live stream (its id and its intent's). */
function decisionPath(p: Proposal, store: ColonyStore): DecisionView[] {
  const own = (p as Proposal & { decisions?: unknown }).decisions;
  if (Array.isArray(own) && own.length) {
    return own
      .filter((d): d is DecisionView => !!d && typeof d === "object" && typeof (d as DecisionView).layer === "string")
      .map((d) => ({ kind: d.kind, layer: d.layer, p: Number.isFinite(d.p) ? d.p : 0, action: String(d.action ?? ""), at: Number.isFinite(d.at) ? d.at : 0 }));
  }
  const list = [...(store.decisions.get(p.intentId) ?? []), ...(store.decisions.get(p.id) ?? [])];
  if (list.length) return list.sort((a, b) => a.at - b.at).slice(-6);
  // Escalated before this page opened: read the chain from the evidence the reflex and LLM layers wrote.
  return decisionsFromChecks(p.evidence?.checks);
}

/** The review card's lifecycle strip, built from the queue's item. */
function ReviewLifecycle({ store, p, mode }: { store: ColonyStore; p: Proposal; mode: Backend["mode"] }) {
  const s = reviewLifecycle(store, p);
  const colonyId = store.colony?.id ?? store.colonyId;
  return <LifecycleStrip s={s} href={(l) => lifecycleHref(colonyId, s, l, mode)} now={store.now()} />;
}

const LAYER_LABEL: Record<DecisionLayer, string> = { reflex: "Reflex", llm: "LLM", human: "Human" };

function DecisionPath({ path }: { path: DecisionView[] }) {
  return (
    <div className="dpath">
      {path.map((d, i) => (
        <span className="dpath-step" key={i} style={{ borderColor: LAYER_COLOR[d.layer] ?? "#3a4558" }}>
          <b style={{ color: LAYER_COLOR[d.layer] ?? "#aab5c6" }}>{LAYER_LABEL[d.layer] ?? d.layer}</b>
          <span>
            {d.kind} → {d.action}
          </span>
          {Number.isFinite(d.p) ? <span className="mono dpath-p">p {Math.max(0, Math.min(1, d.p)).toFixed(2)}</span> : null}
        </span>
      ))}
      <span className="dpath-step dpath-you" style={{ borderColor: LAYER_COLOR.human }}>
        <b style={{ color: LAYER_COLOR.human }}>Human</b>
        <span>you decide</span>
      </span>
    </div>
  );
}

/**
 * What needs a person: agents' reports that an intent cannot be done as written (amend, withdraw or
 * dismiss), then proposals escalated to a human, code first: the change itself (danger lines and
 * files outside the footprint, then the full diff), then the decision path, checks and model
 * verdicts, and approve/return/reject.
 */
export function ReviewTab({ store, backend, director = false }: { store: ColonyStore; backend: Backend; director?: boolean }) {
  useThrottledVersion(store, 500);
  const [items, setItems] = useState<Proposal[] | null>(null);
  // Read once per fetch: the tab re-renders with the store twice a second, the queue only every few seconds.
  const views = useMemo(() => new Map((items ?? []).map((p) => [p.id, reviewOf(p)])), [items]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  // A decision the server refused for want of a token: asked for on that card, retried once the token is saved.
  const [pending, setPending] = useState<{ id: string; decision: ReviewDecision; refused: boolean } | null>(null);
  const decided = useRef(new Set<string>());
  const replay = backend.mode === "replay";
  const reports = store.openEscalations();
  const answered = store.recentlyResolved();

  const load = useCallback(async () => {
    try {
      const list = await backend.review();
      setItems(list.filter((p) => p && (p.status === "escalated" || !p.status) && !decided.current.has(p.id)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? `Couldn't load the review queue: ${err.message}` : "Couldn't load the review queue.");
    }
  }, [backend]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 12_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Tests before approval: while a card's run waits or goes, the queue is read every few seconds, so its result shows soon.
  const testing = useMemo(() => testsPending(items ?? []), [items]);
  useEffect(() => {
    if (!testing) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [testing, load]);

  const reviewVersion = store.reviewVersion;
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 350);
    return () => window.clearTimeout(timer);
  }, [reviewVersion, load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const decide = async (p: Proposal, decision: ReviewDecision) => {
    const reason = (notes[p.id] ?? "").trim();
    if (decision !== "approve" && !reason) return;
    setBusy(p.id);
    try {
      await backend.decide(p.id, decision, reason, readReviewer() || undefined);
      decided.current.add(p.id);
      setItems((cur) => (cur ? cur.filter((x) => x.id !== p.id) : cur));
      setToast(doneText(decision, store.agentName(p.agentId)));
      setError(null);
      setPending(null);
      store.setHighlight([]);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        setPending({ id: p.id, decision, refused: readToken() !== "" });
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "The decision didn't go through.");
      }
    } finally {
      setBusy(null);
    }
  };

  const f = store.funnel;
  const total = f.proof + f.reflex + f.llm + f.human;
  const handled = total ? (f.proof + f.reflex + f.llm) / total : 1;
  const vaccine = store.vaccination();

  const queued = replay ? store.reviewQueue() : (items?.length ?? 0);
  const head =
    items === null && !replay
      ? "Loading the review queue…"
      : queued + reports.length === 0
        ? "Nothing needs a human"
        : `${[queued ? plural(queued, "change") : "", reports.length ? plural(reports.length, "agent report") : ""].filter(Boolean).join(" and ")} ${queued + reports.length === 1 ? "needs" : "need"} a human`;
  return (
    <div className="review">
      <div className="review-head">
        <div className="review-count">{head}</div>
        {replay ? <div className="review-sub">A replay is read-only: it shows what waited for a person at this point in the run. Open the live colony to review.</div> : null}
        <div className="review-sub">
          {total
            ? store.settledFunnel
              ? `Proof, reflex models and LLMs settled ${fmtPct(handled, 1)} of ${fmtInt(total)} proposals. Only the ones they were unsure about reach you.`
              : `Reflex models and LLMs settled ${fmtPct(handled, 1)} of ${fmtInt(total)} decisions. Only the ones they were unsure about reach you.`
            : "Reflex models and LLMs settle every confident decision. Only the ones they are unsure about reach you."}
        </div>
        {vaccine ? (
          <div className="review-vaccine">
            <VaccineMeter v={vaccine} compact />
          </div>
        ) : null}
        {/* Earned autonomy per region (AutonomyStrip.tsx): where review relaxed, and what took it back. */}
        <AutonomyStrip backend={backend} refresh={reviewVersion} />
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      {error ? <div className="alert">{error}</div> : null}
      {reports.length || answered.length ? (
        <section className="cards report-cards" aria-label="Agents' reports">
          <div className="k">Agents' reports</div>
          {reports.map((e) => (
            <EscalationCard key={e.intentId} esc={e} store={store} backend={backend} readOnly={replay} director={director} />
          ))}
          {answered.map((e) => (
            <EscalationCard key={`${e.intentId}:${e.resolved?.at ?? 0}`} esc={e} store={store} backend={backend} readOnly director={director} />
          ))}
        </section>
      ) : null}
      <div className="cards">
        {(items ?? []).map((p) => {
          const intent = store.intents.get(p.intentId);
          const residual = p.evidence?.residual ?? [];
          const declared = p.declared?.footprint ?? [];
          const paths = [...residual, ...declared];
          const reason = notes[p.id] ?? "";
          const hasReason = reason.trim().length > 0;
          const path = decisionPath(p, store);
          const antibodies = matchedAntibodies(p);
          const view = views.get(p.id) ?? null;
          const held = mergeHoldOf(p);
          const winner = typeof p.supersededBy === "string" && p.supersededBy ? p.supersededBy : store.superseded.get(p.id);
          // What beat the intent's last change (the queue's lastReturn, else a return this page saw): the landings this one was redone on.
          const moved = cleanMoved((p as Proposal & { lastReturn?: { movedBy?: unknown } }).lastReturn?.movedBy) ?? store.returns.get(p.intentId)?.movedBy ?? null;
          // Return hunks (FT_RETURN_HUNKS): the last change's contested regions, when the queue quoted them.
          const contested = cleanContested((p as Proposal & { lastReturn?: { contested?: unknown } }).lastReturn?.contested) ?? null;
          return (
            <article key={p.id} className="card" onMouseEnter={() => store.setHighlight(paths)} onMouseLeave={() => store.setHighlight([])}>
              <header className="card-head">
                <span className="pill pill-escalated">Escalated</span>
                <span className="mono card-id" title={p.id}>
                  {shortId(p.id)}
                </span>
                {winner ? (
                  <span className="pill pill-superseded" title={`Another attempt at this intent landed instead: ${winner}`}>
                    superseded by {shortId(winner)}
                  </span>
                ) : null}
                <span className="card-when">{timeAgo(p.createdAt)}</span>
              </header>
              <h3 className="card-title">
                {intent?.title ?? p.declared?.summary ?? p.intentId}
                {intent?.contest && intent.contest >= 2 ? <span className="ibadge ibadge-contest card-badge">contest ×{intent.contest}</span> : null}
              </h3>
              <div className="card-meta">
                by <span className="mono">{store.agentName(p.agentId)}</span> · wrote {fmtInt(p.writeSet?.length ?? 0)} · read {fmtInt(p.readSet?.length ?? 0)}
              </div>
              {/* Tests before approval: the colony's tests on the change at its base lead what a person reads. */}
              <ReviewTests item={p} backend={backend} readOnly={replay} director={director} onAsked={() => void load()} />
              {/* Its lifecycle strip: how far it came, and that it waits for a person (Lifecycle.tsx, core/lifecycle.ts). */}
              <ReviewLifecycle store={store} p={p} mode={backend.mode} />
              {moved || contested ? <MovedByList moved={moved ?? []} contested={contested ?? []} agentName={(id) => store.agentName(id)} /> : null}
              {/* Merge locks: the merge a person is asked to approve, read before the change itself. */}
              {held ? <MergeHold files={held} /> : null}
              {view ? (
                <>
                  <ReviewChange view={view} declared={p.declared?.footprint ?? NONE} />
                  {p.reason ? <p className="card-reason">{p.reason}</p> : null}
                </>
              ) : (
                <>
                  {p.reason ? <p className="card-reason">{p.reason}</p> : null}
                  {residual.length ? (
                    <div className="residual">
                      <div className="k">Residual · changed outside the declared footprint</div>
                      {residual.map((rp) => (
                        <div className="mono residual-path" key={rp}>
                          {rp}
                        </div>
                      ))}
                      {declared.length ? (
                        <div className="declared">
                          declared <span className="mono">{declared.slice(0, 3).join(", ")}</span>
                          {declared.length > 3 ? ` +${declared.length - 3}` : ""}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {backend.mode === "live" ? (
                    <div className="nodiff" title="Proposals escalated before diffs were kept carry none, and a long queue sends diffs with its first cards only.">
                      No diff came with this card.
                    </div>
                  ) : null}
                </>
              )}
              <div className="k card-k">Decision path</div>
              <DecisionPath path={path} />
              {/* Who said each check and the statement of what was not verified (core/answerable.ts): FireTrident's first, the agent's quoted. */}
              <EvidenceChips evidence={p.evidence} />
              {antibodies.length ? (
                <div className="abs">
                  <div className="k">Matched antibodies</div>
                  {antibodies.map((a) => (
                    <div className="ab" key={a.id}>
                      {a.question}
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                className="note"
                rows={2}
                placeholder="Reason (required to return or reject)"
                value={reason}
                onChange={(e) => setNotes({ ...notes, [p.id]: e.target.value })}
              />
              <div className="note-help">
                <b>Reject</b> turns your reason into an antibody that screens every later change to these paths. <b>Return</b> sends it back to the agent as feedback.
              </div>
              <div className="actions">
                <button type="button" className="btn btn-approve" disabled={busy === p.id} onClick={() => void decide(p, "approve")}>
                  Approve
                </button>
                <button type="button" className="btn" disabled={busy === p.id || !hasReason} title={hasReason ? undefined : "Write a reason first"} onClick={() => void decide(p, "return")}>
                  Return
                </button>
                <button type="button" className="btn btn-reject" disabled={busy === p.id || !hasReason} title={hasReason ? undefined : "Write a reason first"} onClick={() => void decide(p, "reject")}>
                  Reject
                </button>
              </div>
              {pending?.id === p.id && !director ? (
                <TokenForm
                  refused={pending.refused}
                  action={pending.decision === "approve" ? "Approve" : pending.decision === "return" ? "Return" : "Reject"}
                  onRetry={() => {
                    const again = pending;
                    setPending(null);
                    void decide(p, again.decision);
                  }}
                  onCancel={() => setPending(null)}
                />
              ) : null}
            </article>
          );
        })}
        {items && !items.length && !reports.length && !error && queued === 0 ? (
          <div className="empty-big">
            <div className="empty-title">All clear</div>
            <div>
              A proposal lands here when it changes files it did not declare, touches what decides on agents, or when the models disagree. Rejecting one teaches the colony an antibody. An agent that finds an intent cannot be done as written reports it here
              too.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
