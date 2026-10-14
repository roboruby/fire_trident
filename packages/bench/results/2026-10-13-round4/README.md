# Round 4 scale runs on a preview deployment, 2026-10-13

Measured on Workers preview p18 (its own Durable Objects; Artifacts namespaces shared with production) with the round-4
code (`FT_INLINE`, `FT_VIRTUAL_CHECKOUT`, `FT_CULPRITS` and `FT_DELETION_GUARD` on; `FT_ASYNC_PUBLISH` per run). One
colony, `p18-scale2`: created empty with 64 regions (region depth 2), a workspace pool of 6,000 forks, review off.
Synthetic API agents (no model calls, no work time), 120 s runs with a 10 s ramp; landings per minute are counted from
the live landing feed between 25 s and 120 s. Driver: `packages/bench/src/live.ts`. `summary.json` collects the runs.

What the modes mean:

- **git path**: each proposal names a blob already on trunk (the README's), so the trunk writer reads it from the agent's
  workspace repository (`readBlob` on the Artifacts binding) and its push carries no new file contents. A real agent's
  change adds new blobs, so a real git-path cycle pays this read and a bigger push.
- **inline**: each proposal carries its new file's text (`contents`, checked against its git blob id), so the trunk
  writer reads nothing from workspaces: one call to the colony per cycle. Every text is new, so each landing adds one
  new blob to the push.
- **async**: `FT_ASYNC_PUBLISH` lists the colony. The trunk writer's cycle records its landings and moves its own main;
  a publish loop beside the cycles pushes everything recorded since its last push.

In the order they ran, all on the same colony:

| File | Mode | Agents | Landings/min | Landed in the run | Time to land p50 / p90 | Trunk cycle p50 | Of it, reading changes p50 | Push p50 | Failed calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `base-n1000.json` | git path, sync | 1,000 | 1,626, intents ran out | 3,000 of 3,000 | 15.6 / 21.9 s | 4.3 s | 3.2 s | 0.6 s, in the cycle | 0 of 27,816 |
| `inline-n1000.json` | inline, sync | 1,000 | 1,433, intents ran out | 3,000 of 3,000 | 9.9 / 12.5 s | 2.8 s | 0.6 s | 1.6 s, in the cycle | 0 of 28,469 |
| `base-n5000.json` | git path, sync | 5,000 | 1,821 | 3,761 | 19.1 / 25.0 s | 5.1 s | 3.9 s | 0.8 s, in the cycle | 666 of 55,965 |
| `inline-n5000.json` | inline, sync | 5,000 | **3,842** | 7,485 | 10.7 / 14.7 s | 2.8 s | 0.9 s | 1.6 s, in the cycle | 603 of 48,932 |
| `inline-async-n5000-fullwalk.json` | inline, async (first take check, 068b5df) | 5,000 | 3,776 | 7,502 | 8.0 / 20.8 s | 1.8 s | 1.2 s | 10.7 s, beside the cycle | 568 of 52,739 |
| `inline-async-n5000.json` | inline, async (c16c1fa) | 5,000 | 2,759 | 5,662 | 8.2 / 28.1 s | 2.5 s | 2.0 s | 6.3 s, beside the cycle | 456 of 51,961 |

Nothing was returned in any run. Failed calls were the load generator's own (`fetch failed`: connection resets, connect
timeouts and DNS failures, from one machine driving 5,000 agents) except where noted below.

What it shows:

- **Inline changes double the trunk writer's throughput.** At 5,000 agents the git path spends 3.9 s of a 5.1 s cycle
  reading blobs from workspaces, at the 200-proposal cap; inline changes cut that to 0.9 s, so the cycle takes 2.8 s and
  twice as many changes land, sooner (time to land p50 10.7 s instead of 19.1 s). The 1,000-agent runs ran out of
  intents (3 per agent), so their rates measure the supply, but their cycles show the same cut.
- **Asynchronous publishing takes the push out of the cycle but did not raise throughput at 5,000 agents.** The cycle
  fell to 1.8 to 2.5 s and stopped filling the 200-proposal cap, and median time to land fell to about 8 s, but landings
  a minute did not rise: the colony object became the limit. It answers every take and proposal and the trunk writer's
  call for inline contents (2.0 s at p50 in the last asynchronous run against 0.9 s in the synchronous one), and the
  slowest landings waited longer (p90 21 to 28 s). Pushes beside the cycle carried a backlog of 120 to 360 landings and
  took 6 to 11 s each.
- **The colony object slows as its history grows.** Every run added up to 15,000 intents and thousands of proposals to
  the same colony; the later runs did worse, and the last one (below) failed in its ramp with the colony answering
  "Durable Object is overloaded". The next scale step is to take work off that one object, not off the trunk writer.
- The git path was slower than on 2026-10-12, when the same code reached 2,778 landings a minute at 5,000 agents
  (`../2026-10-12-scale/`): its blob reads then took 2.2 s a cycle, today 3.9 s. The pull code has not changed since
  those runs; Artifacts read latency has.

The other runs:

- `inline-n5000-stopped.json` (after `base-n5000`): stopped itself at 15 s with 63% of calls failing in a 5 s window
  (the load generator's DNS and connection failures in the ramp, and some takes answered "Durable Object is
  overloaded"); `inline-n5000.json` is the rerun with the same settings.
- `inline-n5000-mixed.json` (after `inline-n5000`, 2,995 landings a minute) was meant to be asynchronous and was not: the
  colony object had restarted on the new `FT_ASYNC_PUBLISH`, its trunk writer had not, so the trunk writer still pushed
  every cycle. It exposed a real cost: with the colony's head off the published head, every take sorted the landings
  table and parsed the newest 500. Commit 068b5df made that check walk only the landings between the two heads, by an
  index, reused while neither head moves, and the driver now counts a colony as asynchronous only when its trunk writer
  says so (`publish.on`). The first asynchronous run then showed takes waiting for room 10,201 times (the colony's head
  moves with every landing, so the check still re-walked the whole backlog); commit c16c1fa walks only the landings
  since its last answer, and the waits fell to 237.
- `inline-n5000-b-stopped.json` (last, inline and synchronous again, to separate the mode from the colony's growth):
  stopped at 15 s; 1,110 registrations, 3,856 takes and 80 proposals failed, many of them answered "Durable Object is
  overloaded. Requests queued for too long."
- Runs on an earlier colony, `p18-scale`, created without a region depth: its 64 bench directories were one region, so
  admission control, not the trunk writer, set the pace. Not kept.

Reproduce (needs an admin token for the deployment in `FT_TOKEN`; a fresh colony with `regionDepth: 2` and
`poolTarget: 6000`, review off with `POST /api/colonies/<id>/decide/policy {"enabled":false}`):

    FT_URL=https://<deployment> node packages/bench/src/live.ts --colony <id> --agents 5000 --duration 120 \
      --expect-publish sync --out base-n5000.json
    FT_URL=https://<deployment> node packages/bench/src/live.ts --colony <id> --agents 5000 --duration 120 \
      --inline --expect-publish sync --out inline-n5000.json
    # with FT_ASYNC_PUBLISH listing the colony, once its trunk writer reports publish.on:
    FT_URL=https://<deployment> node packages/bench/src/live.ts --colony <id> --agents 5000 --duration 120 \
      --inline --expect-publish async --out inline-async-n5000.json
