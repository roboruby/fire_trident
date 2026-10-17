import { bySpeaker, evidenceLines, type Evidence, type EvidenceLine, type LandingAnswerable, type Speaker, type SpeakerKind } from "@fire_trident/core";
import { basename, fmtMs } from "../format.ts";

/**
 * Who said each line of a change's evidence, and who answers for a landing (core/answerable.ts), as the Why tab, the
 * review card and the landing page's note card draw them: every line carries a label (`checked by FireTrident`,
 * `model (<name>)`, `person (<name>)`, `agent's claim`, or `unknown` for a note older than the record), FireTrident's
 * facts come first, then models, then the agent's claims, and the agent's own words are quoted, as data.
 */

const SAID_TITLE: Record<SpeakerKind, string> = {
  platform: "FireTrident checked this itself",
  person: "A person said this",
  model: "A model's answer",
  agent: "The agent's own words, shown as data: FireTrident did not check them",
  unknown: "This note was written before notes recorded who said each line",
};

/** The label of who said a line. */
export function SaidBy({ s }: { s: Speaker }) {
  return (
    <span className={`said said-${s.kind}`} title={SAID_TITLE[s.kind]}>
      {s.label}
    </span>
  );
}

/** A line's text: the agent's own words (or words of unknown origin) in quotes, anything else as it is. */
export function SaidText({ line }: { line: Pick<EvidenceLine, "text" | "quoted"> }) {
  if (!line.text) return null;
  return line.quoted ? <span className="said-quote">“{line.text}”</span> : <span>{line.text}</span>;
}

/** The answerable line of a landing card: the nearest person answerable for it, or that no person is and why. */
export function AnswerableLine({ a }: { a: Pick<LandingAnswerable, "answer" | "text"> }) {
  return (
    <div className={`answerable is-${a.answer}`}>
      <span className="answerable-k">Answerable</span>
      <span className="answerable-text">{a.text}</span>
    </div>
  );
}

/** The statement of what was not verified, in a row of its own with who wrote it. */
export function NotVerifiedRow({ line }: { line: EvidenceLine }) {
  return (
    <div className={`nv${line.quoted ? " is-quoted" : ""}`}>
      <span className="nv-k">
        Not verified <SaidBy s={line.speaker} />
      </span>
      <span className="nv-text">
        <SaidText line={line} />
      </span>
    </div>
  );
}

/** The Why tab's evidence: each check, the files outside the footprint and the statement of what was not verified, each with who said it. */
export function EvidenceList({ evidence, path }: { evidence: Partial<Evidence> | undefined; path?: string }) {
  const lines = evidenceLines(evidence);
  const checks = lines.filter((l) => l.kind === "check");
  return (
    <>
      {checks.length ? null : <div className="lin-muted">No checks recorded.</div>}
      {lines.map((l, i) => {
        if (l.kind === "not-verified") return <NotVerifiedRow key={`nv-${i}`} line={l} />;
        if (l.kind === "residual") {
          return (
            <div className="lin-residual" key={`residual-${i}`}>
              <span className="lin-chip lin-chip-need">residual</span>
              <SaidBy s={l.speaker} />
              <span className="mono">{(l.paths ?? []).join(", ")}</span>
            </div>
          );
        }
        return (
          <div className={`evid-row ${l.ok ? "is-ok" : "is-bad"}`} key={`${l.name}-${i}`}>
            <span className="evid-mark">{l.ok ? "✓" : "✕"}</span>
            <span className="evid-name" title={l.name}>
              {path ? l.name.replace(path, basename(path)) : l.name}
            </span>
            <span className="evid-ms mono">{l.ms !== undefined ? fmtMs(l.ms) : ""}</span>
            <span className="evid-detail">
              <SaidBy s={l.speaker} /> <SaidText line={l} />
            </span>
          </div>
        );
      })}
    </>
  );
}

/** The review card's checks as chips, in runs of one speaker under its label, then the statement of what was not verified. */
export function EvidenceChips({ evidence }: { evidence: Partial<Evidence> | undefined }) {
  const lines = evidenceLines(evidence);
  const runs = bySpeaker(lines.filter((l) => l.kind === "check"));
  const nv = lines.find((l) => l.kind === "not-verified");
  return (
    <>
      {runs.length ? (
        <div className="checks">
          {runs.map((run, r) => (
            <span className="checks-run" key={`run-${r}`}>
              <SaidBy s={run.speaker} />
              {run.lines.map((c, i) => (
                <span key={`${c.name}-${i}`} className={`check ${c.ok ? "check-ok" : "check-bad"}`} title={c.text && c.quoted ? `“${c.text}”` : c.text}>
                  {c.ok ? "✓" : "✕"} {c.name} <span className="check-ms">{c.ms !== undefined ? fmtMs(c.ms) : ""}</span>
                </span>
              ))}
            </span>
          ))}
        </div>
      ) : null}
      {nv ? <NotVerifiedRow line={nv} /> : null}
    </>
  );
}
