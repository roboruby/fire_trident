import { useEffect, useState, type ReactNode } from "react";
import { decisionSpeaker } from "@fire_trident/core";
import { NoteSealBadge } from "../components/NoteSeal.tsx";
import { SaidBy } from "../components/SaidBy.tsx";
import { TestsBody } from "../components/TestsRow.tsx";
import { shortId, shortSha, timeAgo } from "../format.ts";
import { colonyHref } from "../route.ts";
import { LAYER_COLOR, STAGE_COLOR } from "../theme.ts";
import { loadNoteCard, noteColonies, recordedCard, verifyCommands, type CardDecision, type NoteCard } from "./note.ts";
import { Code, SERVER } from "./RunIt.tsx";

/** A read the card gives up on, so a slow colony never holds it. */
const REQUEST_TIMEOUT_MS = 12_000;
/** Checks listed before "and N more". */
const CHECKS_SHOWN = 10;

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const limited = typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : signal;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: limited });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** The server the commands name: this page's own origin on a deployment (it serves the plain-git trunks too), else the public one. */
export function serverOrigin(loc: { protocol: string; hostname: string; origin: string }): string {
  return loc.protocol === "https:" && !/^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname) ? loc.origin : SERVER;
}

function Field({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="nc-field">
      <div className="nc-k">{k}</div>
      <div className="nc-v">{children}</div>
    </div>
  );
}

function Decision({ d }: { d: CardDecision }) {
  const color = (STAGE_COLOR as Record<string, string>)[d.layer] ?? (LAYER_COLOR as Record<string, string>)[d.layer] ?? "#8b97a8";
  return (
    <div className="nc-dec">
      <span className="nc-layer" style={{ color, borderColor: color }}>
        {d.layer}
      </span>
      <span className="nc-dec-what">
        {d.kind ? `${d.kind} → ` : "→ "}
        <b>{d.action || "?"}</b>
        <span className="nc-by">
          <SaidBy s={decisionSpeaker(d)} />
        </span>
      </span>
      <span className="mono nc-p">{d.p !== null ? `p ${d.p.toFixed(2)}` : d.layer === "proof" ? "no model" : ""}</span>
    </div>
  );
}

/** The why without the lines the title already says, at most three lines of it. */
function whyLines(why: string, title: string): string[] {
  const said = title.toLowerCase();
  return why
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !said.includes(l.toLowerCase().replace(/[.\s]+$/, "")))
    .slice(0, 3);
}

/** One landing's note as the card draws it: the badge its check earned, the commit, the note's fields, and the commands that check it again. */
export function NoteCardView({ card, origin }: { card: NoteCard; origin: string }) {
  const why = card.path ? `${colonyHref(card.colonyId)}?path=${encodeURIComponent(card.path)}` : colonyHref(card.colonyId);
  const checks = card.checks.slice(0, CHECKS_SHOWN);
  const reasons = card.intent ? whyLines(card.intent.why, card.intent.title) : [];
  return (
    <figure className={`nc${card.live ? "" : " is-recorded"}`}>
      <div className="nc-head">
        <NoteSealBadge seal={card.seal} />
        <span className="nc-where">
          <a className="mono nc-sha" href={why} title={`${card.commit}\nOpen this landing in the colony's Why tab`}>
            {shortSha(card.commit)}
          </a>
          <span className="mono">{card.colonyId}</span>
          {card.at !== null ? <span>{card.live ? timeAgo(card.at) : new Date(card.at).toISOString().slice(0, 10)}</span> : null}
        </span>
      </div>
      <div className="nc-ref mono">
        refs/notes/firetrident · {card.landingId}
        {card.others > 0 ? ` · the first of ${card.others + 1} proposals` : ""}
      </div>
      <div className="nc-body">
        <div className="nc-col">
          <Field k="Answerable">
            <div className={`nc-answerable is-${card.answerable.answer}`}>{card.answerable.text}</div>
          </Field>
          <Field k="Tests">
            {card.tests ? (
              <TestsBody t={card.tests} />
            ) : (
              <span className="nc-dim">{card.live ? "No test row came back for this landing just now." : "Not read: this note is from FireTrident's recorded results."}</span>
            )}
          </Field>
          <Field k="Intent">
            <div className="nc-title">{card.intent?.title ?? "No intent recorded"}</div>
            {reasons.map((l, i) => (
              <div className="nc-why" key={i}>
                {l}
              </div>
            ))}
          </Field>
          <Field k="Rule">
            {card.rule ? (
              <>
                <span>{card.rule.name ?? shortId(card.rule.id)}</span>
                {card.rule.approvedBy ? (
                  <span className="nc-dim">
                    {" "}
                    · approved by <b className="nc-approver">{card.rule.approvedBy}</b>
                  </span>
                ) : null}
              </>
            ) : (
              <span className="nc-dim">None: the intent was declared directly, not made from a rule.</span>
            )}
          </Field>
          <Field k="Agent">
            {card.agent ? (
              <>
                <div>
                  <span className="mono" title={card.agent.id}>
                    {card.agent.name ?? shortId(card.agent.id)}
                  </span>
                  <span className="nc-dim"> · {card.agent.kind}</span>
                  {card.agent.model ? <span className="mono nc-model"> · {card.agent.model}</span> : null}
                </div>
                {card.provenance ? (
                  <div className={`nc-prov is-${card.provenance.level}`}>
                    <b>{card.provenance.label}</b>
                    {card.provenance.detail ? <span> · {card.provenance.detail}</span> : null}
                    <div className="nc-dim">{card.provenance.author}</div>
                  </div>
                ) : (
                  <div className="nc-dim">This note predates the record of how its author and model are known.</div>
                )}
              </>
            ) : (
              <span className="nc-dim">FireTrident's own commit: no agent wrote it.</span>
            )}
          </Field>
        </div>
        <div className="nc-col">
          <Field k="Decisions">
            {card.decisions.length ? card.decisions.map((d, i) => <Decision key={i} d={d} />) : <span className="nc-dim">No decision was recorded with this change.</span>}
          </Field>
          <Field k="Checks">
            <div className="nc-checks">
              {checks.map((c, i) => (
                <span key={`${c.name}:${i}`} className="nc-check-said">
                  {/* Who said it, once per run of one speaker: FireTrident's checks come first, the agent's last. */}
                  {i === 0 || checks[i - 1]!.speaker.label !== c.speaker.label ? <SaidBy s={c.speaker} /> : null}
                  <span className={`nc-check ${c.ok ? "is-ok" : "is-bad"}`} title={c.detail ? (c.quoted ? `“${c.detail}”` : c.detail) : undefined}>
                    {c.ok ? "✓" : "✕"} {c.name}
                  </span>
                </span>
              ))}
              {card.checks.length > checks.length ? <span className="nc-dim">and {card.checks.length - checks.length} more</span> : null}
            </div>
            {card.notVerified ? (
              <div className="nc-nv">
                <b>Not verified:</b> {card.notVerifiedBy ? <SaidBy s={card.notVerifiedBy} /> : null}{" "}
                {card.notVerifiedBy?.kind === "platform" ? card.notVerified : <span className="said-quote">“{card.notVerified}”</span>}
              </div>
            ) : null}
          </Field>
          <Field k="Files">
            {card.reads.map((f) => (
              <div className="nc-file" key={`r:${f.path}`}>
                <span className="nc-dim">read</span> <span className="mono">{f.path}</span> <span className="mono nc-dim">{f.blob ? shortSha(f.blob) : "absent"}</span>
              </div>
            ))}
            {card.moreReads > 0 ? <div className="nc-dim">and {card.moreReads} more read</div> : null}
            {card.writes.map((f) => (
              <div className="nc-file" key={`w:${f.path}`}>
                <span className="nc-dim">wrote</span> <span className="mono">{f.path}</span> <span className="mono nc-new">{f.blob ? `→ ${shortSha(f.blob)}` : "deleted"}</span>
              </div>
            ))}
            {card.moreWrites > 0 ? <div className="nc-dim">and {card.moreWrites} more written</div> : null}
          </Field>
        </div>
      </div>
      <Code label="check it again with stock git" text={verifyCommands(origin, card.colonyId, card.commit)} />
      <figcaption className="nc-cap">
        {card.live ? `The newest sealed landing on ${card.colonyId}, read from its public API as this page loaded. ` : "No colony answered just now: this note is from FireTrident's recorded results, and this page did not check it. "}
        Run the lines beside a checkout of the FireTrident repository: the second checks the note from the clone alone and prints its verdict.
      </figcaption>
    </figure>
  );
}

/** The Remember prong's note: the newest sealed landing of a showcase colony, read live, or the recorded stand-in when none answers. */
export function LiveNote() {
  const [card, setCard] = useState<NoteCard | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    loadNoteCard(noteColonies(location.search), (url) => getJson(url, ctl.signal))
      .catch(() => null)
      .then((c) => {
        if (!ctl.signal.aborted) setCard(c ?? recordedCard());
      });
    return () => ctl.abort();
  }, []);
  if (!card) return <div className="nc nc-skeleton" aria-busy="true" aria-label="Reading the newest sealed note" />;
  return <NoteCardView card={card} origin={serverOrigin(location)} />;
}
