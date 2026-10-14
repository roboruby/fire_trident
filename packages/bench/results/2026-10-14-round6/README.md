# Round 6 results (2026-10-14)

All runs are labeled MEASURED. Logs pass through `node packages/bench/src/evidence.ts redact`.

## Agent-count sweep, on round-5 code (preview, text merge on)

The Hono rule "relative imports name their file" (958 violations, 283 intents), Gemma 4 26B agents, one run after another (`scripts/demo_hono.rb --agents N --model @cf/google/gemma-4-26b-a4b-it`). Coordination numbers come from `scripts/coordination.rb`, which reads only each colony's public git, lineage notes and public API.

| Agents | Violations to zero | Landings a minute | Proposals merged | Code sharing (median agent) | Specialization vs shuffled | Model cost |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 187.8 s | 61.3 | 283 of 283 | 0.000 | +0.009 (p 0.37) | $0.059 |
| 20 | 117.5 s | 99.0 | 283 of 283 | 0.000 | +0.028 (p 0.03) | $0.046 |
| 40 | 76.7 s | 149.4 | 283 of 283 | 0.000 | +0.100 (p 0.001) | $0.040 |
| 80 | 55.8 s | 206.5 | 283 of 283 | 0.000 | +0.000 (p 0.81) | $0.040 |

Code sharing is zero because each intent edits its own file; a colony where four agents edited one file under text merge scores 0.917. Logs and full reports: `sweep/`.

## Polling flood over MCP (preview, round-6 code)

`packages/bench/src/scenarios/flood.ts`: 16 greedy sessions call `inbox` without `wait` as fast as answers come back, 4 honest agents take, read and propose inline changes with `wait`. 120 s each.

| Call budget | Greedy calls | Answered 429 | Reached the colony | Honest landings a minute | Honest propose to landed, p50 | Honest refused |
| --- | --- | --- | --- | --- | --- | --- |
| off | 56,450 | 0 | 56,450 | 123.5 | 1,332 ms | 0 |
| on (4 a second, 20 at once) | 71,418 | 63,444 | 7,974 | 120.5 | 1,311 ms | 0 |

The 30-second honest-only baseline in each report runs first, while the colony's objects and pool are cold, so compare the flood phases. Reports: `flood-off.json`, `flood-on.json`.

## Live checks (preview, round-6 code, call budget on)

| Script | Result |
| --- | --- |
| `scripts/goal_conflict.ts` | 34 checks pass. Three agents each move one backend to a different language: with the check on, the first landed and the other two waited for a person, each naming the landing it would undo; a person's approval landed one with `undoes` in its note. With it off, all three landed and the last won. |
| `scripts/megafile.ts` | 24 checks pass. A file grown from 650 to 830 lines by five agents was held with a split intent; changes on their way went back with the hold's reason; the split landed (830 → 3 lines, all 69 exports kept) and the hold lifted. |
| `scripts/field_guide.ts` | 22 checks pass. A lesson went active on its landing's green certification and reached the next agent's take with its author and model; a reverted landing's lesson was dropped. |
| `scripts/resolver.ts` | 19 checks pass. Two edits of one line from one trunk: the second came back, the resolver merged both (one model call), and the merge landed with `resolves` in its note; with the resolver off, it went back as before. |

Logs: `checks/`.

## Hono rule run on round-6 code

20 Gemma agents with the field guide, the megafile alarm and the call budget on: 958 violations → 0 in 128.9 s, 283 intents landed, 0 returned, 0 abandoned, $0.049 (`hono-20-agents-round6.log`).

## An external agent on the live service

Claude Code (claude-sonnet-5-5, `scripts/mcp_join.rb`) joined `byo-demo` on production running round-6 code, took "Document isPlainObject with a JSDoc comment", sent the new `index.js` inline and landed: join at 7.3 s, take at 10.5 s, propose at 17.4 s, landed at 19.4 s. The note records an external agent with its model declared; `GET /api/colonies/byo-demo/notes/verify` reports it intact, and `node scripts/verify_note.mjs HEAD` in a stock clone prints `intact` (`byo-demo-claude-production.log`).
