#!/usr/bin/env node
// Record a shot ahead of the cut, for a live state that does not last (an escalation waiting for a
// person): the same recorder, badge and camera as render.mjs, into $FT_VIDEO_OUT/precapture/<name>.mp4.
// scenes.mjs uses the file as a `clip` shot. The spec lives in scenes.mjs (PRECAPTURES).
//
//   node video/precapture.mjs decide-review-live
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { evaluate, launch, newPage, press } from "./lib/cdp.mjs";
import { openPage, recordPage } from "./lib/record.mjs";
import { FPS, PRECAPTURES } from "./scenes.mjs";

const name = process.argv[2];
const sp = PRECAPTURES[name];
if (!sp) {
  console.error(`usage: node video/precapture.mjs <${Object.keys(PRECAPTURES).join(" | ")}>`);
  process.exit(1);
}
const OUT = resolve(process.env.FT_VIDEO_OUT ?? join(homedir(), ".firetrident/video"));
for (let d = OUT; d !== dirname(d); d = dirname(d)) {
  if (existsSync(join(d, ".obsidian"))) {
    console.error(`Refusing to write media inside a notes folder (${d}); set FT_VIDEO_OUT to a folder outside it.`);
    process.exit(1);
  }
}
const out = join(OUT, "precapture", `${name}.mp4`);
mkdirSync(dirname(out), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIRECTOR_READY = "!!document.querySelector('.director') && !document.querySelector('.overlay') && !!(document.querySelector('.dir-caption') || document.querySelector('.dir-title.is-on'))";
const BADGE_CSS = `.ftv-badge{position:fixed;z-index:2147483647;display:flex;align-items:center;gap:10px;font:600 15px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;padding:10px 16px;border-radius:999px;background:rgba(5,7,11,.86);border:1px solid;box-shadow:0 6px 24px rgba(0,0,0,.4)}
.ftv-badge i{width:8px;height:8px;border-radius:50%;background:currentColor;display:block}
.ftv-badge.sim{color:#5fd0ff;border-color:rgba(95,208,255,.5)}.ftv-badge.prod{color:#1fe08e;border-color:rgba(31,224,142,.45)}
.ftv-badge.br{right:30px;bottom:28px}.ftv-badge.bl{left:26px;bottom:50px}.ftv-badge.tc{left:420px;top:104px}`;
const css = `${BADGE_CSS}.dir-lower{display:none!important}${sp.css ?? ""}`;
const badge = sp.badge ? `<div class="ftv-badge ${sp.badge.kind} ${sp.badge.pos ?? "br"}"><i></i>${sp.badge.text}</div>` : "";

const browser = await launch({ profileDir: join(OUT, "chrome-profile-precapture") });
try {
  const page = await newPage(browser.cdp);
  await openPage(page, { url: sp.url, css, html: badge, ready: DIRECTOR_READY, settleMs: sp.settleMs ?? 3500 });
  if (sp.waitFor) {
    const t0 = Date.now();
    while (!(await evaluate(page, sp.waitFor))) {
      if (Date.now() - t0 > 30_000) throw new Error(`timed out waiting for ${sp.waitFor}`);
      await sleep(200);
    }
    await sleep(800);
  }
  for (const a of sp.prep ?? []) {
    if (a.key) await press(page, a.key);
    if (a.js) await evaluate(page, a.js);
    await sleep(a.wait ?? 500);
  }
  let perFrame = null;
  if (sp.camera) {
    // Move in on one element after `delay` s, over `move` s, to scale[0], then drift to scale[1].
    // alignRight keeps the page's right edge at the frame's (less `margin`), for the side panel.
    const c = await evaluate(page, `(() => { const e = document.querySelector(${JSON.stringify(sp.camera.on)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!c) throw new Error(`camera target ${sp.camera.on} not found`);
    const [s0, s1] = sp.camera.scale;
    if (sp.camera.alignRight) c[0] = 1920 - 960 / s0 - (sp.camera.margin ?? 0);
    const move = sp.camera.move ?? 1.6;
    const delay = sp.camera.delay ?? 0;
    perFrame = (t) => {
      const u = Math.min(1, Math.max(0, (t - delay) / move));
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const s = 1 + (s0 - 1) * e + (s1 - s0) * Math.max(0, (t - delay - move) / Math.max(0.1, sp.seconds - delay - move));
      return `(() => { const r = document.getElementById("root"); if (r) { r.style.transformOrigin = "${c[0].toFixed(1)}px ${c[1].toFixed(1)}px"; r.style.transform = "translate(${((960 - c[0]) * e).toFixed(2)}px, ${((540 - c[1]) * e).toFixed(2)}px) scale(${s.toFixed(5)})"; } })()`;
    };
  }
  const tmp = `${out}.part.mp4`;
  await recordPage(page, { seconds: sp.seconds, out: tmp, fps: FPS, perFrame, log: console.log });
  renameSync(tmp, out);
  console.log(`recorded ${out}`);
} finally {
  await browser.close();
}
