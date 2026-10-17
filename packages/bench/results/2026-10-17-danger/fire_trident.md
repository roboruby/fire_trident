# Deterministic danger checks on fire_trident history

80 non-merge commits walked (`555f92a249f7f66419d063142565abd7f3843e83`), 50f143c89b (2026-10-12) to 555f92a249 (2026-10-13). Command: `node --experimental-transform-types packages/bench/src/danger/history.ts --repo . --name fire_trident --rev 555f92a249f7f66419d063142565abd7f3843e83 --out packages/bench/results/2026-10-17-danger`

Selection: non-merge commits from git log --no-merges (rename detection off), each against its parent; modified (M) regular files with new content, scripts (.js .jsx .mjs .cjs .ts .tsx .mts .cts), not tests (decide/signals.ts isTestPath), not matched by --exclude. Checks: decide/danger.ts scanDanger on each file with no intent (danger patterns, loosened guards, governance paths), the default policy's allowances (none), then triageDanger; texts read under the decide stage's limits (512 KiB, a NUL in the first 8 KiB, invalid UTF-8); flagged = a must-human hit or a danger signal.

| Measure | Count |
| --- | --- |
| Modified script files (all) | 409 |
| Left out as tests | 83 |
| Left out by --exclude | 0 |
| Mode change only, or not a regular file | 0 |
| Files scanned (commit and path) | 326 |
| Distinct paths scanned | 110 |
| Texts the decide stage would not read | 0 |
| Files flagged | 10 |
| Flagged: sent to a person | 7 |
| Flagged: danger signals only (a second opinion must look) | 3 |
| Commits with a scanned file | 60 |
| Commits with a flagged file | 9 |

- Files flagged: 10 of 326 (3.1%, 95% CI 1.7% to 5.6%)
- Files sent to a person: 7 of 326 (2.1%, 95% CI 1.0% to 4.4%)
- Loosened guard: 2 of 326 (0.6%, 95% CI 0.2% to 2.2%)
- Commits with a flagged file: 9 of 60 (15.0%, 95% CI 8.1% to 26.1%)

## By danger class

| Class | Files | Share of files scanned | Hits |
| --- | --- | --- | --- |
| auth | 6 | 6 of 326 (1.8%, 95% CI 0.8% to 4.0%) | 11 |
| loosened-guard | 2 | 2 of 326 (0.6%, 95% CI 0.2% to 2.2%) | 2 |
| crypto | 1 | 1 of 326 (0.3%, 95% CI 0.1% to 1.7%) | 1 |
| capability | 1 | 1 of 326 (0.3%, 95% CI 0.1% to 1.7%) | 1 |
| test-weakening | 1 | 1 of 326 (0.3%, 95% CI 0.1% to 1.7%) | 1 |

## By pattern

| Pattern | Files | Hits |
| --- | --- | --- |
| auth:unauthorized | 5 | 5 |
| auth:authorization-header | 2 | 2 |
| auth:bearer-scheme | 2 | 3 |
| crypto:primitive | 1 | 1 |
| loosened-guard:deleted-limit-check | 1 | 1 |
| loosened-guard:removed-expiry-check | 1 | 1 |
| capability:network | 1 | 1 |
| test-weakening:skip-or-only | 1 | 1 |
| auth:admin-gate | 1 | 1 |

## Paths flagged most often

| Path | Commits flagged |
| --- | --- |
| packages/worker/src/api/app.ts | 3 |
| packages/web/src/App.tsx | 1 |
| packages/worker/src/agents/gitfs.ts | 1 |
| packages/worker/src/api/vaccinate.ts | 1 |
| packages/worker/src/colony/ColonyDO.ts | 1 |
| packages/worker/src/decide/danger.ts | 1 |
| packages/worker/src/index.ts | 1 |
| packages/worker/src/region/RegionDO.ts | 1 |

## Flagged files

| Commit | Path | Tier | Hits |
| --- | --- | --- | --- |
| 9887501e05 | packages/worker/src/decide/danger.ts | person | auth:unauthorized line 547: `if (AUTH_DENIAL.test(t) && DENIAL_CONTEXT.test(t)) return { status: /\b401\b\|unauthori[sz]ed/i.test(t) ? "401" : "403", thrown };`; crypto:primitive line 509: `const CONSTANT_TIME = /\b(?:timingSafeEqual\|timingSafeCompare\|constantTimeEqual\|constantTimeCompare\|safeCompare\|secureCompare\|safeEqual)\s*…` |
| 3a6ed0322a | packages/worker/src/colony/ColonyDO.ts | second-opinion | loosened-guard:deleted-limit-check line 2865: `removed: if (shared instanceof CallLimiter)` |
| e2d1db9016 | packages/worker/src/api/app.ts | person | auth:authorization-header line 86: `const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");`; auth:bearer-scheme line 86: `const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");` |
| 29902e189f | packages/worker/src/api/app.ts | person | auth:unauthorized line 77: `return json({ error: "forbidden: writes need FT_ADMIN_TOKEN configured on the server" }, 403);` |
| 29902e189f | packages/worker/src/api/vaccinate.ts | person | auth:unauthorized line 41: `return json({ error: "forbidden: writes need FT_ADMIN_TOKEN configured on the server" }, 403);` |
| 24b8e8d7a4 | packages/worker/src/region/RegionDO.ts | second-opinion | loosened-guard:removed-expiry-check line 714: `if (!isExpired(toMark(r), now)) -> if (markValue(toMark(r), now) >= bar)` |
| 15238ddf89 | packages/worker/src/agents/gitfs.ts | person | capability:network line 111: `const res = await fetch(req.url, {` |
| 1c67f21746 | packages/web/src/App.tsx | second-opinion | test-weakening:skip-or-only line 84: `fit();` |
| d235cf4822 | packages/worker/src/api/app.ts | person | auth:unauthorized line 64: `if (!c.env.FT_ADMIN_TOKEN) return json({ error: "forbidden: this route needs FT_ADMIN_TOKEN configured on the server" }, 403);`; auth:admin-gate line 65: `return requireAdmin(c, next);` |
| 652597b880 | packages/worker/src/index.ts | person | auth:authorization-header line 26: `const header = req.headers.get("authorization") ?? "";`; auth:bearer-scheme line 27: `const bearer <redacted> header.startsWith("Bearer ") ? header.slice(7) : "";`; auth:bearer-scheme line 29: `return bearer <redacted> expected \|\| query === expected;`; and 1 more |
