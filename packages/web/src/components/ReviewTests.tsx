import type { Proposal } from "@fire_trident/core";
import { memo, useState } from "react";
import { HttpError, readReviewer, readToken, type Backend } from "../api.ts";
import { visible } from "../review.ts";
import { ON_TRUNK, reviewTestsLead, reviewTestsOf, reviewTestsTone } from "../reviewtests.ts";
import { TokenForm } from "./TokenForm.tsx";

/**
 * What leads a review card: the colony's tests run on the change at its base while it waits for a person (tests before
 * approval). The result in a sentence, each failing test with how it did on trunk and its error's first line, the base's
 * own certification, and "Run again" where the backend can ask for it (a live colony, with the admin token). Nothing for
 * an item that carries no run (an older server, the simulator).
 */
export const ReviewTests = memo(function ReviewTests({ item, backend, readOnly = false, director = false, onAsked }: { item: Proposal; backend: Backend; readOnly?: boolean; director?: boolean; onAsked?: () => void }) {
  const run = reviewTestsOf(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The run shown when a person asked again: the note stays until the new run replaces it.
  const [asked, setAsked] = useState<string | null>(null);
  const [pending, setPending] = useState<{ refused: boolean } | null>(null);
  if (!run) return null;
  const tone = reviewTestsTone(run);
  const canRetest = !readOnly && typeof backend.retestProposal === "function" && (run.status === "ran" || run.status === "notrun");

  const retest = async () => {
    if (!backend.retestProposal) return;
    setBusy(true);
    setError(null);
    try {
      await backend.retestProposal(item.id, readReviewer() || undefined);
      setAsked(run?.id ?? "");
      setPending(null);
      onAsked?.();
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) setPending({ refused: readToken() !== "" });
      else setError(err instanceof Error ? err.message : "The tests could not be asked for again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`rtests is-${tone}`} aria-label="Tests on this change">
      <div className="rtests-lead">{visible(reviewTestsLead(run))}</div>
      {run.failing?.length ? (
        <ul className="rtests-failing">
          {run.failing.map((f, i) => (
            <li className="rtests-fail" key={`${f.file}\n${f.name}\n${i}`}>
              <span className="rtests-name mono">{visible(f.name)}</span>
              <span className="rtests-file mono">{visible(f.file)}</span>
              <span className={`rtests-on is-${f.onTrunk}`}>{ON_TRUNK[f.onTrunk]}</span>
              {f.error ? <div className="rtests-error mono">{visible(f.error)}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {run.trunk ? (
        <div className="rtests-trunk">
          On trunk at <span className="mono">{run.trunk.sha.slice(0, 7)}</span> (certified {run.trunk.status}): {run.trunk.passed}/{run.trunk.tests} passed
          {run.trunk.failing > 0 ? `, ${run.trunk.failing} failing` : ""}
        </div>
      ) : null}
      {asked !== null && asked === run.id ? (
        <div className="rtests-note">Asked to run them again. The result replaces this one when they end.</div>
      ) : canRetest ? (
        <div className="rtests-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void retest()}>
            Run again
          </button>
        </div>
      ) : null}
      {error ? <div className="alert">{error}</div> : null}
      {pending && !director ? (
        <TokenForm
          refused={pending.refused}
          action="Run again"
          onRetry={() => {
            setPending(null);
            void retest();
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </section>
  );
});
