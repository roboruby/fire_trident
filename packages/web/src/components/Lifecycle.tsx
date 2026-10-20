import { useEffect, useState, type ReactNode } from "react";
import { LIFECYCLE_CAPTION, LIFECYCLE_LABEL, type ChangeLifecycle, type IntentLifecycle, type LandingTests, type LifecycleLink, type LifecycleStep, type LineageNote } from "@fire_trident/core";
import type { Backend, WhyEntry } from "../api.ts";
import { shortId, timeAgo } from "../format.ts";
import { lifecycleHref, readLifecycle, whyLifecycle, type LifecycleState } from "../lifecycle.ts";
import type { ColonyStore } from "../store.ts";
import "./lifecycle.css";

/**
 * The lifecycle strip (core/lifecycle.ts, lifecycle.ts): one row of steps from declared to merged by a person, each
 * linked to its evidence, the step reached highlighted, and where a change left the path; under it the reached step's
 * words, what comes next, the caption, and every step in a list a person can open. The last two steps happen in the
 * team's GitHub and are never drawn as done. The row wraps on a narrow screen and the list stacks.
 */

/** Each state's mark: done, not yet, on the team's GitHub, does not apply. */
const MARK: Record<LifecycleStep["state"], string> = { done: "✓", todo: "○", outside: "↗", none: "–" };

/** Link text or plain text, as the step's evidence allows. */
function Evidence({ href, children, title }: { href: string | null; children: ReactNode; title?: string }) {
  return href ? (
    <a className="life-ev" href={href} target={href.startsWith("/#") ? undefined : "_blank"} rel="noreferrer" title={title}>
      {children}
    </a>
  ) : (
    <span className="life-ev" title={title}>
      {children}
    </span>
  );
}

/** One change's strip. `href` turns a step's evidence into a link (null: no link). */
export function LifecycleStrip({ s, href, now = Date.now(), open = false, caption = true }: { s: ChangeLifecycle; href: (l: LifecycleLink | undefined) => string | null; now?: number; open?: boolean; caption?: boolean }) {
  const [all, setAll] = useState(open);
  const reached = s.steps.find((x) => x.key === s.reached);
  const certified = s.steps.find((x) => x.key === "certified");
  const landed = s.steps.some((x) => x.key === "landed" && x.state === "done");
  const offAt = s.off ? s.steps.findIndex((x) => x.key === s.off!.after) : -1;
  const when = (at: number | undefined) => (typeof at === "number" ? timeAgo(at, now) : "");
  const takeBack = s.steps.find((x) => x.key === "taken-back");
  return (
    <section className={`life${s.off ? ` is-off is-${s.off.kind}` : ""}`} aria-label="Lifecycle">
      <ol className="life-row">
        {s.steps.map((x, i) => {
          const link = href(x.link);
          const title = [x.label, x.text, when(x.at)].filter(Boolean).join(" · ");
          const left = offAt >= 0 && i > offAt;
          return (
            <li key={x.key} className={`life-step is-${x.state}${x.key === s.reached ? " is-reached" : ""}${left ? " is-left" : ""}`} aria-current={x.key === s.reached ? "step" : undefined}>
              {link ? (
                <a className="life-chip" href={link} target={link.startsWith("/#") ? undefined : "_blank"} rel="noreferrer" title={title}>
                  <span className="life-mark" aria-hidden="true">
                    {MARK[x.state]}
                  </span>
                  {x.label}
                </a>
              ) : (
                <span className="life-chip" title={title}>
                  <span className="life-mark" aria-hidden="true">
                    {MARK[x.state]}
                  </span>
                  {x.label}
                </span>
              )}
              {s.off && i === offAt ? (
                <span className="life-chip life-off-chip" title={`${s.off.label}: ${s.off.text}`}>
                  <span className="life-mark" aria-hidden="true">
                    ↳
                  </span>
                  {s.off.label}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {s.off ? (
        <div className="life-line life-off">
          <b>
            {s.off.label} after {LIFECYCLE_LABEL[s.off.after].toLowerCase()}
          </b>
          : {s.off.text}
          {s.off.beatenBy ? (
            <>
              {" "}
              · beaten by{" "}
              <Evidence href={href(s.off.link)} title={s.off.beatenBy.title}>
                landing {shortId(s.off.beatenBy.landingId)}
              </Evidence>
              {s.off.beatenBy.title ? <span className="life-quote"> “{s.off.beatenBy.title}”</span> : null}
            </>
          ) : null}
          {s.off.at ? <span className="life-at"> · {when(s.off.at)}</span> : null}
        </div>
      ) : reached ? (
        <div className="life-line">
          <b>{reached.label}</b>: <Evidence href={href(reached.link)}>{reached.text}</Evidence>
          {reached.at ? <span className="life-at"> · {when(reached.at)}</span> : null}
        </div>
      ) : null}
      {!s.off && landed ? (
        <div className="life-line life-next">
          {certified?.state === "done" ? (
            <>
              Next, outside FireTrident: <Evidence href={href(takeBack?.link)}>push certified as a branch</Evidence> and open a pull request.
            </>
          ) : (
            <>Next: {certified?.text ?? "certification"}.</>
          )}
        </div>
      ) : null}
      {caption ? <p className="life-caption">{LIFECYCLE_CAPTION}</p> : null}
      <button type="button" className="link life-toggle" aria-expanded={all} onClick={() => setAll(!all)}>
        <span aria-hidden="true">{all ? "▾" : "▸"}</span> {all ? "Hide the steps" : "Each step"}
      </button>
      {all ? (
        <ol className="life-list">
          {s.steps.map((x, i) => (
            <li key={x.key} className={`life-item is-${x.state}${x.key === s.reached ? " is-reached" : ""}`}>
              <span className="life-item-k">
                <span className="life-mark" aria-hidden="true">
                  {MARK[x.state]}
                </span>
                {x.label}
              </span>
              <span className="life-item-v">
                <Evidence href={href(x.link)}>{x.text}</Evidence>
                {x.at ? <span className="life-at"> · {when(x.at)}</span> : null}
                {x.command ? <code className="life-cmd">{x.command}</code> : null}
                {s.off && i === offAt ? (
                  <span className="life-item-off">
                    ↳ {s.off.label}: {s.off.text}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/**
 * The strips of a Why card: one per change it shows, built from the lineage note the card holds. Its test row is read
 * once for the newest cards (`auto`, the same read the card's tests row makes); the others place the landing by the
 * newest green commit this page knows.
 */
export function WhyLifecycles({ store, backend, entry, proposals, auto }: { store: ColonyStore; backend: Backend; entry: WhyEntry; proposals: ReadonlyArray<LineageNote["proposals"][number]>; auto: boolean }) {
  const { landing, note } = entry;
  const [tests, setTests] = useState<LandingTests | null>(null);
  useEffect(() => {
    if (!auto || typeof backend.landingTests !== "function") return;
    let live = true;
    backend.landingTests(landing.id).then(
      (t) => live && setTests(t),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [backend, landing.id, auto]);
  const colonyId = store.colony?.id ?? store.colonyId;
  return (
    <div className="life-why">
      {proposals.map((p) => {
        const s = whyLifecycle(store, landing, p, note, tests);
        return (
          <div key={p.id}>
            {proposals.length > 1 ? <div className="life-for mono">{shortId(p.id)}</div> : null}
            <LifecycleStrip s={s} href={(l) => lifecycleHref(colonyId, s, l, backend.mode)} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * An intent's strip in the Intents tab, read from the colony when a person opens it (GET /intents/:iid/lifecycle): the
 * change it stands on now, then how many earlier changes it had and the last of them in a line.
 */
export function IntentLifecycleView({ colonyId, intentId, mode, now }: { colonyId: string; intentId: string; mode: "live" | "mock" | "replay"; now?: number }) {
  const [state, setState] = useState<LifecycleState>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setState({ state: "loading" });
    void readLifecycle(colonyId, intentId, mode).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [colonyId, intentId, mode]);
  if (state.state === "loading") return <div className="life-quiet">Reading its lifecycle…</div>;
  if (state.state === "unknown") return <div className="life-quiet">Its lifecycle is not known here: {state.why}.</div>;
  const l: IntentLifecycle = state.lifecycle;
  const s = l.current;
  const earlier = l.changes.filter((x) => x.proposalId !== s.proposalId);
  return (
    <div className="life-intent">
      <LifecycleStrip s={s} href={(link) => lifecycleHref(colonyId, s, link, mode)} {...(now !== undefined ? { now } : {})} />
      {earlier.length > 0 ? (
        <div className="life-earlier">
          {earlier.length === 1 ? "An earlier change" : `${earlier.length} earlier changes`}; the last: <span className="mono">{shortId(earlier[0]!.proposalId ?? "")}</span> {earlier[0]!.text}
        </div>
      ) : null}
    </div>
  );
}

/** The page's mode, as the store knows it: the simulator, a replay (or a recording), or a live colony. */
function modeOf(store: Pick<ColonyStore, "conn" | "replay">): "live" | "mock" | "replay" {
  return store.conn === "mock" ? "mock" : store.conn === "replay" || store.replay ? "replay" : "live";
}

/** An intent row's "Lifecycle" toggle in the Intents tab: the intent's strip, read when a person opens it. */
export function IntentLifecycleToggle({ store, intentId, now }: { store: ColonyStore; intentId: string; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    // The row picks its file on a click: a click inside the strip stays here.
    <div className="life-toggle-row" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="link life-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> Lifecycle
      </button>
      {open ? <IntentLifecycleView colonyId={store.colony?.id ?? store.colonyId} intentId={intentId} mode={modeOf(store)} now={now} /> : null}
    </div>
  );
}
