// Frame-exact recording: open a page with the virtual-time shim, freeze its clock, then for
// every output frame run the scheduled actions, step the clock by 1/fps and take a screenshot,
// piping JPEG frames into ffmpeg. The result is a constant-rate clip whose motion does not
// depend on how fast this machine can render or encode.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { click, evaluate, press, waitFor } from "./cdp.mjs";

export const SHIM = readFileSync(new URL("./timeshim.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A document-start script that adds a stylesheet and optional overlay HTML once the DOM exists. */
function decorate({ css = "", html = "" }) {
  return `(() => {
    const css = ${JSON.stringify(css)};
    const html = ${JSON.stringify(html)};
    const add = () => {
      if (css) {
        const s = document.createElement("style");
        s.setAttribute("data-ft-video", "");
        s.textContent = css;
        document.head.appendChild(s);
      }
      if (html) {
        const d = document.createElement("div");
        d.setAttribute("data-ft-video", "");
        d.innerHTML = html;
        document.body.appendChild(d);
      }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true });
    else add();
  })();`;
}

/**
 * Navigate a fresh page: install the shim and decorations, load the URL, wait until `ready`
 * (a page expression) is truthy, then let it settle in real time for settleMs.
 */
export async function openPage(page, { url, css, html, ready, readyTimeoutMs = 60_000, settleMs = 0, shim = true }) {
  if (shim) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });
  if (css || html) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: decorate({ css, html }) });
  const loaded = page.once("Page.loadEventFired", 90_000);
  await page.send("Page.navigate", { url });
  await loaded;
  if (ready) await waitFor(page, ready, { timeoutMs: readyTimeoutMs, what: ready });
  if (settleMs) await sleep(settleMs);
}

/** Run one timeline action: {js}, {key}, {click: [x, y]}, or {fn: async (page) => {}}. */
async function act(page, a) {
  if (a.js) await evaluate(page, a.js);
  if (a.key) await press(page, a.key);
  if (a.click) await click(page, a.click[0], a.click[1]);
  if (a.fn) await a.fn(page);
}

/**
 * Record `seconds` of the page at `fps` into `out` (H.264, near-lossless intermediate).
 * timeline: [{at: seconds, js | key | click | fn}], applied before the frame at that time.
 * perFrame(t): an expression string (or null) evaluated before each frame, e.g. a scroll position.
 * skipMs: virtual time to fast-forward after freezing, before frame 0.
 * timeScale: virtual time that passes per recorded frame, in frame lengths (2 records a time-lapse at double speed).
 */
export async function recordPage(page, { seconds, out, fps = 30, timeline = [], perFrame, skipMs = 0, timeScale = 1, quality = 92, crf = 12, log = () => {} }) {
  const frames = Math.max(1, Math.round(seconds * fps));
  const ff = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "pipe:0", "-vf", "scale=in_range=full:out_range=limited,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-r", String(fps), "-movflags", "+faststart", out],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let fferr = "";
  ff.stderr.on("data", (d) => {
    fferr = (fferr + d).slice(-4000);
  });
  const exited = once(ff, "exit");
  await evaluate(page, "window.__ft.freeze()");
  if (skipMs > 0) await evaluate(page, `window.__ft.skip(${skipMs})`);
  await evaluate(page, "window.__ftBegin && window.__ftBegin()");
  const events = [...timeline].sort((a, b) => a.at - b.at);
  let next = 0;
  const t0 = Date.now();
  const dt = 1000 / fps;
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    while (next < events.length && events[next].at <= t + 1e-6) await act(page, events[next++]);
    const pre = perFrame ? perFrame(t, i) : null;
    if (pre) await evaluate(page, pre);
    await evaluate(page, `window.__ft.step(${i === 0 ? 0 : dt * timeScale})`);
    const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true });
    if (!ff.stdin.write(Buffer.from(data, "base64"))) await once(ff.stdin, "drain");
    if (i % (fps * 5) === 0 && i) log(`  ${(t).toFixed(0)}s of ${seconds.toFixed(1)}s (${((i / (Date.now() - t0)) * 1000).toFixed(1)} frames/s)`);
  }
  ff.stdin.end();
  const [code] = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed for ${out}: ${fferr}`);
  return { frames, ms: Date.now() - t0 };
}

/** One still frame (PNG) of the page as it is now, for checks. */
export async function still(page, out) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, Buffer.from(data, "base64"));
}
