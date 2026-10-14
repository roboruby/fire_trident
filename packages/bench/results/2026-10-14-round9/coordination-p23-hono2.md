## Coordination: p23-hono2

Trunk a1ded7b: 196 landing commits and 0 system commits, 196 read from lineage notes and 0 from trailers and the API; record recorded, 5,195 events; region depth 3. Definitions: scripts/coordination.rb.

| Measure | Value |
| --- | --- |
| Proposals merged | 283 of 283 (1.000); 0 returned, 0 redirected, 0 rejected, 0 in flight |
| Intents merged | 283 of 283 (1.000) |
| Code sharing, median agent | 0.000 over whole files, 0.000 over agent-written lines (21 agents, 283 files; 0 lines unattributed) |
| Specialization, median top-region share | 0.188 against 0.158 shuffled (+0.030, p 0.001; 21 agents with 3+ landings) |
| Returns, cumulative over 3 min | 0: stale 0, text merge 0, review 0, rule 0, other 0 |
| Hottest file | none: no returns |
| Sprawl | top-level directories 9 → 9, regions 127 → 127 over 196 commits |
| Lines per landed intent | 0.00 (+959 −958 over 283 intents); 78,668 lines in 283 agent-touched files, 959 agent-written |
| Where the time went | 2,073.8 agent-seconds over 283 landed intents, from claim to landing: agent work 932.2 (45.0%, median 2.2 s), review 50.8 (2.4%, median 0.1 s), waiting to land 1,090.8 (52.6%, median 1.8 s), rework 0.0 (0.0%, median 0.0 s); 52.6% of agent time waiting to land |
| Critical path to the last landing | `int_mv8ajenmsfc75g` (Relative imports in src name their file, so Hono runs on Deno, JSR and Node buil) landed at +158.5 s in lnd_mv8am77uc0xicd (1 change): claimed at +152.8 s, 1 proposal; agent work 5.0 s, rework 0.0 s, review 0.1 s, ready to landed 0.6 s (the lane and the trunk writer together); 5.7 s from claim to landing |
