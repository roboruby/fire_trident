# Lateral inhibition by the strongest file, and a capped age term, 2026-10-18

SIMULATED, except one table that is COMPUTED with core's own functions. A review of the coordination math found two
things in how `ColonyDO.take` weighs claims and age (`packages/core/src/threshold.ts`):

1. **Lateral inhibition summed claims over every shared file.** An open intent was skipped when other agents' live
   claims on its own files, added up over all of them, reached half a fresh claim. A claim decays with tau = 5 minutes,
   so a silent agent's claims on n of an intent's files kept it inhibited for 5·ln(2n) minutes: 3.5 for one file, 18.4
   for twenty. Now (`FT_INHIBIT_STRONGEST`) the strongest single file's claim counts, so inhibition lasts one
   half-life however many files overlap. Several agents' claims on the same file still add up on that file.
2. **The age multiplier had no cap.** Stimulus is `priority × (1 + ageMinutes / 10) − repulsion`, so an intent an hour
   old had a multiplier of 7 and co-change or import repulsion stopped mattering for it. Now (`FT_AGE_CAP`) the
   multiplier stops at `AGE_FACTOR_CAP` = 4, reached at 30 minutes. The cap was chosen from the sweep below.

Both ship behind flags that are off when absent (`packages/worker/src/colony/takemath.ts`); off, take() behaves as
before. The simulator (`packages/bench/src/sim/fire.ts`) gained the same two options (`inhibitBy`, `ageCap`) and records
how long each task waited open before its first claim (`waitP50S`, `waitP99S`, `waitMaxS`).

## How these files were made

```sh
node packages/bench/src/sim/inhibition.ts --steps silent --out packages/bench/results/2026-10-18-inhibition
node packages/bench/src/sim/inhibition.ts --steps agecap --variants group+cc5+inh+max,group+cc5+imp1+inh+max --caps inf,2,3,4,6 --out packages/bench/results/2026-10-18-inhibition
node packages/bench/src/sim/inhibition.ts --steps sim,ttz --agents 100,1000 --seeds 1,2,3 --ttz-agents 100,1000 --ttz-seeds 1,2,3,4,5 \
  --variants ft+cc5+inh,group+cc5+inh,group+cc+inh,group+cc+inh+max --ttz-variants ft+cc5+inh,group+cc5+inh,group+cc+inh,group+cc+inh+max \
  --out packages/bench/results/2026-10-18-inhibition/before
node packages/bench/src/sim/inhibition.ts --steps sim,ttz --agents 100,1000 --seeds 1,2,3 --ttz-agents 100,1000 --ttz-seeds 1,2,3,4,5 \
  --variants ft+cc5+inh+fix,group+cc5+inh+fix,group+cc+inh+fix --ttz-variants ft+cc5+inh+fix,group+cc5+inh+fix,group+cc+inh+fix \
  --out packages/bench/results/2026-10-18-inhibition/after
node packages/bench/src/sim/inhibition.ts --steps summary --out <each of the three folders>
```

Same workload and settings as [2026-10-12-inhibition](../2026-10-12-inhibition/): hono's history as 100 package copies,
co-change table h200, steady state over 20 simulated minutes (5 of warm-up) with a backlog of 1,000, draining 1,500 tasks
that are all open at t = 0. Variant names: `ft` is one commit per lane batch, `group` the group-commit trunk writer (as
deployed); `cc` is co-change repulsion at weight 2 (the 2026-10-12 runs), `cc5` at the deployed `FT_COCHANGE_WEIGHT` of
5; `imp1` adds import repulsion at weight 1 (`FT_IMPORT_WEIGHT`, off as deployed); `inh` is lateral inhibition; `+max`
inhibits by the strongest file; `+fix` is both fixes. The before runs reproduce 2026-10-12 exactly where they overlap
(`group+cc+inh` at 1,000 agents: 175.9 landed a minute, 31.2% rework; draining, seed 3 in 1,563 s and seed 5 in 1,697 s).

Files: [silent.json](silent.json), [sim-agecap.json](sim-agecap.json) and [summary.json](summary.json) here;
[before/](before/) and [after/](after/) each hold `sim-steady.json`, `sim-ttz.json` and `summary.json`.

## A silent agent's claims (COMPUTED)

How long an intent stays inhibited when a silent agent (no heartbeats) holds claims on n of its files, checked every
second with core `markValue`, `directClaimOn` and `inhibited` at the deployed threshold of half a fresh claim.

| Shared files | Summed (before), minutes | Strongest file (after), minutes |
| --- | --- | --- |
| 1 | 3.47 | 3.47 |
| 2 | 6.93 | 3.47 |
| 3 | 8.97 | 3.47 |
| 5 | 11.52 | 3.47 |
| 10 | 14.98 | 3.47 |
| 20 | 18.45 | 3.47 |
| 50 | 23.03 | 3.47 |

Two silent agents on the same single file hold it 6.93 minutes either way: claims on one file still add up.

## Before and after (SIMULATED)

Mean over seeds (3 in steady state, 5 draining); "slowest wait" is the mean over seeds of the longest any task waited
open before its first claim.

| Agents | Model | Landed/min | Rework % | Draining 1,500: all landed, median s | Slowest wait, s |
| --- | --- | --- | --- | --- | --- |
| 100 | group commit, co-change 5 (as deployed) | 64.5 → 64.5 | 10.0 → 10.0 | 2,029 → 2,029 | 2,193 → 2,193 |
| 1,000 | group commit, co-change 5 (as deployed) | 157.9 → 157.9 | 27.6 → 27.6 | 1,801 → 1,801 | 1,450 → 1,450 |
| 100 | per-lane commits, co-change 5 | 63.4 → 63.4 | 10.0 → 10.0 | 2,042 → 2,042 | 2,167 → 2,192 |
| 1,000 | per-lane commits, co-change 5 | 86.3 → 86.3 | 26.2 → 26.2 | 2,051 → 2,051 | 1,917 → 1,917 |
| 1,000 | group commit, co-change 2 (the 2026-10-12 setting) | 175.9 → 175.9 | 31.2 → 31.2 | 1,697 → 1,697 | 1,742 → 1,742 |

- **Inhibition by the strongest file changes nothing a live-agent simulation can show**, by construction: live agents
  heartbeat, so every claim in the model is a fresh one (1), and a candidate has a claimed file at 0.5 or more whether
  claims are summed or not. The `+max` runs in [before/](before/) are identical to the summed ones, run for run. What
  it changes is the silent case above.
- **The age cap at 4 binds only on tasks older than 30 minutes**, which the deployed configuration rarely has: it moved
  only the 100-agent drains of seed 4, where the last task landed 1 s sooner in both group-commit models, and in the
  per-lane model one task's first claim came 3,240 s after it opened instead of 3,119 s, with the same drain time.

## Choosing the cap (SIMULATED)

Group commit with co-change at the deployed weight 5, alone and with import repulsion at weight 1, both inhibiting by
the strongest file; caps of 2, 3, 4 and 6 against none.

Steady state, 1,000 agents, mean of 3 seeds:

| Model | Cap | Landed/min | Rework % | Conflicts per 1,000 | Wait p99, s | Slowest wait, s |
| --- | --- | --- | --- | --- | --- | --- |
| co-change 5 | none | 158 | 27.6 | 173 | 901 | 1,188 |
| co-change 5 | 2 | 157 | 27.9 | 176 | 853 | 1,188 |
| co-change 5 | 3, 4 or 6 | 158 | 27.6 | 173 | 901 | 1,188 |
| co-change 5 + imports 1 | none | 150 | 15.2 | 93 | 890 | 1,169 |
| co-change 5 + imports 1 | 2 | 151 | 14.6 | 87 | 903 | 1,172 |
| co-change 5 + imports 1 | 3, 4 or 6 | 150 | 15.2 | 93 | 890 | 1,169 |

Draining 1,500 tasks, 5 seeds (median and slowest of the five drains):

| Agents | Model | Cap | All landed, median s | All landed, slowest s | Rework % | Slowest wait, s |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | co-change 5 | none | 2,029 | 3,353 | 10.0 | 3,119 |
| 100 | co-change 5 | 2 | 2,409 | 3,257 | 10.0 | 3,144 |
| 100 | co-change 5 | 3 | 2,277 | 3,171 | 10.0 | 3,068 |
| 100 | co-change 5 | 4 | 2,029 | 3,352 | 10.0 | 3,119 |
| 100 | co-change 5 | 6 | 2,029 | 3,353 | 10.0 | 3,119 |
| 1,000 | co-change 5 | none | 1,801 | 2,333 | 21.6 | 2,273 |
| 1,000 | co-change 5 | 2 | 2,020 | 2,333 | 21.5 | 2,273 |
| 1,000 | co-change 5 | 3 | 1,897 | 2,333 | 21.6 | 2,273 |
| 1,000 | co-change 5 | 4 or 6 | 1,801 | 2,333 | 21.6 | 2,273 |
| 100 | co-change 5 + imports 1 | none | 1,927 | 3,201 | 1.5 | 3,106 |
| 100 | co-change 5 + imports 1 | 2 | 1,926 | 2,549 | 0.9 | 2,490 |
| 100 | co-change 5 + imports 1 | 3 | 1,927 | 2,549 | 1.3 | 2,489 |
| 100 | co-change 5 + imports 1 | 4 | 1,927 | 2,549 | 1.3 | 2,489 |
| 100 | co-change 5 + imports 1 | 6 | 1,927 | 3,227 | 1.5 | 3,133 |
| 1,000 | co-change 5 + imports 1 | none | 1,953 | 3,743 | 13.3 | 3,084 |
| 1,000 | co-change 5 + imports 1 | 2 | 1,628 | 2,404 | 12.5 | 2,301 |
| 1,000 | co-change 5 + imports 1 | 3 | 2,019 | 2,370 | 13.1 | 2,266 |
| 1,000 | co-change 5 + imports 1 | 4 | 1,953 | 2,360 | 13.1 | 2,256 |
| 1,000 | co-change 5 + imports 1 | 6 | 1,953 | 3,837 | 13.3 | 3,743 |

- **The cap is about the tail.** In steady state no task waits long enough (the slowest wait is under 20 minutes, a
  multiplier under 3) for 3, 4 or 6 to bind. Draining a fixed set, old intents are what the cap is for.
- **With import repulsion on, a cap of 4 shortened the slowest drains:** 3,743 → 2,360 s at 1,000 agents and
  3,201 → 2,549 s at 100 agents, with the median unchanged and rework a little lower (13.3% → 13.1%; seed 1 at 1,000
  agents went from 14.2% to 13.1%). Uncapped, an old intent whose imported files were claimed outgrew its repulsion,
  was taken anyway, and came back; capped, it waited for those files to land. A cap of 6 never bound there.
- **Lower caps cost the anti-starvation purpose.** With co-change alone, 2 and 3 slowed the median drain (1,801 →
  2,020 and 1,897 s at 1,000 agents; 2,029 → 2,409 and 2,277 s at 100) and lowered no rework: once every old intent
  has the same multiplier, age stops ordering them. 4 left every co-change-only run as it was uncapped, to within a
  second.

So 4 is the smallest cap that costs nothing where repulsion is co-change only and keeps import repulsion working on old
intents. The model's limits stand as in 2026-10-12: one workload (hono's history), simulated agents with fixed timings,
and claims that are always fresh while an agent works.
