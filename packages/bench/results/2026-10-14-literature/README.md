# Literature-scan results (2026-10-14)

Checks of the mechanisms a literature triage suggested, on a preview with production's flags plus the new flags named per colony. All runs are labeled MEASURED; logs pass through `node packages/bench/src/evidence.ts redact`.

| Check | Result |
| --- | --- |
| Contest judge (`checks/bias_judge.log`) | `scripts/contest_bias.ts --contests 20`: two synthetic agents propose equal-evidence variants of one change (a one-line arrow function against a three-line function), the order alternating; the judge is asked in both orders. Orders agreed on a side 0 times; in 18 contests the judge saw no clear difference in both orders, in 2 it preferred whichever was shown first; the deterministic tie-break decided 20 of 20. Settle time median 1.9 s, max 2.4 s; 40 calls, $0.0028 ($0.0001 a contest). |
| Contest jury (`checks/bias_jury.log`) | With `FT_CONTEST_JURY` naming the colony (three small models from different families, each asked in both orders at once): a majority decided 7 of 20, the tie-break 13; of 60 member seats, 19 were inconsistent (17 positional, 2 late); settle time median 4.4 s, max 45 s; 120 calls, $0.0124 ($0.0006 a contest). Ties fell from 100% to 65% but not by half, settling took longer, and on equal variants a tie may be the right answer: the jury stays off in production. |
