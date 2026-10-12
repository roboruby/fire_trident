import { useEffect, useLayoutEffect, useRef } from "react";
import { fmtInt } from "../format.ts";

interface Props {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
  /** Floor for the shown value (counters never show negatives). */
  min?: number;
}

/** A finite value at or above `min` (NaN, Infinity, and undefined become `min`). */
function clean(v: unknown, min: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : min;
}

/**
 * A number that rolls to its new value. It writes text straight into its span
 * every animation frame, so a counter ticking at 60fps never re-renders React.
 * Values are sanitized on the way in and on every frame: the shown number is
 * always finite and never below `min`.
 */
export function AnimatedNumber({ value, format = fmtInt, duration = 750, className, min = 0 }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const target = clean(value, min);
  const anim = useRef({ shown: target, from: target, to: target, start: 0, raf: 0 });

  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = format(clean(anim.current.shown, min));
  }, [format, min]);

  useEffect(() => {
    const a = anim.current;
    if (a.to === target) return;
    a.from = clean(a.shown, min);
    a.to = target;
    a.start = performance.now();
    cancelAnimationFrame(a.raf);
    const tick = () => {
      // Read the clock here rather than trusting the rAF timestamp: it can precede `start`
      // or lag performance.now(), and an unclamped cubic ease extrapolates into nonsense.
      const now = performance.now();
      const u = Math.max(0, Math.min(1, (now - a.start) / Math.max(1, duration)));
      const next = a.from + (a.to - a.from) * (1 - (1 - u) ** 3);
      a.shown = clean(next, min);
      if (ref.current) ref.current.textContent = format(a.shown);
      if (u < 1) a.raf = requestAnimationFrame(tick);
    };
    a.raf = requestAnimationFrame(tick);
  }, [target, duration, format, min]);

  useEffect(() => {
    const a = anim.current;
    return () => cancelAnimationFrame(a.raf);
  }, []);

  return <span ref={ref} className={className} />;
}
