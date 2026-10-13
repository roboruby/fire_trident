import { useState } from "react";
import { HttpError, readReviewer, readToken, type Backend, type EscalationDecision } from "../api.ts";
import { amendOf, answeredText, blockedAnswer, type AmendDraft } from "../escalation.ts";
import { KIND_LABEL } from "../eventText.ts";
import { timeAgo } from "../format.ts";
import { visible } from "../review.ts";
import type { ColonyStore, EscalationView } from "../store.ts";
import { TokenForm } from "./TokenForm.tsx";

const ACTION: Record<EscalationDecision, string> = { amend: "Amend", withdraw: "Withdraw", dismiss: "Dismiss" };
const DONE: Record<EscalationDecision, string> = { amend: "amended the intent", withdraw: "withdrew the intent", dismiss: "dismissed the report" };

/**
 * One agent's report that an intent cannot be done as written: the intent, the kind of problem, the
 * agent's own words (shown as text, never as markup), and a person's three answers: amend the intent
 * (title, why, footprint), withdraw it, or dismiss the report. Answers use the same token flow as the
 * review buttons. A report someone already answered shows who answered and how.
 */
export function EscalationCard({ esc, store, backend, readOnly = false, director = false }: { esc: EscalationView; store: ColonyStore; backend: Backend; readOnly?: boolean; director?: boolean }) {
  const intent = store.intents.get(esc.intentId);
  const footprint = intent?.footprint ?? [];
  const [amending, setAmending] = useState(false);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<AmendDraft>(() => ({ title: intent?.title ?? esc.title, why: intent?.why ?? "", footprint: footprint.join("\n") }));
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ decision: EscalationDecision; refused: boolean } | null>(null);
  const [sent, setSent] = useState<EscalationDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const amend = amendOf({ title: intent?.title ?? esc.title, ...(intent?.why !== undefined ? { why: intent.why } : {}), footprint }, draft);
  const agent = store.agentName(esc.agentId);
  const resolved = esc.resolved;
  const id = `esc-${esc.intentId}`;

  const answer = async (decision: EscalationDecision) => {
    if (blockedAnswer(decision, note, amend)) return;
    setBusy(true);
    setError(null);
    try {
      await backend.resolveEscalation(esc.intentId, decision, note.trim(), readReviewer() || undefined, decision === "amend" && amend ? amend : undefined);
      setSent(decision);
      setPending(null);
      setAmending(false);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) setPending({ decision, refused: readToken() !== "" });
      else setError(err instanceof Error ? err.message : "The answer didn't go through.");
    } finally {
      setBusy(false);
    }
  };

  const hint = (d: EscalationDecision) => blockedAnswer(d, note, amend) ?? undefined;
  if (resolved) {
    // Answered: who answered and how, with the report one line long (it was read when it was open).
    return (
      <article className="card card-report is-resolved" aria-labelledby={`${id}-title`}>
        <header className="card-head">
          <span className="pill pill-answered">Answered</span>
          <span className="report-kind">{KIND_LABEL[esc.kind] ?? esc.kind}</span>
          <span className="card-when">{timeAgo(resolved.at, store.now())}</span>
        </header>
        <h3 className="card-title" id={`${id}-title`}>
          {esc.title}
        </h3>
        <div className="card-meta report-line" title={esc.report ? visible(esc.report) : undefined}>
          {agent} reported: {esc.report ? visible(esc.report) : "no details"}
        </div>
        <div className="report-answer">
          <b>{resolved.by}</b> {DONE[resolved.decision]}
          {resolved.note ? <span className="report-answer-note">“{resolved.note}”</span> : null}
        </div>
      </article>
    );
  }
  return (
    <article
      className="card card-report"
      aria-labelledby={`${id}-title`}
      onMouseEnter={() => store.setHighlight(footprint)}
      onMouseLeave={() => store.setHighlight([])}
    >
      <header className="card-head">
        <span className="pill pill-report">Agent report</span>
        <span className="report-kind">{KIND_LABEL[esc.kind] ?? esc.kind}</span>
        <span className="card-when">{timeAgo(esc.at, store.now())}</span>
      </header>
      <h3 className="card-title" id={`${id}-title`}>
        {esc.title}
        {intent?.contest && intent.contest >= 2 ? <span className="ibadge ibadge-contest card-badge">contest ×{intent.contest}</span> : null}
      </h3>
      <div className="card-meta">
        reported by <span className="mono">{agent}</span>
        {footprint.length ? (
          <>
            {" "}
            · <span className="mono">{footprint[0]}</span>
            {footprint.length > 1 ? ` +${footprint.length - 1}` : ""}
          </>
        ) : null}
      </div>
      <figure className="report">
        <figcaption className="k">In the agent's words</figcaption>
        <blockquote className="report-text">{esc.report ? visible(esc.report) : "The agent sent no details."}</blockquote>
      </figure>
      {intent?.why ? (
        <div className="report-why" title={intent.why}>
          <span className="k">The intent's why</span>
          {intent.why}
        </div>
      ) : null}
      {sent ? (
        <div className="toast">{answeredText(sent)}</div>
      ) : readOnly ? (
        <div className="report-ro">{backend.mode === "replay" ? "A replay is read-only: open the live colony to answer reports." : "Answering is off here."}</div>
      ) : (
        <>
          <div className="report-wait">No agent takes this intent until a person answers.</div>
          {amending ? (
            <fieldset className="amend">
              <legend className="k">Amend the intent</legend>
              <label className="amend-field">
                <span>Title</span>
                <input type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label className="amend-field">
                <span>Why</span>
                <textarea rows={3} value={draft.why} onChange={(e) => setDraft({ ...draft, why: e.target.value })} />
              </label>
              <label className="amend-field">
                <span>Footprint · one path per line</span>
                <textarea className="mono" rows={Math.min(6, Math.max(2, footprint.length + 1))} value={draft.footprint} onChange={(e) => setDraft({ ...draft, footprint: e.target.value })} spellCheck={false} />
              </label>
            </fieldset>
          ) : null}
          <textarea
            className="note"
            rows={2}
            aria-label="Note for your answer"
            placeholder="Note (required): what you decided and why"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="note-help">
            <b>Amend</b> changes the title, why or footprint. <b>Withdraw</b> calls the intent off. <b>Dismiss</b> keeps it as written, and agents can take it again.
          </div>
          <div className="actions">
            {amending ? (
              <>
                <button type="button" className="btn btn-approve" disabled={busy || !!hint("amend")} title={hint("amend")} onClick={() => void answer("amend")}>
                  Amend the intent
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => setAmending(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-approve" disabled={busy} onClick={() => setAmending(true)}>
                  Amend…
                </button>
                <button type="button" className="btn btn-reject" disabled={busy || !!hint("withdraw")} title={hint("withdraw")} onClick={() => void answer("withdraw")}>
                  Withdraw
                </button>
                <button type="button" className="btn" disabled={busy || !!hint("dismiss")} title={hint("dismiss")} onClick={() => void answer("dismiss")}>
                  Dismiss
                </button>
              </>
            )}
          </div>
          {error ? <div className="alert">{error}</div> : null}
          {pending && !director ? (
            <TokenForm
              refused={pending.refused}
              action={ACTION[pending.decision]}
              onRetry={() => {
                const again = pending.decision;
                setPending(null);
                void answer(again);
              }}
              onCancel={() => setPending(null)}
            />
          ) : null}
        </>
      )}
    </article>
  );
}
