# FireTrident video pipeline

Narration, picture and the final cut for the submission video, from one command:

```sh
node video/render.mjs
```

The result is `~/Desktop/save/firetrident/video/out/firetrident-roughcut-v0.mp4` (H.264 1080p30, AAC 48 kHz, loudness-normalized to about -16 LUFS), with an `.srt` subtitle file and a `.timeline.json` of every scene and shot next to it. All media (speech, recorded shots, the cut) goes to `$FT_VIDEO_OUT`, default `~/Desktop/save/firetrident/video`. The script refuses to write media inside a notes folder that holds this repository, because Obsidian indexes every file on disk.

## What it does

1. **Voice.** Each paragraph of `narration.md` is spoken by Workers AI `@cf/deepgram/aura-2-en` through the `ft-voice` Worker (`voice-worker/`), as 48 kHz WAV. Every paragraph is also transcribed with Whisper (`@cf/openai/whisper-large-v3-turbo`) to get word timings, so cuts land on the words that motivate them, and to catch mispronunciations. Speech and transcriptions are cached by content hash; only changed paragraphs are billed again (Aura-2 is $0.03 per 1,000 characters; the whole script is about $0.20).
2. **Timeline.** Scene lengths come from the speech: 0.55 s of air before the first paragraph, 0.5 s between paragraphs, 0.85 s after the last, a 0.28 s dip through black between scenes, and title cards at both ends.
3. **Picture.** `scenes.mjs` says what is on screen during each scene. Headless Chrome (`/Applications/Google Chrome.app`, driven over the DevTools protocol with Node's built-in WebSocket) records each shot frame by frame at 1920x1080: a virtual clock (`lib/timeshim.js`) freezes the page, then every frame advances timers, animation frames, CSS animations and SVG timelines by exactly 1/30 s before a screenshot. Motion is smooth regardless of machine speed, and the simulator is deterministic.
4. **Cut.** ffmpeg trims every shot to its frame count, adds the scene fades, concatenates, lays the narration under it with a two-pass `loudnorm`, and encodes.

## After the numbers or the UI change

- **Numbers.** `{braced}` values in `narration.md` are placeholders to verify against the final production runs. Edit the value inside the braces (keep the braces until it is checked) and run `node video/render.mjs`. Only the changed paragraphs are spoken again; shots whose timing moved are re-recorded automatically.
- **UI or production data.** Shots of production pages and the simulator are cached. Re-record them with `node video/render.mjs --recapture`, or one scene with `--only decide` (comma-separate several).
- **Wording.** Edit `narration.md` the same way. Phrases in `scenes.mjs` anchor cuts to the narration; if a phrase disappears, the render stops and names it.
- **Voice.** `node video/render.mjs --samples` writes the cold open in several voices to `voices/<speaker>.mp3` (`--voices a,b,c` to choose). Narrate with another speaker using `--voice <speaker>`, or change `VOICE` in `scenes.mjs`. Words the synthesizer gets wrong are respelled for it only in `pronounce.json` ("Hono" is heard as "Hano" otherwise).
- **Audio only.** `--audio-only` writes the narration track, subtitles and timeline without recording.

A full render records about 12,000 frames; on an Apple Silicon laptop that is roughly 12 minutes, and seconds when every shot is cached.

## Files

| Path | Role |
| --- | --- |
| `render.mjs` | The one command: voice, timeline, capture, assembly |
| `narration.md` | The script, `## m:ss Title (picture note)` per scene |
| `scenes.mjs` | The picture per scene: shots, phrase anchors, badges |
| `pronounce.json` | Respellings for the synthesizer |
| `terminal.html` | Replays a transcript with typing, in the app's palette |
| `cards.html` | Title and end cards, the queue chart, nature, stat, stack and pending cards |
| `transcripts/` | Real CLI and git output (see below) |
| `lib/` | DevTools client, virtual clock, recorder, speech client, word alignment, WAV helpers, static server |
| `voice-worker/` | The `ft-voice` Worker |

## Honesty rules on screen

- Simulator footage carries a **Simulator** badge; production colonies carry a **Production** badge naming the run.
- Stat cards say **Measured** or **Simulated** and name the result file under `packages/bench/results/` that holds the numbers. The queue chart is labeled an illustration.
- Terminal scenes replay real output, verbatim. `transcripts/*.txt` come from the production runs of 2026-10-12: `hono-import` and `hono-rule` from the Hono demo log (the source URL's host is elided as `https://…/honojs/hono`, so no other git host is named on screen), `shortlinks-new` and `shortlinks-test` from `demo/run_new_project.rb`'s log (an excerpt; one local temporary path is shortened to `…/shortlinks`), `why` from `ft why hono src/index.ts:17`, and `git-land` and `git-notes` from a plain clone of the hono trunk and its `refs/notes/firetrident` (a read token from `wrangler artifacts repos issue-token`, never stored). No transcript may contain a token: `grep -E 'art_v[0-9]+_' video/transcripts/*` must print nothing.
- Shots of finished production colonies get a slow push-in (they do not move on their own); the bring-your-own-agent shot moves in on the landing page's MCP column and hides the rest of that section.
- Placeholder scenes that wait for footage say so on screen (**Footage pending**).

## The voice Worker

`voice-worker/` is a separate Worker named `ft-voice` with an AI binding. `POST /v1/speak` takes `{"text", "speaker", "encoding", "container", "sample_rate"}` and returns audio; `POST /v1/transcribe` takes audio and returns Whisper JSON with word timings. Both need `Authorization: Bearer <token>`.

```sh
cd video/voice-worker
npx wrangler deploy
openssl rand -hex 32   # a new token, if needed
printf %s "$TOKEN" | npx wrangler secret put VOICE_TOKEN
```

The pipeline reads `FT_VOICE_URL` and `FT_VOICE_TOKEN` from the environment or from `~/.config/firetrident/voice.env` (`chmod 600`):

```
FT_VOICE_URL=https://ft-voice.<account>.workers.dev
FT_VOICE_TOKEN=<token>
```

## Requirements

Node 24 (global WebSocket and fetch), ffmpeg with libx264, Google Chrome. Nothing is installed into the repository.
