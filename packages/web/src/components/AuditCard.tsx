import type { Proposal } from "@fire_trident/core";
import { useState } from "react";
import { HttpError, readReviewer, readToken, type Backend } from "../api.ts";
import { auditDoneText, auditOf, type AuditVerdict } from "../audit.ts";
import { fmtInt, shortId, timeAgo } from "../format.ts";
import type { ReviewView } from "../review.ts";
import type { ColonyStore } from "../store.ts";
import { ReviewChange } from "./ReviewChange.tsx";
import { EvidenceChips } from "./SaidBy.tsx";
import { TokenForm } from "./TokenForm.tsx";
import "./audit.css";

const NONE: readonly string[] = [];

/**
 * An audit item on the review tab (audit.ts): a change that already landed without a person, from the colony's audit
 * sample, on a card like an escalation's (the change, then the checks) plus what landed it. A person answers fine, or
 * should not have landed with a reason (and may revert it at once); the answer is measured per confirming layer.
 */
export function AuditCard({
  p,
  view,
  store,
  backend,
  onDone,
}: {
  p: Proposal;
  view: ReviewView | null;
  store: ColonyStore;
  backend: Backend;
  /** The answer went through: the sentence the server said back. */
  onDone: (id: string, sentence: string) => void;
}) {
  const mark = auditOf(p);
  const [reason, setReason] = useState("");
  const [revert, setRevert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ verdict: AuditVerdict; refused: boolean } | null>(null);
  if (!mark) return null;
  const answer = backend.auditAnswer;
  const readOnly = !answer;
  const hasReason = reason.trim().length > 0;
  const intent = store.intents.get(p.intentId);

  const send = async (verdict: AuditVerdict) => {
    if (!answer || (verdict === "should-not-have-landed" && !hasReason)) return;
    setBusy(true);
    try {
      const res = await answer.call(backend, p.id, verdict, reason.trim(), readReviewer() || undefined, verdict === "should-not-have-landed" && revert);
      setError(null);
      setPending(null);
      onDone(p.id, auditDoneText(res, verdict));
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) setPending({ verdict, refused: readToken() !== "" });
      else setError(err instanceof Error ? err.message : "The answer didn't go through.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card card-audit" onMouseEnter={() => store.setHighlight(p.declared?.footprint ?? [])} onMouseLeave={() => store.setHighlight([])}>
      <header className="card-head">
        <span className="pill pill-audit">Audit · landed</span>
        <span className="mono card-id" title={p.id}>
          {shortId(p.id)}
        </span>
        <span className="card-when">{mark.landedAt > 0 ? `landed ${timeAgo(mark.landedAt)}` : "landed"}</span>
      </header>
      <h3 className="card-title">{intent?.title ?? p.declared?.summary ?? p.intentId}</h3>
      <div className="card-meta">
        by <span className="mono">{store.agentName(p.agentId)}</span> · wrote {fmtInt(p.writeSet?.length ?? 0)} · read {fmtInt(p.readSet?.length ?? 0)}
      </div>
      <p className="audit-landed">
        <b>{mark.landedBy}</b> No person looked at it before it landed. This is a sample of what lands without one, so the ordinary landings stay in view: was it fine to land?
      </p>
      {view ? <ReviewChange view={view} declared={p.declared?.footprint ?? NONE} /> : <div className="nodiff">No diff came with this card yet: it is read from the landing, and shows on a later read.</div>}
      <EvidenceChips evidence={p.evidence} />
      {error ? <div className="alert">{error}</div> : null}
      <textarea className="note" rows={2} placeholder="Reason (required for should not have landed)" value={reason} disabled={readOnly} onChange={(e) => setReason(e.target.value)} />
      <label className="audit-revert">
        <input type="checkbox" checked={revert} disabled={readOnly} onChange={(e) => setRevert(e.target.checked)} />
        and revert it now, as ft revert would (it is refused when work landed on top)
      </label>
      <div className="actions">
        <button type="button" className="btn btn-approve" disabled={busy || readOnly} title={readOnly ? "A replay is read-only" : undefined} onClick={() => void send("fine")}>
          Fine
        </button>
        <button
          type="button"
          className="btn btn-reject"
          disabled={busy || readOnly || !hasReason}
          title={readOnly ? "A replay is read-only" : hasReason ? undefined : "Write a reason first"}
          onClick={() => void send("should-not-have-landed")}
        >
          Should not have landed
        </button>
      </div>
      {pending ? (
        <TokenForm
          refused={pending.refused}
          action={pending.verdict === "fine" ? "Answer fine" : "Answer should not have landed"}
          onRetry={() => {
            const again = pending;
            setPending(null);
            void send(again.verdict);
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </article>
  );
}
