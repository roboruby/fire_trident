# Round 7 results (2026-10-14)

Build 4420071 and its docs, on a preview. All runs are labeled MEASURED; logs pass through `node packages/bench/src/evidence.ts redact`.

| Check | Result |
| --- | --- |
| `scripts/landing_diff.ts` | 28 checks pass. A public colony's landings show their change to a file (an added file, then a one-line edit diffed against the first landing's blob, also by commit prefix); a file a landing did not change answers 404, and so does every diff of a colony not listed public. One landing's note checks intact by landing id or by commit. |
| bench scenario `insertions` | 12 checks pass. Two appends to one file from one trunk: with `FT_MERGE_INSERTIONS` both landed and the note records `rule: "insertions"`; without it the second went back naming the hunk, its return named the landing that beat it (intent, agent, model, commit), and the next take handed that back in `lastReturn`. |
| `scripts/resolver.ts` | 19 checks pass with the stricter merge check: the overlapping edits of one line still merge with both kept. |
| `scripts/protect_race.rb --queued` | With pushes held 12 s (`FT_TEST_PUSH_DELAY_MS`): every answer matched trunk. Three changes protected 0, 2 and 4 s after they were ready had entered the trunk writer's cycle, and each answer named the landing it lost to; a change queued behind another was stopped, waited for a person and landed on approval. With pushes held 8 s the queued round was inconclusive (nothing was queued yet); held 20 s, the queued change was stopped but the other three answers came back unconfirmed, because the trunk writer was still inside a held push past the answer's 15 s wait (`protect_race.log`, `protect_race2.log`, `protect_race3.log`). |
| `scripts/tour_check.ts` | All 10 numbers the tour quotes agree with the colony's `/metrics`. |
| Front door | `/` carries `Link: </start.md>; rel="service-doc"` and `Vary: Accept`; `Accept: text/markdown` gets start.md; `/llms.txt` and `/start.md` serve; the page holds the static summary. |
| Hono rule run, 20 Gemma agents, every flag on | 958 → 0 in 125.6 s, 283 landed, 0 returned, $0.042 (`p21-hono.log`). Impact of `src/hono-base.ts`: 176 files through imports up to three levels, on the public MCP with no token and `ft impact`. Where the time went: 1,906 agent-seconds from claim to landing, 36.8% agent work (median 1.9 s), 1.8% review, 61.4% waiting to land (median 2.3 s), no rework (`coordination-p21-hono.md`). |
| Production, showcase notes | Claude Code over MCP landed a documentation intent on hono (29.7 s into its session) and on shortlinks (17.3 s); every showcase trunk's newest note now verifies intact from a stock clone (`hono-claude.log`, `shortlinks-claude.log`). |
