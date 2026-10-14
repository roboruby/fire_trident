import type { LandingDiff } from "@fire_trident/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "../api.ts";
import { fmtInt, plural, shortSha } from "../format.ts";
import { parseHunks } from "../review.ts";
import { CHECKING_SEAL, sealOf, uncheckedSeal, type NoteSeal, type SealState } from "../verified.ts";
import { DiffLines } from "./ReviewChange.tsx";

/** A note whose push is due is checked again this many times, this far apart. */
const PENDING_RETRIES = 3;
const PENDING_RETRY_MS = 5_000;

const GLYPH: Record<SealState, string> = { intact: "✓", altered: "✕", unsealed: "○", missing: "!", pending: "…", checking: "…", unchecked: "–" };

/** A lineage note's integrity badge, from the note check: intact, altered, landed before notes were sealed, and the rest. */
export function NoteSealBadge({ seal }: { seal: NoteSeal }) {
  return (
    <span className={`seal is-${seal.state}`} title={seal.detail}>
      <b aria-hidden="true">{GLYPH[seal.state]}</b>
      {seal.label}
    </span>
  );
}

/** What the change toggle holds: being read, read, or failed with the reason. */
export type ChangeState = { kind: "loading" } | { kind: "loaded"; diff: LandingDiff } | { kind: "failed"; message: string };

const WHAT: Record<LandingDiff["status"], string> = {
  added: "new file",
  deleted: "deleted",
  modified: "modified",
  unchanged: "unchanged",
  binary: "binary",
  "too-large": "too large",
  unreadable: "not read",
};

/** Why a change shows no lines, as a sentence: the server's own, or one for its status. */
export function noLinesText(d: LandingDiff): string {
  if (d.detail) return d.detail;
  if (d.status === "binary") return "The file is binary, so there are no lines to show.";
  if (d.status === "unchanged") return "This landing left the file as its parent commit had it.";
  return "No lines changed.";
}

/** The change a landing made to the file, as its toggle shows it: the review card's diff view, or why there are no lines. */
export function LandingChange({ state }: { state: ChangeState }) {
  const lines = useMemo(() => (state.kind === "loaded" ? parseHunks(state.diff.hunks) : []), [state]);
  if (state.kind === "loading") return <div className="lin-change is-quiet">Reading the change from the trunk repository…</div>;
  if (state.kind === "failed") return <div className="lin-change is-quiet">{state.message}</div>;
  const d = state.diff;
  return (
    <div className="lin-change">
      <div className="lin-change-head">
        <span className="file-stat mono">
          <b>+{fmtInt(d.added)}</b> <i>−{fmtInt(d.removed)}</i>
        </span>
        <span className="lin-change-what">{WHAT[d.status]}</span>
        <span className="mono lin-change-ids" title={`${d.before ?? "absent"} → ${d.after ?? "absent"}`}>
          {d.before ? shortSha(d.before) : "new"} → {d.after ? shortSha(d.after) : "deleted"}
        </span>
      </div>
      {lines.length ? <DiffLines lines={lines} /> : <div className="spot-none">{noLinesText(d)}</div>}
      {d.truncated ? <div className="lin-change-cut">The change is longer than this shows ({plural(d.added + d.removed, "line")} in all): a plain git clone of the colony has it whole.</div> : null}
    </div>
  );
}

/** The note check of one landing, as a badge; checked again while its push is due. Null for a backend that cannot check notes. */
function useSeal(backend: Backend, landingId: string): NoteSeal | null {
  const can = typeof backend.verifyNote === "function";
  const [seal, setSeal] = useState<NoteSeal | null>(can ? CHECKING_SEAL : null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (typeof backend.verifyNote !== "function") return;
    let live = true;
    let timer = 0;
    backend.verifyNote(landingId).then(
      (check) => {
        if (!live) return;
        const next = check ? sealOf(check) : uncheckedSeal("the note check did not name this landing");
        setSeal(next);
        if (next.state === "pending" && round < PENDING_RETRIES) timer = window.setTimeout(() => setRound((r) => r + 1), PENDING_RETRY_MS);
      },
      (e: unknown) => {
        if (live) setSeal(uncheckedSeal(e instanceof Error ? e.message : "the note check failed"));
      },
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [backend, landingId, round]);
  return seal;
}

/**
 * A landing's note in the Why tab: the integrity badge from the note check, and "Show the change", which reads the change
 * the landing made to this file and shows it with the review card's diff view. Nothing for a backend that can do neither
 * (the simulator, whose notes are not in any repository).
 */
export function NoteBar({ backend, landingId, path }: { backend: Backend; landingId: string; path: string }) {
  const seal = useSeal(backend, landingId);
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState<ChangeState | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const canDiff = typeof backend.landingDiff === "function";
  if (!seal && !canDiff) return null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || !backend.landingDiff || (change && change.kind !== "failed")) return;
    setChange({ kind: "loading" });
    backend.landingDiff(landingId, path).then(
      (diff) => alive.current && setChange({ kind: "loaded", diff }),
      (e: unknown) => alive.current && setChange({ kind: "failed", message: e instanceof Error ? e.message : "The change could not be read." }),
    );
  };
  return (
    <>
      <div className="lin-note">
        {seal ? <NoteSealBadge seal={seal} /> : null}
        {canDiff ? (
          <button type="button" className={`lin-change-btn${open ? " is-open" : ""}`} aria-expanded={open} onClick={toggle} title={`The change this landing made to ${path}`}>
            <span aria-hidden="true">{open ? "▾" : "▸"}</span> {open ? "Hide the change" : "Show the change"}
          </button>
        ) : null}
      </div>
      {open && change ? <LandingChange state={change} /> : null}
    </>
  );
}
