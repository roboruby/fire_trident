# Round 11 results (2026-10-14)

Round-11 code on a preview with production's flags, and read-only checks of the live service. All runs are labeled MEASURED; logs pass through `node packages/bench/src/evidence.ts redact`.

| Check | Result |
| --- | --- |
| First red commit on a long history (`checks/bisect40.log`, `checks/bisect100.log`) | `scripts/bisect.ts --landings 40`: the 40 landings since green landed in 111.4 s, the search found the breaking landing in 6 test runs (432 ms), the fewest possible (ceil(log2 41) = 6). `--landings 100 --break-at 7`: 100 landings in 198.8 s, found in 7 runs (375 ms), the fewest possible. The "off" halves of both checks report a search too, because the preview had `FT_BISECT` on for every colony, as production does; they are not failures of the search. |
| Tours (`checks/tour_first-red.log`, `checks/tour_order-backend.log`, `checks/tour_p25_first-red.log`) | Against the live service: the first-red tour's 14 numbers and the order-backend tour's 13 agree with `/certifications`, `/review`, the snapshot and `/metrics` (hono's 10 unchanged); on the preview, the first-red tour on a 40-landing colony agrees on all 12. |
| Signed-notes card (`checks/signed_notes.log`) | On the preview with a test key: the signed check passes (a landing intact and signed by the key, a stock clone verifying it, a forged rewrite reading bad signature), and the card reads "Signed by <key id>", the key's since-date, "newest landing fc6c417: note intact and signed" and the stock-git line. The colony's first creation answered 500 twice while a 40-landing run was landing on the fresh preview; the third try, after that run, created it at once. |
| Try panel (`checks/tryit.log`) | `/#try` on the preview: four scenes render and the default merge scene prints the trunk writer's decision ("Lands as a line-by-line merge: trunk moved src/limits.ts …"); no horizontal scroll. |
