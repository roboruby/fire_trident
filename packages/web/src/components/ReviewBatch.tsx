import type { Proposal } from "@fire_trident/core";
import type { ReactNode } from "react";
import { shortId, timeAgo } from "../format.ts";
import { reviewOf } from "../review.ts";
import { batchHeadline, batchMemberLine, batchWhy, type BatchGroup } from "../batch.ts";

/**
 * One card for a batch of escalated changes (escalation batching, batch.ts): what they share, each change listed, and
 * approve all, reject all (with a reason) or open each, which shows every change's own card below.
 */
export function ReviewBatchCard({
  group,
  agentName,
  titleOf,
  open,
  busy,
  readOnly,
  reason,
  onReason,
  onToggle,
  onDecide,
  children,
}: {
  group: BatchGroup;
  agentName: (id: string) => string;
  titleOf: (p: Proposal) => string;
  open: boolean;
  busy: boolean;
  /** A replay, or a backend that cannot answer a batch: the card reads, nothing is sent. */
  readOnly: boolean;
  reason: string;
  onReason: (text: string) => void;
  onToggle: () => void;
  onDecide: (decision: "approve" | "reject") => void;
  /** The token form, when a decision was refused for want of one. */
  children?: ReactNode;
}) {
  const n = group.members.length;
  const hasReason = reason.trim().length > 0;
  return (
    <article className="card card-batch" aria-label={batchHeadline(group)}>
      <header className="card-head">
        <span className="pill pill-escalated">Escalated</span>
        <span className="pill pill-batch">Batch of {n}</span>
        <span className="mono card-id" title={`${group.batch.rule}: ft review <colony> --approve-batch ${group.batch.id || group.batch.key}`}>
          {group.batch.id || group.batch.rule.split(" ")[0]}
        </span>
      </header>
      <h3 className="card-title">{batchHeadline(group)}: review them together</h3>
      <div className="card-meta">{batchWhy(group.batch)}</div>
      <ul className="batch-list">
        {group.members.map((p) => (
          <li key={p.id} className="batch-item">
            <span className="mono batch-id" title={p.id}>
              {shortId(p.id)}
            </span>
            <span className="batch-title">{titleOf(p)}</span>
            <span className="batch-by">
              by <span className="mono">{agentName(p.agentId)}</span> · {timeAgo(p.createdAt)}
            </span>
            <span className="mono batch-line">{batchMemberLine(p, reviewOf(p))}</span>
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <>
          <textarea className="note" rows={2} placeholder="Reason (required to reject all)" value={reason} onChange={(e) => onReason(e.target.value)} />
          <div className="note-help">
            <b>Reject all</b> turns your reason into one antibody, from the first change, and rejects every change listed. <b>Open each</b> shows their own cards to decide one by one.
          </div>
        </>
      )}
      <div className="actions">
        {readOnly ? null : (
          <>
            <button type="button" className="btn btn-approve" disabled={busy} onClick={() => onDecide("approve")}>
              Approve all {n}
            </button>
            <button type="button" className="btn btn-reject" disabled={busy || !hasReason} title={hasReason ? undefined : "Write a reason first"} onClick={() => onDecide("reject")}>
              Reject all {n}
            </button>
          </>
        )}
        <button type="button" className="btn" aria-expanded={open} onClick={onToggle}>
          {open ? "Close each" : "Open each"}
        </button>
      </div>
      {children}
    </article>
  );
}
