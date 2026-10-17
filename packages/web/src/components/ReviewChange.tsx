import { memo, useMemo, useState } from "react";
import { fmtInt } from "../format.ts";
import { changeSize, dangerLines, lookHereFirst, parseHunks, visible, type DangerSpot, type DiffLine, type ResidualSpot, type ReviewFile, type ReviewView } from "../review.ts";

/** Danger spots listed before "and N more" (the rest are marked in the full change). */
const MAX_SPOTS = 12;
/** Lines of a file outside the footprint shown before "Show N more lines". */
const RESIDUAL_LINES = 16;
/** Lines of one file's diff rendered at once; the rest wait for a click, so a long diff stays fast. */
const FILE_LINES = 400;

const NO_HITS: ReadonlySet<number> = new Set();

/** Diff lines with their numbers: added and removed lines tinted, `hits` (new-text line numbers) marked. Also the Why tab's view of a landing's change. */
export function DiffLines({ lines, hits = NO_HITS, limit = FILE_LINES }: { lines: readonly DiffLine[]; hits?: ReadonlySet<number>; limit?: number }) {
  const [all, setAll] = useState(false);
  const cut = !all && lines.length > limit;
  const shown = cut ? lines.slice(0, limit) : lines;
  return (
    <>
      <div className="diff">
        <div className="diff-in">
          {shown.map((l, i) => {
            const hit = l.kind === "add" && l.new !== undefined && hits.has(l.new);
            const n = l.kind === "del" ? l.old : l.kind === "add" || l.kind === "ctx" ? l.new : undefined;
            const mark = l.kind === "add" ? "+" : l.kind === "del" ? "-" : l.kind === "ctx" ? " " : "";
            return (
              <div key={i} className={`dl dl-${l.kind}${hit ? " is-hit" : ""}`}>
                <span className="dl-n">{n ?? ""}</span>
                <span className="dl-t">
                  {mark}
                  {visible(l.text)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {cut ? (
        <button type="button" className="diff-more" onClick={() => setAll(true)}>
          Show {fmtInt(lines.length - limit)} more lines
        </button>
      ) : null}
    </>
  );
}

/** Why a file shows no lines: a binary or unreadable file, or a diff that was not kept. */
function noLines(f: ReviewFile | null): string {
  if (!f) return "Its diff was not kept with this card.";
  if (f.status === "binary") return "Binary file: no text diff.";
  if (f.status === "unreadable") return "The file could not be read for review.";
  return f.truncated ? "Too large to keep: see the full change." : "No line changes kept.";
}

function DangerRow({ spot }: { spot: DangerSpot }) {
  const hits = useMemo(() => new Set([spot.line]), [spot.line]);
  return (
    <div className={`spot${spot.severe ? " is-severe" : ""}`} title={spot.labels.map(visible).join("\n") || undefined}>
      <div className="spot-head">
        <span className="mono spot-where">{visible(spot.line > 0 ? `${spot.path}:${spot.line}` : spot.path)}</span>
        <span className="spot-what">{spot.what.map(visible).join(" · ")}</span>
      </div>
      {spot.lines.length ? <DiffLines lines={spot.lines} hits={hits} /> : null}
    </div>
  );
}

function ResidualRow({ spot }: { spot: ResidualSpot }) {
  const f = spot.file;
  const lines = useMemo(() => (f ? parseHunks(f.hunks) : []), [f]);
  return (
    <div className="spot is-residual">
      <div className="spot-head">
        <span className="mono spot-where">{visible(spot.path)}</span>
        <span className="spot-what">changed outside the declared footprint</span>
        {f ? <FileStat f={f} /> : null}
      </div>
      {lines.length ? <DiffLines lines={lines} limit={RESIDUAL_LINES} /> : <div className="spot-none">{noLines(f)}</div>}
    </div>
  );
}

const STATUS_TAG: Record<string, string> = { added: "new", deleted: "deleted", binary: "binary", unreadable: "unreadable" };

function FileStat({ f }: { f: ReviewFile }) {
  return (
    <>
      <span className="file-stat mono">
        <b>+{fmtInt(f.added)}</b> <i>−{fmtInt(f.removed)}</i>
      </span>
      {f.truncated ? (
        <span className="file-tag is-cut" title="The kept diff of this file was cut: it changes more than this shows.">
          truncated
        </span>
      ) : null}
    </>
  );
}

/** One file of the full change: a row that opens its diff (parsed only once opened). */
function FileRow({ f, hits }: { f: ReviewFile; hits: ReadonlySet<number> | undefined }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => (open ? parseHunks(f.hunks) : []), [open, f.hunks]);
  const tag = STATUS_TAG[f.status];
  return (
    <div className={`file${open ? " is-open" : ""}`}>
      <button type="button" className="file-row" aria-expanded={open} onClick={() => setOpen(!open)} title={visible(f.path)}>
        <span className="file-caret">{open ? "▾" : "▸"}</span>
        <span className="mono file-path">{visible(f.path)}</span>
        {hits?.size ? <span className="file-tag is-hit">{hits.size === 1 ? "1 danger line" : `${fmtInt(hits.size)} danger lines`}</span> : null}
        {tag ? <span className="file-tag">{tag}</span> : null}
        <FileStat f={f} />
      </button>
      {open ? <div className="file-body">{lines.length ? <DiffLines lines={lines} hits={hits} /> : <div className="spot-none">{noLines(f)}</div>}</div> : null}
    </div>
  );
}

/**
 * The change itself on a review card, code first: "Look here first" leads with the danger lines
 * (with the masked line and a little context) and the files changed outside the declared footprint;
 * the full change follows, one collapsed row per file. It is where to start reading, not what to skip.
 */
export const ReviewChange = memo(function ReviewChange({ view, declared }: { view: ReviewView; declared: readonly string[] }) {
  const look = useMemo(() => lookHereFirst(view), [view]);
  const hits = useMemo(() => dangerLines(view), [view]);
  const size = useMemo(() => changeSize(view), [view]);
  const files = view.filesChanged;
  const left = view.filesChanged - view.files.length;
  const repro = view.reproduction;
  return (
    <div className="change">
      {repro ? (
        <section className="look">
          <div className="k card-k">Reproduced by recipe</div>
          <div className="spot-head">
            <span className="spot-what">{visible(repro.text)}</span>
          </div>
          <div className="look-more">
            {fmtInt(repro.reproduced.files)} {repro.reproduced.files === 1 ? "file" : "files"} ({fmtInt(repro.reproduced.lines)} {repro.reproduced.lines === 1 ? "line" : "lines"}) equal <span className="mono">{visible(repro.recipe)}</span> replayed on their base and are not shown. What
            follows is the residual: each file the recipe rewrote is shown against its output.
          </div>
        </section>
      ) : null}
      {look.danger.length || look.residual.length ? (
        <section className="look">
          <div className="k card-k">Look here first</div>
          {look.danger.slice(0, MAX_SPOTS).map((s) => (
            <DangerRow key={`${s.path}:${s.line}`} spot={s} />
          ))}
          {look.danger.length > MAX_SPOTS ? <div className="look-more">and {fmtInt(look.danger.length - MAX_SPOTS)} more danger lines, marked in the full change</div> : null}
          {look.residual.map((r) => (
            <ResidualRow key={r.path} spot={r} />
          ))}
          {look.residual.length && declared.length ? (
            <div className="declared">
              declared <span className="mono">{declared.slice(0, 3).join(", ")}</span>
              {declared.length > 3 ? ` +${declared.length - 3}` : ""}
            </div>
          ) : null}
        </section>
      ) : null}
      {files > 0 ? (
        <section className="full">
          <div className="k card-k">
            {repro ? "Residual to review" : "Full change"} · {fmtInt(files)} {files === 1 ? "file" : "files"} ·{" "}
            <span className="file-stat">
              <b>+{fmtInt(size.added)}</b> <i>−{fmtInt(size.removed)}</i>
            </span>
          </div>
          <div className="files">
            {view.files.map((f) => (
              <FileRow key={f.path} f={f} hits={hits.get(f.path)} />
            ))}
          </div>
          {left > 0 ? <div className="look-more">{left === 1 ? "1 more changed file was" : `${fmtInt(left)} more changed files were`} not kept with this card.</div> : null}
        </section>
      ) : null}
    </div>
  );
});
