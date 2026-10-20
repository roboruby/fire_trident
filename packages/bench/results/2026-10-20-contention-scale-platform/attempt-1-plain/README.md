# Contention at scale (2026-10-20)

<!-- measured -->
MEASURED on staging.firetrident.com (build 9f00539), 2026-10-20: what happens when hundreds of agents edit the same files at the same time, with every result checked against the final trunk afterwards.

Real landings: synthetic agents (no model) on a generated TypeScript repository whose hot files every agent edits; each intent placed with its agent (assignedTo), every change an inline change built from the hot file read at its lease's base with stock git, redone against the current trunk whenever it comes back.

## The workload

A generated TypeScript repository seeded into a fresh colony per run: 10 hot files (`hot/h00/state.ts` and so on: a registry of 32 names, one a line, 4 counters and three functions each) and 400 modules (`mods/g00/mod_0000.ts` and so on, one constant per hot file each), with a `node:test` file that imports every file and asserts no registry holds a name twice. Seed 1. The tasks, mixed and shuffled:

- **register**: insert one new name into a hot file's registry where it sorts, so concurrent inserts land on nearby lines. Correct: every landed name appears exactly once.
- **increment**: add exactly 1 to one counter of a hot file (read the value, write it plus one). Two increments of one counter cannot both apply to the same base. Correct: each counter equals the increments that landed on it; a lost update (two landed, the value rose by one) fails the run.
- **read-own**: read a hot file and write only the task's own module, copying the registry's length into a constant. Such a change may land only if what it read is still current. Correct: the constant equals the registry's length on the trunk its landing was built on.

Each intent is declared already claimed by the agent that does it (`assignedTo`), so hundreds of agents hold intents on the same hot file at once. The agent takes it (a lease on the current trunk), reads the files at the lease's base with stock git, makes the edit and proposes it as an inline change whose read set is what it read. When the change comes back it declares the same work again with itself, takes it on a fresh lease of the current trunk, reads again and redoes the edit. A change closed as already on trunk is not redone, as the agent guides say. Review is off (no model is called).

## Commands

```
node packages/bench/src/scenarios/contention-scale.ts --base https://staging.firetrident.com --scenario contention-scale --agents 1000 --intents 3000 --out /data/results/platform
```

## Flags the deployment had

- 1,000 agents (build 9f00539): `FT_A2A`, `FT_ACCOUNTS`, `FT_AGENT_CALL_BUDGET`, `FT_AGE_CAP`, `FT_ALREADY_ON_TRUNK`, `FT_BISECT`, `FT_CREDIT_TRAILERS`, `FT_CULPRITS`, `FT_DEFAULT_SPEND_CAP`, `FT_DELETION_GUARD`, `FT_ESCALATION_BATCH`, `FT_FIELD_GUIDE`, `FT_GOAL_CONFLICT`, `FT_HEADS_UP`, `FT_HEDGE`, `FT_INHIBIT_STRONGEST`, `FT_INLINE`, `FT_INTENT_SPEND`, `FT_LESSON_SCOPE`, `FT_MEGAFILE`, `FT_MERGE_INSERTIONS`, `FT_MODEL_STEPUP`, `FT_PERSON_WAIT`, `FT_PRELAND`, `FT_PUBLIC_GIT`, `FT_PUBLIC_MCP`, `FT_QUOTED_ACCEPTANCE`, `FT_RED_BRAKE`, `FT_REPRODUCE`, `FT_RESOLVER`, `FT_RETURN_HUNKS`, `FT_REVIEW_VIEW`, `FT_TEXT_MERGE`, `FT_TRUNK_TESTS`, `FT_TWINS`, `FT_VIRTUAL_CHECKOUT`

`/api/about` lists a flag that is on for every colony or for some listed colonies, without saying which; the run's own numbers below (merges by the insertion rule, returns by cause) show what applied to its colony.

## Results

| Measure | 1,000 agents |
| --- | --- |
| Tasks (register / increment / read-own) | 3,000 (1,000 / 1,000 / 1,000) |
| Agents joined | 969 |
| Tasks landed | 129 of 3,000 |
| How the rest ended | unresolved 870, not-started 2,001 |
| Proposals (landed) | 351 (129) |
| Trunk commits whose lineage note names them | 130 |
| Landings a minute (trunk commits), first to last landing | 168.9 |
| Changes landed a minute | 168.9 |
| Propose to landed, p50 / p95 | 17.9 s / 30.7 s |
| A task's first proposal to landed, rounds included, p50 / p95 | 17.9 s / 30.7 s |
| Changes that came back | 222 |
| … for a stale read (a file it read had moved) | 191 |
| … for a text-merge conflict | 0 |
| … sent back by review | 0 |
| … for a megafile hold | 31 |
| … for any other reason | 0 |
| … register / increment / read-own | 13 / 62 / 147 |
| Rounds to land, median / p95 / max | 1 / 1 / 1 |
| Changes merged line by line (files; by the insertion rule) | 114 (114; 8) |
| Agents holding an intent at once, peak | 230 |
| Intents on one hot file held at once, peak | 31 |
| Takes that lost their assignment (declared again) | 635 |
| Wall time of the agents | 48.8 s |

## Correctness, from the final trunk

Read with stock git from the colony's trunk after the run: the final tree, main's first-parent history and the lineage notes under `refs/notes/firetrident`, which name the proposals each commit landed.

| Check | 1,000 agents |
| --- | --- |
| every file parses | PASS |
| registry entries appear exactly once | PASS |
| every counter equals its landed increments | PASS |
| no increment was closed as already on trunk | PASS |
| every read-own constant matches the trunk it landed on | PASS |
| the agents' outcomes agree with the lineage notes | FAIL |

### 1,000 agents

- **PASS** every file parses: 413 files at 72a78ae62ad8: all parse; the tree holds the seeded files and no others.
- **PASS** registry entries appear exactly once: 79 landed register tasks: 0 duplicated, 0 missing, 0 present without a landing, 0 seed entries gone, 0 unknown.
- **PASS** every counter equals its landed increments: 40 counters, 45 landed increments, counters adding up to 45: 0 lost updates, 0 counted twice.
- **PASS** no increment was closed as already on trunk: No increment came back as already on trunk.
- **PASS** every read-own constant matches the trunk it landed on: 6 landed read-own changes: 0 constants differ from the registry they landed on, 0 landed on a version they did not read, 0 landed behind a writer of their file in the same commit, 0 set without a landing.
- **FAIL** the agents' outcomes agree with the lineage notes: 129 proposals reported landed, 130 proposals of this run in the notes: 0 reported landed but not in a note, 1 in a note but reported otherwise, 0 tasks landed twice.
  - proposal prp_mvg1anlno38mwx (task t00819) is in landing a149621eeae5's note but its agent was told returned: hot/h07/state.ts is being split by intent int_mvg1b2pdl692qr; take again after it lands
- Counters, value/landed increments: `hot/h00/state.ts` 2/2 2/2 2/2 1/1; `hot/h01/state.ts` 1/1 2/2 1/1 1/1; `hot/h02/state.ts` 1/1 1/1 1/1 1/1; `hot/h03/state.ts` 0/0 1/1 1/1 1/1; `hot/h04/state.ts` 1/1 2/2 1/1 1/1; `hot/h05/state.ts` 1/1 1/1 1/1 2/2; `hot/h06/state.ts` 0/0 0/0 1/1 1/1; `hot/h07/state.ts` 1/1 1/1 1/1 1/1; `hot/h08/state.ts` 1/1 1/1 2/2 2/2; `hot/h09/state.ts` 1/1 1/1 1/1 1/1

## Honest limits

- Synthetic agents make scripted edits with no model and run no tests: this measures the platform's landing path under contention (read-set validation, text merge, group commit, the lineage record), not agents' judgment or review.
- Every intent is placed with its agent (`assignedTo`), which goes past admission and the claim-lease exclusion that normally keep agents from holding intents on the same file at once. The run measures what happens when changes collide, not how often they would collide in normal operation.
- A change that comes back reopens its intent; the agent declares the same work again as a new intent with itself, and the reopened intent is left open with no agent taking it (the colony's intent counts include those).
- Agents read the hot files at their lease's base from a stock git mirror, fetched as the trunk moves; the fetch time adds to the time between take and propose.
- One generated repository shape, one deployment, and every agent run from one machine. Review was off; certification ran as the deployment has it.
- Inside one landing commit, the order the trunk writer applied its proposals is taken from the order of the lineage note.

