# Paper-review checks of the simulator, 2026-10-13

The 2026-10-13 paper reviews questioned the simulator numbers in README line 167: "plain optimistic claims at about 42% rework against 22% for exclusive locks; decaying inhibition and co-change learning bring it to about 31% (26% with a stronger co-change weight) with no loss of throughput, and conflicts per 1,000 submissions fall below the lock design's (285 vs 318)".

This folder re-runs each question with the existing harness: 10 seeds per configuration, at 100, 1,000 and 10,000 agents. It adds three analysis options that are not built in the platform: a classifier for why changes come back, import-aware take(), and assumption revalidation.

**Every number here is SIMULATED. None comes from a deployment.** The reviewers' numbers came from their own runs or estimates, and this is the first reproduction.

## Verdicts

Unless noted, figures are at 1,000 agents, the mean of seeds 1-10 ± the 95% interval. "Deployed" means group commit plus co-change weight 2 plus lateral inhibition, which is what production runs.

| Question | Reviewer's claim | This re-run (SIMULATED) | Verdict |
| --- | --- | --- | --- |
| Q1. Equal retry costs | The README's 42% vs 22% charges a returned optimistic change a full redo and a locked one half a redo (review 2606.15376). At equal costs, the reviewer had locks at 36.1% (full redo) and deployed at 17.3% (half redo, 212 landed/min). | Locks 34.8 ± 0.8% (full), 21.3 ± 0.7% (half). Deployed 30.5 ± 0.9% (full), 17.4 ± 0.6% (half, 208 landed/min). Plain optimistic claims 43.2 ± 1.2% (full), 27.5 ± 0.9% (half). | **Reproduces.** At equal retry cost, FireTrident with inhibition and co-change reworks *less* than locks: 30.5 vs 34.8% (full redo) and 17.4 vs 21.3% (half redo). It does so at 3.4 to 4.0 times locks' landings. Plain optimistic claims rework more than locks, by 6 to 8 points, not 20. |
| Q2. Inhibition's throughput cost | "No loss of throughput" holds only for per-proposal lanes; under group commit, inhibition costs about 8% of landings a minute (review 2610.04779). | Group commit: −7.2% (−11.0 to −3.5) at 1,000 agents and −10.8% (−14.0 to −7.5) at 10,000. Without co-change: −15.2% and −16.4%. Per-lane commits: +0.6% (+0.2 to +0.9). | **Reproduces.** "No loss of throughput" is true only for per-lane commits, the trunk writer behind the README's numbers. Production now uses group commit, where inhibition costs 7-11% of landings a minute. |
| Q3a. Stale reads | About 98% of the remaining conflicts are stale reads (reviews 2610.04779 and 2609.08015). The reviewer put per-proposal lanes at 51-52%. | Deployed: 99.8 ± 0.1% read-only, 0.0% write-write, 0.2% a group-commit ordering rule. Per-lane commits with inhibition: 100.0% read-only. | **Reproduces, and understates.** No change that comes back after inhibition is a write conflict. The "about 98%" and "51-52%" came from the published write-write counter, which counts every return found by the trunk writer as write-write. With per-lane commits that is half of all returns. |
| Q3b. Hub files | 72% of stale reads are on Hono's three most-imported files: `src/context.ts`, `src/hono.ts`, `src/types.ts` (review 2606.00953). The reviewer had 64% for per-lane commits. | Deployed: 71.2 ± 1.6% of changed reads, and 77.5% of read-only returns touch one of the three. Per-lane commits: 69.6 ± 2.2%. | **Reproduces** for the deployed configuration. For per-lane commits it is about 70%, not 64%. |
| Q4. Import-aware take() | Repelling claims on a footprint's imports and importers cuts rework from 31.2% to 16.8% (weight 1) or 1.1% (weight 2), at about 11% fewer landings a minute (review 2606.00953). | Deployed: weight 1 gives 16.2 ± 1.3% at 158.0/min (−9.8%); weight 2 gives 1.9 ± 0.3% at 153.0/min (−12.6%). Per-lane commits: 16.7% and 6.3%, with no throughput cost. At 100 agents: 0.0% rework and +9.7% landings. | **Reproduces.** This is a best case, because the simulator's reads are exactly these import edges. |
| Q5. Assumption revalidation | Landing a read-only-stale change when its assumptions hold would bring the deployed configuration to about 13.5-15% (57.6% hold) or about 10% (68.7% hold). Locks would fall to about 9% (review 2609.08015, an ESTIMATE). | Deployed: 18.1 ± 0.9% (57.6%) with +18.7% landings, and 14.2 ± 1.1% (68.7%) with +23.9% landings. Locks: 10.1% and 7.4%. | **Does not reproduce: the estimate is about 4 points too optimistic.** A returned change has 1.32 changed reads on average, and a file can change more than once while a change waits. So only 46% and 58% of read-only-stale changes land, not 57.6% and 68.7%. The estimate left out the throughput gain. For locks the estimate is close: 10.1% against about 9%. |

The README's own numbers still hold on their own terms. Plain optimistic claims rework 43.2 ± 1.2%, inhibition plus co-change 30.4 ± 1.2%, co-change weight 5 25.9 ± 1.4%, and conflicts are 273 per 1,000 against 310 for locks. All of these come from per-lane commits with the unequal retry costs.

## What was run

Every number in this folder is **SIMULATED**: the coordination simulator in `packages/bench/src/sim` (FireSim for FireTrident, BaselineSim for locks), on the Hono workload of the 2026-10-12 benchmark. Nothing here was measured on a deployment.

- **Workload.** Tasks drawn from 2,285 Hono commits (3.01 files per change) in a monorepo of 100 package copies, region depth 3. Each task reads the direct relative imports of the files it writes (at most 8). Agent work per attempt is log-normal with a 60 s median (sigma 0.8). Timings are the in-platform calibration in `data/calibration.json`, with checks free (`testMs` 0).
- **Settings.** The same as `results/2026-10-12-inhibition`, which produced every number in README line 167: 20 simulated minutes with the first 5 as warm-up, a backlog of 1,000 open tasks, co-change weight 2 (top 8 neighbors with coupling of at least 0.1, mined from Hono's last 200 commits), lateral inhibition at 0.5.
- **Seeds and statistics.** Seeds 1 to 10 for every configuration, at 100, 1,000 and 10,000 agents. Tables show the mean over seeds ± the 95% Student t half-width. A change between two configurations is the difference of their means with a Welch 95% interval.
- **Two trunk writers.**
  - *Per-lane commits* (model `firetrident`): each lane batch is its own commit, and one writer serves them one at a time. The README's 42%, 31%, 26%, "no loss of throughput" and "285 vs 318" all come from this model. Review 2610.04779 calls it "per-proposal lanes".
  - *Group commit* (model `firetrident-group`): the writer folds every waiting batch into one commit. Production works this way with one difference: it writes one chained commit per batch and pushes the tip once with compare-and-swap (`TrunkDO` and `planCycle` in `packages/worker/src/trunk/plan.ts`).
- **Reproduction check.** 81 rows here repeat a configuration of `results/2026-10-12-inhibition/sim-steady.json` (same variant, agents and seed, default retry cost). All 81 are identical to the published rows: landings, rework, conflicts, write-write, claim-to-land p50 and submissions. The new options are off by default, and the return classifier does not change a run.

### New simulator code (analysis only; none of it is built in the platform)

- `FireOptions.onReturn` (`sim/fire.ts`) reports why each returned proposal went back. It classifies the return as one of three kinds:
  - **read-only staleness**: only files it read moved, on trunk or by a proposal ahead of it in the same commit;
  - **write-write**: a file it writes moved, or another proposal of the commit writes it;
  - **order**: it writes a file that a proposal ahead of it in the same group commit read.
- `FireOptions.assumptions` and `BaselineOptions.assumptions` add assumption revalidation. A change that is stale only through files it read lands anyway when its assumption on each of those files held through every change since the agent read it. Each change is one independent draw at the hold probability.
- `sim/imports.ts` adds import-aware repulsion: `weight` times core `neighborRepulsion` over each written file's direct imports and importers (weight 1 per edge), added to co-change repulsion the way `ColonyDO.take` adds it.
- `sim/papers.ts` is the driver and the report. The tests are in `test/papers.test.ts`.

## Q1. Equal retry costs: the 42% vs 22% compares a full redo with half a redo

`sweep.ts` sets `rework: model === "baseline" ? 0.5 : 1.0`. A locked change that comes back is reworked at half its work time; a FireTrident change that comes back is redone in full. Here both models run with the same retry cost, 1.0 and then 0.5.

- **Locks, 1,000 agents:** 34.8% with a full redo against the published 21.3% with half a redo. Landings and conflicts barely move (51.9/min; 314 and 310 conflicts per 1,000), because the merge queue limits locks.
- **FireTrident with inhibition and co-change:** below locks at both costs, with either trunk writer.
  - Per-lane commits: 30.4% (full) and 17.8% (half).
  - Group commit, as deployed: 30.5% (full) and 17.4% (half).
  - This comes with fewer conflicts (194 to 273 per 1,000, against 310 to 314) and 1.7 to 4.0 times the landings.
- **Plain optimistic claims** rework more than locks: 43.2% against 34.8% with a full redo, and 27.5% against 21.3% with half. The gap is 6 to 8 points, not the 20 points the README implies.
- **A cheaper retry also raises throughput under group commit** (deployed: 175 to 208 landed/min), because agents spend less time redoing work. With per-lane commits the trunk writer is the limit (about 86/min either way).
- **At 100 agents** every design reworks 5 to 11%. Locks are not better there either: 10.3% against 9.5-11.4% with a full redo.
- **At 100 agents co-change weights 2 and 5 give identical runs.** A one-seed probe showed weight 10 does too: a stronger weight changes no agent's choice there.

### Q1. Equal retry costs (SIMULATED, seeds 1, 2, 3, 4, 5, 6, 7, 8, 9, 10; mean ± 95% CI over seeds)

100 agents:

| model | retry cost | rework % | landed/min | conflicts per 1,000 | retry cost | rework % | landed/min | conflicts per 1,000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Locks + one merge queue | 1.0 | 10.3 ± 1.3 | 55.9 | 68 | 0.5 (as published) | 5.3 ± 0.7 | 56.2 | 68 |
| Plain optimistic claims, per-lane commits | 1.0 (as published) | 11.2 ± 1.2 | 63.0 | 67 | 0.5 | 5.6 ± 0.7 | 66.4 | 65 |
| Per-lane commits + co-change 2 + inhibition | 1.0 (as published) | 9.5 ± 1.4 | 64.1 | 58 | 0.5 | 4.9 ± 0.7 | 67.1 | 57 |
| Per-lane commits + co-change 5 + inhibition | 1.0 (as published) | 9.5 ± 1.4 | 64.1 | 58 | 0.5 | 4.9 ± 0.7 | 67.1 | 57 |
| Plain optimistic claims, group commit | 1.0 (as published) | 11.4 ± 1.4 | 63.5 | 70 | 0.5 | 5.8 ± 0.7 | 67.1 | 68 |
| Group commit + co-change 2 + inhibition (deployed) | 1.0 (as published) | 9.9 ± 1.2 | 64.6 | 61 | 0.5 | 5.0 ± 0.7 | 67.5 | 58 |

1,000 agents:

| model | retry cost | rework % | landed/min | conflicts per 1,000 | retry cost | rework % | landed/min | conflicts per 1,000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Locks + one merge queue | 1.0 | 34.8 ± 0.8 | 51.9 | 314 | 0.5 (as published) | 21.3 ± 0.7 | 51.9 | 310 |
| Plain optimistic claims, per-lane commits | 1.0 (as published) | 43.2 ± 1.2 | 85.7 | 410 | 0.5 | 27.5 ± 0.9 | 85.6 | 400 |
| Per-lane commits + co-change 2 + inhibition | 1.0 (as published) | 30.4 ± 1.2 | 86.3 | 273 | 0.5 | 17.8 ± 1.1 | 86.4 | 267 |
| Per-lane commits + co-change 5 + inhibition | 1.0 (as published) | 25.9 ± 1.4 | 86.3 | 230 | 0.5 | 15.0 ± 1.1 | 86.4 | 229 |
| Plain optimistic claims, group commit | 1.0 (as published) | 45.9 ± 0.8 | 205.1 | 324 | 0.5 | 30.2 ± 0.5 | 273.3 | 325 |
| Group commit + co-change 2 + inhibition (deployed) | 1.0 (as published) | 30.5 ± 0.9 | 175.2 | 198 | 0.5 | 17.4 ± 0.6 | 208.0 | 194 |

10,000 agents:

| model | retry cost | rework % | landed/min | conflicts per 1,000 | retry cost | rework % | landed/min | conflicts per 1,000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Locks + one merge queue | 1.0 | 34.8 ± 0.8 | 51.9 | 313 | 0.5 (as published) | 21.3 ± 0.7 | 51.9 | 310 |
| Plain optimistic claims, per-lane commits | 1.0 (as published) | 42.5 ± 1.2 | 85.8 | 400 | 0.5 | 26.9 ± 0.9 | 85.9 | 393 |
| Per-lane commits + co-change 2 + inhibition | 1.0 (as published) | 30.3 ± 1.2 | 86.2 | 273 | 0.5 | 18.1 ± 0.9 | 86.3 | 269 |
| Per-lane commits + co-change 5 + inhibition | 1.0 (as published) | 26.6 ± 1.5 | 86.3 | 233 | 0.5 | 15.2 ± 1.3 | 86.3 | 230 |
| Plain optimistic claims, group commit | 1.0 (as published) | 46.4 ± 1.1 | 203.5 | 327 | 0.5 | 29.9 ± 0.6 | 268.8 | 326 |
| Group commit + co-change 2 + inhibition (deployed) | 1.0 (as published) | 30.7 ± 1.3 | 169.1 | 200 | 0.5 | 16.9 ± 0.7 | 209.1 | 187 |

## Q2. Lateral inhibition costs throughput under group commit

- **With per-lane commits** (the README's numbers), inhibition costs nothing: +0.6% landed/min, with a 95% interval of +0.2 to +0.9 at 1,000 agents.
- **With group commit**, the trunk writer folds batches into one commit. Throughput then depends on how much independent work agents find, and inhibition costs real landings:
  - −7.2% at 1,000 agents with co-change, as deployed (−11.0 to −3.5);
  - −10.8% at 10,000 agents (−14.0 to −7.5);
  - −15 to −16% without co-change.
  - It is still about 3.4 times locks' landings (175 against 52 per minute).
- **The rework it buys** is about 10 points: 40.9% to 30.5% deployed, 45.9% to 31.6% without co-change.
- **Why it costs landings** (from `results/2026-10-12-inhibition`): inhibited intents sit at the head of the 200-oldest candidate window until their files' claims clear.
- **At 100 agents** the runs with and without inhibition are identical. With few agents a claimed intent never outranks a free one.

### Q2. What lateral inhibition costs in throughput (SIMULATED, seeds 1, 2, 3, 4, 5, 6, 7, 8, 9, 10; change = difference of means with a Welch 95% CI)

| agents | trunk writer | co-change | landed/min, off | landed/min, on | change | rework %, off → on | conflicts per 1,000, off → on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | per-lane commits | off | 63.0 ± 1.5 | 63.0 ± 1.5 | +0.0% (-3.2 to +3.2) | 11.2 → 11.2 | 67 → 67 |
| 100 | per-lane commits | 2 | 64.1 ± 1.8 | 64.1 ± 1.8 | +0.0% (-3.6 to +3.6) | 9.5 → 9.5 | 58 → 58 |
| 100 | group commit | off | 63.5 ± 1.7 | 63.5 ± 1.7 | +0.0% (-3.4 to +3.4) | 11.4 → 11.4 | 70 → 70 |
| 100 | group commit | 2 (deployed) | 64.6 ± 1.6 | 64.6 ± 1.6 | +0.0% (-3.2 to +3.2) | 9.9 → 9.9 | 61 → 61 |
| 1,000 | per-lane commits | off | 85.7 ± 0.3 | 86.2 ± 0.2 | +0.6% (+0.2 to +0.9) | 43.2 → 32.2 | 410 → 286 |
| 1,000 | per-lane commits | 2 | 85.8 ± 0.2 | 86.3 ± 0.2 | +0.6% (+0.3 to +0.8) | 38.6 → 30.4 | 360 → 273 |
| 1,000 | group commit | off | 205.1 ± 4.2 | 173.9 ± 10.5 | -15.2% (-20.6 to -9.8) | 45.9 → 31.6 | 324 → 205 |
| 1,000 | group commit | 2 (deployed) | 188.8 ± 4.4 | 175.2 ± 6.1 | -7.2% (-11.0 to -3.5) | 40.9 → 30.5 | 281 → 198 |
| 10,000 | per-lane commits | off | 85.8 ± 0.2 | 86.3 ± 0.2 | +0.5% (+0.2 to +0.8) | 42.5 → 32.0 | 400 → 283 |
| 10,000 | per-lane commits | 2 | 85.7 ± 0.2 | 86.2 ± 0.2 | +0.6% (+0.3 to +0.9) | 39.1 → 30.3 | 366 → 273 |
| 10,000 | group commit | off | 203.5 ± 4.7 | 170.2 ± 6.2 | -16.4% (-19.9 to -12.8) | 46.4 → 31.7 | 327 → 203 |
| 10,000 | group commit | 2 (deployed) | 189.5 ± 3.7 | 169.1 ± 5.4 | -10.8% (-14.0 to -7.5) | 40.9 → 30.7 | 279 → 200 |

## Q3. What still comes back: stale reads, mostly on three hub files

Each return is classified as it happens, using `FireOptions.onReturn`. The classifier has no effect on a run: all 81 rows that repeat a published configuration are identical.

- **With inhibition, no return is a write conflict.** The simulator's agents heartbeat, so every claim is fresh, and inhibition never lets two agents hold a claim on the same file at the same time.
  - Per-lane commits: 100.0% of returns are read-only staleness.
  - Group commit: 99.8%. The other 0.2% are proposals that write a file a proposal ahead of them in the same commit read. The simulated group-commit screen returns these, while `planCycle` lands that case across lane batches.
  - Without inhibition, 36-41% of returns are write-write.
- **The published `writeWritePer1000` counter misleads.** It counts every return the trunk writer finds as write-write (`finishTick` passes `true`).
  - With per-lane commits, about half of all returns are found there. That is where the reviewer's "51-52% read-only" came from; the true share is 100%.
  - Under group commit about 1% are found there, so that counter's 98.7% is close to the classified 99.8%.
- **The three most-imported files take about 70% of the stale reads.**
  - `src/context.ts` (73 importers), `src/hono.ts` (69) and `src/types.ts` (63) account for 71.2% of the changed reads behind read-only returns in the deployed configuration, and 68-75% in every other configuration and agent count.
  - 77.5% of the read-only returns touch at least one of them.
  - A read-only return has 1.32 changed reads on average under group commit, and 1.18 with per-lane commits.

### Q3. What sends changes back (SIMULATED, the Q2 runs; shares of returns after warm-up, mean ± 95% CI over seeds)

| agents | model | conflicts per 1,000 | read-only, from the published counter | read-only, classified | write-write | write after a read in the same group commit | found by the trunk writer | trunk-writer returns that were read-only | changed reads on the top-3 files | read-only returns touching a top-3 file | changed reads per read-only return |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | Plain optimistic claims, per-lane commits | 67 | 98.8 ± 0.9% | 100.0 ± 0.0% | 0.0 ± 0.0% | 0.0 ± 0.0% | 1.2 ± 0.9% | 100.0 ± 0.0% | 70.2 ± 3.5% | 74.6 ± 2.4% | 1.22 ± 0.05 |
| 100 | Per-lane commits + inhibition | 67 | 98.8 ± 0.9% | 100.0 ± 0.0% | 0.0 ± 0.0% | 0.0 ± 0.0% | 1.2 ± 0.9% | 100.0 ± 0.0% | 70.2 ± 3.5% | 74.6 ± 2.4% | 1.22 ± 0.05 |
| 100 | Per-lane commits + co-change 2 + inhibition | 58 | 98.9 ± 0.9% | 100.0 ± 0.0% | 0.0 ± 0.0% | 0.0 ± 0.0% | 1.1 ± 0.9% | 100.0 ± 0.0% | 74.3 ± 2.8% | 78.7 ± 3.7% | 1.21 ± 0.04 |
| 100 | Plain optimistic claims, group commit | 70 | 98.6 ± 1.1% | 99.9 ± 0.3% | 0.0 ± 0.0% | 0.1 ± 0.3% | 1.4 ± 1.1% | 91.7 ± 21.4% | 71.5 ± 2.4% | 76.3 ± 2.2% | 1.22 ± 0.05 |
| 100 | Group commit + inhibition | 70 | 98.6 ± 1.1% | 99.9 ± 0.3% | 0.0 ± 0.0% | 0.1 ± 0.3% | 1.4 ± 1.1% | 91.7 ± 21.4% | 71.5 ± 2.4% | 76.3 ± 2.2% | 1.22 ± 0.05 |
| 100 | Group commit + co-change 2 + inhibition (deployed) | 61 | 98.7 ± 1.0% | 99.5 ± 0.6% | 0.0 ± 0.0% | 0.5 ± 0.6% | 1.3 ± 1.0% | 66.7 ± 42.9% | 74.9 ± 3.2% | 79.3 ± 3.6% | 1.19 ± 0.04 |
| 1,000 | Plain optimistic claims, per-lane commits | 410 | 31.3 ± 1.3% | 64.2 ± 2.1% | 35.8 ± 2.1% | 0.0 ± 0.0% | 47.2 ± 1.0% | 69.7 ± 2.5% | 68.9 ± 1.3% | 72.9 ± 1.4% | 1.18 ± 0.01 |
| 1,000 | Per-lane commits + inhibition | 286 | 48.8 ± 1.4% | 100.0 ± 0.0% | 0.0 ± 0.0% | 0.0 ± 0.0% | 51.2 ± 1.4% | 100.0 ± 0.0% | 69.5 ± 2.5% | 74.2 ± 2.4% | 1.19 ± 0.02 |
| 1,000 | Per-lane commits + co-change 2 + inhibition | 273 | 49.7 ± 1.7% | 100.0 ± 0.0% | 0.0 ± 0.0% | 0.0 ± 0.0% | 50.3 ± 1.7% | 100.0 ± 0.0% | 69.6 ± 2.2% | 74.0 ± 2.3% | 1.18 ± 0.02 |
| 1,000 | Plain optimistic claims, group commit | 324 | 58.6 ± 1.4% | 59.3 ± 1.5% | 40.6 ± 1.5% | 0.1 ± 0.1% | 1.1 ± 0.2% | 63.5 ± 8.0% | 71.4 ± 1.4% | 78.2 ± 1.5% | 1.33 ± 0.02 |
| 1,000 | Group commit + inhibition | 205 | 98.9 ± 0.3% | 99.8 ± 0.2% | 0.0 ± 0.0% | 0.2 ± 0.2% | 1.1 ± 0.3% | 81.8 ± 12.3% | 70.3 ± 1.2% | 77.8 ± 1.0% | 1.35 ± 0.02 |
| 1,000 | Group commit + co-change 2 + inhibition (deployed) | 198 | 98.7 ± 0.3% | 99.8 ± 0.1% | 0.0 ± 0.0% | 0.2 ± 0.1% | 1.3 ± 0.3% | 82.6 ± 4.6% | 71.2 ± 1.6% | 77.5 ± 1.8% | 1.32 ± 0.02 |
| 10,000 | Plain optimistic claims, per-lane commits | 400 | 31.2 ± 1.6% | 63.3 ± 2.0% | 36.7 ± 2.0% | 0.0 ± 0.0% | 46.9 ± 1.3% | 68.5 ± 2.8% | 68.5 ± 1.4% | 72.7 ± 1.8% | 1.18 ± 0.02 |
| 10,000 | Per-lane commits + inhibition | 283 | 48.4 ± 1.4% | 100.0 ± 0.0% | 0.0 ± 0.0% | 0.0 ± 0.0% | 51.6 ± 1.4% | 100.0 ± 0.0% | 69.5 ± 1.7% | 74.1 ± 2.2% | 1.19 ± 0.01 |
| 10,000 | Per-lane commits + co-change 2 + inhibition | 273 | 48.7 ± 2.4% | 100.0 ± 0.0% | 0.0 ± 0.0% | 0.0 ± 0.0% | 51.3 ± 2.4% | 100.0 ± 0.0% | 69.0 ± 1.9% | 73.6 ± 2.1% | 1.17 ± 0.02 |
| 10,000 | Plain optimistic claims, group commit | 327 | 59.0 ± 1.7% | 59.4 ± 1.6% | 40.4 ± 1.6% | 0.2 ± 0.1% | 0.8 ± 0.2% | 55.0 ± 13.1% | 71.6 ± 1.1% | 79.1 ± 0.7% | 1.34 ± 0.01 |
| 10,000 | Group commit + inhibition | 203 | 98.8 ± 0.3% | 99.7 ± 0.1% | 0.0 ± 0.0% | 0.3 ± 0.1% | 1.2 ± 0.3% | 79.1 ± 10.2% | 70.6 ± 1.5% | 77.3 ± 1.7% | 1.34 ± 0.02 |
| 10,000 | Group commit + co-change 2 + inhibition (deployed) | 200 | 98.9 ± 0.4% | 99.8 ± 0.2% | 0.0 ± 0.0% | 0.2 ± 0.2% | 1.1 ± 0.3% | 82.3 ± 9.5% | 72.3 ± 1.4% | 78.8 ± 1.3% | 1.32 ± 0.01 |

## Q4. Import-aware take() (ANALYSIS, not built)

The new term is `weight × neighborRepulsion(footprint, import neighbors, claims)`. Each direct import, or importer, of a written file that another agent holds a claim on adds that claim, at weight 1. It is added to the co-change term the way `ColonyDO.take` adds co-change repulsion, and it only repels: it never inhibits.

- **Rework.**
  - Weight 1 roughly halves it: deployed 30.5% falls to 16.2%, per-lane commits 30.4% to 16.7%.
  - Weight 2 nearly removes it: 1.9% deployed, 6.3% with per-lane commits.
  - The tail shortens too: deployed claim-to-land p99 falls from 683 s to 382 s at weight 2.
- **Throughput.**
  - Under group commit it costs 9.8% (weight 1) and 12.6% (weight 2) of landings a minute at 1,000 agents, and 3.9% and 11.8% at 10,000.
  - With per-lane commits it costs nothing.
  - At 100 agents it removes all rework and adds about 9-10% landings.
- **These numbers match review 2606.00953's probe.** The probe had 16.8% and 1.1% at about 11% fewer landings, and 7.0% for per-lane commits at weight 2.
- **Best case.** The simulator's read sets are drawn from the same import edges, so the term sees every read. Real agents read more than their direct imports.

### Q4. Import-aware take() (ANALYSIS, not built; SIMULATED, seeds 1, 2, 3, 4, 5, 6, 7, 8, 9, 10; mean ± 95% CI over seeds)

| agents | model | import weight | rework % | landed/min | landed/min vs weight 0 | conflicts per 1,000 | claim to land p50 s | p99 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | Per-lane commits + co-change 2 + inhibition | 0 | 9.5 ± 1.4 | 64.1 ± 1.8 | - | 58 | 62 | 434 |
| 100 | Per-lane commits + co-change 2 + inhibition | 1 | 0.0 ± 0.0 | 69.8 ± 1.4 | +8.8% (+5.5 to +12.1) | 0 | 62 | 373 |
| 100 | Per-lane commits + co-change 2 + inhibition | 2 | 0.0 ± 0.0 | 69.8 ± 1.4 | +8.8% (+5.5 to +12.1) | 0 | 62 | 373 |
| 100 | Group commit + co-change 2 + inhibition (deployed) | 0 | 9.9 ± 1.2 | 64.6 ± 1.6 | - | 61 | 62 | 435 |
| 100 | Group commit + co-change 2 + inhibition (deployed) | 1 | 0.0 ± 0.0 | 70.9 ± 1.5 | +9.7% (+6.6 to +12.9) | 0 | 61 | 374 |
| 100 | Group commit + co-change 2 + inhibition (deployed) | 2 | 0.0 ± 0.0 | 70.9 ± 1.5 | +9.7% (+6.6 to +12.9) | 0 | 61 | 374 |
| 1,000 | Per-lane commits + co-change 2 + inhibition | 0 | 30.4 ± 1.2 | 86.3 ± 0.2 | - | 273 | 288 | 924 |
| 1,000 | Per-lane commits + co-change 2 + inhibition | 1 | 16.7 ± 1.0 | 86.8 ± 0.1 | +0.6% (+0.3 to +0.8) | 148 | 228 | 686 |
| 1,000 | Per-lane commits + co-change 2 + inhibition | 2 | 6.3 ± 1.0 | 86.9 ± 0.1 | +0.7% (+0.5 to +0.9) | 61 | 186 | 506 |
| 1,000 | Group commit + co-change 2 + inhibition (deployed) | 0 | 30.5 ± 0.9 | 175.2 ± 6.1 | - | 198 | 67 | 683 |
| 1,000 | Group commit + co-change 2 + inhibition (deployed) | 1 | 16.2 ± 1.3 | 158.0 ± 3.4 | -9.8% (-13.6 to -6.0) | 99 | 64 | 542 |
| 1,000 | Group commit + co-change 2 + inhibition (deployed) | 2 | 1.9 ± 0.3 | 153.0 ± 6.0 | -12.6% (-17.2 to -8.1) | 9 | 62 | 382 |
| 10,000 | Per-lane commits + co-change 2 + inhibition | 0 | 30.3 ± 1.2 | 86.2 ± 0.2 | - | 273 | 287 | 960 |
| 10,000 | Per-lane commits + co-change 2 + inhibition | 1 | 17.0 ± 1.3 | 86.8 ± 0.2 | +0.7% (+0.4 to +0.9) | 150 | 231 | 693 |
| 10,000 | Per-lane commits + co-change 2 + inhibition | 2 | 6.1 ± 0.7 | 87.0 ± 0.1 | +0.9% (+0.7 to +1.1) | 60 | 184 | 508 |
| 10,000 | Group commit + co-change 2 + inhibition (deployed) | 0 | 30.7 ± 1.3 | 169.1 ± 5.4 | - | 200 | 68 | 704 |
| 10,000 | Group commit + co-change 2 + inhibition (deployed) | 1 | 15.7 ± 1.0 | 162.4 ± 2.3 | -3.9% (-7.3 to -0.6) | 96 | 65 | 522 |
| 10,000 | Group commit + co-change 2 + inhibition (deployed) | 2 | 2.0 ± 0.5 | 149.1 ± 5.0 | -11.8% (-15.9 to -7.7) | 11 | 61 | 385 |

## Q5. Assumption revalidation (ANALYSIS, not built)

A change that is stale only through files it read lands anyway when its assumption on each changed file held through every change since the agent read it. Each change is one independent draw at the hold rate. The rates come from the probe on 2,285 Hono commits: 68.7% when the signatures of the imported names held, and 57.6% when test importers also need the bodies unchanged. "Always" is the upper bound, ignoring reads entirely.

- **Deployed.**
  - Rework falls from 30.5% to 18.1% (57.6%) or 14.2% (68.7%).
  - Landings rise 19-24%, because work that used to be redone now lands.
  - Ignoring reads altogether would give 0.1% rework and +51% landings.
- **Why the estimate was too optimistic.**
  - The review's 13.5-15% and about 10% assumed each stale return lands at the hold rate.
  - A returned change has 1.32 changed reads on average, and a hot file can change more than once while a change waits.
  - So only 46.1% and 57.9% of read-only-stale changes land.
- **Locks benefit just as much:** 21.3% falls to 10.1% or 7.4%, with +6-7% landings. Assumptions do not favor optimism over locks.
- **Plain optimistic claims** keep their write conflicts: 43.2% falls only to 29.6-31.9%, and to 21.2% even with every assumption holding. Assumptions complement inhibition; they do not replace it.
- **False landings cost nothing here.** Real assumption checks would let some broken changes through, and certification would have to catch them.

### Q5. Assumption revalidation (ANALYSIS, not built; SIMULATED, seeds 1, 2, 3, 4, 5, 6, 7, 8, 9, 10; mean ± 95% CI over seeds)

| agents | model | assumption holds per change | rework % | landed/min | landed/min vs off | conflicts per 1,000 | kept landings per 1,000 submitted | read-only-stale changes that landed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | Locks + one merge queue | off (as built) | 5.3 ± 0.7 | 56.2 ± 0.2 | - | 68 | - | - |
| 100 | Locks + one merge queue | 57.6% | 2.6 ± 0.6 | 56.9 ± 0.1 | +1.3% (+0.8 to +1.7) | 34 | 35.1 | 51.1% |
| 100 | Locks + one merge queue | 68.7% | 1.9 ± 0.4 | 57.1 ± 0.1 | +1.6% (+1.1 to +2.0) | 25 | 43.0 | 63.7% |
| 100 | Locks + one merge queue | always (upper bound) | 0.0 ± 0.0 | 57.6 ± 0.0 | +2.5% (+2.1 to +2.9) | 0 | 68.1 | 100.0% |
| 100 | Plain optimistic claims, per-lane commits | off (as built) | 11.2 ± 1.2 | 63.0 ± 1.5 | - | 67 | - | - |
| 100 | Plain optimistic claims, per-lane commits | 57.6% | 5.8 ± 1.2 | 66.4 ± 1.4 | +5.4% (+2.3 to +8.5) | 34 | 32.5 | 48.8% |
| 100 | Plain optimistic claims, per-lane commits | 68.7% | 4.2 ± 0.7 | 67.3 ± 1.6 | +6.7% (+3.5 to +10.0) | 25 | 41.3 | 62.5% |
| 100 | Plain optimistic claims, per-lane commits | always (upper bound) | 0.0 ± 0.0 | 69.8 ± 1.5 | +10.7% (+7.5 to +13.8) | 0 | 66.0 | 100.0% |
| 100 | Per-lane commits + co-change 2 + inhibition | off (as built) | 9.5 ± 1.4 | 64.1 ± 1.8 | - | 58 | - | - |
| 100 | Per-lane commits + co-change 2 + inhibition | 57.6% | 5.1 ± 0.9 | 67.0 ± 1.5 | +4.5% (+1.1 to +7.9) | 30 | 28.8 | 49.0% |
| 100 | Per-lane commits + co-change 2 + inhibition | 68.7% | 3.5 ± 0.5 | 67.9 ± 1.6 | +5.8% (+2.4 to +9.3) | 22 | 36.7 | 63.1% |
| 100 | Per-lane commits + co-change 2 + inhibition | always (upper bound) | 0.0 ± 0.0 | 69.9 ± 1.4 | +8.9% (+5.6 to +12.2) | 0 | 58.4 | 100.0% |
| 100 | Group commit + co-change 2 + inhibition (deployed) | off (as built) | 9.9 ± 1.2 | 64.6 ± 1.6 | - | 61 | - | - |
| 100 | Group commit + co-change 2 + inhibition (deployed) | 57.6% | 5.4 ± 0.9 | 67.5 ± 1.7 | +4.5% (+1.2 to +7.8) | 31 | 29.0 | 48.5% |
| 100 | Group commit + co-change 2 + inhibition (deployed) | 68.7% | 3.7 ± 0.8 | 68.5 ± 1.7 | +6.0% (+2.7 to +9.3) | 21 | 35.9 | 63.1% |
| 100 | Group commit + co-change 2 + inhibition (deployed) | always (upper bound) | 0.0 ± 0.0 | 71.1 ± 1.5 | +9.9% (+6.9 to +13.0) | 0 | 58.0 | 100.0% |
| 1,000 | Locks + one merge queue | off (as built) | 21.3 ± 0.7 | 51.9 ± 0.2 | - | 310 | - | - |
| 1,000 | Locks + one merge queue | 57.6% | 10.1 ± 0.7 | 54.9 ± 0.2 | +5.9% (+5.4 to +6.4) | 156 | 167.1 | 51.6% |
| 1,000 | Locks + one merge queue | 68.7% | 7.4 ± 0.8 | 55.5 ± 0.2 | +7.1% (+6.6 to +7.6) | 120 | 202.4 | 62.7% |
| 1,000 | Locks + one merge queue | always (upper bound) | 0.0 ± 0.0 | 57.6 ± 0.0 | +11.0% (+10.6 to +11.4) | 0 | 328.2 | 100.0% |
| 1,000 | Plain optimistic claims, per-lane commits | off (as built) | 43.2 ± 1.2 | 85.7 ± 0.3 | - | 410 | - | - |
| 1,000 | Plain optimistic claims, per-lane commits | 57.6% | 31.9 ± 1.1 | 87.1 ± 0.3 | +1.7% (+1.3 to +2.1) | 294 | 129.8 | 51.3% |
| 1,000 | Plain optimistic claims, per-lane commits | 68.7% | 29.6 ± 1.1 | 87.5 ± 0.2 | +2.1% (+1.7 to +2.4) | 273 | 157.8 | 62.7% |
| 1,000 | Plain optimistic claims, per-lane commits | always (upper bound) | 21.2 ± 1.4 | 88.3 ± 0.2 | +3.1% (+2.7 to +3.5) | 193 | 244.3 | 100.0% |
| 1,000 | Per-lane commits + co-change 2 + inhibition | off (as built) | 30.4 ± 1.2 | 86.3 ± 0.2 | - | 273 | - | - |
| 1,000 | Per-lane commits + co-change 2 + inhibition | 57.6% | 15.5 ± 1.0 | 87.5 ± 0.3 | +1.4% (+1.0 to +1.8) | 137 | 145.3 | 51.6% |
| 1,000 | Per-lane commits + co-change 2 + inhibition | 68.7% | 11.4 ± 1.4 | 87.9 ± 0.2 | +1.9% (+1.5 to +2.2) | 103 | 177.7 | 63.4% |
| 1,000 | Per-lane commits + co-change 2 + inhibition | always (upper bound) | 0.0 ± 0.0 | 88.7 ± 0.2 | +2.7% (+2.4 to +3.0) | 0 | 283.6 | 100.0% |
| 1,000 | Group commit + co-change 2 + inhibition (deployed) | off (as built) | 30.5 ± 0.9 | 175.2 ± 6.1 | - | 198 | - | - |
| 1,000 | Group commit + co-change 2 + inhibition (deployed) | 57.6% | 18.1 ± 0.9 | 207.9 ± 4.8 | +18.7% (+14.6 to +22.8) | 108 | 91.8 | 46.1% |
| 1,000 | Group commit + co-change 2 + inhibition (deployed) | 68.7% | 14.2 ± 1.1 | 217.1 ± 4.0 | +23.9% (+20.0 to +27.9) | 83 | 113.0 | 57.9% |
| 1,000 | Group commit + co-change 2 + inhibition (deployed) | always (upper bound) | 0.1 ± 0.1 | 264.6 ± 5.2 | +51.0% (+46.8 to +55.3) | 1 | 198.1 | 100.0% |
| 10,000 | Locks + one merge queue | off (as built) | 21.3 ± 0.7 | 51.9 ± 0.2 | - | 310 | - | - |
| 10,000 | Locks + one merge queue | 57.6% | 10.1 ± 0.6 | 54.9 ± 0.2 | +5.9% (+5.4 to +6.4) | 156 | 167.5 | 51.7% |
| 10,000 | Locks + one merge queue | 68.7% | 7.4 ± 0.8 | 55.5 ± 0.2 | +7.1% (+6.6 to +7.6) | 121 | 203.9 | 62.8% |
| 10,000 | Locks + one merge queue | always (upper bound) | 0.0 ± 0.0 | 57.6 ± 0.0 | +11.0% (+10.6 to +11.4) | 0 | 330.4 | 100.0% |
| 10,000 | Plain optimistic claims, per-lane commits | off (as built) | 42.5 ± 1.2 | 85.8 ± 0.2 | - | 400 | - | - |
| 10,000 | Plain optimistic claims, per-lane commits | 57.6% | 32.1 ± 1.0 | 87.1 ± 0.2 | +1.5% (+1.1 to +1.8) | 294 | 127.4 | 50.7% |
| 10,000 | Plain optimistic claims, per-lane commits | 68.7% | 28.8 ± 1.6 | 87.4 ± 0.2 | +1.8% (+1.5 to +2.1) | 267 | 156.8 | 62.7% |
| 10,000 | Plain optimistic claims, per-lane commits | always (upper bound) | 21.0 ± 1.5 | 88.3 ± 0.2 | +2.9% (+2.6 to +3.3) | 191 | 243.3 | 100.0% |
| 10,000 | Per-lane commits + co-change 2 + inhibition | off (as built) | 30.3 ± 1.2 | 86.2 ± 0.2 | - | 273 | - | - |
| 10,000 | Per-lane commits + co-change 2 + inhibition | 57.6% | 15.4 ± 1.4 | 87.5 ± 0.2 | +1.5% (+1.2 to +1.8) | 134 | 143.8 | 51.7% |
| 10,000 | Per-lane commits + co-change 2 + inhibition | 68.7% | 11.8 ± 1.3 | 87.9 ± 0.2 | +1.9% (+1.6 to +2.2) | 102 | 173.8 | 63.0% |
| 10,000 | Per-lane commits + co-change 2 + inhibition | always (upper bound) | 0.0 ± 0.0 | 88.6 ± 0.2 | +2.8% (+2.5 to +3.1) | 0 | 276.5 | 100.0% |
| 10,000 | Group commit + co-change 2 + inhibition (deployed) | off (as built) | 30.7 ± 1.3 | 169.1 ± 5.4 | - | 200 | - | - |
| 10,000 | Group commit + co-change 2 + inhibition (deployed) | 57.6% | 17.9 ± 0.7 | 210.5 ± 4.3 | +24.5% (+20.7 to +28.3) | 108 | 93.7 | 46.6% |
| 10,000 | Group commit + co-change 2 + inhibition (deployed) | 68.7% | 14.5 ± 1.0 | 219.1 ± 7.9 | +29.6% (+24.2 to +35.0) | 84 | 113.8 | 57.9% |
| 10,000 | Group commit + co-change 2 + inhibition (deployed) | always (upper bound) | 0.1 ± 0.1 | 271.2 ± 7.8 | +60.4% (+55.2 to +65.7) | 1 | 200.0 | 100.0% |

## Caveats

1. **Footprints and reads are idealized.** A task's declared footprint is exactly its write set, an oracle footprint. Its reads are exactly the direct imports of its written files. Real agents read more, and their footprints are predictions. Every take-time remedy (inhibition, co-change, imports) is therefore at its best here.
2. **Import-aware take is a best case.** It repels on the same import edges the simulator draws read sets from.
3. **Assumption revalidation costs nothing when it is wrong.** The model has no false landings: a kept change that real code would break costs nothing. The hold rate is uniform across files. On Hono the hottest files hold less often for signatures (`src/context.ts` 50.6%, `src/hono.ts` 56.1%) and `src/types.ts` more often (85.5%). The probe weights each modification by its importer's touches, roughly the simulator's own exposure, so the average is a fair first-order rate. There is one draw per change to a changed file, not one per importing file, so a change whose two files both import a changed file gets a single draw.
4. **The published write-write counter is misleading.** `writeWritePer1000` counts every return found by the trunk writer as write-write. Q3 classifies each return directly, and the published counter is shown beside it.
5. **The simulated group commit is slightly stricter than production.** Its screen returns a proposal that writes a file a proposal ahead of it in the same commit read ("order"). `planCycle` lands that case across lane batches. Q3 shows how rare it is.
6. **Rework is agent work only.** It includes no model or review cost for a redo, and no cost for revalidating assumptions.
7. **Locks saturate.** The locks model gives identical runs at 1,000 and 10,000 agents. The merge queue serves about 52 changes a minute, claims go oldest first, and the extra agents only wait. The published runs show the same.

## Files

| File | Contents |
| --- | --- |
| `q1-*.json` | Q1 runs, one row per (configuration, agents, seed) |
| `q2-*.json` | Q2 runs. Each row's `returns` holds the Q3 classification. |
| `q4-*.json` | Q4 runs |
| `q5-*.json` | Q5 runs. `keptPer1000` counts landings that went past a changed read. |
| `summary.json` | Mean, sd, 95% interval, min and max per configuration, plus the check against the published runs |

Every JSON file carries `"label": "SIMULATED"`, the command that wrote it, the workload, the settings and the variants.

## Reproduce

Run these from the repository root. Nothing touches the network or a deployment. Runs are deterministic, so the same command writes the same rows; only `generatedAt` and `wallMs` change. These are the 16 shards behind this folder. They ran 6 at a time in about 40 minutes, about 225 CPU-minutes in all.

```sh
OUT=packages/bench/results/2026-10-13-papers
node packages/bench/src/sim/papers.ts --steps q1 --out $OUT --agents 100 --tag n100
node packages/bench/src/sim/papers.ts --steps q1 --out $OUT --agents 1000 --tag n1000
node packages/bench/src/sim/papers.ts --steps q1 --out $OUT --agents 10000 --seeds 1,2,3,4,5 --tag n10000-a
node packages/bench/src/sim/papers.ts --steps q1 --out $OUT --agents 10000 --seeds 6,7,8,9,10 --tag n10000-b
node packages/bench/src/sim/papers.ts --steps q2 --out $OUT --agents 100 --tag n100
node packages/bench/src/sim/papers.ts --steps q2 --out $OUT --agents 1000 --tag n1000
node packages/bench/src/sim/papers.ts --steps q2 --out $OUT --agents 10000 --tag n10000
node packages/bench/src/sim/papers.ts --steps q4 --out $OUT --agents 100 --tag n100
node packages/bench/src/sim/papers.ts --steps q4 --out $OUT --agents 1000 --seeds 1,2,3,4,5 --tag n1000-a
node packages/bench/src/sim/papers.ts --steps q4 --out $OUT --agents 1000 --seeds 6,7,8,9,10 --tag n1000-b
node packages/bench/src/sim/papers.ts --steps q4 --out $OUT --agents 10000 --seeds 1,2,3 --tag n10000-a
node packages/bench/src/sim/papers.ts --steps q4 --out $OUT --agents 10000 --seeds 4,5,6 --tag n10000-b
node packages/bench/src/sim/papers.ts --steps q4 --out $OUT --agents 10000 --seeds 7,8,9,10 --tag n10000-c
node packages/bench/src/sim/papers.ts --steps q5 --out $OUT --agents 100 --tag n100
node packages/bench/src/sim/papers.ts --steps q5 --out $OUT --agents 1000 --tag n1000
node packages/bench/src/sim/papers.ts --steps q5 --out $OUT --agents 10000 --tag n10000
# summary.json, the check against results/2026-10-12-inhibition, and the tables above (markdown, on stdout)
node packages/bench/src/sim/papers.ts --steps report --out $OUT
```

A single `node packages/bench/src/sim/papers.ts --out <empty folder>` runs every step in one process at the default agent counts and seeds 1-10, then prints the report.

The report counts each configuration and seed once. Re-running a shard, or mixing tagged and untagged files, does not double-count.

Tests: `npx vitest run --root packages/bench`. `test/papers.test.ts` covers the return classifier, assumption revalidation in both models and import-aware repulsion.
