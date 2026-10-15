# FireTrident video pipeline

Narration, picture and the final cut for the submission video, from one command:

```sh
node video/render.mjs
```

The result is `~/.firetrident/video/out/firetrident-final.mp4` (H.264 1080p30, AAC 48 kHz, loudness-normalized to about -16 LUFS), with an `.srt` subtitle file and a `.timeline.json` of every scene and shot next to it. All media (speech, recorded shots, the cut) goes to `$FT_VIDEO_OUT`, default `~/.firetrident/video`. The script refuses to write media inside a notes folder that holds this repository, because Obsidian indexes every file on disk.

## What it does

1. **Voice.** Each paragraph of `narration.md` is spoken by Workers AI `@cf/deepgram/aura-2-en` through the `ft-voice` Worker (`voice-worker/`), as 48 kHz WAV. Every paragraph is also transcribed with Whisper (`@cf/openai/whisper-large-v3-turbo`) to get word timings, so cuts land on the words that motivate them, and to catch mispronunciations. Speech and transcriptions are cached by content hash; only changed paragraphs are billed again (Aura-2 is $0.03 per 1,000 characters; the whole script is about $0.20).
2. **Timeline.** Scene lengths come from the speech: 0.6 s of air before the first paragraph, 0.65 s between paragraphs, 1.1 s after the last, a 0.28 s dip through black between scenes, and title cards at both ends. A scene can hold a longer pause after a paragraph (`gaps`) or a longer tail, where the picture needs a moment without words (the approval in Decide, the time-lapse in A new project, the landing in Bring your own agent).
3. **Picture.** `scenes.mjs` says what is on screen during each scene. Headless Chrome (`/Applications/Google Chrome.app`, driven over the DevTools protocol with Node's built-in WebSocket) records each shot frame by frame at 1920x1080: a virtual clock (`lib/timeshim.js`) freezes the page, then every frame advances timers, animation frames, CSS animations and SVG timelines by exactly 1/30 s before a screenshot. Motion is smooth regardless of machine speed, and the simulator is deterministic. Production colonies are filmed as replays of their own record (`/c/<id>?replay=1`, director mode on top): the recorder holds a replay while the page loads (`?delay`), pauses it with the director's space key, and resumes it on the shot's first frame, so it plays from exactly the `?t=` that the shot's `sync` computes. `sync: {at, run}` puts a moment of the run (seconds after its first event) on screen when a phrase is spoken; actions can be timed to the run too (`atRun`). A `timeScale` records a time-lapse.
4. **Cut.** ffmpeg trims every shot to its frame count, adds the scene fades, concatenates, lays the narration under it with a two-pass `loudnorm`, and encodes.

## After the numbers or the UI change

- **Numbers.** A `{braced}` value in `narration.md` is a placeholder still to verify; once checked, the braces go (the timeline's `placeholders` list is then empty). Edit and run `node video/render.mjs`. Only the changed paragraphs are spoken again; shots whose timing moved are re-recorded automatically. The numbers in the final script and where each comes from are listed below.
- **UI or production data.** Shots of production pages and the simulator are cached. Re-record them with `node video/render.mjs --recapture`, or one scene with `--only decide` (comma-separate several).
- **Wording.** Edit `narration.md` the same way. Phrases in `scenes.mjs` anchor cuts to the narration; if a phrase disappears, the render stops and names it.
- **Voice.** `node video/render.mjs --samples` writes the cold open in several voices to `voices/<speaker>.mp3` (`--voices a,b,c` to choose). Narrate with another speaker using `--voice <speaker>`, or change `VOICE` in `scenes.mjs`. Words the synthesizer gets wrong are respelled for it only in `pronounce.json` ("Hono" is heard as "Hano" otherwise).
- **Audio only.** `--audio-only` writes the narration track, subtitles and timeline without recording.

A full render records about 14,000 frames; on an Apple Silicon laptop that is roughly 15 minutes, and a minute or two when every shot is cached.

## The numbers in the script

Checked on 2026-10-12, 2026-10-13 and 2026-10-15 against the production colonies (GET requests only) and the result files:

| Narration | Source |
| --- | --- |
| 958 problems fixed in about a minute; 583 files; 282 intents; 80 agents | the hono colony's record (`GET /api/colonies/hono/events`: the rule at 21.0 s, 0 violations at 82.8 s, "958 fixed in 1 min 2 s" on screen) and `packages/bench/results/2026-10-12-prod/hono-run.log` |
| All 282 of the rule's edits landed on proof alone | `colony-hono.json`: proof 282, a model 2 (the prerequisite and the follow-up, which are not the rule's) |
| It sent 28 through; the second opinion turned back 7, the other 21 went to a person, none landed | `vaccination-openspec-w1.json` (the README's vaccination row: 7 returned by the second opinion, 21 sent to a person) |
| Two edits to different lines of one file both land with text merge | `packages/bench/results/2026-10-14-round5/textmerge-on.json` and `textmerge-off.json` (preview) |
| On a preview, 30 of 30 landed on their first try with import-name revalidation; without it, 30 of 30 went back | `packages/bench/results/2026-10-13-round2/cascade-revalidate-on.json` and `-off.json`; revalidation is off in production |
| Every note sealed into its commit by its hash; each commit signed with a published key; a short script on a stock clone says intact and names the signer | the `verify-signed` transcript, run on 2026-10-15 against `https://firetrident.com/git/signed-notes.git` with the repository's `scripts/verify_note.mjs` |
| 35 intents withdrawn and 3 changes in flight back, in under a second; nothing lands for the rule again | the direction-retract record: the retraction, 35 withdrawals and 3 returned proposals share one timestamp; the only landing is 2 s before it |
| the agent restarts within about a second; the new version lands 23 seconds later | the direction-steer record: amended 20:12:29.259, restarting 166 ms later, the r2 change landed 23.5 s after the amendment |
| re-plans in 2 seconds | the direction-steer record: the directive at 20:12:30.180, the change in flight returned 92 ms and "redoing" 144 ms later, the redone file committed 2.4 s after the directive |
| 13 intents, 5 rules, eight minutes, 60 of 60, 7 of 7 | `shortlinks-run.log` (479.1 s) and the `shortlinks-test` transcript |
| a second run of the spec had left five tests failing; certification found them in a quarter of a second and the colony turned them into a repair | the shortlinks-review record (`GET /api/colonies/shortlinks-review/events`) and `shortlinks-review-certify-events.jsonl`: at 22:38:33 EDT (an operator's `ft certify --now`) e1468ea certified red, 62 of 67 passing, 5 failing, in 267 ms; the repair intent `int_mv62ngu7hcins0` opened the same millisecond (`shortlinks-review-certify-run.log`) |
| two fixes landed, review turned back a broken one, trunk went green: 67 of 67 | the same record: 48f74b8 landed 22:50:06 (certified 66 of 67; the colony opened repair `int_mv632bs6omjsyf`), an attempt was returned 23:22:10 by the second-opinion model (`@cf/openai/gpt-oss-120b`), 97b1036 landed 23:45:33 and certified green, 67 of 67, in 88 ms; `certifications-shortlinks-review.json`; a plain clone of 97b1036 passes `node --test` 67 of 67 (`shortlinks-review-certify-green.log`) |
| On the live service, two thousand agents landed 6,606 changes in one repository in 145 seconds, about 2,700 a minute, none went back | `packages/bench/results/2026-10-14-round8/scale-production.json` and the README's live-service scale row (2,730 a minute, 1,350 trunk commits, p50 9.6 s; synthetic agents, each change adds one new file) |
| On a preview, five thousand started at once | `packages/bench/results/2026-10-12-scale/summary.json` (2,777.7/min) |
| Ten agents in about three minutes, eighty in under one (a preview) | `packages/bench/results/2026-10-14-round6/sweep/` (187.8 s and 55.8 s; 20 and 40 agents 117.5 s and 76.7 s) |
| The eighty-agent run on the live service cost six and a half cents in model calls | the README's Hono row: $0.065 as the colony prices the tokens it counted, at Workers AI list prices (`packages/bench/results/2026-10-12-prod/`) |
| Rework from 46 to about 30 percent, below exclusive locks, at more than three times their landings a minute | `packages/bench/results/2026-10-13-papers/summary.json` (simulated, every returned change redone in full, mean of 10 seeds: 45.9% to 30.5% at 175.2 a minute; locks 34.8% at 51.9) |

## Files

| Path | Role |
| --- | --- |
| `render.mjs` | The one command: voice, timeline, capture, assembly |
| `narration.md` | The script, `## m:ss Title (picture note)` per scene |
| `scenes.mjs` | The picture per scene: shots, phrase anchors, replay sync, badges; the precapture specs |
| `precapture.mjs` | Records a shot ahead of the cut, for a live state that will not last (`node video/precapture.mjs <name>`) |
| `pronounce.json` | Respellings for the synthesizer |
| `terminal.html` | Replays a transcript with typing, in the app's palette |
| `cards.html` | Title and end cards, the queue chart, nature (the systems the narration names), stat, stack and pending cards |
| `transcripts/` | Real CLI and git output (see below) |
| `lib/` | DevTools client, virtual clock, recorder, speech client, word alignment, WAV helpers, static server |
| `voice-worker/` | The `ft-voice` Worker |

## Honesty rules on screen

- Simulator footage carries a **Simulator** badge; production colonies carry a **Production** badge naming the run and how it is shown: a replay says so, says **reconstructed** when the run predates the event record (claim times are estimated from what the colony stores) or **recorded**, and gives the speed when it is not 1x. Direction actions taken by `scripts/demo_direction.rb` are labeled as the script's (`operator-script`); the only person's decision on screen is the approval of the escalated route in shortlinks-review, which its lineage records as `ms`. The only simulator on screen is the landing page's hero colony (its own page labels it too), badged **Simulator**.
- Stat cards say **Measured** or **Simulated** and name the result file under `packages/bench/results/` that holds the numbers. The queue chart is labeled an illustration.
- Terminal scenes replay real output, verbatim. `transcripts/*.txt` come from the production runs of 2026-10-12: `hono-import` and `hono-rule` from the Hono demo log (the source URL's host is elided as `https://…/honojs/hono`, so no other git host is named on screen), `shortlinks-new` and `shortlinks-test` from `demo/run_new_project.rb`'s log (an excerpt; one local temporary path is shortened to `…/shortlinks`), `why` from `ft why hono src/index.ts:17`, `git-land` and `git-notes` from a plain clone of the hono trunk and its `refs/notes/firetrident` (a read token from `wrangler artifacts repos issue-token`, never stored), `git-clone` from `git clone https://firetrident.mattsolt.workers.dev/git/hono.git` with no account and no token (the full output of `git log --notes=firetrident -3`), `verify-signed` from `git clone https://firetrident.com/git/signed-notes.git` on 2026-10-15 with no account and no token, the commit's message and `node ../verify_note.mjs HEAD --keys https://firetrident.com/.well-known/firetrident-keys.json` (the repository's `scripts/verify_note.mjs`, copied next to the clone), and `byo-session` from `packages/bench/results/2026-10-12-prod/byo-run.log` (an excerpt of the outside agent's session from its start to the landing; its tool-search lines are left out and local paths shortened). No transcript may contain a token: `grep -E 'art_v[0-9]+_' video/transcripts/*` must print nothing.
- Still pictures get a slow push-in so nothing sits frozen: finished production colonies 3.5%, cards, terminals and other pages 2%, replays (which move on their own) 1.2%. The review card, the approval and its lineage instead frame the side panel with a camera move, so their text is readable. A director sub-caption that would state what has not happened yet in a replay ("no change of course", "an outside agent ... landed a change") stays hidden until the moment it describes.
- The review-tab shot of the escalated route was recorded live while it waited for a person (`precapture.mjs`, badge burned in); the approval, the landing and the lineage that follow are a replay and the finished colony.
- Trunk certification (A new project) is a card on how it runs (a Dynamic Worker, no network, CPU and time limits) and two 1x shots of the shortlinks-review replay, framed on the trunk bar's test badge and the events panel: the red run at 22:38:33 EDT and, after a cut, the fix landing and certifying green at 23:45:33. The second shot's badge says **67 minutes later**, so the cut does not read as speed. Their badges carry a second line: an operator started the certification (`ft certify --now`) and the two agents; the repair intents, the fixes, the returned attempt and the green run are the colony's.
- Placeholder scenes that wait for footage say so on screen (**Footage pending**); the final cut has none.

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
