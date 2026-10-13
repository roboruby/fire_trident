import { useEffect, useRef, useState } from "react";
import { GUIDE_STEPS, rememberGuide, type GuideTarget } from "../guide.ts";

/**
 * The first-visit guide: a small card over the bottom of the map that walks through what is on
 * screen in six steps, ringing the part each step explains (`onTarget`). It never covers the
 * panels, takes no focus when it opens, and closing it (×, Skip, Got it or Escape) is remembered.
 * `lifted` keeps it above a replay's controls.
 */
export function Guide({ onTarget, onClose, lifted = false }: { onTarget: (t: GuideTarget | null) => void; onClose: () => void; lifted?: boolean }) {
  const [i, setI] = useState(0);
  const step = GUIDE_STEPS[i] ?? GUIDE_STEPS[0];
  const n = GUIDE_STEPS.length;
  const report = useRef(onTarget);
  report.current = onTarget;
  useEffect(() => {
    report.current(step?.target ?? null);
  }, [step]);
  useEffect(() => () => report.current(null), []);
  if (!step) return null;
  const close = () => {
    rememberGuide();
    onClose();
  };
  return (
    <section
      className={`guide${lifted ? " is-lifted" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="guide-title"
      aria-describedby="guide-text"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        close();
      }}
    >
      <div className="guide-head">
        <span className="guide-k">
          How to read this · {i + 1}/{n}
        </span>
        <button type="button" className="guide-x" aria-label="Close the guide" title="Close the guide" onClick={close}>
          ×
        </button>
      </div>
      <h2 className="guide-title" id="guide-title">
        {step.title}
      </h2>
      <p className="guide-text" id="guide-text">
        {step.text.split("`").map((part, k) => (k % 2 ? <span className="guide-label" key={k}>{part}</span> : part))}
      </p>
      <div className="guide-foot">
        <span className="guide-dots" aria-hidden="true">
          {GUIDE_STEPS.map((s, j) => (
            <i key={s.target} className={j === i ? "is-on" : j < i ? "is-past" : undefined} />
          ))}
        </span>
        {i > 0 ? (
          <button type="button" className="btn guide-btn" onClick={() => setI(i - 1)}>
            Back
          </button>
        ) : (
          <button type="button" className="link guide-skip" onClick={close}>
            Skip
          </button>
        )}
        {i < n - 1 ? (
          <button type="button" className="btn btn-approve guide-btn" onClick={() => setI(i + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn btn-approve guide-btn" onClick={close}>
            Got it
          </button>
        )}
      </div>
    </section>
  );
}
