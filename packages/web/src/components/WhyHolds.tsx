import type { LandingTests, LineageNote, Path, WhyHolds, WhyWalk } from "@fire_trident/core";
import { coverText, holdsText, speaker, walkLines, type CertNow } from "@fire_trident/core";
import { useEffect, useState } from "react";
import type { Backend } from "../api.ts";
import { SaidBy } from "./SaidBy.tsx";

/**
 * Today in the Why tab (worker trunk/whywalk.ts, core/whyholds.ts): under a line's heading, how the walk found the landing
 * that wrote it (the formatting-only landings it skipped, the moves it followed back to another file), and on each landing
 * card one "Holds" line: the file as it wrote it, changed since or deleted, the other files it wrote or read that changed,
 * and the current certification of the tests that cover it, from its test row's closure data when the card reads one,
 * else the page's latest certification. Nothing from a server before the walk.
 */

/** The walk's lines under a line's heading; nothing for a file, or without a walk. */
export function WalkLines({ walk, path, line }: { walk: WhyWalk | undefined; path: Path; line: number | null }) {
  if (!line) return null;
  const lines = walkLines(walk, { path, line });
  if (lines.length === 0) return null;
  return (
    <div className="why-walk">
      {lines.map((l, i) => (
        <div key={i} className={`why-walk-line${/^skipped /.test(l) ? " is-skipped" : /^moved from /.test(l) ? " is-moved" : ""}`}>
          {l}
        </div>
      ))}
    </div>
  );
}

/** One landing's holds line as drawn, from what is known: its holds, its test row when read, the latest certification. */
export function HoldsView({ holds, row, cert, wrote }: { holds: WhyHolds | undefined; row: LandingTests | null; cert: CertNow | null; wrote: Path[] }) {
  const text = holdsText(holds, coverText(row, cert, wrote));
  if (!holds || !text) return null;
  return (
    <div className={`holds-row is-${holds.wrote?.state ?? "same"}`}>
      <span className="tests-k">Holds</span>
      <SaidBy s={speaker("platform")} />
      <span className="holds-text">{text}</span>
    </div>
  );
}

/**
 * A landing card's holds line: its test row read beside the card's own (`auto`, the newest landings: the page keeps one
 * read per landing, so this asks nothing more), else the latest certification alone.
 */
export function HoldsLine({ entry, backend, cert, auto }: { entry: { landing: { id: string }; note?: Pick<LineageNote, "proposals">; holds?: WhyHolds }; backend: Backend; cert: CertNow | null; auto: boolean }) {
  const [row, setRow] = useState<LandingTests | null>(null);
  const id = entry.landing.id;
  useEffect(() => {
    let alive = true;
    if (auto && entry.holds && typeof backend.landingTests === "function") {
      backend.landingTests(id).then(
        (t) => alive && setRow(t),
        () => undefined,
      );
    }
    return () => {
      alive = false;
    };
  }, [backend, id, auto, !!entry.holds]);
  const wrote: Path[] = [];
  for (const p of Array.isArray(entry.note?.proposals) ? entry.note.proposals : []) for (const w of Array.isArray(p?.writeSet) ? p.writeSet : []) if (typeof w?.path === "string") wrote.push(w.path);
  return <HoldsView holds={entry.holds} row={row} cert={cert} wrote={wrote} />;
}
