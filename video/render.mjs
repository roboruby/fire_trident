#!/usr/bin/env node
// FireTrident video, one command: narration (Workers AI Aura-2 via the ft-voice Worker), picture
// (headless Chrome, frame-exact), and the cut (ffmpeg, H.264 1080p30 + AAC at -16 LUFS).
//
//   node video/render.mjs                    render; speech and recorded shots are cached
//   node video/render.mjs --recapture        record every shot again (after UI or data changes)
//   node video/render.mjs --only sense,land  record these scenes again, then reassemble
//   node video/render.mjs --voice odysseus   narrate with another Aura-2 speaker
//   node video/render.mjs --samples          the cold open in several voices (voices/<speaker>.mp3)
//   node video/render.mjs --audio-only       narration, subtitles and timings, no picture
//
// Media goes to $FT_VIDEO_OUT (default ~/Desktop/save/firetrident/video), never into the repo.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { align, sentences, timedWords, words } from "./lib/align.mjs";
import { fadeEdges, RATE, readWav, trimSilence, writeWav } from "./lib/audio.mjs";
import { evaluate, launch, newPage, press } from "./lib/cdp.mjs";
import { loadNarration, placeholders } from "./lib/narration.mjs";
import { openPage, recordPage } from "./lib/record.mjs";
import { serve } from "./lib/server.mjs";
import { speak, spend, transcribe } from "./lib/voice.mjs";
import { FPS, OPENING, PACE, SCENES, VOICE } from "./scenes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const OUT = resolve(process.env.FT_VIDEO_OUT ?? join(homedir(), "Desktop/save/firetrident/video"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash("sha256").update(s).digest("hex");
const log = (...a) => console.log(...a);

// -- arguments -------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const voice = opt("voice", VOICE);
const only = new Set((opt("only", "") || "").split(",").filter(Boolean));
const name = opt("name", "firetrident-roughcut-v0");
const SAMPLE_VOICES = (opt("voices", "electra,thalia,odysseus,orpheus") || "").split(",");

// -- media stays outside any notes folder ---------------------------------------------------------
function vaultRoot(dir) {
  for (let d = dir; d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".obsidian"))) return d;
  return null;
}
const vault = vaultRoot(REPO);
if (vault && (OUT === vault || OUT.startsWith(`${vault}/`))) {
  console.error(`Refusing to write media inside a notes folder (${vault}); set FT_VIDEO_OUT to a folder outside it.`);
  process.exit(1);
}
const DIRS = { tts: join(OUT, "tts"), voices: join(OUT, "voices"), captures: join(OUT, "captures"), build: join(OUT, "build"), out: join(OUT, "out"), review: join(OUT, "review") };
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
const ffprobeDur = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
const WHISPER_HINT = "FireTrident, Hono, Clef, Artifacts, Durable Objects, Workers AI, MCP, Claude Code";

// -- 1. narration --------------------------------------------------------------------------
const pronounce = JSON.parse(readFileSync(join(HERE, "pronounce.json"), "utf8"));
const scenes = loadNarration(join(HERE, "narration.md"), pronounce);
for (const s of scenes) if (!SCENES[s.id]) throw new Error(`scenes.mjs has no plan for "${s.id}" (narration heading "${s.title}")`);

if (flag("samples")) {
  const text = scenes[0].paragraphs.map((p) => p.spoken).join(" ");
  log(`Voice samples of the cold open (${text.length} characters each):`);
  for (const speaker of SAMPLE_VOICES) {
    const r = await speak({ text, speaker, format: "mp3", dir: DIRS.tts, log });
    const dest = join(DIRS.voices, `${speaker}.mp3`);
    copyFileSync(r.path, dest);
    const dur = ffprobeDur(dest);
    const heard = await transcribe({ path: dest, dir: DIRS.tts });
    const a = align(words(text), timedWords(heard), dur);
    log(`  ${speaker.padEnd(10)} ${dur.toFixed(1)} s, ${Math.round((words(text).length / dur) * 60)} words/min, Whisper word error ${(a.wer * 100).toFixed(1)}%  ${dest}`);
  }
  log(`TTS spend so far: ${spend(DIRS.tts).chars} characters, $${spend(DIRS.tts).usd.toFixed(3)}`);
  process.exit(0);
}

log(`Narration: ${scenes.length} scenes, voice ${voice}`);
const paras = scenes.flatMap((s) => s.paragraphs.map((p) => ({ s, p })));
await pool(paras, 4, async ({ p }) => {
  const r = await speak({ text: p.spoken, speaker: voice, format: "wav", dir: DIRS.tts, log });
  const wav = readWav(r.path);
  if (wav.rate !== RATE) throw new Error(`${r.path}: expected ${RATE} Hz, got ${wav.rate}`);
  const trimmed = trimSilence(wav.samples);
  p.samples = fadeEdges(trimmed.samples);
  p.duration = p.samples.length / RATE;
  p.words = words(p.text);
  // Whisper with a spelling prompt sometimes returns nothing; then the plain transcription wins.
  let heard = await transcribe({ path: r.path, dir: DIRS.tts, prompt: WHISPER_HINT });
  let a = align(p.words, timedWords(heard), wav.samples.length / RATE);
  if (a.wer > 0.25) {
    const plain = await transcribe({ path: r.path, dir: DIRS.tts });
    const b = align(p.words, timedWords(plain), wav.samples.length / RATE);
    if (b.wer < a.wer) [heard, a] = [plain, b];
  }
  const shift = trimmed.cut / RATE;
  p.times = a.times.map((x) => ({ start: Math.max(0, x.start - shift), end: Math.max(0, x.end - shift) }));
  p.wer = a.wer;
  p.heard = heard.text?.trim() ?? "";
});
const words_ = paras.reduce((n, { p }) => n + p.words.length, 0);
const speech = paras.reduce((n, { p }) => n + p.duration, 0);
log(`  ${words_} words, ${speech.toFixed(1)} s of speech (${Math.round((words_ / speech) * 60)} words/min); TTS spend so far $${spend(DIRS.tts).usd.toFixed(3)}`);
for (const { s, p } of paras) if (p.wer > 0.12) log(`  check pronunciation in ${s.id} paragraph ${p.index + 1}: Whisper heard "${p.heard}"`);

// -- 2. timeline -----------------------------------------------------------------------------
const shots = [];
const subs = [];
let clock = 0;
shots.push({ scene: "opening", index: 0, spec: OPENING, start: 0, end: OPENING.dur, fadeIn: 0.5, fadeOut: PACE.fade });
clock = OPENING.dur;

for (const s of scenes) {
  const plan = SCENES[s.id];
  const lead = plan.lead ?? PACE.lead;
  const gap = plan.gap ?? PACE.gap;
  const tail = plan.tail ?? PACE.tail;
  const start = clock;
  let pos = start + lead;
  for (const p of s.paragraphs) {
    p.start = pos;
    pos += p.duration + gap;
  }
  const end = pos - gap + tail;
  /** Absolute time a phrase is spoken, first occurrence at or after `after`. */
  const spokenAt = (phrase, after) => {
    const needle = phrase.toLowerCase();
    for (const p of s.paragraphs) {
      const lower = p.text.toLowerCase();
      for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) {
        const wi = p.words.findIndex((w) => w.at + w.raw.length > i);
        if (wi < 0) continue;
        const t = p.start + p.times[wi].start;
        if (t >= after - 0.05) return t;
      }
    }
    throw new Error(`"${phrase}" is not spoken in ${s.id} after ${after.toFixed(2)} s`);
  };
  const starts = [];
  let prev = start;
  for (const shot of plan.shots) {
    let t = typeof shot.at === "number" ? start + shot.at : spokenAt(shot.at, prev) - PACE.cutLead;
    t = Math.max(t, prev);
    starts.push(t);
    prev = t;
  }
  plan.shots.forEach((spec, i) => {
    const s0 = starts[i];
    const s1 = starts[i + 1] ?? end;
    const rel = (anchor, lead = 0) => (typeof anchor === "number" ? anchor : Math.max(0, spokenAt(anchor, s0) - s0 - lead));
    const resolved = { ...spec };
    if (spec.actions) resolved.actions = spec.actions.map((a) => ({ ...a, at: rel(a.at, 0.3) }));
    if (spec.cues) resolved.cues = spec.cues.map((c) => rel(c, 0.15));
    if (spec.beats) resolved.beats = spec.beats.map((b) => rel(b, 0.12));
    if (spec.scroll) resolved.scroll = { ...spec.scroll, keys: spec.scroll.keys.map((k) => ({ ...k, at: rel(k.at, 0.3) })) };
    shots.push({ scene: s.id, index: i, spec: resolved, start: s0, end: s1, fadeIn: i === 0 ? PACE.fade : 0, fadeOut: i === plan.shots.length - 1 ? PACE.fade : 0 });
  });
  for (const p of s.paragraphs) for (const x of sentences(p.text.replace(/[{}]/g, ""), words(p.text.replace(/[{}]/g, "")), p.times)) subs.push({ text: x.text, start: p.start + x.start, end: p.start + x.end });
  s.start = start;
  s.end = end;
  clock = end;
}
const last = shots[shots.length - 1];
last.fadeOut = 1.2;
const total = clock;
for (const sh of shots) {
  sh.f0 = Math.round(sh.start * FPS);
  sh.f1 = Math.round(sh.end * FPS);
  sh.frames = sh.f1 - sh.f0;
  sh.seconds = sh.frames / FPS;
}
const totalFrames = shots[shots.length - 1].f1;
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
log(`Timeline: ${shots.length} shots, ${mmss(total)} (${total.toFixed(1)} s)`);
for (const s of scenes) log(`  ${mmss(s.start)}  ${s.title.padEnd(22)} ${(s.end - s.start).toFixed(1).padStart(5)} s`);

// -- narration track and subtitles ------------------------------------------------------------
const track = new Int16Array(Math.round(totalFrames / FPS * RATE));
for (const { p } of paras) track.set(p.samples.subarray(0, Math.max(0, track.length - Math.round(p.start * RATE))), Math.round(p.start * RATE));
const narrationWav = join(DIRS.build, `${name}.narration.wav`);
writeWav(narrationWav, track);
const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
const srt = subs.map((x, i) => `${i + 1}\n${srtTime(x.start)} --> ${srtTime(Math.max(x.end + 0.15, x.start + 0.8))}\n${x.text}\n`).join("\n");
writeFileSync(join(DIRS.out, `${name}.srt`), srt);
writeFileSync(
  join(DIRS.out, `${name}.timeline.json`),
  JSON.stringify(
    {
      voice,
      fps: FPS,
      total,
      placeholders: placeholders(scenes),
      scenes: scenes.map((s) => ({ id: s.id, title: s.title, start: s.start, end: s.end, paragraphs: s.paragraphs.map((p) => ({ start: p.start, duration: p.duration, wer: p.wer, text: p.text })) })),
      shots: shots.map((sh) => ({ scene: sh.scene, index: sh.index, kind: sh.spec.kind, start: sh.start, end: sh.end, frames: sh.frames, source: sh.spec.url ?? sh.spec.t ?? sh.spec.card })),
    },
    null,
    2,
  ),
);
if (flag("audio-only")) {
  log(`Narration: ${narrationWav}\nSubtitles: ${join(DIRS.out, `${name}.srt`)}`);
  process.exit(0);
}

// -- 3. picture ----------------------------------------------------------------------------------
const READY = {
  director: "!!document.querySelector('.director') && !document.querySelector('.overlay') && !!(document.querySelector('.dir-caption') || document.querySelector('.dir-title.is-on'))",
  landing: "!!document.querySelector('.l-h1') && document.querySelectorAll('.lc-head').length > 0",
  why: "!document.querySelector('.overlay') && /lineage of/i.test(document.querySelector('.side') ? document.querySelector('.side').innerText : '')",
  complete: "document.readyState === 'complete'",
  local: "!!document.body && document.body.dataset.ready === '1'",
};
const SETTLE = { director: 2600, landing: 2600, why: 1800, complete: 500, local: 300 };
const BADGE_CSS = `.ftv-badge{position:fixed;z-index:2147483647;display:flex;align-items:center;gap:10px;font:600 15px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;padding:10px 16px;border-radius:999px;background:rgba(5,7,11,.86);border:1px solid;box-shadow:0 6px 24px rgba(0,0,0,.4)}
.ftv-badge i{width:8px;height:8px;border-radius:50%;background:currentColor;display:block}
.ftv-badge.sim{color:#5fd0ff;border-color:rgba(95,208,255,.5)}.ftv-badge.prod{color:#1fe08e;border-color:rgba(31,224,142,.45)}
.ftv-badge.br{right:30px;bottom:28px}.ftv-badge.bl{left:26px;bottom:50px}.ftv-badge.tc{left:420px;top:104px}`;
const SCROLL_JS = `window.__ftScroller = (sel) => {
  if (!sel) return document.scrollingElement;
  if (sel.startsWith("auto:")) {
    const root = document.querySelector(sel.slice(5));
    if (!root) return null;
    return [root, ...root.querySelectorAll("*")].find((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) || null;
  }
  return document.querySelector(sel);
};
window.__ftTarget = (sel, to) => {
  const el = window.__ftScroller(sel);
  if (!el) return 0;
  let node = null;
  if (to.startsWith("text:")) node = [...document.querySelectorAll("h1,h2,h3")].find((h) => h.textContent.includes(to.slice(5)));
  else node = document.querySelector(to);
  if (!node) return 0;
  const base = el === document.scrollingElement ? 0 : el.getBoundingClientRect().top;
  return node.getBoundingClientRect().top - base + el.scrollTop;
};
window.__ftScrollTo = (sel, y) => { const el = window.__ftScroller(sel); if (el) el.scrollTop = y; };`;

function shotUrl(sh, origin) {
  const sp = sh.spec;
  const dur = sh.seconds;
  if (sp.kind === "terminal") {
    const params = { t: sp.t, dur, cues: sp.cues, mark: sp.mark, maxType: sp.maxType, lps: sp.lps, blockLps: sp.blockLps, hold: sp.hold };
    return `${origin}/terminal.html#${encodeURIComponent(JSON.stringify(params))}`;
  }
  if (sp.kind === "card") {
    const { kind, at, ...rest } = sp;
    return `${origin}/cards.html#${encodeURIComponent(JSON.stringify({ ...rest, dur }))}`;
  }
  return sp.local ? `${origin}${sp.url}` : sp.url;
}

const source = (f) => readFileSync(join(HERE, f), "utf8");
const recorderVersion = hash(source("lib/timeshim.js") + source("lib/record.mjs")).slice(0, 12);
/** Cache key of a shot: its spec, length, the recorder, and the local page and transcript it shows. */
function shotKey(sh) {
  const sp = sh.spec;
  const extra = sp.kind === "terminal" ? source("terminal.html") + source(`transcripts/${sp.t}.txt`) : sp.kind === "card" ? source("cards.html") : "";
  return hash(JSON.stringify({ sp, frames: sh.frames, fps: FPS, recorderVersion, extra: hash(extra) })).slice(0, 12);
}

const server = await serve({ "/": HERE, "/bench/": join(REPO, "packages/bench/results") });
const todo = [];
for (const sh of shots) {
  sh.file = join(DIRS.captures, `${sh.scene}-${sh.index}-${shotKey(sh)}.mp4`);
  const forced = flag("recapture") || only.has(sh.scene);
  if (forced && existsSync(sh.file)) rmSync(sh.file);
  if (!existsSync(sh.file)) todo.push(sh);
}
log(`Picture: ${shots.length - todo.length} shots cached, ${todo.length} to record`);
if (todo.length) {
  const browser = await launch({ profileDir: join(OUT, "chrome-profile") });
  try {
    for (const sh of todo) {
      const sp = sh.spec;
      const url = shotUrl(sh, server.origin);
      const director = sp.kind === "page" && /[?&]director=1/.test(url);
      const ready = READY[sp.ready ?? (sp.kind !== "page" ? "local" : director ? "director" : "complete")];
      const settle = sp.settleMs ?? SETTLE[sp.ready ?? (sp.kind !== "page" ? "local" : director ? "director" : "complete")];
      let css = BADGE_CSS;
      if (director) css += ".dir-lower{display:none!important}";
      if (sp.hideSub) css += ".dir-sub{display:none!important}";
      if (sp.css) css += sp.css;
      css += ".landing{scroll-behavior:auto!important}html{scroll-behavior:auto!important}";
      const badge = sp.badge ? `<div class="ftv-badge ${sp.badge.kind} ${sp.badge.pos ?? "br"}"><i></i>${sp.badge.text}</div>` : "";
      const t0 = Date.now();
      log(`  ${sh.scene} #${sh.index + 1} ${sp.kind} ${sh.seconds.toFixed(1)} s  ${sp.kind === "page" ? url : sp.t ?? sp.card}`);
      const page = await newPage(browser.cdp);
      try {
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SCROLL_JS });
        await openPage(page, { url, css, html: badge, ready, settleMs: settle });
        for (const a of sp.prep ?? []) {
          if (a.key) await press(page, a.key);
          if (a.js) await evaluate(page, a.js);
          await sleep(500);
        }
        let perFrame = null;
        if (sp.scroll) {
          const el = JSON.stringify(sp.scroll.el ?? null);
          const keys = [];
          for (const k of sp.scroll.keys) keys.push({ at: k.at, dur: k.dur ?? 1.4, y: k.to ? (await evaluate(page, `window.__ftTarget(${el}, ${JSON.stringify(k.to)})`)) + (k.offset ?? 0) : k.y });
          keys.sort((a, b) => a.at - b.at);
          const yAt = (t) => {
            let y = keys[0].y;
            for (const k of keys) {
              if (t < k.at) break;
              const u = Math.min(1, (t - k.at) / k.dur);
              const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
              y = y + (k.y - y) * e;
            }
            return Math.max(0, Math.round(y));
          };
          await evaluate(page, `window.__ftScrollTo(${el}, ${yAt(0)})`);
          await sleep(200);
          perFrame = (t) => `window.__ftScrollTo(${el}, ${yAt(t)})`;
        }
        // Finished production colonies do not move; a slow push-in (scale on the app root, so the
        // badge stays put) keeps those shots alive. drift is the zoom reached at the end of the shot.
        const drift = sp.drift ?? (director && !/[?&]mock=1/.test(url) && !sp.camera ? 0.035 : 0);
        if (sp.camera) {
          // Move in on one element: bring its center to the middle of the frame and scale it from
          // 1 to scale[0] over `move` seconds, then drift on to scale[1] by the end of the shot.
          const c = await evaluate(page, `(() => { const e = document.querySelector(${JSON.stringify(sp.camera.on)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
          if (!c) throw new Error(`camera target ${sp.camera.on} not found on ${url}`);
          const [s0, s1] = sp.camera.scale ?? [1.3, 1.4];
          const move = sp.camera.move ?? 1.6;
          const scroll = perFrame;
          const cam = (t) => {
            const u = Math.min(1, t / move);
            const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
            const s = 1 + (s0 - 1) * e + (s1 - s0) * Math.max(0, (t - move) / Math.max(0.1, sh.seconds - move));
            return `(() => { const r = document.getElementById("root"); if (r) { r.style.transformOrigin = "${c[0].toFixed(1)}px ${c[1].toFixed(1)}px"; r.style.transform = "translate(${((960 - c[0]) * e).toFixed(2)}px, ${((540 - c[1]) * e).toFixed(2)}px) scale(${s.toFixed(5)})"; } })()`;
          };
          perFrame = (t) => [scroll ? scroll(t) : null, cam(t)].filter(Boolean).join(";");
        }
        if (drift) {
          const scroll = perFrame;
          const zoom = (t) => `(() => { const r = document.getElementById("root"); if (r) { r.style.transformOrigin = "50% 50%"; r.style.transform = "scale(${(1 + (drift * t) / sh.seconds).toFixed(5)})"; } })()`;
          perFrame = (t) => [scroll ? scroll(t) : null, zoom(t)].filter(Boolean).join(";");
        }
        const timeline = (sp.actions ?? []).map((a) => ({ at: a.at, key: a.key, js: a.js }));
        const tmp = `${sh.file}.part.mp4`;
        await recordPage(page, { seconds: sh.seconds, out: tmp, fps: FPS, timeline, perFrame, skipMs: sp.skipMs ?? 0, log });
        renameSync(tmp, sh.file);
        log(`    recorded ${sh.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
await server.close();

// Review stills: one frame from the middle of every shot.
for (const sh of shots) {
  const still = join(DIRS.review, `${String(shots.indexOf(sh)).padStart(2, "0")}-${sh.scene}-${sh.index + 1}.jpg`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", (sh.seconds * 0.6).toFixed(2), "-i", sh.file, "-frames:v", "1", "-vf", "scale=960:-1", "-q:v", "4", still]);
}

// -- 4. assembly -----------------------------------------------------------------------------------
log("Assembly: loudness pass");
// Mono narration plays as dual mono, so loudness is measured after the pan (dual mono reads 3 LU
// louder than the mono file). A gentle limiter first lets loudnorm use a single linear gain.
const PRE = "pan=stereo|c0=c0|c1=c0,alimiter=limit=0.6:attack=5:release=50:level=disabled";
const measure = spawn("ffmpeg", ["-hide_banner", "-nostats", "-i", narrationWav, "-af", `${PRE},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"]);
let mtext = "";
measure.stderr.on("data", (d) => (mtext += d));
await new Promise((r) => measure.on("exit", r));
const m = JSON.parse(mtext.slice(mtext.lastIndexOf("{"), mtext.lastIndexOf("}") + 1));
const loud = `${PRE},loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
const linear = Number(m.input_tp) + (-16 - Number(m.input_i)) <= -1.5;
log(`  narration ${m.input_i} LUFS, true peak ${m.input_tp} dBTP; ${linear ? "one linear gain" : "dynamic normalization"} to -16 LUFS`);

const inputs = [];
const parts = [];
shots.forEach((sh, i) => {
  inputs.push("-i", sh.file);
  const fades = [];
  if (sh.fadeIn) fades.push(`fade=t=in:st=0:d=${sh.fadeIn}`);
  if (sh.fadeOut) fades.push(`fade=t=out:st=${(sh.seconds - sh.fadeOut).toFixed(3)}:d=${sh.fadeOut}`);
  parts.push(`[${i}:v]trim=end_frame=${sh.frames},setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p${fades.length ? `,${fades.join(",")}` : ""}[v${i}]`);
});
inputs.push("-i", narrationWav);
const graph = `${parts.join(";")};${shots.map((_, i) => `[v${i}]`).join("")}concat=n=${shots.length}:v=1:a=0[v];[${shots.length}:a]${loud},aresample=48000[a]`;
const final = join(DIRS.out, `${name}.mp4`);
log(`Assembly: encoding ${final}`);
execFileSync(
  "ffmpeg",
  ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", String(FPS * 2), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-t", (totalFrames / FPS).toFixed(3), final],
  { stdio: "inherit" },
);
const check = spawn("ffmpeg", ["-hide_banner", "-nostats", "-i", final, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
let ctext = "";
check.stderr.on("data", (d) => (ctext += d));
await new Promise((r) => check.on("exit", r));
const lufs = ctext.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop() ?? "?";
const size = statSync(final).size;
log(`Done: ${final}\n  ${mmss(ffprobeDur(final))} (${ffprobeDur(final).toFixed(1)} s), ${(size / 1024 / 1024).toFixed(1)} MB, integrated loudness ${lufs.replace(/\s+/g, " ")}\n  subtitles ${join(DIRS.out, `${name}.srt`)}\n  review stills ${DIRS.review}\n  TTS spend so far $${spend(DIRS.tts).usd.toFixed(3)}`);
