import type { NoteDecision } from "@fire_trident/core";
import { cardReceipt, decisionReceipt, earlierText, receiptText } from "../receipt.ts";

/** One recorded decision's review receipt under its line in the Why tab: the head, what it was shown, verified or stated. */
export function DecisionReceipt({ d }: { d: NoteDecision }) {
  const r = decisionReceipt(d);
  if (!r) return null;
  const title = [r.headFull ? `head ${r.headFull}` : "", r.digestFull ?? ""].filter(Boolean).join("\n") || undefined;
  return (
    <div className="dec-answer dec-receipt" title={title}>
      receipt · {receiptText(r)}
    </div>
  );
}

/** "8 of 11 decisions kept", when the note's cap left earlier decisions of a change out. */
export function EarlierDecisions({ decisions }: { decisions: readonly unknown[] }) {
  const text = earlierText(decisions);
  return text ? <div className="dec-answer dec-receipt">{text}</div> : null;
}

/** A review card's receipt: the head and the digest of the view it serves, which the person's decision records. */
export function CardReceipt({ item }: { item: unknown }) {
  const r = cardReceipt(item);
  if (!r) return null;
  const title = ["A decision on this card records this head and this digest of the view above, inside the signed lineage note.", r.headFull ?? "", r.digestFull ?? ""].filter(Boolean).join("\n");
  return (
    <div className="note-help card-receipt mono" title={title}>
      Reviewing {receiptText(r)}
    </div>
  );
}
