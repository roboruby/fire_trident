# Contention at scale (2026-10-19)

<!-- measured -->
MEASURED on staging.firetrident.com (build 21c534d), 2026-10-19: what happens when hundreds of agents edit the same files at the same time, with every result checked against the final trunk afterwards.

Real landings: synthetic agents (no model) on a generated TypeScript repository whose hot files every agent edits; each intent placed with its agent (assignedTo), every change an inline change built from the hot file read at its lease's base with stock git, redone against the current trunk whenever it comes back.

## The workload

A generated TypeScript repository seeded into a fresh colony per run: 10 hot files (`hot/h00/state.ts` and so on: a registry of 32 names, one a line, 4 counters and three functions each) and 400 modules (`mods/g00/mod_0000.ts` and so on, one constant per hot file each), with a `node:test` file that imports every file and asserts no registry holds a name twice. Seed 1. The tasks, mixed and shuffled:

- **register**: insert one new name into a hot file's registry where it sorts, so concurrent inserts land on nearby lines. Correct: every landed name appears exactly once.
- **increment**: add exactly 1 to one counter of a hot file (read the value, write it plus one). Two increments of one counter cannot both apply to the same base. Correct: each counter equals the increments that landed on it; a lost update (two landed, the value rose by one) fails the run.
- **read-own**: read a hot file and write only the task's own module, copying the registry's length into a constant. Such a change may land only if what it read is still current. Correct: the constant equals the registry's length on the trunk its landing was built on.

Each intent is declared already claimed by the agent that does it (`assignedTo`), so hundreds of agents hold intents on the same hot file at once. The agent takes it (a lease on the current trunk), reads the files at the lease's base with stock git, makes the edit and proposes it as an inline change whose read set is what it read. When the change comes back it declares the same work again with itself, takes it on a fresh lease of the current trunk, reads again and redoes the edit. A change closed as already on trunk is not redone, as the agent guides say. Review is off (no model is called).

## Commands

```
node packages/bench/src/scenarios/contention-scale.ts --base https://staging.firetrident.com --scenario contention-scale --agents 200 --intents 600
```

```
node packages/bench/src/scenarios/contention-scale.ts --base https://staging.firetrident.com --scenario contention-scale --agents 1000 --intents 3000
```

## Flags the deployment had

- 200 agents (build 21c534d): `FT_A2A`, `FT_ACCOUNTS`, `FT_AGENT_CALL_BUDGET`, `FT_AGE_CAP`, `FT_ALREADY_ON_TRUNK`, `FT_BISECT`, `FT_CREDIT_TRAILERS`, `FT_CULPRITS`, `FT_DEFAULT_SPEND_CAP`, `FT_DELETION_GUARD`, `FT_ESCALATION_BATCH`, `FT_FIELD_GUIDE`, `FT_GOAL_CONFLICT`, `FT_HEADS_UP`, `FT_HEDGE`, `FT_INHIBIT_STRONGEST`, `FT_INLINE`, `FT_INTENT_SPEND`, `FT_LESSON_SCOPE`, `FT_MERGE_INSERTIONS`, `FT_MODEL_STEPUP`, `FT_PERSON_WAIT`, `FT_PRELAND`, `FT_PUBLIC_GIT`, `FT_PUBLIC_MCP`, `FT_QUOTED_ACCEPTANCE`, `FT_RED_BRAKE`, `FT_REPRODUCE`, `FT_RESOLVER`, `FT_RETURN_HUNKS`, `FT_REVIEW_VIEW`, `FT_TEXT_MERGE`, `FT_TRUNK_TESTS`, `FT_TWINS`, `FT_VIRTUAL_CHECKOUT`
- 1,000 agents (build 21c534d): `FT_A2A`, `FT_ACCOUNTS`, `FT_AGENT_CALL_BUDGET`, `FT_AGE_CAP`, `FT_ALREADY_ON_TRUNK`, `FT_BISECT`, `FT_CREDIT_TRAILERS`, `FT_CULPRITS`, `FT_DEFAULT_SPEND_CAP`, `FT_DELETION_GUARD`, `FT_ESCALATION_BATCH`, `FT_FIELD_GUIDE`, `FT_GOAL_CONFLICT`, `FT_HEADS_UP`, `FT_HEDGE`, `FT_INHIBIT_STRONGEST`, `FT_INLINE`, `FT_INTENT_SPEND`, `FT_LESSON_SCOPE`, `FT_MERGE_INSERTIONS`, `FT_MODEL_STEPUP`, `FT_PERSON_WAIT`, `FT_PRELAND`, `FT_PUBLIC_GIT`, `FT_PUBLIC_MCP`, `FT_QUOTED_ACCEPTANCE`, `FT_RED_BRAKE`, `FT_REPRODUCE`, `FT_RESOLVER`, `FT_RETURN_HUNKS`, `FT_REVIEW_VIEW`, `FT_TEXT_MERGE`, `FT_TRUNK_TESTS`, `FT_TWINS`, `FT_VIRTUAL_CHECKOUT`

`/api/about` lists a flag that is on for every colony or for some listed colonies, without saying which; the run's own numbers below (merges by the insertion rule, returns by cause) show what applied to its colony.

## Results

| Measure | 200 agents | 1,000 agents |
| --- | --- | --- |
| Tasks (register / increment / read-own) | 600 (200 / 200 / 200) | 3,000 (1,000 / 1,000 / 1,000) |
| Agents joined | 200 | 1,000 |
| Tasks landed | 584 of 600 | 1,346 of 3,000 |
| How the rest ended | unresolved 16 | unresolved 720, not-started 934 |
| Proposals (landed) | 1,910 (584) | 4,775 (1,346) |
| Trunk commits whose lineage note names them | 560 | 1,194 |
| Landings a minute (trunk commits), first to last landing | 29.1 | 37.7 |
| Changes landed a minute | 30.4 | 42.5 |
| Propose to landed, p50 / p95 | 14.3 s / 52.5 s | 30.4 s / 841.5 s |
| A task's first proposal to landed, rounds included, p50 / p95 | 26.0 s / 181.6 s | 93.4 s / 860.1 s |
| Changes that came back | 1,326 | 3,186 |
| … for a stale read (a file it read had moved) | 1,326 | 3,185 |
| … for a text-merge conflict | 0 | 1 |
| … sent back by review | 0 | 0 |
| … for a megafile hold | 0 | 0 |
| … for any other reason | 0 | 0 |
| … register / increment / read-own | 0 / 321 / 1,005 | 0 / 741 / 2,445 |
| Rounds to land, median / p95 / max | 1 / 12 / 25 | 1 / 8 / 17 |
| Changes merged line by line (files; by the insertion rule) | 373 (373; 17) | 797 (797; 171) |
| Agents holding an intent at once, peak | 200 | 991 |
| Intents on one hot file held at once, peak | 36 | 122 |
| Takes that lost their assignment (declared again) | 18 | 6,524 |
| Wall time of the agents | 1801.1 s | 1861.9 s |

## Correctness, from the final trunk

Read with stock git from the colony's trunk after the run: the final tree, main's first-parent history and the lineage notes under `refs/notes/firetrident`, which name the proposals each commit landed.

| Check | 200 agents | 1,000 agents |
| --- | --- | --- |
| every file parses | PASS | PASS |
| registry entries appear exactly once | PASS | PASS |
| every counter equals its landed increments | PASS | PASS |
| no increment was closed as already on trunk | PASS | PASS |
| every read-own constant matches the trunk it landed on | PASS | PASS |
| the agents' outcomes agree with the lineage notes | PASS | FAIL |

### 200 agents

- **PASS** every file parses: 413 files at c193400309f4: all parse; the tree holds the seeded files and no others.
- **PASS** registry entries appear exactly once: 200 landed register tasks: 0 duplicated, 0 missing, 0 present without a landing, 0 seed entries gone, 0 unknown.
- **PASS** every counter equals its landed increments: 40 counters, 199 landed increments, counters adding up to 199: 0 lost updates, 0 counted twice.
- **PASS** no increment was closed as already on trunk: No increment came back as already on trunk.
- **PASS** every read-own constant matches the trunk it landed on: 185 landed read-own changes: 0 constants differ from the registry they landed on, 0 landed on a version they did not read, 0 landed behind a writer of their file in the same commit, 0 set without a landing.
- **PASS** the agents' outcomes agree with the lineage notes: 584 proposals reported landed, 584 proposals of this run in the notes: 0 reported landed but not in a note, 0 in a note but reported otherwise, 0 tasks landed twice.
- Counters, value/landed increments: `hot/h00/state.ts` 6/6 10/10 8/8 5/5; `hot/h01/state.ts` 4/4 6/6 5/5 2/2; `hot/h02/state.ts` 3/3 3/3 5/5 7/7; `hot/h03/state.ts` 2/2 5/5 10/10 7/7; `hot/h04/state.ts` 2/2 5/5 4/4 5/5; `hot/h05/state.ts` 7/7 5/5 3/3 3/3; `hot/h06/state.ts` 6/6 8/8 5/5 5/5; `hot/h07/state.ts` 5/5 4/4 3/3 9/9; `hot/h08/state.ts` 4/4 8/8 6/6 1/1; `hot/h09/state.ts` 3/3 3/3 4/4 3/3

### 1,000 agents

- **PASS** every file parses: 413 files at ee8510282465: all parse; the tree holds the seeded files and no others.
- **PASS** registry entries appear exactly once: 617 landed register tasks: 0 duplicated, 0 missing, 0 present without a landing, 0 seed entries gone, 0 unknown.
- **PASS** every counter equals its landed increments: 40 counters, 156 landed increments, counters adding up to 156: 0 lost updates, 0 counted twice.
- **PASS** no increment was closed as already on trunk: No increment came back as already on trunk.
- **PASS** every read-own constant matches the trunk it landed on: 575 landed read-own changes: 0 constants differ from the registry they landed on, 0 landed on a version they did not read, 0 landed behind a writer of their file in the same commit, 0 set without a landing.
- **FAIL** the agents' outcomes agree with the lineage notes: 1,346 proposals reported landed, 1,348 proposals of this run in the notes: 0 reported landed but not in a note, 2 in a note but reported otherwise, 0 tasks landed twice.
  - proposal prp_mvfsl6yfa3kcen (task t01849) is in landing ee8510282465's note but its agent was told ready
  - proposal prp_mvfskkymlibcyt (task t01707) is in landing 824d06df8e96's note but its agent was told ready
- Counters, value/landed increments: `hot/h00/state.ts` 4/4 4/4 3/3 2/2; `hot/h01/state.ts` 3/3 4/4 4/4 4/4; `hot/h02/state.ts` 5/5 3/3 4/4 4/4; `hot/h03/state.ts` 3/3 4/4 4/4 4/4; `hot/h04/state.ts` 5/5 5/5 5/5 4/4; `hot/h05/state.ts` 4/4 4/4 4/4 4/4; `hot/h06/state.ts` 3/3 3/3 4/4 5/5; `hot/h07/state.ts` 3/3 4/4 5/5 4/4; `hot/h08/state.ts` 3/3 4/4 5/5 5/5; `hot/h09/state.ts` 4/4 3/3 3/3 4/4

## Honest limits

- Synthetic agents make scripted edits with no model and run no tests: this measures the platform's landing path under contention (read-set validation, text merge, group commit, the lineage record), not agents' judgment or review.
- Every intent is placed with its agent (`assignedTo`), which goes past admission and the claim-lease exclusion that normally keep agents from holding intents on the same file at once. The run measures what happens when changes collide, not how often they would collide in normal operation.
- A change that comes back reopens its intent; the agent declares the same work again as a new intent with itself, and the reopened intent is left open with no agent taking it (the colony's intent counts include those).
- Agents read the hot files at their lease's base from a stock git mirror, fetched as the trunk moves; the fetch time adds to the time between take and propose.
- One generated repository shape, one deployment, and every agent run from one machine. Review was off; certification ran as the deployment has it.
- Inside one landing commit, the order the trunk writer applied its proposals is taken from the order of the lineage note.

