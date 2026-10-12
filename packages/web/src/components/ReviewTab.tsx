import type { Proposal } from "@fire_trident/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, readToken, saveToken, type Backend, type ReviewDecision } from "../api.ts";
import { fmtInt, fmtPct, shortId, timeAgo } from "../format.ts";
import type { ColonyStore } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";

const DONE: Record<ReviewDecision, string> = {
  approve: "Approved. It joins its lane and lands on the next cycle.",
  return: "Returned to its agent with your note.",
  reject: "Rejected. The colony learns an antibody from it.",
};

/** Proposals escalated to a human: residual paths, reasons, checks, and approve/return/reject. */
export function ReviewTab({ store, backend }: { store: ColonyStore; backend: Backend }) {
  useThrottledVersion(store, 500);
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [token, setToken] = useState(readToken);
  const decided = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const list = await backend.review();
      setItems(list.filter((p) => (p.status === "escalated" || !p.status) && !decided.current.has(p.id)));
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

  const reviewVersion = store.reviewVersion;
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 350);
    return () => window.clearTimeout(timer);
  }, [reviewVersion, load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const decide = async (p: Proposal, decision: ReviewDecision) => {
    setBusy(p.id);
    try {
      await backend.decide(p.id, decision, (notes[p.id] ?? "").trim());
      decided.current.add(p.id);
      setItems((cur) => (cur ? cur.filter((x) => x.id !== p.id) : cur));
      setToast(DONE[decision]);
      setError(null);
      store.setHighlight([]);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        setNeedToken(true);
        setError("This colony needs an admin token to record review decisions.");
      } else {
        setError(err instanceof Error ? err.message : "The decision didn't go through.");
      }
    } finally {
      setBusy(null);
    }
  };

  const total = store.funnel.reflex + store.funnel.llm + store.funnel.human;
  const handled = total ? (store.funnel.reflex + store.funnel.llm) / total : 1;

  return (
    <div className="review">
      <div className="review-head">
        <div className="review-count">
          {items === null ? "Loading the review queue…" : items.length ? `${items.length} ${items.length === 1 ? "proposal needs" : "proposals need"} a human` : "Nothing needs a human"}
        </div>
        <div className="review-sub">
          The reflex and LLM layers settled {fmtPct(handled, 1)} of {fmtInt(total)} decisions. These are the ones they were not sure about.
        </div>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      {error ? <div className="alert">{error}</div> : null}
      {needToken ? (
        <form
          className="token"
          onSubmit={(e) => {
            e.preventDefault();
            saveToken(token.trim());
            setNeedToken(false);
            setError(null);
          }}
        >
          <input type="password" placeholder="Admin token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <button type="submit" className="btn">
            Save
          </button>
        </form>
      ) : null}
      <div className="cards">
        {(items ?? []).map((p) => {
          const intent = store.intents.get(p.intentId);
          const residual = p.evidence?.residual ?? [];
          const checks = p.evidence?.checks ?? [];
          const paths = [...residual, ...(p.declared?.footprint ?? [])];
          return (
            <article key={p.id} className="card" onMouseEnter={() => store.setHighlight(paths)} onMouseLeave={() => store.setHighlight([])}>
              <header className="card-head">
                <span className="pill pill-escalated">Escalated</span>
                <span className="mono card-id">{shortId(p.id)}</span>
                <span className="card-when">{timeAgo(p.createdAt)}</span>
              </header>
              <h3 className="card-title">{intent?.title ?? p.declared?.summary ?? p.intentId}</h3>
              <div className="card-meta">
                by <span className="mono">{store.agentName(p.agentId)}</span> · wrote {p.writeSet?.length ?? 0} · read {p.readSet?.length ?? 0}
              </div>
              {p.reason ? <p className="card-reason">{p.reason}</p> : null}
              {residual.length ? (
                <div className="residual">
                  <div className="k">Residual · outside the declared footprint</div>
                  {residual.map((path) => (
                    <div className="mono residual-path" key={path}>
                      {path}
                    </div>
                  ))}
                </div>
              ) : null}
              {checks.length ? (
                <div className="checks">
                  {checks.map((c) => (
                    <span key={c.name} className={`check ${c.ok ? "check-ok" : "check-bad"}`} title={c.detail}>
                      {c.ok ? "✓" : "✕"} {c.name} <span className="check-ms">{(c.ms / 1000).toFixed(1)}s</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {p.evidence?.notVerified ? (
                <div className="not-verified">
                  <span className="k">Not verified</span> {p.evidence.notVerified}
                </div>
              ) : null}
              <input
                className="note"
                placeholder="Note for the agent (optional)"
                value={notes[p.id] ?? ""}
                onChange={(e) => setNotes({ ...notes, [p.id]: e.target.value })}
              />
              <div className="actions">
                <button type="button" className="btn btn-approve" disabled={busy === p.id} onClick={() => void decide(p, "approve")}>
                  Approve
                </button>
                <button type="button" className="btn" disabled={busy === p.id} onClick={() => void decide(p, "return")}>
                  Return
                </button>
                <button type="button" className="btn btn-reject" disabled={busy === p.id} onClick={() => void decide(p, "reject")}>
                  Reject
                </button>
              </div>
            </article>
          );
        })}
        {items && !items.length && !error ? (
          <div className="empty-big">
            <div className="empty-title">All clear</div>
            <div>Escalations appear here when a proposal changes files it did not declare, or when the models disagree.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
