import type { ContestedRegion, MovedBy } from "@fire_trident/core";
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
 * model, so the reviewer can check that this change keeps what they did. With return hunks (FT_RETURN_HUNKS), each
 * landing's quoted diff of those files follows its line, and the contested regions of the last change's text merge come
 * last; both are repository content, shown as text.
 */
export function MovedByList({ moved, agentName, contested = [] }: { moved: readonly MovedBy[]; agentName?: (id: string) => string; contested?: readonly ContestedRegion[] }) {
  if (moved.length === 0 && contested.length === 0) return null;
  return (
    <div className="moved">
      <div className="k">Its intent's last change came back: trunk moved its files. This one should keep what they did</div>
      {movedLines(moved, agentName).map((line, i) => (
        <div key={`${moved[i]?.landingId ?? ""}-${i}`}>
          <div className="moved-line">{line}</div>
          {(moved[i]?.hunks ?? []).map((h) => (
            <pre className="moved-hunk" key={h.path} title={`What landing ${moved[i]?.landingId ?? ""} changed in ${h.path}`}>
              {`${h.path}${h.truncated ? " (cut short)" : ""}\n${h.diff}`}
            </pre>
          ))}
        </div>
      ))}
      {contested.map((r) => (
        <pre className="moved-hunk" key={`${r.path}:${r.line}`} title="A contested region of the last change's text merge">
          {[`${r.path}, from line ${r.line} of its base${r.truncated ? " (cut short)" : ""}`, "base:", ...r.base, "trunk:", ...r.trunk, "the change:", ...r.own].join("\n")}
        </pre>
      ))}
    </div>
  );
}
