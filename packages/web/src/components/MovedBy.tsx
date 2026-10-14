import type { MovedBy } from "@fire_trident/core";
import { movedLabel, movedLines } from "../moved.ts";

/**
 * The badge an intent card wears while its latest change is back because trunk moved its files: what beat it, with
 * every landing on hover.
 */
export function MovedBadge({ moved, agentName }: { moved: readonly MovedBy[]; agentName?: (id: string) => string }) {
  if (moved.length === 0) return null;
  return (
    <span className="ibadge ibadge-moved" title={`Its last change came back because trunk moved its files. Keep what these landings did unless the intent says otherwise:\n${movedLines(moved, agentName).join("\n")}`}>
      lost to {movedLabel(moved)}
    </span>
  );
}

/**
 * What beat the intent's last change, on a review card: each landing that moved its files, with its intent, agent and
 * model, so the reviewer can check that this change keeps what they did.
 */
export function MovedByList({ moved, agentName }: { moved: readonly MovedBy[]; agentName?: (id: string) => string }) {
  if (moved.length === 0) return null;
  return (
    <div className="moved">
      <div className="k">Its intent's last change came back: trunk moved its files. This one should keep what they did</div>
      {movedLines(moved, agentName).map((line, i) => (
        <div className="moved-line" key={`${moved[i]?.landingId ?? ""}-${i}`}>
          {line}
        </div>
      ))}
    </div>
  );
}
