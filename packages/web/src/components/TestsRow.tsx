import type { LandingTests } from "@fire_trident/core";
import { speaker, testsLines } from "@fire_trident/core";
import { useEffect, useRef, useState } from "react";
import type { Backend } from "../api.ts";
import { SaidBy } from "./SaidBy.tsx";

/**
 * A landing's test row (core/testdelta.ts, worker certify/landingtests.ts), as the Why tab and the landing page's note
 * card draw it: one line of tests at the base against the certified commit, the tests lost, what landed it and its
 * spend, then the lines under it: the lost tests by name, a red result before it was certified, whose tests they are, and
 * the closure check, in amber when no earlier test reaches the change. Every number is FireTrident's own.
 */

/** The lines under a row: the lost tests, a red result first, whose tests, the closure check (amber when it warns), what could not be read. */
function Lines({ t }: { t: LandingTests }) {
  return (
    <>
      {testsLines(t).map((l, i) => (
        <div key={`${l.k}-${i}`} className={`tests-line is-${l.k}${l.warn ? " is-warn" : ""}`}>
          {l.text}
        </div>
      ))}
    </>
  );
}

/** One landing's test row, as the Why tab draws it: under a "Tests" label, checked by FireTrident. */
export function TestsRow({ t }: { t: LandingTests }) {
  const warn = testsLines(t).some((l) => l.warn);
  return (
    <div className={`tests-row is-${t.status}${warn ? " is-warn" : ""}`}>
      <div className="tests-head">
        <span className="tests-k">Tests</span>
        <SaidBy s={speaker("platform")} />
        <span className="tests-text">{t.text}</span>
      </div>
      <Lines t={t} />
    </div>
  );
}

/** One landing's test row inside a card field that is already labeled (the landing page's note card). */
export function TestsBody({ t }: { t: LandingTests }) {
  const warn = testsLines(t).some((l) => l.warn);
  return (
    <div className={`nc-tests is-${t.status}${warn ? " is-warn" : ""}`}>
      <div className="tests-text">
        <SaidBy s={speaker("platform")} /> {t.text}
      </div>
      <Lines t={t} />
    </div>
  );
}

/** What the row holds: not asked yet, being read, read, no row for this landing, or failed with the reason. */
export type TestsState = { kind: "idle" } | { kind: "loading" } | { kind: "loaded"; t: LandingTests } | { kind: "none" } | { kind: "failed"; message: string };

/** The row in each of its states (`ask` reads it when it was not asked yet). */
export function TestsRowView({ state, ask }: { state: TestsState; ask?: () => void }) {
  if (state.kind === "loaded") return <TestsRow t={state.t} />;
  const body =
    state.kind === "idle" ? (
      <button type="button" className="link tests-btn" onClick={ask} title="Read this landing's tests at its base against the certified commit that includes it">
        <span aria-hidden="true">▸</span> Show its tests
      </button>
    ) : state.kind === "loading" ? (
      <span className="tests-quiet">Reading its tests at its base and at the certified commit…</span>
    ) : state.kind === "none" ? (
      <span className="tests-quiet">The colony has no test row for this landing.</span>
    ) : (
      <span className="tests-quiet">{state.message}</span>
    );
  return (
    <div className={`tests-row is-${state.kind}`}>
      <div className="tests-head">
        <span className="tests-k">Tests</span>
        {body}
      </div>
    </div>
  );
}

/**
 * A landing's test row in the Why tab, read from the colony when the card opens (`auto`, the newest landings) or when a
 * person asks; nothing for a backend that has no test rows (the simulator).
 */
export function LandingTestsRow({ backend, landingId, auto }: { backend: Backend; landingId: string; auto: boolean }) {
  const [state, setState] = useState<TestsState>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const ask = (): void => {
    if (typeof backend.landingTests !== "function") return;
    setState({ kind: "loading" });
    backend.landingTests(landingId).then(
      (t) => alive.current && setState(t ? { kind: "loaded", t } : { kind: "none" }),
      (e: unknown) => alive.current && setState({ kind: "failed", message: e instanceof Error ? e.message : "The test row could not be read." }),
    );
  };
  // Asked once per landing shown (`ask` reads the current backend).
  useEffect(() => {
    if (auto) ask();
  }, [backend, landingId, auto]);
  if (typeof backend.landingTests !== "function") return null;
  return <TestsRowView state={state} ask={ask} />;
}
