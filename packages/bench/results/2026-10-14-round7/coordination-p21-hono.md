## Coordination: p21-hono

Trunk 97824b7: 193 landing commits and 0 system commits, 193 read from lineage notes and 0 from trailers and the API; record recorded, 5,088 events; region depth 3. Definitions: scripts/coordination.rb.

| Measure | Value |
| --- | --- |
| Proposals merged | 283 of 283 (1.000); 0 returned, 0 redirected, 0 rejected, 0 in flight |
| Intents merged | 283 of 283 (1.000) |
| Code sharing, median agent | 0.000 over whole files, 0.000 over agent-written lines (21 agents, 283 files; 0 lines unattributed) |
| Specialization, median top-region share | 0.188 against 0.154 shuffled (+0.034, p 0.001; 21 agents with 3+ landings) |
| Returns, cumulative over 3 min | 0: stale 0, text merge 0, review 0, rule 0, other 0 |
| Hottest file | none: no returns |
| Sprawl | top-level directories 9 → 9, regions 127 → 127 over 193 commits |
| Lines per landed intent | 0.00 (+959 −958 over 283 intents); 78,668 lines in 283 agent-touched files, 959 agent-written |
| Where the time went | 1,906.0 agent-seconds over 283 landed intents, from claim to landing: agent work 700.9 (36.8%, median 1.9 s), review 34.4 (1.8%, median 0.1 s), waiting to land 1,170.7 (61.4%, median 2.3 s), rework 0.0 (0.0%, median 0.0 s); 61.4% of agent time waiting to land |
| Critical path to the last landing | `int_mv850dpi9gvnpz` (Relative imports in src name their file, so Hono runs on Deno, JSR and Node buil) landed at +152.6 s in lnd_mv85321aq3fgf0 (1 change): claimed at +143.1 s, 1 proposal; agent work 8.9 s, rework 0.0 s, review 0.1 s, ready to landed 0.5 s (the lane and the trunk writer together); 9.5 s from claim to landing |
