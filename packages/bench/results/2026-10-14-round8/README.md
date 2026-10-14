# Round 8 results (2026-10-14)

Round-8 code on a preview with production's flags, then two showcase runs on the live service. All runs are labeled MEASURED; logs pass through `node packages/bench/src/evidence.ts redact`.

| Check | Result |
| --- | --- |
| Model spend (`p22-hono.log`, `p22-hono-spend.json`) | A 20-agent Gemma Hono run: 958 → 0 in 132.0 s, 283 landed, 0 returned. The demo's estimate from the agents' token counters was $0.0435; the colony's own `spend` priced its agents at $0.0435037, plus $0.00030356 of review (Clef and a second opinion), $0.04380726 in all, $0.0001548 a landed intent, with nothing unpriced. |
| First red commit (`checks/bisect.log`) | With `FT_BISECT` naming one colony: after three good landings, one that broke a test and two more, certification went red and the search found the breaking landing in 3 test runs (267 ms) over the 6 landings since green, naming its commit, its proposal with the file it changed, and its intent; a `bisect` event followed the red result and the repair intent's why names the commit. The colony the flag does not name got no search. |
| Goal-conflict demo (`checks/goal_demo.log`, preview) | The Rust change landed; the Go and TypeScript changes wait for a person, each naming the landing it would undo. The script decides nothing. |
| 2,000-agent rehearsal (`checks/p22-scale.log`, `p22-scale.json`) | 2,000 joined; 5,959 changes landed in 1,132 trunk commits over 133 s from the first landing to the last (2,690 a minute), time to land p50 11.3 s, p95 17.1 s, 0 returned; 67,025 events in the record. |
| Goal-conflict demo on production (`checks/goal_demo_production.log`) | `order-backend`: the same result on the live service; the two held changes are left for a person. |
| Scale on production (`checks/scale-production.log`, `scale-production.json`) | `scale`: 2,000 joined; 6,606 changes landed in 1,350 trunk commits over 145 s from the first landing to the last (2,730 a minute), time to land p50 9.6 s, p95 15.2 s. |
