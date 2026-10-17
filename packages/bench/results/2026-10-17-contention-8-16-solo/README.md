# Contention smoke test: 8 agents, 16 agents, 1 agent on one shared module

MEASURED on https://staging.firetrident.com (build 9803729), 2026-10-17: in-platform agents calling real models, review on, the project's node:test tests certified on trunk. The workload is `demo/contention/spec.md`: a 20-file TypeScript seed whose sixteen intents (source human, equal priority) all change `src/core/money.ts` as well as their own module, three of them change a signature in it, and four intents are built on the old signatures (the designed semantic-conflict pairs). Each run started on its own fresh colony from the same seed and intents.

Operator's note: FT_LATERAL_INHIBITION=off, FT_MEGAFILE=off (staging deploy overrides); FT_PERSON_WAIT on

```sh
ruby scripts/contention.rb --base https://staging.firetrident.com --sweep 8,16 --solo --note 'FT_LATERAL_INHIBITION=off, FT_MEGAFILE=off (staging deploy overrides); FT_PERSON_WAIT on'
```

Every intent writes the shared module, and the take path keeps an agent off an intent whose files another agent holds (lateral inhibition, on unless the deployment sets `FT_LATERAL_INHIBITION=off`, which `/api/about` does not show). The row "Intents held at once" says whether the agents contended: a peak of 1 with many agents means they were held to one intent at a time.

Written by `scripts/contention.rb` (numbers: `scripts/contention_report.rb`, whose header defines each one) and copied through `packages/bench/src/evidence.ts redact`. Files: `contention.json` (every number), `run-<n>.json` (each run's record: events, certifications, proposals, agents), `run.log`.

## Runs side by side

| Measure | 8 agents | 16 agents | 1 agent |
| --- | --- | --- | --- |
| Models | kimi-k2.7-code×1, glm-5.3-flash×1, gpt-oss-120b×2, gemma-4-26b-a4b-it×4 | kimi-k2.7-code×1, glm-5.3-flash×1, gpt-oss-120b×2, gemma-4-26b-a4b-it×12 | gemma-4-26b-a4b-it×1 |
| Review | on (reflex clef) | on (reflex clef) | on (reflex clef) |
| How the run ended | timeout: 14/16 intents landed after 2400 s | stall: nothing landed for 900 s (14/16 landed); stalled: 2 changes wait for a person in the review queue; trunk is red at 0798db0 (20 failing); agents: 16 waiting, 1 dead, 10 waiting on their own changes | timeout: 7/16 intents landed after 2400 s |
| Stalled (no intent moved, intents open) | 2 reports, longest 605.5 s: 2 changes wait for a person in the review queue; trunk is red at 11a231d (13 failing); agents: 8 waiting, 7 waiting on their own changes | 3 reports, longest 902.7 s: 2 changes wait for a person in the review queue; trunk is red at 0798db0 (20 failing); agents: 16 waiting, 1 dead, 10 waiting on their own changes | 1 report, longest 304.1 s: 1 change waits for a person in the review queue; trunk is red at 5e0c885 (2 failing); claims on the open intents' files: src/core/money.ts claim 1.0 (need 52.0); agents: 1 working |
| Intents landed | 14 of 16 | 14 of 16 | 7 of 16 |
| Intents held at once, peak (mean) | 6 (3.49) | 7 (3.61) | 3 (1.70) |
| Intents the colony or agents declared | none | none | none |
| Wall time, release to the last landing | not all landed (last at 1596.7 s) | not all landed (last at 1364.1 s) | not all landed (last at 2232.5 s) |
| Release to green after the last landing | n/a | n/a | n/a |
| Proposals (landed) | 23 (14) | 21 (14) | 10 (7) |
| Returned: stale read | 0 | 0 | 0 |
| Returned: text-merge conflict | 0 | 1 | 0 |
| Returned: review | 7 | 4 | 1 |
| Returned: rule | 0 | 0 | 0 |
| Returned: other | 0 | 0 | 0 |
| Cause-repeat rate | 33% (2/6) | 0% (0/5) | 0% (0/1) |
| Rounds to land, median (max) | 1.0 (3) | 1.0 (3) | 1 (2) |
| Model calls to land, median | 8.0 | 9.5 | 10 |
| Semantic-conflict pairs landed | 0 | 0 | 0 |
| Designed pairs found red | 0 of 4 | 0 of 4 | 0 of 4 |
| Red-trunk episodes (open at the end) | 1 (1) | 1 (1) | 2 (1) |
| Time to green, median (max) | n/a (n/a) | n/a (n/a) | 658.9 s (658.9 s) |
| Repair intents declared (landed) | 1 (0) | 1 (0) | 2 (1) |
| Human queue: escalations, held merges, agent reports | 2, 0, 1 | 2, 0, 1 | 2, 0, 1 |
| Time in the human queue, median (max) | 1829.1 s (2198.9 s) | 2104.6 s (2184.0 s) | 536.1 s (1919.3 s) |
| Model calls: agents (review) | 108 (46) | 122 (42) | 86 (20) |
| Model spend this platform made | $0.3663 | $0.3345 | $0.1480 |
| Spend per landed intent | $0.0262 | $0.0239 | $0.0211 |
| Hidden acceptance tests passed | 12 of 16 intents | 11 of 16 intents | 6 of 16 intents |

## 8 agents (colony contention-1017-101855-8)

Model mix `@cf/moonshotai/kimi-k2.7-code=1,@cf/zai-org/glm-5.3-flash=1,@cf/openai/gpt-oss-120b=2,@cf/google/gemma-4-26b-a4b-it`; flags on: FT_A2A, FT_AGENT_CALL_BUDGET, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed 20 files, 23 tests, digest 4ff227736e2f; spend cap set.

Returns: 7 (and 0 redirects). Cause repeats by cause: stale read 0/0, text-merge conflict 0/0, review 2/6, rule 0/0, other 0/0.

| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |
| --- | --- | --- | --- |
| stale read | 0 | n/a | n/a |
| text-merge conflict | 0 | n/a | n/a |
| review | 4 | 2.5 | 14.0 |
| rule | 0 | n/a | n/a |
| other | 0 | n/a | n/a |
| first try | 10 | 1.0 | 6.0 |

| Intent | Change | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| split | adds | landed | 1 | 1 |  | 5 | $0.0346 | pass |
| free-shipping | adds | landed | 3 | 3 | review 2 | 23 | $0.1238 | pass |
| refund | adds | landed | 1 | 1 |  | 8 | $0.0053 | pass |
| fx | adds | landed | 1 | 1 |  | 6 | $0.0103 | pass |
| format-options | signature | proposed | 1 | n/a |  | 6 | $0.0098 | fail |
| csv | adds | landed | 2 | 2 | review 1 | 11 | $0.0151 | pass |
| parse-options | signature | proposed | 2 | n/a | review 1 | 11 | $0.0222 | fail |
| import | adds | landed | 1 | 1 |  | 6 | $0.0063 | fail |
| basis-points | signature | landed | 1 | 1 |  | 6 | $0.0056 | pass |
| tips | adds | landed | 3 | 3 | review 2 | 16 | $0.0453 | pass |
| late-fee | adds | landed | 1 | 1 |  | 8 | $0.0165 | pass |
| loyalty | adds | landed | 1 | 1 |  | 5 | $0.0031 | pass |
| gift-card | adds | landed | 2 | 2 | review 1 | 12 | $0.0109 | pass |
| currency-symbols | behavior | landed | 1 | 1 |  | 5 | $0.0086 | pass |
| rounding | behavior | landed | 1 | 1 |  | 9 | $0.0107 | pass |
| price-range | adds | landed | 1 | 1 |  | 16 | $0.0250 | fail |

| Designed pair | Landed second | Second built before the first landed | Next certification | Found as a pair | Hidden tests (first, second) |
| --- | --- | --- | --- | --- | --- |
| format-options → csv | format-options did not land | n/a | n/a | n/a | fail, pass |
| parse-options → import | parse-options did not land | n/a | n/a | n/a | fail, fail |
| basis-points → tips | tips | no | red | no | pass, pass |
| basis-points → late-fee | late-fee | no | red | no | pass, pass |

| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |
| --- | --- | --- | --- | --- | --- |
| 1 | 378.2 s | test/refund.test.ts | refund (first red) | still red | 11 |

Spend by model, with the in-platform agents on it and their calls: @cf/google/gemma-4-26b-a4b-it $0.0459 (4, 49); @cf/moonshotai/kimi-k2.7-code $0.1770 (1, 14); @cf/openai/gpt-oss-120b $0.1212 (2, 39); @cf/zai-org/glm-5.3-flash $0.0061 (1, 6); @cf/cloudflare/clef $0.0136 (0, 0); @cf/zai-org/glm-4.7-flash $0.0025 (0, 0). By layer: agents $0.3250, review $0.0413, judge $0.0000, resolver $0.0000, other $0.0000.

## 16 agents (colony contention-1017-101855-16)

Model mix `@cf/moonshotai/kimi-k2.7-code=1,@cf/zai-org/glm-5.3-flash=1,@cf/openai/gpt-oss-120b=2,@cf/google/gemma-4-26b-a4b-it`; flags on: FT_A2A, FT_AGENT_CALL_BUDGET, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed 20 files, 23 tests, digest 4ff227736e2f; spend cap set.

Returns: 5 (and 0 redirects). Cause repeats by cause: stale read 0/0, text-merge conflict 0/1, review 0/4, rule 0/0, other 0/0.

| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |
| --- | --- | --- | --- |
| stale read | 0 | n/a | n/a |
| text-merge conflict | 1 | 3 | 27 |
| review | 4 | 2.0 | 16.5 |
| rule | 0 | n/a | n/a |
| other | 0 | n/a | n/a |
| first try | 10 | 1.0 | 7.0 |

| Intent | Change | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| split | adds | landed | 1 | 1 |  | 5 | $0.0427 | pass |
| free-shipping | adds | proposed | 1 | n/a |  | 5 | $0.0034 | fail |
| refund | adds | landed | 1 | 1 |  | 12 | $0.0080 | pass |
| fx | adds | proposed | 1 | n/a |  | 6 | $0.0035 | fail |
| format-options | signature | landed | 1 | 1 |  | 9 | $0.0052 | pass |
| csv | adds | landed | 1 | 1 |  | 7 | $0.0074 | pass |
| parse-options | signature | landed | 2 | 2 | review 1 | 10 | $0.0117 | fail |
| import | adds | landed | 1 | 1 |  | 11 | $0.0088 | fail |
| basis-points | signature | landed | 1 | 1 |  | 7 | $0.0049 | pass |
| tips | adds | landed | 1 | 1 |  | 13 | $0.0095 | fail |
| late-fee | adds | landed | 3 | 3 | text-merge conflict 1, review 1 | 27 | $0.0933 | pass |
| loyalty | adds | landed | 1 | 1 |  | 7 | $0.0423 | pass |
| gift-card | adds | landed | 1 | 1 |  | 6 | $0.0039 | pass |
| currency-symbols | behavior | landed | 1 | 1 |  | 5 | $0.0039 | pass |
| rounding | behavior | landed | 2 | 2 | review 1 | 11 | $0.0103 | pass |
| price-range | adds | landed | 2 | 2 | review 1 | 22 | $0.0464 | pass |

| Designed pair | Landed second | Second built before the first landed | Next certification | Found as a pair | Hidden tests (first, second) |
| --- | --- | --- | --- | --- | --- |
| format-options → csv | csv | no | red | no | pass, pass |
| parse-options → import | parse-options | yes | red | no | fail, fail |
| basis-points → tips | basis-points | no | red | no | pass, fail |
| basis-points → late-fee | late-fee | no | red | no | pass, pass |

| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |
| --- | --- | --- | --- | --- | --- |
| 1 | 336.0 s | test/giftcard.test.ts | gift-card (first red) | still red | 11 |

Spend by model, with the in-platform agents on it and their calls: @cf/google/gemma-4-26b-a4b-it $0.0723 (12, 84); @cf/moonshotai/kimi-k2.7-code $0.1830 (2, 14); @cf/openai/gpt-oss-120b $0.0477 (2, 11); @cf/zai-org/glm-5.3-flash $0.0141 (1, 13); @cf/cloudflare/clef $0.0129 (0, 0); @cf/zai-org/glm-4.7-flash $0.0046 (0, 0). By layer: agents $0.2837, review $0.0313, judge $0.0000, resolver $0.0196, other $0.0000.

## 1 agent (colony contention-1017-101855-solo)

Model mix `@cf/google/gemma-4-26b-a4b-it`; flags on: FT_A2A, FT_AGENT_CALL_BUDGET, FT_BISECT, FT_CREDIT_TRAILERS, FT_CULPRITS, FT_DELETION_GUARD, FT_ESCALATION_BATCH, FT_FIELD_GUIDE, FT_GOAL_CONFLICT, FT_HEADS_UP, FT_HEDGE, FT_INLINE, FT_INTENT_SPEND, FT_LESSON_SCOPE, FT_MERGE_INSERTIONS, FT_MODEL_STEPUP, FT_PERSON_WAIT, FT_PUBLIC_GIT, FT_PUBLIC_MCP, FT_QUOTED_ACCEPTANCE, FT_REPRODUCE, FT_RESOLVER, FT_RETURN_HUNKS, FT_TEXT_MERGE, FT_TRUNK_TESTS, FT_TWINS, FT_VIRTUAL_CHECKOUT; seed 20 files, 23 tests, digest 4ff227736e2f; spend cap set.

Returns: 1 (and 0 redirects). Cause repeats by cause: stale read 0/0, text-merge conflict 0/0, review 0/1, rule 0/0, other 0/0.

| Rounds and calls to land, by cause | Intents | Median rounds | Median calls |
| --- | --- | --- | --- |
| stale read | 0 | n/a | n/a |
| text-merge conflict | 0 | n/a | n/a |
| review | 1 | 2 | 11 |
| rule | 0 | n/a | n/a |
| other | 0 | n/a | n/a |
| first try | 6 | 1.0 | 10.0 |

| Intent | Change | Status | Proposals | Rounds | Returns | Model calls | Spend | Hidden test |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| split | adds | proposed | 1 | n/a |  | 22 | $0.0186 | fail |
| free-shipping | adds | landed | 1 | 1 |  | 5 | $0.0026 | pass |
| refund | adds | landed | 1 | 1 |  | 11 | $0.0071 | pass |
| fx | adds | landed | 1 | 1 |  | 10 | $0.0068 | pass |
| format-options | signature | landed | 1 | 1 |  | 10 | $0.0061 | pass |
| csv | adds | landed | 1 | 1 |  | 11 | $0.0081 | pass |
| parse-options | signature | proposed | 1 | n/a |  | 6 | $0.0040 | fail |
| import | adds | landed | 2 | 2 | review 1 | 11 | $0.0103 | fail |
| basis-points | signature | landed | 1 | 1 |  | 6 | $0.0033 | pass |
| tips | adds | open | 0 | n/a |  | 8 | $0.0058 | fail |
| late-fee | adds | open | 0 | n/a |  | 0 | n/a | fail |
| loyalty | adds | open | 0 | n/a |  | 0 | n/a | fail |
| gift-card | adds | open | 0 | n/a |  | 0 | n/a | fail |
| currency-symbols | behavior | open | 0 | n/a |  | 0 | n/a | fail |
| rounding | behavior | open | 0 | n/a |  | 0 | n/a | fail |
| price-range | adds | open | 0 | n/a |  | 0 | n/a | fail |

| Designed pair | Landed second | Second built before the first landed | Next certification | Found as a pair | Hidden tests (first, second) |
| --- | --- | --- | --- | --- | --- |
| format-options → csv | csv | no | red | no | pass, pass |
| parse-options → import | parse-options did not land | n/a | n/a | n/a | fail, fail |
| basis-points → tips | tips did not land | n/a | n/a | n/a | pass, fail |
| basis-points → late-fee | late-fee did not land | n/a | n/a | n/a | pass, fail |

| Red episode | Red at | Failing files | Culprit | Time to green | Landings during |
| --- | --- | --- | --- | --- | --- |
| 1 | 630.6 s | test/free-shipping.test.ts | free-shipping (first red) | 658.9 s | 2 |
| 2 | 1617.2 s | test/format-options.test.ts | format-options (first red) | still red | 3 |

Spend by model, with the in-platform agents on it and their calls: @cf/google/gemma-4-26b-a4b-it $0.0589 (1, 81); @cf/moonshotai/kimi-k2.7-code $0.0747 (0, 5); @cf/cloudflare/clef $0.0066 (0, 0); @cf/openai/gpt-oss-120b $0.0028 (0, 0); @cf/zai-org/glm-4.7-flash $0.0050 (0, 0). By layer: agents $0.1336, review $0.0144, judge $0.0000, resolver $0.0000, other $0.0000.

## Solo against 8 agents: transitions per intent

Each intent's outcome alone (1 agent) and among 8: first try, after returns, or not landed. Median change in rounds 0.0, in model calls 5.0.

| Solo → concurrent | Intents |
| --- | --- |
| after returns -> first try | 1 |
| first try -> after returns | 2 |
| first try -> first try | 3 |
| first try -> not landed | 1 |
| not landed -> after returns | 2 |
| not landed -> first try | 6 |
| not landed -> not landed | 1 |

Hidden tests, solo → concurrent: fail -> fail 3, fail -> pass 7, pass -> fail 1, pass -> pass 5.

## Solo against 16 agents: transitions per intent

Each intent's outcome alone (1 agent) and among 16: first try, after returns, or not landed. Median change in rounds 0, in model calls 2.5.

| Solo → concurrent | Intents |
| --- | --- |
| after returns -> first try | 1 |
| first try -> first try | 4 |
| first try -> not landed | 2 |
| not landed -> after returns | 4 |
| not landed -> first try | 5 |

Hidden tests, solo → concurrent: fail -> fail 3, fail -> pass 7, pass -> fail 2, pass -> pass 4.

## What this does not measure

- One small repository and one workload; the numbers are a first contended point, not a curve.
- Model calls are what this platform counted for the colony (agents, review, the resolver, the judge); the hidden-test grade is from the colony's own certification of the graded trunk.
- Models answer differently between runs: a second run of the same command will not give the same numbers.
