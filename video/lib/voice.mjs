// Client for the ft-voice Worker (video/voice-worker): speech and transcription, cached on disk
// by content hash, with a ledger of billed characters so the TTS spend stays visible.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Workers AI list price for @cf/deepgram/aura-2-en, USD per 1,000 characters. */
export const AURA2_USD_PER_1K = 0.03;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** URL and bearer token: env vars, else ~/.config/firetrident/voice.env (never printed). */
export function voiceConfig() {
  let url = process.env.FT_VOICE_URL ?? "";
  let token = process.env.FT_VOICE_TOKEN ?? "";
  const file = join(homedir(), ".config/firetrident/voice.env");
  if ((!url || !token) && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      if (m[1] === "FT_VOICE_URL" && !url) url = m[2];
      if (m[1] === "FT_VOICE_TOKEN" && !token) token = m[2];
    }
  }
  if (!url || !token) throw new Error("Set FT_VOICE_URL and FT_VOICE_TOKEN, or write them to ~/.config/firetrident/voice.env (see video/README.md).");
  return { url: url.replace(/\/+$/, ""), token };
}

async function post(path, body, headers, tries = 4) {
  const { url, token } = voiceConfig();
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      // A synthesis call that hangs (seen once with Aura-2) is abandoned after two minutes and retried.
      const res = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(120_000) });
      if (res.ok) return res;
      last = new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      if (res.status === 400 || res.status === 401) break;
    } catch (err) {
      last = err;
    }
    await sleep(1500 * (i + 1));
  }
  throw last;
}

/**
 * Speak `text` with `speaker`; returns the cached file path. format "wav" is 48 kHz 16-bit mono
 * PCM (for assembly), "mp3" is the model's default MP3 (for listening).
 */
export async function speak({ text, speaker, format = "wav", dir, log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const key = sha(JSON.stringify({ model: "@cf/deepgram/aura-2-en", speaker, text, format })).slice(0, 20);
  const path = join(dir, `${speaker}-${key}.${format}`);
  if (existsSync(path)) return { path, cached: true, chars: 0 };
  const body = format === "wav" ? { text, speaker, encoding: "linear16", container: "wav", sample_rate: 48000 } : { text, speaker, encoding: "mp3" };
  const res = await post("/v1/speak", JSON.stringify(body), { "content-type": "application/json" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`speech for "${text.slice(0, 40)}…" came back with ${buf.length} bytes`);
  writeFileSync(path, buf);
  appendFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), speaker, format, chars: text.length, usd: (text.length / 1000) * AURA2_USD_PER_1K })}\n`);
  log(`  spoke ${text.length} chars as ${speaker} (${format})`);
  return { path, cached: false, chars: text.length };
}

/** Whisper transcription with word timings for an audio file (cached by content). */
export async function transcribe({ path, prompt = "", dir }) {
  mkdirSync(dir, { recursive: true });
  const audio = readFileSync(path);
  const out = join(dir, `whisper-${sha(audio.toString("base64") + prompt).slice(0, 20)}.json`);
  if (existsSync(out)) return JSON.parse(readFileSync(out, "utf8"));
  const q = prompt ? `?prompt=${encodeURIComponent(prompt)}` : "";
  const res = await post(`/v1/transcribe${q}`, audio, { "content-type": "application/octet-stream" });
  const json = await res.json();
  writeFileSync(out, JSON.stringify(json));
  return json;
}

/** Total characters and dollars billed so far (from the ledger). */
export function spend(dir) {
  const file = join(dir, "ledger.jsonl");
  if (!existsSync(file)) return { chars: 0, usd: 0 };
  let chars = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim()) chars += JSON.parse(line).chars;
  return { chars, usd: (chars / 1000) * AURA2_USD_PER_1K };
}
