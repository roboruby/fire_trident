// Virtual time for deterministic frame capture. Injected before any page script runs
// (Page.addScriptToEvaluateOnNewDocument). While "live", the virtual clock follows the real
// one, so pages load and settle normally. After window.__ft.freeze(), time moves only when
// the recorder calls window.__ft.step(ms): timers fire in order, requestAnimationFrame
// callbacks run once with the new timestamp, CSS and Web Animations are seeked, and SVG
// (SMIL) timelines are set, so every captured frame sits exactly ms after the previous one.
(() => {
  if (window.__ft) return;
  const realPerfNow = performance.now.bind(performance);
  const realRAF = window.requestAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const RealDate = Date;
  const perf0 = realPerfNow();
  const date0 = RealDate.now();
  let vt = 0;
  let live = true;

  const elapsed = () => {
    if (live) vt = Math.max(vt, realPerfNow() - perf0);
    return vt;
  };

  // -- clocks ---------------------------------------------------------------
  performance.now = () => perf0 + elapsed();
  function VDate(...args) {
    if (!new.target) return new RealDate(date0 + elapsed()).toString();
    return args.length ? new RealDate(...args) : new RealDate(date0 + elapsed());
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = () => Math.floor(date0 + elapsed());
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  Object.defineProperty(VDate.prototype, "constructor", { value: VDate, configurable: true, writable: true });
  window.Date = VDate;

  // -- timers ---------------------------------------------------------------
  let nextId = 1;
  let seq = 1;
  const timers = new Map();
  const call = (fn, args) => {
    try {
      if (typeof fn === "function") fn(...args);
      else (0, eval)(String(fn));
    } catch (err) {
      console.error(err);
    }
  };
  const add = (fn, delay, args, repeat) => {
    const id = nextId++;
    const d = Math.max(repeat ? 1 : 0, Number(delay) || 0);
    timers.set(id, { at: elapsed() + d, fn, args, interval: repeat ? d : null, seq: seq++ });
    return id;
  };
  window.setTimeout = (fn, delay, ...args) => add(fn, delay, args, false);
  window.setInterval = (fn, delay, ...args) => add(fn, delay, args, true);
  window.clearTimeout = (id) => void timers.delete(id);
  window.clearInterval = (id) => void timers.delete(id);

  /** Fire every timer due at or before `target` (virtual ms), earliest first. */
  function runTimers(target) {
    for (let guard = 0; guard < 200000; guard++) {
      let bestId = 0;
      let best = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq))) {
          best = t;
          bestId = id;
        }
      }
      if (!best) break;
      vt = Math.max(vt, best.at);
      if (best.interval !== null) {
        best.at += best.interval;
        best.seq = seq++;
      } else timers.delete(bestId);
      call(best.fn, best.args);
    }
    vt = Math.max(vt, target);
  }

  // -- animation frames ------------------------------------------------------
  let rafId = 1;
  let rafs = new Map();
  window.requestAnimationFrame = (cb) => {
    const id = rafId++;
    rafs.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => void rafs.delete(id);
  function runRafs() {
    const q = rafs;
    rafs = new Map();
    const ts = perf0 + vt;
    for (const cb of q.values()) call(cb, [ts]);
  }

  // While live, a real frame loop (and a timer fallback) drives the virtual clock.
  const pump = () => {
    if (!live) return;
    runTimers(elapsed());
    runRafs();
  };
  const liveFrame = () => {
    if (!live) return;
    pump();
    realRAF(liveFrame);
  };
  realRAF(liveFrame);
  const liveTick = () => {
    if (!live) return;
    pump();
    realSetTimeout(liveTick, 16);
  };
  realSetTimeout(liveTick, 16);

  // -- CSS / Web Animations and SVG timelines ----------------------------------
  const animStart = new WeakMap();
  const svgStart = new WeakMap();
  function syncAnimations(continuing) {
    for (const a of document.getAnimations()) {
      let s = animStart.get(a);
      if (s === undefined) {
        const ct = continuing && typeof a.currentTime === "number" ? a.currentTime / (a.playbackRate || 1) : 0;
        s = vt - ct;
        animStart.set(a, s);
        try {
          a.pause();
        } catch {}
      }
      try {
        a.currentTime = (vt - s) * (a.playbackRate || 1);
      } catch {}
    }
    for (const svg of document.querySelectorAll("svg")) {
      if (svg.ownerSVGElement) continue;
      let s = svgStart.get(svg);
      if (s === undefined) {
        s = vt / 1000 - (continuing ? svg.getCurrentTime() : 0);
        svgStart.set(svg, s);
        try {
          svg.pauseAnimations();
        } catch {}
      }
      try {
        svg.setCurrentTime(Math.max(0, vt / 1000 - s));
      } catch {}
    }
  }

  // -- settling: let tasks queued by the step (React commits) run ---------------
  const channel = new MessageChannel();
  const waiting = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  const macrotask = () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
  async function settle(turns) {
    for (let i = 0; i < turns; i++) await macrotask();
  }

  window.__ft = {
    /** Stop following real time; from now on only step() moves the clock. */
    async freeze() {
      if (!live) return vt;
      elapsed();
      live = false;
      runTimers(vt);
      syncAnimations(true);
      await settle(2);
      return vt;
    },
    /** Advance `ms` of virtual time and render one frame at the new time. */
    async step(ms, turns = 3) {
      runTimers(vt + ms);
      runRafs();
      await settle(turns);
      syncAnimations(false);
      return vt;
    },
    /** Advance `ms` quickly (timers and frames every `frame` ms, no capture). */
    async skip(ms, frame = 50) {
      const end = vt + ms;
      while (vt < end) {
        runTimers(Math.min(end, vt + frame));
        runRafs();
        await settle(1);
      }
      syncAnimations(false);
      await settle(2);
      return vt;
    },
    now: () => vt,
    isLive: () => live,
  };
})();
