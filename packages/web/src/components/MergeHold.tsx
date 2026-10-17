import type { HeldDiff } from "@fire_trident/core";
import { memo, useMemo } from "react";
import { fmtInt } from "../format.ts";
import { shortBlob, type HeldFileView } from "../mergehold.ts";
import { parseHunks, visible } from "../review.ts";
import { DiffLines } from "./ReviewChange.tsx";

/** Lines of a held diff shown at once (the server keeps about 60). */
const HELD_LINES = 60;

/** One of a held file's two diffs, with its size, or why it shows none. */
function HeldDiffBlock({ title, diff }: { title: string; diff: HeldDiff | null }) {
  const lines = useMemo(() => (diff ? parseHunks(diff.hunks) : []), [diff]);
  return (
    <div className="held-diff">
      <div className="spot-what">
        {title}
        {diff ? (
          <span className="file-stat mono">
            {" "}
            <b>+{fmtInt(diff.added)}</b> <i>−{fmtInt(diff.removed)}</i>
          </span>
        ) : null}
        {diff?.truncated ? <span className="file-tag is-cut">truncated</span> : null}
      </div>
      {lines.length ? <DiffLines lines={lines} limit={HELD_LINES} /> : <div className="spot-none">{diff ? "No line changes." : "Its diff was not kept with this card."}</div>}
    </div>
  );
}

/**
 * The merge a person is asked to approve, on a review card: for each file trunk changed since the change was decided,
 * its blobs, what trunk changed since the change's base, and the merged result against the version that was decided on.
 * Approving the change lands exactly this merge.
 */
export const MergeHold = memo(function MergeHold({ files }: { files: readonly HeldFileView[] }) {
  return (
    <section className="look merge-hold">
      <div className="k card-k">
        Trunk moved since this was decided: approving lands {files.length === 1 ? "this merge" : `these ${fmtInt(files.length)} merged files`}
      </div>
      {files.map((f) => (
        <div className="spot" key={f.path}>
          <div className="spot-head">
            <span className="mono spot-where">{visible(f.path)}</span>
            <span className="spot-what mono">
              {shortBlob(f.base)} at its base, {shortBlob(f.trunk)} on trunk{f.by ? ` from ${visible(f.by)}` : ""}, decided on {shortBlob(f.theirs)}, merged as {shortBlob(f.result)}
            </span>
          </div>
          <HeldDiffBlock title="What trunk changed since the change's base" diff={f.trunkDiff} />
          <HeldDiffBlock title="The merged result against the version that was decided on" diff={f.mergedDiff} />
        </div>
      ))}
    </section>
  );
});
