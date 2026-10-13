# Round 2 checks on a preview deployment, 2026-10-13

Measured on a Workers preview deployment (its own Durable Objects; Artifacts shared with production), with the code of
the round-2 commit, `FT_REVALIDATE` on for one colony and `FT_IMPORT_WEIGHT=1`. Both colonies are fresh imports of
Hono (583 files, region depth 3).

## Assumption revalidation: the cascade, on and off

`packages/bench/src/scenarios/cascade.ts --readers 30 --shared src/hono.ts --imports`: 30 API agents each take an intent
in the `src` region and push a new module that imports `Hono` from `src/hono.ts`; then a writer lands a real edit to
`src/hono.ts` that adds an export and removes none; then the readers propose. Every reader read the old blob of
`src/hono.ts`, so without revalidation the lane returns all of them as stale.

| Colony | Revalidation | Name assumptions recorded | Landed on the first proposal | Returned stale | σ max | Region inhibited |
| --- | --- | --- | --- | --- | --- | --- |
| `cascade-revalidate-on.json` | on | 30 of 30 | 30 | 0 | 0 | 0 times |
| `cascade-revalidate-off.json` | off | 0 (recorded only when on) | 0 | 30 | 29 | 14 times |

With it off, the 30 returned readers re-proposed after rework and landed in 9 later commits; with it on, nothing went
back and no rework happened. Revalidation checks names only: a change whose imported names survive but whose
behavior changed still lands, and trunk certification is the backstop.

Reproduce (needs an admin token for the deployment in `FT_TOKEN`, and the colony imported first with `ft import`):

    FT_URL=https://<deployment> node packages/bench/src/scenarios/cascade.ts --colony <colony> --readers 30 \
      --shared src/hono.ts --imports --out cascade.json
