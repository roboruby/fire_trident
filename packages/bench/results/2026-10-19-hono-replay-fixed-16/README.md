# Hono replay: 16 agents on honojs/hono's own pull requests

MEASURED on https://staging.firetrident.com (build 1a51ebe), 2026-10-19: in-platform agents calling real models, review on, a scripted person answering the review queue, graded by Hono's own tests under real vitest. The workload is `demo/hono-replay/workload.json` (`scripts/hono_replay_select.rb`): honojs/hono at ab590e4ec8be (2026-07-10) and 15 pull requests merged into main after it, each redone as one intent (source human, equal priority) with its title, its description as the why and the files it changed under src/ as its footprint. Each pull request changes source that another one also changes; most shared: `src/request.ts` (5), `src/client/client.ts` (3), `src/router/trie-router/node.ts` (2), `src/utils/cookie.ts` (2). Each run started on its own fresh colony from the same seed (B's tree, 346 files) and intents.

Operator's note: Staging build 1a51ebe (the 8-agent run's fixes plus accounts, which operator colonies do not use); colonies at regionDepth 3; #5236 dropped (15 intents). Flags: FT_LATERAL_INHIBITION=off, FT_MEGAFILE=off (as Oct 17), FT_RED_BRAKE, FT_REVIEW_VIEW (with FT_QUOTED_ACCEPTANCE), FT_INHIBIT_STRONGEST, FT_AGE_CAP, FT_PRELAND on; FT_DEFAULT_SPEND_CAP 5.

Each colony was created at region depth 3 (`--region-depth`, default 3). Admission is decided per region (a region admits while its working agents are fewer than max(3, 2 x its landings in the last minute)), and every file of this workload is under src/: at depth 1 the whole workload is one region and a run holds about three working agents whatever its agent count.

Left out of each colony's trunk certification, not of the grade (they pass under Node and fail in workerd): `src/helper/proxy/index.test.ts > Proxy Middleware > proxy > client disconnect`, `src/request.test.ts > cloneRawRequest > clones consumed request object`.

```sh
ruby scripts/hono_replay.rb --base https://staging.firetrident.com --clone <clone> --modules <modules> --agents 16 --name hono-replay --note 'Staging build 1a51ebe (the 8-agent run'\''s fixes plus accounts, which operator colonies do not use); colonies at regionDepth 3; #5236 dropped (15 intents). Flags: FT_LATERAL_INHIBITION=off, FT_MEGAFILE=off (as Oct 17), FT_RED_BRAKE, FT_REVIEW_VIEW (with FT_QUOTED_ACCEPTANCE), FT_INHIBIT_STRONGEST, FT_AGE_CAP, FT_PRELAND on; FT_DEFAULT_SPEND_CAP 5.'
```

The grade never reads FireTrident's certification: after a run, the final trunk is cloned with stock git, what the run changed since the seed is laid over B in a scratch Hono worktree, and for each intent the pull request's test files are copied in and run with real vitest (Hono's main project, B's dependencies). Those hidden test files, which no agent saw, are the pull request's test files as its history left them right after it, with the selected pull requests laid on B in merge order. An intent passes when every one of its own tests passes: the tests in those files that fail right before it and pass right after it. "Hidden test files pass whole" says whether every test in them passed (B's tests and the earlier pull requests' tests in the same files as well).

The scripted person answers the review queue every 30.0 s: a change waiting at least 120.0 s gets its tests run again on the platform (the review card's "Run again"); it is approved with "scripted person: the visible tests pass" when they pass (or when every failing test fails on its base too), and returned naming the failing tests otherwise. When no test can run on it, it is approved when every file it writes is in its intent's footprint and returned naming the files outside otherwise. A change approved 3 times that comes back again is returned to be redone on the current trunk, and an agent's report waiting as long is dismissed with a note to do the intent as written. Every decision is in `run-<n>.json` under `person`.

Written by `scripts/hono_replay.rb` (numbers: `scripts/contention_report.rb`, whose header defines each one) and copied through `packages/bench/src/evidence.ts redact`. Files: `hono-replay.json` (every number), `run-<n>.json` (each run's record: events, certifications, proposals, agents, the scripted person's decisions, the grade), `run.log`.

## Runs side by side

| Measure | 16 agents |
| --- | --- |
| Models | kimi-k2.7-code×1, glm-5.3-flash×1, gpt-oss-120b×2, gemma-4-26b-a4b-it×12 |
| Review | on (reflex clef) |
| Seed's certification (the baseline) | green (2328/2446), 6 files not run |
| How the run ended | timeout: 12/15 intents landed after 2400 s |
| Stalled (no intent moved, intents open) | 1 report, longest 304.9 s: trunk is red at 14025c6 (30 failing); agents: 12 waiting, 4 working, 7 waiting on their own changes |
| Intents landed | 12 of 15 |
| Intents held at once, peak (mean) | 11 (5.57) |
| Intents the colony or agents declared | none |
| Wall time, release to the last landing | not all landed (last at 1542.9 s) |
| Release to green after the last landing | n/a |
| Proposals (landed) | 20 (12) |
| Returned: stale read | 0 |
| Returned: text-merge conflict | 0 |
| Returned: review | 8 |
| Returned: rule | 0 |
| Returned: other | 0 |
| Cause-repeat rate | 40% (2/5) |
| Rounds to land, median (max) | 1.0 (3) |
| Model calls to land, median | 5.5 |
| Red-trunk episodes (open at the end) | 2 (1) |
| Time to green, median (max) | 18.0 s (18.0 s) |
| Repair intents declared (landed) | 2 (0) |
| Human queue: escalations, held merges, agent reports | 1, 0, 0 |
| Time in the human queue, median (max) | 195.6 s (195.6 s) |
| Scripted person: approved, returned (by the no-tests rule) | 0, 1 (0) |
| Scripted person: test runs asked (refused), reports dismissed | 1 (0), 0 |
| Model calls: agents (review) | 82 (36) |
| Model spend this platform made | $0.8137 |
| Spend per landed intent | $0.0678 |
| Hidden tests (real vitest): intents passing | 10 of 15 |
| Their own tests passing at the end | 21 of 29 |
| Intents whose hidden test files pass whole | 4 of 15 |
| Visible suite at the end (same vitest) | 3535 of 3593 tests pass, 32 failing (1 file did not load) |

## 16 agents (colony hono-replay-16)

Model mix `@cf/moonshotai/kimi-k2.7-code=1,@cf/zai-org/glm-5.3-flash=1,@cf/openai/gpt-oss-120b=2,@cf/google/gemma-4-26b-a4b-it`; region depth 3; flags on: FT_A2A, FT_ACCOUNTS, FT_AGENT_CALL_BUDGET, FT_AGE_CAP, FT_ALREADY_ON_TRUNK, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DEFAULT_SPEND_CAP, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INHIBIT_STRONGEST, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PRELAND, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_RED_BRAKE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_REVIEW_VIEW, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed 346 files in 7 inline changes, digest 2955e216b062, trunk held it exactly; spend cap set.

Returns: 8 (and 0 redirects). Cause repeats by cause: stale read 0/0, text-merge conflict 0/0, review 2/5, rule 0/0, other 0/0.

| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |
| --- | --- | --- | --- |
| stale read | 0 | n/a | n/a |
| text-merge conflict | 0 | n/a | n/a |
| review | 3 | 3 | 12 |
| rule | 0 | n/a | n/a |
| other | 0 | n/a | n/a |
| first try | 9 | 1 | 4 |

| Intent | Pull request | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden tests | Its own tests passing | Hidden files whole |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5102 | fix(trie-router): match empty wildcard remainder after regexp param | landed | 1 | 1 |  | 6 | $0.0406 | pass | 2 of 2 | pass (531/553) |
| #5133 | fix(request): fix multipart boundary mismatch in `cloneRawRequest` | landed | 1 | 1 |  | 4 | $0.0776 | pass | 1 of 1 | pass (39/39) |
| #5161 | fix: use `Object.create(null)` when parsing query, headers, and params | open | 1 | n/a | review 1 | 18 | $0.0509 | fail | 0 of 3 | fail (100/103) |
| #5164 | fix(cookie): relax name validation when parsing Cookie header | landed | 1 | 1 |  | 4 | $0.0076 | pass | 2 of 2 | fail (43/46) |
| #5189 | fix(trie-router): count every slash a pattern consumes | landed | 1 | 1 |  | 6 | $0.0141 | fail | 3 of 4 | fail (544/567) |
| #4988 | fix(utils/stream): re-acquire writer lock when pipe() throws | landed | 1 | 1 |  | 6 | $0.0140 | pass | 2 of 2 | pass (11/11) |
| #5202 | fix(client): serialize multiple cookies correctly | open | 1 | n/a | review 1 | 7 | $0.0673 | fail | 0 of 1 | fail (103/104) |
| #5209 | fix(url): strip trailing question mark correctly for optional params with regex  | landed | 3 | 3 | review 2 | 12 | $0.0579 | pass | 1 of 1 | fail (33/34) |
| #5215 | fix(client): send falsy JSON bodies | landed | 1 | 1 |  | 4 | $0.0105 | pass | 4 of 4 | fail (107/108) |
| #5268 | fix(request): handle params on unmatched requests | landed | 1 | 1 |  | 4 | $0.0071 | pass | 1 of 1 | fail (40/41) |
| #5244 | fix(client): skip undefined header and cookie values | open | 1 | n/a | review 1 | 9 | $0.0487 | fail | 0 of 2 | fail (107/110) |
| #5282 | fix(request): drop stale content length for cloned FormData | landed | 2 | 2 | review 1 | 8 | $0.0167 | pass | 1 of 1 | fail (41/42) |
| #5288 | fix(request): serialize cached JSON body in cloneRawRequest | landed | 1 | 1 |  | 5 | $0.0083 | fail | 0 of 1 | fail (41/43) |
| #5246 | fix(cookie): allow parsing signed cookies with empty string values | landed | 3 | 3 | review 2 | 15 | $0.1291 | pass | 2 of 2 | fail (74/77) |
| #5274 | fix(utils/stream): do not let abort listeners crash abort() | landed | 1 | 1 |  | 4 | $0.0034 | pass | 2 of 2 | pass (14/14) |

| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |
| --- | --- | --- | --- | --- | --- |
| 1 | -33.0 s | src/adapter/lambda-edge/handler.test.ts, src/client/types.test.ts, src/helper/factory/index.test.ts, src/helper/ssg/utils.test.ts | int_mvfnyls1oohfwb (suspect) | 18.0 s | 3 |
| 2 | 121.2 s | src/request.test.ts | #5268 (first red) | still red | 10 |

Human queue: 1 escalations, 0 held merges, 0 agent reports; 0 waiting at the end. The scripted person approved 0 and returned 1 (0 of them by the no-tests rule), asked for 1 test runs (0 refused) and dismissed 0 reports.

| At | Change | Intent | Decision | Rule | Tests run on it | Waited |
| --- | --- | --- | --- | --- | --- | --- |
| 372.9 s | prp_mvfo3knoxqjx1u | #5202 | return | tests fail | ran 2328/2446 | 165.2 s |

Spend by model, with the in-platform agents on it and their calls: @cf/google/gemma-4-26b-a4b-it $0.1433 (12, 50); @cf/moonshotai/kimi-k2.7-code $0.5439 (1, 15); @cf/openai/gpt-oss-120b $0.1021 (2, 13); @cf/zai-org/glm-5.3-flash $0.0154 (1, 4); @cf/cloudflare/clef $0.0082 (0, 0); @cf/zai-org/glm-4.7-flash $0.0007 (0, 0). By layer: agents $0.7920, review $0.0216, judge $0.0000, resolver $0.0000, other $0.0000.

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
