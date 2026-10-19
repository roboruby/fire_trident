# Hono replay: 8 agents, 16 agents on honojs/hono's own pull requests

MEASURED on https://staging.firetrident.com (build 67baa13), 2026-10-19: in-platform agents calling real models, review on, a scripted person answering the review queue, graded by Hono's own tests under real vitest. The workload is `demo/hono-replay/workload.json` (`scripts/hono_replay_select.rb`): honojs/hono at ab590e4ec8be (2026-07-10) and 15 pull requests merged into main after it, each redone as one intent (source human, equal priority) with its title, its description as the why and the files it changed under src/ as its footprint. Each pull request changes source that another one also changes; most shared: `src/request.ts` (5), `src/client/client.ts` (3), `src/router/trie-router/node.ts` (2), `src/utils/cookie.ts` (2). Each run started on its own fresh colony from the same seed (B's tree, 346 files) and intents.

Operator's note: Staging build 67baa13 (path-line fix, red brake reserves after admission, FT_PRELAND checks a change's own tests; the seed lands without tests before landing); colonies at regionDepth 3; #5236 dropped (15 intents). Flags: FT_LATERAL_INHIBITION=off, FT_MEGAFILE=off (as Oct 17), FT_RED_BRAKE, FT_REVIEW_VIEW (with FT_QUOTED_ACCEPTANCE), FT_INHIBIT_STRONGEST, FT_AGE_CAP, FT_PRELAND on; FT_DEFAULT_SPEND_CAP 5.

Each colony was created at region depth 3 (`--region-depth`, default 3). Admission is decided per region (a region admits while its working agents are fewer than max(3, 2 x its landings in the last minute)), and every file of this workload is under src/: at depth 1 the whole workload is one region and a run holds about three working agents whatever its agent count.

Left out of each colony's trunk certification, not of the grade (they pass under Node and fail in workerd): `src/helper/proxy/index.test.ts > Proxy Middleware > proxy > client disconnect`, `src/request.test.ts > cloneRawRequest > clones consumed request object`.

```sh
ruby scripts/hono_replay.rb --base https://staging.firetrident.com --clone <clone> --modules <modules> --sweep 8,16 --name hono-replay --note 'Staging build 67baa13 (path-line fix, red brake reserves after admission, FT_PRELAND checks a change'\''s own tests; the seed lands without tests before landing); colonies at regionDepth 3; #5236 dropped (15 intents). Flags: FT_LATERAL_INHIBITION=off, FT_MEGAFILE=off (as Oct 17), FT_RED_BRAKE, FT_REVIEW_VIEW (with FT_QUOTED_ACCEPTANCE), FT_INHIBIT_STRONGEST, FT_AGE_CAP, FT_PRELAND on; FT_DEFAULT_SPEND_CAP 5.'
```

The grade never reads FireTrident's certification: after a run, the final trunk is cloned with stock git, what the run changed since the seed is laid over B in a scratch Hono worktree, and for each intent the pull request's test files are copied in and run with real vitest (Hono's main project, B's dependencies). Those hidden test files, which no agent saw, are the pull request's test files as its history left them right after it, with the selected pull requests laid on B in merge order. An intent passes when every one of its own tests passes: the tests in those files that fail right before it and pass right after it. "Hidden test files pass whole" says whether every test in them passed (B's tests and the earlier pull requests' tests in the same files as well).

The scripted person answers the review queue every 30.0 s: a change waiting at least 120.0 s gets its tests run again on the platform (the review card's "Run again"); it is approved with "scripted person: the visible tests pass" when they pass (or when every failing test fails on its base too), and returned naming the failing tests otherwise. When no test can run on it, it is approved when every file it writes is in its intent's footprint and returned naming the files outside otherwise. A change approved 3 times that comes back again is returned to be redone on the current trunk, and an agent's report waiting as long is dismissed with a note to do the intent as written. Every decision is in `run-<n>.json` under `person`.

Written by `scripts/hono_replay.rb` (numbers: `scripts/contention_report.rb`, whose header defines each one) and copied through `packages/bench/src/evidence.ts redact`. Files: `hono-replay.json` (every number), `run-<n>.json` (each run's record: events, certifications, proposals, agents, the scripted person's decisions, the grade), `run.log`.

## Runs side by side

| Measure | 8 agents | 16 agents |
| --- | --- | --- |
| Models | kimi-k2.7-code×1, glm-5.3-flash×1, gpt-oss-120b×2, gemma-4-26b-a4b-it×4 |  |
| Review | on (reflex clef) | n/a |
| Seed's certification (the baseline) | green (2328/2446), 6 files not run | n/a |
| How the run ended | timeout: 10/15 intents landed after 2400 s | failed: creating colony hono-replay-16: HTTP 500: Expected "unpack ok" or "unpack [error message]" but received "". |
| Stalled (no intent moved, intents open) | 1 report, longest 305 s: trunk is red at 5f04247 (3 failing); claims on the open intents' files: src/request.ts claim 2.7 (need 19.0), src/request.test.ts claim 1.9 (need 9.0), src/utils/url.ts claim 1.7 (need 16.0), src/client/client.test.ts claim 1.2 (need 9.0); agents: 3 proposing, 5 working, 3 waiting on their own changes | no |
| Intents landed | 10 of 15 | n/a |
| Intents held at once, peak (mean) | 9 (6.70) | n/a |
| Intents the colony or agents declared | none | n/a |
| Wall time, release to the last landing | not all landed (last at 1955.0 s) | n/a |
| Release to green after the last landing | n/a | n/a |
| Proposals (landed) | 20 (10) | n/a |
| Returned: stale read | 0 | n/a |
| Returned: text-merge conflict | 0 | n/a |
| Returned: review | 10 | n/a |
| Returned: rule | 0 | n/a |
| Returned: other | 0 | n/a |
| Cause-repeat rate | 43% (3/7) | n/a |
| Rounds to land, median (max) | 1.0 (2) | n/a |
| Model calls to land, median | 6.0 | n/a |
| Red-trunk episodes (open at the end) | 2 (1) | n/a |
| Time to green, median (max) | 16.6 s (16.6 s) | n/a |
| Repair intents declared (landed) | 2 (0) | n/a |
| Human queue: escalations, held merges, agent reports | 3, 0, 1 | n/a |
| Time in the human queue, median (max) | 174.4 s (197.0 s) | n/a |
| Scripted person: approved, returned (by the no-tests rule) | 0, 3 (0) | 0, 0 (0) |
| Scripted person: test runs asked (refused), reports dismissed | 3 (0), 1 | 0 (0), 0 |
| Model calls: agents (review) | 85 (35) | n/a |
| Model spend this platform made | $0.7382 | n/a |
| Spend per landed intent | $0.0738 | n/a |
| Hidden tests (real vitest): intents passing | 6 of 15 | not graded () |
| Their own tests passing at the end | 13 of 29 | n/a |
| Intents whose hidden test files pass whole | 2 of 15 | n/a |
| Visible suite at the end (same vitest) | 3651 of 3683 tests pass, 6 failing | n/a |

## 8 agents (colony hono-replay-8)

Model mix `@cf/moonshotai/kimi-k2.7-code=1,@cf/zai-org/glm-5.3-flash=1,@cf/openai/gpt-oss-120b=2,@cf/google/gemma-4-26b-a4b-it`; region depth 3; flags on: FT_A2A, FT_AGENT_CALL_BUDGET, FT_AGE_CAP, FT_ALREADY_ON_TRUNK, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DEFAULT_SPEND_CAP, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INHIBIT_STRONGEST, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PRELAND, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_RED_BRAKE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_REVIEW_VIEW, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed 346 files in 7 inline changes, digest 2955e216b062, trunk held it exactly; spend cap set.

Returns: 10 (and 0 redirects). Cause repeats by cause: stale read 0/0, text-merge conflict 0/0, review 3/7, rule 0/0, other 0/0.

| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |
| --- | --- | --- | --- |
| stale read | 0 | n/a | n/a |
| text-merge conflict | 0 | n/a | n/a |
| review | 4 | 2.0 | 9.0 |
| rule | 0 | n/a | n/a |
| other | 0 | n/a | n/a |
| first try | 6 | 1.0 | 4.0 |

| Intent | Pull request | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden tests | Its own tests passing | Hidden files whole |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5102 | fix(trie-router): match empty wildcard remainder after regexp param | open | 2 | n/a | review 2 | 13 | $0.0317 | fail | 0 of 2 | fail (529/553) |
| #5133 | fix(request): fix multipart boundary mismatch in `cloneRawRequest` | landed | 1 | 1 |  | 10 | $0.0690 | fail | 0 of 1 | fail (38/39) |
| #5161 | fix: use `Object.create(null)` when parsing query, headers, and params | open | 2 | n/a | review 2 | 17 | $0.0861 | fail | 0 of 3 | fail (99/103) |
| #5164 | fix(cookie): relax name validation when parsing Cookie header | landed | 2 | 2 | review 1 | 8 | $0.0112 | pass | 2 of 2 | fail (43/46) |
| #5189 | fix(trie-router): count every slash a pattern consumes | landed | 2 | 2 | review 1 | 10 | $0.0477 | fail | 3 of 4 | fail (542/567) |
| #4988 | fix(utils/stream): re-acquire writer lock when pipe() throws | landed | 1 | 1 |  | 4 | $0.0031 | pass | 2 of 2 | pass (11/11) |
| #5202 | fix(client): serialize multiple cookies correctly | open | 2 | n/a | review 2 | 7 | $0.0943 | fail | 0 of 1 | fail (103/104) |
| #5209 | fix(url): strip trailing question mark correctly for optional params with regex  | landed | 2 | 2 | review 1 | 8 | $0.0117 | pass | 1 of 1 | fail (33/34) |
| #5215 | fix(client): send falsy JSON bodies | open | 0 | n/a |  | 3 | $0.0069 | fail | 0 of 4 | fail (103/108) |
| #5268 | fix(request): handle params on unmatched requests | landed | 1 | 1 |  | 4 | $0.0071 | pass | 1 of 1 | fail (39/41) |
| #5244 | fix(client): skip undefined header and cookie values | open | 0 | n/a |  | 4 | $0.0452 | fail | 0 of 2 | fail (103/110) |
| #5282 | fix(request): drop stale content length for cloned FormData | landed | 1 | 1 |  | 4 | $0.0072 | fail | 0 of 1 | fail (39/42) |
| #5288 | fix(request): serialize cached JSON body in cloneRawRequest | landed | 1 | 1 |  | 4 | $0.0064 | fail | 0 of 1 | fail (39/43) |
| #5246 | fix(cookie): allow parsing signed cookies with empty string values | landed | 2 | 2 | review 1 | 13 | $0.0697 | pass | 2 of 2 | fail (74/77) |
| #5274 | fix(utils/stream): do not let abort listeners crash abort() | landed | 1 | 1 |  | 4 | $0.0033 | pass | 2 of 2 | pass (14/14) |

| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |
| --- | --- | --- | --- | --- | --- |
| 1 | -24.5 s | src/adapter/lambda-edge/handler.test.ts, src/client/types.test.ts, src/helper/factory/index.test.ts, src/helper/ssg/utils.test.ts | int_mvfm1cfsgudacc (suspect) | 16.6 s | 4 |
| 2 | 321.8 s | src/request.test.ts | #5282 (first red) | still red | 6 |

Human queue: 3 escalations, 0 held merges, 1 agent reports; 0 waiting at the end. The scripted person approved 0 and returned 3 (0 of them by the no-tests rule), asked for 3 test runs (0 refused) and dismissed 1 reports.

| At | Change | Intent | Decision | Rule | Tests run on it | Waited |
| --- | --- | --- | --- | --- | --- | --- |
| 603.3 s | prp_mvfmavl4sjxz78 | #5202 | return | tests fail | ran 2328/2446 | 164.3 s |
| 698.5 s | prp_mvfmdlxw7oud39 | #5246 | return | tests fail | ran 2329/2455 | 160.8 s |
| 1715.7 s | prp_mvfmz1mojwry7m | #5202 | return | tests fail | ran 2332/2453 | 165.9 s |

Spend by model, with the in-platform agents on it and their calls: @cf/google/gemma-4-26b-a4b-it $0.1295 (4, 44); @cf/moonshotai/kimi-k2.7-code $0.3476 (1, 10); @cf/openai/gpt-oss-120b $0.2396 (2, 24); @cf/zai-org/glm-5.3-flash $0.0128 (1, 7); @cf/cloudflare/clef $0.0082 (0, 0); @cf/zai-org/glm-4.7-flash $0.0005 (0, 0). By layer: agents $0.7164, review $0.0217, judge $0.0000, resolver $0.0000, other $0.0000.

## 16 agents (colony hono-replay-16)

Model mix `@cf/moonshotai/kimi-k2.7-code=1,@cf/zai-org/glm-5.3-flash=1,@cf/openai/gpt-oss-120b=2,@cf/google/gemma-4-26b-a4b-it`; region depth n/a; flags on: FT_A2A, FT_AGENT_CALL_BUDGET, FT_AGE_CAP, FT_ALREADY_ON_TRUNK, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DEFAULT_SPEND_CAP, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INHIBIT_STRONGEST, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PRELAND, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_RED_BRAKE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_REVIEW_VIEW, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed  files in  inline changes, digest ; spend cap not set.

No report: creating colony hono-replay-16: HTTP 500: Expected "unpack ok" or "unpack [error message]" but received ""..

## The workload

Base ab590e4ec8be (2026-07-10T18:15:02+09:00): fix(types): strip extra properties from array types in JSONParsed (#5103). The pull requests, in merge order, with the source files each changed, its hidden test files and how many of its own tests they hold:

| Pull request | Merged | Title | Source files | Hidden test files | Its own tests |
| --- | --- | --- | --- | --- | --- |
| #5102 | 2026-07-10 | fix(trie-router): match empty wildcard remainder after regexp param | `src/router/trie-router/node.ts` | `src/router/common.case.test.ts`, `src/router/linear-router/router.test.ts`, `src/router/trie-router/node.test.ts` | 2 |
| #5133 | 2026-07-17 | fix(request): fix multipart boundary mismatch in `cloneRawRequest` | `src/request.ts` | `src/request.test.ts` | 1 |
| #5161 | 2026-07-24 | fix: use `Object.create(null)` when parsing query, headers, and params | `src/request.ts`, `src/utils/accept.ts`, `src/utils/url.ts` | `src/request.test.ts`, `src/utils/accept.test.ts`, `src/utils/url.test.ts` | 3 |
| #5164 | 2026-07-26 | fix(cookie): relax name validation when parsing Cookie header | `src/utils/cookie.ts` | `src/utils/cookie.test.ts` | 2 |
| #5189 | 2026-08-05 | fix(trie-router): count every slash a pattern consumes | `src/router/trie-router/node.ts` | `src/router/common.case.test.ts`, `src/router/trie-router/node.test.ts` | 4 |
| #4988 | 2026-08-06 | fix(utils/stream): re-acquire writer lock when pipe() throws | `src/utils/stream.ts` | `src/utils/stream.test.ts` | 2 |
| #5202 | 2026-08-09 | fix(client): serialize multiple cookies correctly | `src/client/client.ts` | `src/client/client.test.ts` | 1 |
| #5209 | 2026-08-13 | fix(url): strip trailing question mark correctly for optional params with regex quantifier | `src/utils/url.ts` | `src/utils/url.test.ts` | 1 |
| #5215 | 2026-08-13 | fix(client): send falsy JSON bodies | `src/client/client.ts` | `src/client/client.test.ts` | 4 |
| #5268 | 2026-08-19 | fix(request): handle params on unmatched requests | `src/request.ts` | `src/request.test.ts` | 1 |
| #5244 | 2026-08-22 | fix(client): skip undefined header and cookie values | `src/client/client.ts` | `src/client/client.test.ts` | 2 |
| #5282 | 2026-08-23 | fix(request): drop stale content length for cloned FormData | `src/request.ts` | `src/request.test.ts` | 1 |
| #5288 | 2026-08-23 | fix(request): serialize cached JSON body in cloneRawRequest | `src/request.ts` | `src/request.test.ts` | 1 |
| #5246 | 2026-08-23 | fix(cookie): allow parsing signed cookies with empty string values | `src/utils/cookie.ts` | `src/helper/cookie/index.test.ts`, `src/utils/cookie.test.ts` | 2 |
| #5274 | 2026-08-23 | fix(utils/stream): do not let abort listeners crash abort() | `src/utils/stream.ts` | `src/utils/stream.test.ts` | 2 |

Shared source files: `src/client/client.ts` (#5202, #5215, #5244); `src/request.ts` (#5133, #5161, #5268, #5282, #5288); `src/router/trie-router/node.ts` (#5102, #5189); `src/utils/cookie.ts` (#5164, #5246); `src/utils/stream.ts` (#4988, #5274); `src/utils/url.ts` (#5161, #5209).

Dropped from the workload after selection: #5236: its src/hono.test.ts is 109,470 characters at B and 109,990 right after it, more than the 86,016 characters an in-platform agent can write back in one reply (packages/worker/src/agents/prompt.ts MAX_REWRITE_CHARS), so no agent can produce the file and its intent can never land.

Workload note: #5236 was dropped by hand after selection (considered.dropped says why). The selection now skips a pull request that changes a file longer than an agent can write back (scripts/hono_replay_select.rb), but it was not run again: that needs GitHub reads and fresh vitest runs, and could choose another pull request in its place.
Workload note: The pull requests after #5236 were laid on B again without it (stock git, the same fixed identity and dates), so their laid commits and the target changed; every hidden file's blob id is unchanged, and the overlap and the API scan were recomputed from the remaining pull requests.

The seed is B's tree, 346 files, but for 79 under benchmarks/, 1 over the 256 KiB inline limit, 6 under docs/images/, 12 under perf-measures/, 46 under runtime-tests/: those stay in the scratch worktree the grade runs in.

## What this does not measure

- One repository and one stretch of its history; the numbers are one contended point on real code, not a curve.
- The person is a script: it approves what passes the visible tests and returns what fails them, which a careful reviewer would not always do.
- Model calls are what this platform counted for the colony (agents, review, the resolver, the judge). The grade is real vitest on Node with B's dependencies, outside the platform.
- The pull requests were merged upstream; their descriptions are what each intent says, and a description can say less than the change did.
- Models answer differently between runs: a second run of the same command will not give the same numbers.
