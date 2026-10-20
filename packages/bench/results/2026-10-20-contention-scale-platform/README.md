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
| Agents joined | 1,000 |
| Tasks landed | 1,151 of 3,000 |
| How the rest ended | unresolved 1,849 |
| Proposals (landed) | 3,406 (1,151) |
| Trunk commits whose lineage note names them | 808 |
| Landings a minute (trunk commits), first to last landing | 188.0 |
| Changes landed a minute | 268.5 |
| Propose to landed, p50 / p95 | 6.1 s / 22.2 s |
| A task's first proposal to landed, rounds included, p50 / p95 | 7.3 s / 141.5 s |
| Changes that came back | 2,255 |
| … for a stale read (a file it read had moved) | 399 |
| … for a text-merge conflict | 0 |
| … sent back by review | 0 |
| … for a megafile hold | 1,847 |
| … for any other reason | 9 |
| … register / increment / read-own | 898 / 1,010 / 347 |
| Rounds to land, median / p95 / max | 1 / 3 / 5 |
| Changes merged line by line (files; by the insertion rule) | 329 (329; 13) |
| Agents holding an intent at once, peak | 231 |
| Intents on one hot file held at once, peak | 35 |
| Takes that lost their assignment (declared again) | 5,524 |
| Wall time of the agents | 1800.5 s |

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

- **PASS** every file parses: 413 files at 0fa8dc5f9e53: all parse; the tree holds the seeded files and no others.
- **PASS** registry entries appear exactly once: 104 landed register tasks: 0 duplicated, 0 missing, 0 present without a landing, 0 seed entries gone, 0 unknown.
- **PASS** every counter equals its landed increments: 40 counters, 52 landed increments, counters adding up to 52: 0 lost updates, 0 counted twice.
- **PASS** no increment was closed as already on trunk: No increment came back as already on trunk.
- **PASS** every read-own constant matches the trunk it landed on: 998 landed read-own changes: 0 constants differ from the registry they landed on, 0 landed on a version they did not read, 0 landed behind a writer of their file in the same commit, 0 set without a landing.
- **FAIL** the agents' outcomes agree with the lineage notes: 1,151 proposals reported landed, 1,154 proposals of this run in the notes: 0 reported landed but not in a note, 3 in a note but reported otherwise, 0 tasks landed twice.
  - proposal prp_mvg7bgn6v7ygn8 (task t01113) is in landing 80d77cc7c310's note but its agent was told returned: hot/h06/state.ts is being split by intent int_mvg7byn8ysb1e8; take again after it lands
  - proposal prp_mvg7adcwwcuady (task t00436) is in landing a0b73375f233's note but its agent was told returned: hot/h08/state.ts is being split by intent int_mvg7b4vultiaz2; take again after it lands
  - proposal prp_mvg7a48g3zijgp (task t00333) is in landing 9590cf6705f4's note but its agent was told returned: hot/h07/state.ts is being split by intent int_mvg7b01h47pgn0; take again after it lands
- Counters, value/landed increments: `hot/h00/state.ts` 1/1 1/1 1/1 0/0; `hot/h01/state.ts` 1/1 1/1 1/1 0/0; `hot/h02/state.ts` 3/3 1/1 2/2 2/2; `hot/h03/state.ts` 1/1 1/1 1/1 2/2; `hot/h04/state.ts` 1/1 2/2 2/2 3/3; `hot/h05/state.ts` 2/2 1/1 2/2 2/2; `hot/h06/state.ts` 1/1 1/1 1/1 2/2; `hot/h07/state.ts` 1/1 1/1 1/1 1/1; `hot/h08/state.ts` 1/1 1/1 2/2 1/1; `hot/h09/state.ts` 1/1 1/1 1/1 1/1

## Honest limits

- Synthetic agents make scripted edits with no model and run no tests: this measures the platform's landing path under contention (read-set validation, text merge, group commit, the lineage record), not agents' judgment or review.
- Every intent is placed with its agent (`assignedTo`), which goes past admission and the claim-lease exclusion that normally keep agents from holding intents on the same file at once. The run measures what happens when changes collide, not how often they would collide in normal operation.
- A change that comes back reopens its intent; the agent declares the same work again as a new intent with itself, and the reopened intent is left open with no agent taking it (the colony's intent counts include those).
- Agents read the hot files at their lease's base from a stock git mirror, fetched as the trunk moves; the fetch time adds to the time between take and propose.
- One generated repository shape, one deployment, and every agent run from one machine. Review was off; certification ran as the deployment has it.
- Inside one landing commit, the order the trunk writer applied its proposals is taken from the order of the lineage note.


## Operator's note

Where it ran: the scenario's client was a Cloudflare Container (`standard-3`: 2 vCPU, 8 GiB) in Cloudflare's LAX data center, started by the throwaway Worker in `packages/bench/platform-runner/`, against staging at build 9f00539. The Oct 19 runs in `2026-10-19-contention-scale-fixed/` drove the same scenario from a laptop, whose uplink lost connections at about 1,000 concurrent agents. Three attempts at 1,000 agents were made from the container, after a 50-agent proof run (`proof-50/`: 148 of 150 landed in 63.5 s, all six checks pass).

- **Attempt 1** (`attempt-1-plain/`): plain Node fetch with no cap on connections. The run stopped itself at 20 s with a 39% error rate over 5 s (322 failed calls by then, 506 by 30 s) and 129 tasks landed. The failures were the client's own connection handling, not the deployment: the same Worker served every other call of the night without a failed call.
- **Attempt 2** (`attempt-2-pool256/`): fetch capped at 256 keep-alive connections per origin and 16 libuv threads (`container/dispatcher.mjs`). The agents were done after 278.4 s: 1,168 of 3,000 tasks landed, 2,201 changes came back, 0 failed calls; five checks passed and the lineage check failed on 10 proposals that a note names but whose agents were told returned. Its result files are gone: Cloudflare's rollout from the redeploy that added the connection cap signalled the container to exit at 02:26:51Z, nine minutes after the checks, while the scenario was still deleting its colony and before it wrote its files. The watcher's copy of the log (`run-n1000.watch.log`) is all that survives, so that attempt has no table.
- **Attempt 3** (the files in this directory): the same settings. 1,151 of 3,000 landed, 2,255 came back, 0 failed calls. Landings were over 258 s after the agents started; two agents then held an intent until the 1,800 s limit, so "Wall time of the agents" above is the limit, not the work, and the landings-a-minute figure (first to last landing) is unaffected. 62 s into the run a second cleanup of the previous attempt's colony, a `DELETE` sent by mistake, ran on the server for 85 s before its client was cut off. The run shows no effect from it (1,000 agents joined, 0 failed calls, landings at attempt 2's pace), and it is recorded here so the reader can weigh it.

What bounds the landed count here is the megafile hold, not the network. This build has `FT_MEGAFILE` on and the Oct 19 laptop run did not: 1,847 of the 2,255 returns were megafile holds (every register return and 949 of the 1,010 increment returns), against 0 on Oct 19, where the returns were stale reads. A hold lasts until a split lands, and no synthetic agent takes a split, so the held tasks ended unresolved (1,849 of 3,000). The lineage check's three failures are the same hold: each proposal landed, and its agent was told the file was being split. The two completed attempts agree with each other: 1,151 and 1,168 landed, landings finished in about 260 s, and no call failed.
