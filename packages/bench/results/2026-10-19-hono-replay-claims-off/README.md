# Hono replay: 8 agents, 16 agents, 1 agent on honojs/hono's own pull requests

MEASURED on https://staging.firetrident.com (build 932b210), 2026-10-19: in-platform agents calling real models, review on, a scripted person answering the review queue, graded by Hono's own tests under real vitest. The workload is `demo/hono-replay/workload.json` (`scripts/hono_replay_select.rb`): honojs/hono at ab590e4ec8be (2026-07-10) and 16 pull requests merged into main after it, each redone as one intent (source human, equal priority) with its title, its description as the why and the files it changed under src/ as its footprint. Each pull request changes source that another one also changes; most shared: `src/request.ts` (5), `src/client/client.ts` (3), `src/router/trie-router/node.ts` (3), `src/utils/cookie.ts` (2). Each run started on its own fresh colony from the same seed (B's tree, 346 files) and intents.

Operator's note: Staging build 932b210, as the Oct 17 contention run: FT_LATERAL_INHIBITION=off, FT_MEGAFILE=off (deploy overrides). With the quality fixes on: FT_RED_BRAKE, FT_REVIEW_VIEW (with FT_QUOTED_ACCEPTANCE), FT_INHIBIT_STRONGEST, FT_AGE_CAP; FT_DEFAULT_SPEND_CAP 5.

Left out of each colony's trunk certification, not of the grade (they pass under Node and fail in workerd): `src/helper/proxy/index.test.ts > Proxy Middleware > proxy > client disconnect`, `src/request.test.ts > cloneRawRequest > clones consumed request object`.

```sh
ruby scripts/hono_replay.rb --base https://staging.firetrident.com --clone <clone> --modules <modules> --sweep 8,16 --solo --name hono-replay --note 'Staging build 932b210, as the Oct 17 contention run: FT_LATERAL_INHIBITION=off, FT_MEGAFILE=off (deploy overrides). With the quality fixes on: FT_RED_BRAKE, FT_REVIEW_VIEW (with FT_QUOTED_ACCEPTANCE), FT_INHIBIT_STRONGEST, FT_AGE_CAP; FT_DEFAULT_SPEND_CAP 5.'
```

The grade never reads FireTrident's certification: after a run, the final trunk is cloned with stock git, what the run changed since the seed is laid over B in a scratch Hono worktree, and for each intent the pull request's test files are copied in and run with real vitest (Hono's main project, B's dependencies). Those hidden test files, which no agent saw, are the pull request's test files as its history left them right after it, with the selected pull requests laid on B in merge order. An intent passes when every one of its own tests passes: the tests in those files that fail right before it and pass right after it. "Hidden test files pass whole" says whether every test in them passed (B's tests and the earlier pull requests' tests in the same files as well).

The scripted person answers the review queue every 30.0 s: a change waiting at least 120.0 s gets its tests run again on the platform (the review card's "Run again"); it is approved with "scripted person: the visible tests pass" when they pass (or when every failing test fails on its base too), and returned naming the failing tests otherwise. When no test can run on it, it is approved when every file it writes is in its intent's footprint and returned naming the files outside otherwise. A change approved 3 times that comes back again is returned to be redone on the current trunk, and an agent's report waiting as long is dismissed with a note to do the intent as written. Every decision is in `run-<n>.json` under `person`.

Written by `scripts/hono_replay.rb` (numbers: `scripts/contention_report.rb`, whose header defines each one) and copied through `packages/bench/src/evidence.ts redact`. Files: `hono-replay.json` (every number), `run-<n>.json` (each run's record: events, certifications, proposals, agents, the scripted person's decisions, the grade), `run.log`.

## Runs side by side

| Measure | 8 agents | 16 agents | 1 agent |
| --- | --- | --- | --- |
| Models | kimi-k2.7-code×1, glm-5.3-flash×1, gpt-oss-120b×2, gemma-4-26b-a4b-it×4 | kimi-k2.7-code×1, glm-5.3-flash×1, gpt-oss-120b×2, gemma-4-26b-a4b-it×12 | gemma-4-26b-a4b-it×1 |
| Review | on (reflex clef) | on (reflex clef) | on (reflex clef) |
| Seed's certification (the baseline) | green (2328/2446), 6 files not run | green (2328/2446), 6 files not run | green (2328/2446), 6 files not run |
| How the run ended | stall: nothing landed for 900 s (4/16 landed); stalled: trunk is red at 8a58c1e (3 failing); claims on the open intents' files: src/client/client.test.ts claim 0.7 (need 9.0), src/client/client.ts claim 0.7 (need 9.0), src/router/common.case.test.ts claim 0.6 (need 6.0), src/router/trie-router/node.test.ts claim 0.6 (need 9.0); agents: 4 waiting, 4 working, 2 waiting on their own changes | stall: nothing landed for 900 s (3/16 landed); stalled: trunk is red at 65e52e6 (3 failing); claims on the open intents' files: src/client/client.test.ts claim 1.0 (need 9.0), src/client/client.ts claim 1.0 (need 9.0), src/router/common.case.test.ts claim 0.8 (need 6.0), src/router/trie-router/node.test.ts claim 0.8 (need 9.0); agents: 13 waiting, 3 working, 4 waiting on their own changes | stall: nothing landed for 900 s (0/16 landed); stalled: claims on the open intents' files: src/router/common.case.test.ts claim 0.8 (need 6.0), src/router/trie-router/node.test.ts claim 0.8 (need 9.0), src/router/trie-router/node.ts claim 0.8 (need 9.0); agents: 1 working |
| Stalled (no intent moved, intents open) | 2 reports, longest 304.3 s: trunk is red at 70852c4 (3 failing); claims on the open intents' files: src/client/client.test.ts claim 1.7 (need 9.0), src/client/client.ts claim 1.7 (need 9.0), src/router/common.case.test.ts claim 0.7 (need 6.0), src/router/trie-router/node.test.ts claim 0.7 (need 9.0); agents: 5 waiting, 3 working, 5 waiting on their own changes | 2 reports, longest 304 s: trunk is red at 65e52e6 (3 failing); claims on the open intents' files: src/client/client.test.ts claim 0.8 (need 9.0), src/client/client.ts claim 0.8 (need 9.0), src/router/common.case.test.ts claim 0.6 (need 6.0), src/router/trie-router/node.test.ts claim 0.6 (need 9.0); agents: 13 waiting, 3 working, 3 waiting on their own changes | 2 reports, longest 303.9 s: claims on the open intents' files: src/router/common.case.test.ts claim 0.7 (need 6.0), src/router/trie-router/node.test.ts claim 0.7 (need 9.0), src/router/trie-router/node.ts claim 0.7 (need 9.0); agents: 1 working |
| Intents landed | 4 of 16 | 3 of 16 | 0 of 16 |
| Intents held at once, peak (mean) | 8 (3.24) | 8 (2.94) | 1 (1.00) |
| Intents the colony or agents declared | none | none | none |
| Wall time, release to the last landing | not all landed (last at 1031.2 s) | not all landed (last at 1084.8 s) | not all landed (last at n/a s) |
| Release to green after the last landing | n/a | n/a | n/a |
| Proposals (landed) | 9 (4) | 8 (3) | 1 (0) |
| Returned: stale read | 0 | 0 | 0 |
| Returned: text-merge conflict | 0 | 0 | 0 |
| Returned: review | 5 | 5 | 1 |
| Returned: rule | 0 | 0 | 0 |
| Returned: other | 0 | 0 | 0 |
| Cause-repeat rate | 50% (1/2) | 0% (0/1) | n/a (0/0) |
| Rounds to land, median (max) | 1.0 (3) | 1 (2) | n/a (n/a) |
| Model calls to land, median | 5.0 | 7 | n/a |
| Red-trunk episodes (open at the end) | 2 (1) | 2 (1) | 1 (0) |
| Time to green, median (max) | 12.8 s (12.8 s) | 11.5 s (11.5 s) | 13.2 s (13.2 s) |
| Repair intents declared (landed) | 2 (0) | 2 (0) | 1 (0) |
| Human queue: escalations, held merges, agent reports | 1, 0, 0 | 1, 0, 1 | 0, 0, 0 |
| Time in the human queue, median (max) | 179.5 s (179.5 s) | 166.6 s (190.5 s) | n/a (n/a) |
| Scripted person: approved, returned (by the no-tests rule) | 0, 1 (0) | 0, 1 (0) | 0, 0 (0) |
| Scripted person: test runs asked (refused), reports dismissed | 1 (0), 0 | 1 (0), 1 | 0 (0), 0 |
| Model calls: agents (review) | 41 (16) | 33 (14) | 5 (2) |
| Model spend this platform made | $0.3328 | $0.3431 | $0.0178 |
| Spend per landed intent | $0.0832 | $0.1144 | n/a |
| Hidden tests (real vitest): intents passing | 4 of 16 | 3 of 16 | not graded (no intent landed) |
| Their own tests passing at the end | 6 of 35 | 5 of 35 | n/a |
| Intents whose hidden test files pass whole | 2 of 16 | 2 of 16 | n/a |
| Visible suite at the end (same vitest) | 3631 of 3658 tests pass, 1 failing | 3631 of 3660 tests pass, 3 failing | n/a |

## 8 agents (colony hono-replay-8)

Model mix `@cf/moonshotai/kimi-k2.7-code=1,@cf/zai-org/glm-5.3-flash=1,@cf/openai/gpt-oss-120b=2,@cf/google/gemma-4-26b-a4b-it`; flags on: FT_A2A, FT_AGENT_CALL_BUDGET, FT_AGE_CAP, FT_ALREADY_ON_TRUNK, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DEFAULT_SPEND_CAP, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INHIBIT_STRONGEST, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_RED_BRAKE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_REVIEW_VIEW, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed 346 files in 7 inline changes, digest 2955e216b062, trunk held it exactly; spend cap set.

Returns: 5 (and 0 redirects). Cause repeats by cause: stale read 0/0, text-merge conflict 0/0, review 1/2, rule 0/0, other 0/0.

| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |
| --- | --- | --- | --- |
| stale read | 0 | n/a | n/a |
| text-merge conflict | 0 | n/a | n/a |
| review | 1 | 3 | 12 |
| rule | 0 | n/a | n/a |
| other | 0 | n/a | n/a |
| first try | 3 | 1 | 4 |

| Intent | Pull request | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden tests | Its own tests passing | Hidden files whole |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5102 | fix(trie-router): match empty wildcard remainder after regexp param | open | 1 | n/a | review 1 | 13 | $0.0945 | fail | 0 of 2 | fail (529/553) |
| #5133 | fix(request): fix multipart boundary mismatch in `cloneRawRequest` | landed | 1 | 1 |  | 4 | $0.0084 | pass | 1 of 1 | pass (39/39) |
| #5161 | fix: use `Object.create(null)` when parsing query, headers, and params | open | 0 | n/a |  | 0 | n/a | fail | 0 of 3 | fail (100/103) |
| #5164 | fix(cookie): relax name validation when parsing Cookie header | landed | 1 | 1 |  | 6 | $0.0347 | pass | 2 of 2 | fail (43/46) |
| #5189 | fix(trie-router): count every slash a pattern consumes | open | 0 | n/a |  | 0 | n/a | fail | 0 of 4 | fail (539/567) |
| #4988 | fix(utils/stream): re-acquire writer lock when pipe() throws | landed | 3 | 3 | review 2 | 12 | $0.0533 | pass | 2 of 2 | pass (11/11) |
| #5202 | fix(client): serialize multiple cookies correctly | open | 0 | n/a |  | 3 | $0.0063 | fail | 0 of 1 | fail (103/104) |
| #5209 | fix(url): strip trailing question mark correctly for optional params with regex  | landed | 1 | 1 |  | 4 | $0.0053 | pass | 1 of 1 | fail (33/34) |
| #5215 | fix(client): send falsy JSON bodies | open | 0 | n/a |  | 0 | n/a | fail | 0 of 4 | fail (103/108) |
| #5236 | fix(trie-router): match suffix wildcard routes | open | 0 | n/a |  | 0 | n/a | fail | 0 of 6 | fail (287/296) |
| #5268 | fix(request): handle params on unmatched requests | open | 1 | n/a | review 1 | 4 | $0.0069 | fail | 0 of 1 | fail (39/41) |
| #5244 | fix(client): skip undefined header and cookie values | open | 1 | n/a | review 1 | 2 | $0.0092 | fail | 0 of 2 | fail (103/110) |
| #5282 | fix(request): drop stale content length for cloned FormData | open | 0 | n/a |  | 0 | n/a | fail | 0 of 1 | fail (39/42) |
| #5288 | fix(request): serialize cached JSON body in cloneRawRequest | open | 0 | n/a |  | 0 | n/a | fail | 0 of 1 | fail (39/43) |
| #5246 | fix(cookie): allow parsing signed cookies with empty string values | open | 0 | n/a |  | 7 | $0.0671 | fail | 0 of 2 | fail (72/77) |
| #5274 | fix(utils/stream): do not let abort listeners crash abort() | open | 0 | n/a |  | 0 | n/a | fail | 0 of 2 | fail (12/14) |

| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |
| --- | --- | --- | --- | --- | --- |
| 1 | -25.1 s | src/adapter/lambda-edge/handler.test.ts, src/client/types.test.ts, src/helper/factory/index.test.ts, src/helper/ssg/utils.test.ts | int_mvfiqib2qhlcxa (suspect) | 12.8 s | 1 |
| 2 | 275.3 s | src/request.test.ts | #5133 (first red) | still red | 2 |

Human queue: 1 escalations, 0 held merges, 0 agent reports; 0 waiting at the end. The scripted person approved 0 and returned 1 (0 of them by the no-tests rule), asked for 1 test runs (0 refused) and dismissed 0 reports.

| At | Change | Intent | Decision | Rule | Tests run on it | Waited |
| --- | --- | --- | --- | --- | --- | --- |
| 904.7 s | prp_mvfj6ybx5psjbs | #5244 | return | tests fail | ran 2328/2446 | 165.1 s |

Spend by model, with the in-platform agents on it and their calls: @cf/google/gemma-4-26b-a4b-it $0.0383 (4, 16); @cf/moonshotai/kimi-k2.7-code $0.1303 (1, 5); @cf/openai/gpt-oss-120b $0.1528 (2, 18); @cf/zai-org/glm-5.3-flash $0.0078 (1, 2); @cf/cloudflare/clef $0.0036 (0, 0). By layer: agents $0.3201, review $0.0128, judge $0.0000, resolver $0.0000, other $0.0000.

## 16 agents (colony hono-replay-16)

Model mix `@cf/moonshotai/kimi-k2.7-code=1,@cf/zai-org/glm-5.3-flash=1,@cf/openai/gpt-oss-120b=2,@cf/google/gemma-4-26b-a4b-it`; flags on: FT_A2A, FT_AGENT_CALL_BUDGET, FT_AGE_CAP, FT_ALREADY_ON_TRUNK, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DEFAULT_SPEND_CAP, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INHIBIT_STRONGEST, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_RED_BRAKE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_REVIEW_VIEW, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed 346 files in 7 inline changes, digest 2955e216b062, trunk held it exactly; spend cap set.

Returns: 5 (and 0 redirects). Cause repeats by cause: stale read 0/0, text-merge conflict 0/0, review 0/1, rule 0/0, other 0/0.

| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |
| --- | --- | --- | --- |
| stale read | 0 | n/a | n/a |
| text-merge conflict | 0 | n/a | n/a |
| review | 1 | 2 | 9 |
| rule | 0 | n/a | n/a |
| other | 0 | n/a | n/a |
| first try | 2 | 1.0 | 5.5 |

| Intent | Pull request | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden tests | Its own tests passing | Hidden files whole |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5102 | fix(trie-router): match empty wildcard remainder after regexp param | open | 1 | n/a | review 1 | 11 | $0.1110 | fail | 0 of 2 | fail (529/553) |
| #5133 | fix(request): fix multipart boundary mismatch in `cloneRawRequest` | landed | 1 | 1 |  | 7 | $0.0445 | pass | 1 of 1 | pass (39/39) |
| #5161 | fix: use `Object.create(null)` when parsing query, headers, and params | open | 0 | n/a |  | 0 | n/a | fail | 0 of 3 | fail (100/103) |
| #5164 | fix(cookie): relax name validation when parsing Cookie header | landed | 2 | 2 | review 1 | 9 | $0.0299 | pass | 2 of 2 | fail (43/46) |
| #5189 | fix(trie-router): count every slash a pattern consumes | open | 0 | n/a |  | 0 | n/a | fail | 0 of 4 | fail (539/567) |
| #4988 | fix(utils/stream): re-acquire writer lock when pipe() throws | landed | 1 | 1 |  | 4 | $0.0029 | pass | 2 of 2 | pass (11/11) |
| #5202 | fix(client): serialize multiple cookies correctly | open | 1 | n/a | review 1 | 6 | $0.0787 | fail | 0 of 1 | fail (103/104) |
| #5209 | fix(url): strip trailing question mark correctly for optional params with regex  | open | 1 | n/a | review 1 | 4 | $0.0053 | fail | 0 of 1 | fail (32/34) |
| #5215 | fix(client): send falsy JSON bodies | open | 0 | n/a |  | 0 | n/a | fail | 0 of 4 | fail (103/108) |
| #5236 | fix(trie-router): match suffix wildcard routes | open | 0 | n/a |  | 0 | n/a | fail | 0 of 6 | fail (287/296) |
| #5268 | fix(request): handle params on unmatched requests | open | 1 | n/a | review 1 | 4 | $0.0070 | fail | 0 of 1 | fail (39/41) |
| #5244 | fix(client): skip undefined header and cookie values | open | 0 | n/a |  | 1 | $0.0013 | fail | 0 of 2 | fail (103/110) |
| #5282 | fix(request): drop stale content length for cloned FormData | open | 0 | n/a |  | 0 | n/a | fail | 0 of 1 | fail (39/42) |
| #5288 | fix(request): serialize cached JSON body in cloneRawRequest | open | 0 | n/a |  | 0 | n/a | fail | 0 of 1 | fail (39/43) |
| #5246 | fix(cookie): allow parsing signed cookies with empty string values | open | 0 | n/a |  | 0 | n/a | fail | 0 of 2 | fail (72/77) |
| #5274 | fix(utils/stream): do not let abort listeners crash abort() | open | 0 | n/a |  | 0 | n/a | fail | 0 of 2 | fail (12/14) |

| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |
| --- | --- | --- | --- | --- | --- |
| 1 | -26.2 s | src/adapter/lambda-edge/handler.test.ts, src/client/types.test.ts, src/helper/factory/index.test.ts, src/helper/ssg/utils.test.ts | int_mvfjydc9s9kzos (suspect) | 11.5 s | 1 |
| 2 | 413.3 s | src/request.test.ts | #5133 (first red) | still red | 1 |

Human queue: 1 escalations, 0 held merges, 1 agent reports; 0 waiting at the end. The scripted person approved 0 and returned 1 (0 of them by the no-tests rule), asked for 1 test runs (0 refused) and dismissed 1 reports.

| At | Change | Intent | Decision | Rule | Tests run on it | Waited |
| --- | --- | --- | --- | --- | --- | --- |
| 899.9 s | prp_mvfkeiadj7xonr | #5202 | return | tests fail | ran 2328/2446 | 167.8 s |

Spend by model, with the in-platform agents on it and their calls: @cf/google/gemma-4-26b-a4b-it $0.0365 (12, 14); @cf/moonshotai/kimi-k2.7-code $0.1503 (1, 3); @cf/openai/gpt-oss-120b $0.1512 (2, 14); @cf/zai-org/glm-5.3-flash $0.0024 (1, 2); @cf/cloudflare/clef $0.0028 (0, 0). By layer: agents $0.3352, review $0.0079, judge $0.0000, resolver $0.0000, other $0.0000.

## 1 agent (colony hono-replay-solo)

Model mix `@cf/google/gemma-4-26b-a4b-it`; flags on: FT_A2A, FT_AGENT_CALL_BUDGET, FT_AGE_CAP, FT_ALREADY_ON_TRUNK, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DEFAULT_SPEND_CAP, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INHIBIT_STRONGEST, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_RED_BRAKE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_REVIEW_VIEW, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed 346 files in 7 inline changes, digest 2955e216b062; spend cap set.

Returns: 1 (and 0 redirects). Cause repeats by cause: stale read 0/0, text-merge conflict 0/0, review 0/0, rule 0/0, other 0/0.

| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |
| --- | --- | --- | --- |
| stale read | 0 | n/a | n/a |
| text-merge conflict | 0 | n/a | n/a |
| review | 0 | n/a | n/a |
| rule | 0 | n/a | n/a |
| other | 0 | n/a | n/a |
| first try | 0 | n/a | n/a |

| Intent | Pull request | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden tests | Its own tests passing | Hidden files whole |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #5102 | fix(trie-router): match empty wildcard remainder after regexp param | open | 1 | n/a | review 1 | 7 | $0.0178 | n/a | n/a | n/a |
| #5133 | fix(request): fix multipart boundary mismatch in `cloneRawRequest` | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5161 | fix: use `Object.create(null)` when parsing query, headers, and params | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5164 | fix(cookie): relax name validation when parsing Cookie header | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5189 | fix(trie-router): count every slash a pattern consumes | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #4988 | fix(utils/stream): re-acquire writer lock when pipe() throws | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5202 | fix(client): serialize multiple cookies correctly | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5209 | fix(url): strip trailing question mark correctly for optional params with regex  | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5215 | fix(client): send falsy JSON bodies | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5236 | fix(trie-router): match suffix wildcard routes | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5268 | fix(request): handle params on unmatched requests | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5244 | fix(client): skip undefined header and cookie values | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5282 | fix(request): drop stale content length for cloned FormData | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5288 | fix(request): serialize cached JSON body in cloneRawRequest | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5246 | fix(cookie): allow parsing signed cookies with empty string values | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |
| #5274 | fix(utils/stream): do not let abort listeners crash abort() | open | 0 | n/a |  | 0 | n/a | n/a | n/a | n/a |

| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |
| --- | --- | --- | --- | --- | --- |
| 1 | -25.9 s | src/adapter/lambda-edge/handler.test.ts, src/client/types.test.ts, src/helper/factory/index.test.ts, src/helper/ssg/utils.test.ts | int_mvfl78saj7xn82 (suspect) | 13.2 s | 1 |

Human queue: 0 escalations, 0 held merges, 0 agent reports; 0 waiting at the end. The scripted person approved 0 and returned 0 (0 of them by the no-tests rule), asked for 0 test runs (0 refused) and dismissed 0 reports.

Spend by model, with the in-platform agents on it and their calls: @cf/google/gemma-4-26b-a4b-it $0.0139 (1, 5); @cf/cloudflare/clef $0.0010 (0, 0); @cf/openai/gpt-oss-120b $0.0029 (0, 0). By layer: agents $0.0139, review $0.0039, judge $0.0000, resolver $0.0000, other $0.0000.

## Solo against 8 agents: transitions per intent

Each intent's outcome alone (1 agent) and among 8: first try, after returns, or not landed. Median change in rounds n/a, in model calls 2.5.

| Solo → concurrent | Intents |
| --- | --- |
| not landed -> after returns | 1 |
| not landed -> first try | 3 |
| not landed -> not landed | 12 |

## Solo against 16 agents: transitions per intent

Each intent's outcome alone (1 agent) and among 16: first try, after returns, or not landed. Median change in rounds n/a, in model calls 0.5.

| Solo → concurrent | Intents |
| --- | --- |
| not landed -> after returns | 1 |
| not landed -> first try | 2 |
| not landed -> not landed | 13 |

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
| #5236 | 2026-08-17 | fix(trie-router): match suffix wildcard routes | `src/router/trie-router/node.ts`, `src/router/trie-router/router.ts` | `src/hono.test.ts`, `src/router/trie-router/node.test.ts` | 6 |
| #5268 | 2026-08-19 | fix(request): handle params on unmatched requests | `src/request.ts` | `src/request.test.ts` | 1 |
| #5244 | 2026-08-22 | fix(client): skip undefined header and cookie values | `src/client/client.ts` | `src/client/client.test.ts` | 2 |
| #5282 | 2026-08-23 | fix(request): drop stale content length for cloned FormData | `src/request.ts` | `src/request.test.ts` | 1 |
| #5288 | 2026-08-23 | fix(request): serialize cached JSON body in cloneRawRequest | `src/request.ts` | `src/request.test.ts` | 1 |
| #5246 | 2026-08-23 | fix(cookie): allow parsing signed cookies with empty string values | `src/utils/cookie.ts` | `src/helper/cookie/index.test.ts`, `src/utils/cookie.test.ts` | 2 |
| #5274 | 2026-08-23 | fix(utils/stream): do not let abort listeners crash abort() | `src/utils/stream.ts` | `src/utils/stream.test.ts` | 2 |

Shared source files: `src/client/client.ts` (#5202, #5215, #5244); `src/request.ts` (#5133, #5161, #5268, #5282, #5288); `src/router/trie-router/node.ts` (#5102, #5189, #5236); `src/utils/cookie.ts` (#5164, #5246); `src/utils/stream.ts` (#4988, #5274); `src/utils/url.ts` (#5161, #5209).

The seed is B's tree, 346 files, but for 79 under benchmarks/, 1 over the 256 KiB inline limit, 6 under docs/images/, 12 under perf-measures/, 46 under runtime-tests/: those stay in the scratch worktree the grade runs in.

## What this does not measure

- One repository and one stretch of its history; the numbers are one contended point on real code, not a curve.
- The person is a script: it approves what passes the visible tests and returns what fails them, which a careful reviewer would not always do.
- Model calls are what this platform counted for the colony (agents, review, the resolver, the judge). The grade is real vitest on Node with B's dependencies, outside the platform.
- The pull requests were merged upstream; their descriptions are what each intent says, and a description can say less than the change did.
- Models answer differently between runs: a second run of the same command will not give the same numbers.
