import { useEffect, useLayoutEffect, useRef } from "react";
import { fmtInt } from "../format.ts";

interface Props {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}

/**
 * A number that rolls to its new value. It writes text straight into its span
 * every animation frame, so a counter ticking at 60fps never re-renders React.
 */
export function AnimatedNumber({ value, format = fmtInt, duration = 750, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const anim = useRef({ shown: value, from: value, to: value, start: 0, raf: 0 });

  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = format(anim.current.shown);
  }, [format]);

  useEffect(() => {
    const a = anim.current;
    if (a.to === value) return;
    a.from = a.shown;
    a.to = value;
    a.start = performance.now();
    cancelAnimationFrame(a.raf);
    const tick = () => {
      // Read the clock here rather than trusting the rAF timestamp: it can precede `start`
      // or lag performance.now(), and an unclamped cubic ease extrapolates into nonsense.
      const now = performance.now();
      const u = Math.max(0, Math.min(1, (now - a.start) / duration));
      const next = a.from + (a.to - a.from) * (1 - (1 - u) ** 3);
      a.shown = Number.isFinite(next) ? next : a.to;
      if (ref.current) ref.current.textContent = format(a.shown);
      if (u < 1) a.raf = requestAnimationFrame(tick);
    };
    a.raf = requestAnimationFrame(tick);
  }, [value, duration, format]);

  useEffect(() => {
    const a = anim.current;
    return () => cancelAnimationFrame(a.raf);
  }, []);

  return <span ref={ref} className={className} />;
}
