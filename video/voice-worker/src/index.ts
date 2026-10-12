/**
 * ft-voice: narration for the FireTrident video.
 *
 *   POST /v1/speak       {"text", "speaker"?, "encoding"?, "container"?, "sample_rate"?, "bit_rate"?} -> audio bytes
 *   POST /v1/transcribe  audio bytes (?prompt=<spelling hints>) -> Whisper JSON with word timings
 *   GET  /               model, speakers, endpoints
 *
 * Both POST routes need `Authorization: Bearer <VOICE_TOKEN>` (a Worker secret). Speech is
 * Workers AI `@cf/deepgram/aura-2-en`; the transcription route exists to check pronunciation
 * and to time cuts against words.
 */

/** The slice of the Workers AI binding this Worker uses. */
interface AiBinding {
  run(model: string, input: Record<string, unknown>, options?: { returnRawResponse?: boolean }): Promise<unknown>;
}

interface Env {
  AI: AiBinding;
  VOICE_TOKEN?: string;
}

const TTS_MODEL = "@cf/deepgram/aura-2-en";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Aura-2 English speakers (the model's input schema). */
const SPEAKERS: ReadonlySet<string> = new Set(
  "amalthea andromeda apollo arcas aries asteria athena atlas aurora callista cora cordelia delia draco electra harmonia helena hera hermes hyperion iris janus juno jupiter luna mars minerva neptune odysseus ophelia orion orpheus pandora phoebe pluto saturn thalia theia vesta zeus".split(" "),
);
const ENCODINGS: ReadonlySet<string> = new Set(["linear16", "flac", "mulaw", "alaw", "mp3", "opus", "aac"]);
const CONTAINERS: ReadonlySet<string> = new Set(["none", "wav", "ogg"]);
/** One request's text limit (the provider's per-request cap). */
const MAX_CHARS = 2000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Constant-time check of the bearer token (both sides hashed to equal length first). */
async function authorized(req: Request, env: Env): Promise<boolean> {
  const want = env.VOICE_TOKEN;
  if (!want) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!got) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(got)), crypto.subtle.digest("SHA-256", enc.encode(want))]);
  return (crypto.subtle as unknown as { timingSafeEqual(x: ArrayBuffer, y: ArrayBuffer): boolean }).timingSafeEqual(a, b);
}

/** Content type for an encoding and container. */
function contentType(encoding: string, container: string | undefined): string {
  if (container === "wav") return "audio/wav";
  if (container === "ogg" || encoding === "opus") return "audio/ogg";
  return { mp3: "audio/mpeg", flac: "audio/flac", aac: "audio/aac" }[encoding] ?? "application/octet-stream";
}

/** Bytes to base64 without blowing the call stack on large inputs. */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function speak(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Send JSON: {\"text\": \"...\", \"speaker\": \"luna\"}." }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "text is required." }, 400);
  if (text.length > MAX_CHARS) return json({ error: `text is ${text.length} characters; the limit is ${MAX_CHARS}. Split it.` }, 400);
  const speaker = typeof body.speaker === "string" ? body.speaker : "luna";
  if (!SPEAKERS.has(speaker)) return json({ error: `Unknown speaker ${speaker}.`, speakers: [...SPEAKERS] }, 400);
  const encoding = typeof body.encoding === "string" ? body.encoding : "mp3";
  if (!ENCODINGS.has(encoding)) return json({ error: `Unknown encoding ${encoding}.`, encodings: [...ENCODINGS] }, 400);
  const container = typeof body.container === "string" ? body.container : undefined;
  if (container !== undefined && !CONTAINERS.has(container)) return json({ error: `Unknown container ${container}.`, containers: [...CONTAINERS] }, 400);

  const input: Record<string, unknown> = { text, speaker, encoding };
  if (container) input.container = container;
  if (typeof body.sample_rate === "number") input.sample_rate = body.sample_rate;
  if (typeof body.bit_rate === "number") input.bit_rate = body.bit_rate;

  let out: unknown;
  try {
    out = await env.AI.run(TTS_MODEL, input, { returnRawResponse: true });
  } catch (err) {
    return json({ error: `Speech failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  const headers = { "content-type": contentType(encoding, container), "cache-control": "no-store", "x-ft-chars": String(text.length), "x-ft-speaker": speaker };
  if (out instanceof Response) {
    if (!out.ok) return json({ error: `Speech failed with ${out.status}: ${(await out.text()).slice(0, 500)}` }, 502);
    return new Response(out.body, { headers: { ...headers, "content-type": out.headers.get("content-type") ?? headers["content-type"] } });
  }
  if (out instanceof ReadableStream) return new Response(out, { headers });
  if (out instanceof ArrayBuffer || out instanceof Uint8Array) return new Response(out, { headers });
  const audio = (out as { audio?: unknown } | null)?.audio;
  if (typeof audio === "string") return new Response(Uint8Array.from(atob(audio), (c) => c.charCodeAt(0)), { headers });
  return json({ error: "The model returned no audio." }, 502);
}

async function transcribe(req: Request, env: Env, url: URL): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return json({ error: "Send the audio as the request body." }, 400);
  if (bytes.length > MAX_AUDIO_BYTES) return json({ error: `Audio is ${bytes.length} bytes; the limit is ${MAX_AUDIO_BYTES}.` }, 400);
  const input: Record<string, unknown> = { audio: toBase64(bytes), language: "en" };
  const prompt = url.searchParams.get("prompt");
  if (prompt) input.initial_prompt = prompt.slice(0, 500);
  try {
    return json(await env.AI.run(STT_MODEL, input));
  } catch (err) {
    return json({ error: `Transcription failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return json({
        name: "ft-voice",
        model: TTS_MODEL,
        speakers: [...SPEAKERS],
        endpoints: { "POST /v1/speak": "JSON {text, speaker?, encoding?, container?, sample_rate?, bit_rate?} -> audio", "POST /v1/transcribe": "audio body -> JSON with word timings" },
        auth: "Authorization: Bearer <token>",
      });
    }
    if (req.method !== "POST" || (url.pathname !== "/v1/speak" && url.pathname !== "/v1/transcribe")) return json({ error: "Not found." }, 404);
    if (!(await authorized(req, env))) return json({ error: "Unauthorized." }, 401);
    return url.pathname === "/v1/speak" ? speak(req, env) : transcribe(req, env, url);
  },
};
