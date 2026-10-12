import { useEffect, useRef, useState } from "react";
import { colonyIds } from "../colonies.ts";
import { colonyHref } from "../route.ts";

interface Props {
  current: string;
  label: string;
  mock: boolean;
}

/** The colony name in the header, and a menu to switch colonies, open the simulator, or go home. */
export function ColonyPicker({ current, label, mock }: Props) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Array<{ id: string; name: string }> | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || list) return;
    const ctl = new AbortController();
    colonyIds(ctl.signal)
      .then(setList)
      .catch(() => setList([]));
    return () => ctl.abort();
  }, [open, list]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="picker" ref={root}>
      <button type="button" className="picker-btn mono" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Switch colony">
        <span className="picker-name">{label}</span>
        <svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="picker-menu" role="menu">
          <div className="picker-k">Colonies</div>
          {list === null ? <div className="picker-empty">Loading…</div> : null}
          {list?.map((c) => (
            <a key={c.id} role="menuitem" className={`picker-item${c.id === current && !mock ? " is-current" : ""}`} href={colonyHref(c.id)}>
              <i className="picker-dot" />
              <span className="mono">{c.name}</span>
              {c.name !== c.id ? <span className="picker-id mono">{c.id}</span> : null}
            </a>
          ))}
          {list && !list.length ? <div className="picker-empty">No colonies answered.</div> : null}
          <div className="picker-sep" />
          <a role="menuitem" className={`picker-item${mock ? " is-current" : ""}`} href={colonyHref("demo", { mock: true })}>
            <i className="picker-dot picker-dot-sim" />
            Simulator
          </a>
          <a role="menuitem" className="picker-item" href="/">
            <i className="picker-dot picker-dot-home" />
            All colonies
          </a>
        </div>
      ) : null}
    </div>
  );
}
