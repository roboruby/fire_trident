# Danger checks on real history, 2026-10-17: SQL is not a process

MEASURED. The sweep of [2026-10-13](../2026-10-13-danger/README.md) run again after one change to the detectors: the process pattern (`capability:process` in `decide/danger.ts`) leaves out a SQL statement run on a SQL handle (`decide/sqlexec.ts`). Same script (`packages/bench/src/danger/history.ts`), same ranges, same selection and the same strictest reading (each file on its own, no intent, the default policy's allowances); one more run covers all of FireTrident's history to date.

On 2026-10-13 the checks flagged 9.5% of FireTrident's own modified script files, and 21 of its 31 flagged files were flagged only by SQL: every one of the 165 `capability:process` hits was a Durable Object SQLite call such as `this.sql.exec("UPDATE intents SET ...")`, which the pattern read as `exec("...")`, running a program. Each of those sent its change to a person as new process capability.

## What changed

A call is a SQL statement, and not a process, when all of these hold (`decide/sqlexec.ts`):

- it calls `.exec(` (or `?.exec(`) on a receiver named `sql`, `sqlite`, `db` or `database`, in any case and as the last name of a chain (`sql`, `this.sql`, `this.host.sql`, `ctx.storage.sql`, `env.DB`), or chained on such a receiver from the line before (`const won = this.sql` then `.exec("UPDATE ...")`);
- its first argument is a string literal that starts with the first word of a SQL statement (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `ALTER`, `DROP`, `PRAGMA`, `WITH`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `VACUUM`, `ANALYZE`, `REINDEX`, `EXPLAIN`, `VALUES`) not followed by a letter, digit or hyphen, or a template literal that opens at the end of the line when the next line starts with one;
- the file imports no process module (`child_process`, `cluster`, `worker_threads`); in one that does, every `exec(` still counts.

Everything else that ran a program still fires, each shape with a test (`packages/worker/test/decide/danger-sql.test.ts`): a bare `exec("...")` even when its command starts with `SELECT`, `cp.exec`, `childProcess.exec`, `require("child_process").exec`, `execSync`, `execFileSync`, `spawnSync`, `spawn(`, `execFile(`, `Deno.run`, `Deno.Command`, `Bun.spawn`, a sandbox's `exec`, a SQL handle's `exec` of a command (`db.exec("curl ... | sh")`, `this.sql.exec("update-ca-certificates")`), a longer handle name (`mysql.exec`), a SQL call and a program on one line, a call chained on something that is not a SQL handle, and the process vaccine's line. Only the SQL call's own words are cut from the line, so another call on it still counts.

## Runs

| Run | Range | Files scanned | Flagged before | Flagged after | Sent to a person before | Sent to a person after | Commits flagged after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [fire_trident](fire_trident.md) | all history up to `555f92a` (the 2026-10-13 range), 80 non-merge commits | 326 | 31 (9.5%, 95% CI 6.8% to 13.2%) | 10 (3.1%, CI 1.7% to 5.6%) | 28 (8.6%) | 7 (2.1%, CI 1.0% to 4.4%) | 9 of 60 |
| [fire_trident-all](fire_trident-all.md) | all history up to `a5edad2` (2026-10-12 to 2026-10-17), 295 non-merge commits | 1,107 | 58 (5.2%, CI 4.1% to 6.7%) | 20 (1.8%, CI 1.2% to 2.8%) | 50 (4.5%) | 12 (1.1%, CI 0.6% to 1.9%) | 16 of 188 |
| [hono](hono.md) | all history up to `588ec13`, `deno_dist/` left out, 2,794 non-merge commits | 3,559 | 38 (1.1%, CI 0.8% to 1.5%) | 38 (1.1%), the same files | 16 (0.4%) | 16 (0.4%) | 34 of 1,838 |
| [hono-last-1000](hono-last-1000.md) | the last 1,000 non-merge commits up to `588ec13` | 1,137 | 12 (1.1%) | 12, the same | 6 (0.5%) | 6 | 11 of 690 |
| [hono-with-deno-dist](hono-with-deno-dist.md) | as `hono`, with `deno_dist/` | 4,997 | 55 (1.1%) | 55, the same | 22 (0.4%) | 22 | 36 of 1,876 |

Before: the 2026-10-13 results for the runs it has (reproduced the same on 2026-10-17 with the detectors as they were), and for `fire_trident-all` the same command run with the detectors of `a5edad2`. Every file the change stopped flagging was flagged only by SQL statements (21 of the 31; 38 of the 58 over all of FireTrident's history); no file was flagged that was not before, and no hit on a remaining file changed. Hono had no SQL hit, so nothing in Hono moved: its 1.1% is authentication, JWT, cookie and crypto code and new network calls.

## What is left, classified

True means the hit is what the pattern is for (a person or a second opinion should see the change); a false positive by pattern means the text matched but the code does not do what the pattern looks for.

FireTrident up to `555f92a`, 10 files:

| Commit | File | Tier | Hit | Reading |
| --- | --- | --- | --- | --- |
| `e2d1db9016` | `packages/worker/src/api/app.ts` | person | the Authorization header and bearer scheme of the admin check | true: authentication code |
| `29902e189f` | `packages/worker/src/api/app.ts` | person | a 403 when no admin token is configured | true: authentication code |
| `29902e189f` | `packages/worker/src/api/vaccinate.ts` | person | the same 403 | true: authentication code |
| `d235cf4822` | `packages/worker/src/api/app.ts` | person | a 403 and `requireAdmin(c, next)` | true: authentication code |
| `652597b880` | `packages/worker/src/index.ts` | person | the MCP bearer token check and its 401 | true: authentication code |
| `15238ddf89` | `packages/worker/src/agents/gitfs.ts` | person | `fetch(req.url, ...)` in the agents' git HTTP client | true: new network capability |
| `9887501e05` | `packages/worker/src/decide/danger.ts` | person | 401 and `timingSafeEqual` inside the detector's own regular expressions | false positive by pattern (the text is a pattern, not a use), on a change to the danger checks a person should see anyway |
| `3a6ed0322a` | `packages/worker/src/colony/ColonyDO.ts` | second opinion | a removed `instanceof CallLimiter` branch read as a deleted limit check | false positive by pattern |
| `24b8e8d7a4` | `packages/worker/src/region/RegionDO.ts` | second opinion | `isExpired(...)` replaced by a score threshold, read as a removed expiry check | false positive by pattern |
| `1c67f21746` | `packages/web/src/App.tsx` | second opinion | a local `fit()` read as a focused test | false positive by pattern |

Sent to a person: 7, of them 6 true (5 authentication, 1 network) and 1 false positive by pattern. The 3 second-opinion files never reach a person on their own.

The rest of FireTrident's history up to `a5edad2`, 10 more files:

| Commit | File | Tier | Hit | Reading |
| --- | --- | --- | --- | --- |
| `a67db55691` | `scripts/signed_notes.ts` | person | `spawnSync("git", ...)`, two `execFileSync("git", ...)` and a `fetch` | true: process and network capability (the process pattern still fires) |
| `705e20c093` | `scripts/verify_note.mjs` | person | a `fetch` of the keys and `createHash` | true: network capability and crypto |
| `d7021a0283` | `packages/web/src/tour/Tour.tsx` | person | a `fetch` of the colony's own API | true: network capability |
| `20890ebfd2` | `packages/worker/src/api/app.ts` | person | a 403 for an in-platform agent | true: authentication code |
| `0722300b5f` | `scripts/goal_conflict.ts` | person | a usage line that names the token variables (`FT_MCP_TOKEN=<...>`) read as a secret written to a log | false positive by pattern: no value is logged |
| `a67db55691` | `packages/worker/src/trunk/signature.ts` | second opinion | `crypto.subtle.sign` and `importKey` | true: crypto |
| `501ad217d2` | `packages/worker/src/mcp/tools.ts` | second opinion | `crypto.subtle.digest` | true: crypto |
| `91de86d207` | `packages/worker/src/api/app.ts`, `api/vaccinate.ts`, `mcp/gate.ts` | second opinion | one token compare helper swapped for another (`tokensEqual` to `bearerMatches`), read as a weakened condition | false positive by pattern, on authentication code a second opinion should see |

Over all of FireTrident's history: 12 sent to a person, 10 of them true (6 authentication, 4 network or process capability) and 2 false positives by pattern; 8 for a second opinion only, 2 true and 6 false positives by pattern.

Hono, unchanged: the 16 sent to a person are 12 in the authentication middleware (bearer and JWT parsing, 401s, a `verifyToken` gate, a constant-time compare, the cache middleware's Authorization check; one of them a CORS `credentials` option read as a credential comparison, a false positive by pattern) and 4 network (a JWKS `fetch`, the client's `WebSocket`, an example's `fetch`, an `http` import); the 22 for a second opinion only are 12 loosened guards (11 of them in JWT, bearer, basic-auth, CSRF or signed-cookie code) and 10 crypto uses ([2026-10-13](../2026-10-13-danger/README.md) has each).

These are alarms on commits the projects accepted, so the flagged rate is an upper bound on false alarms: some flagged changes are exactly what a person should see.

## Method

As on [2026-10-13](../2026-10-13-danger/README.md#method), with the detectors of this commit. The labeled corpus sample (`packages/bench/data/danger-sample-corpus.json`) shows the same change: its harmless SQL item (`hm-sql-exec`) is no longer a false alarm.

## Reproduce

Hono was cloned on 2026-10-13 at 18:43 UTC; `--rev` pins the head used. From the repository root:

    git clone --no-checkout https://github.com/honojs/hono <scratch>/hono-history
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo . --name fire_trident --rev 555f92a249f7f66419d063142565abd7f3843e83 --out packages/bench/results/2026-10-17-danger
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo . --name fire_trident-all --rev a5edad267b5a8fe065a406bdbcfc54f263ccf097 --out packages/bench/results/2026-10-17-danger
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo <scratch>/hono-history --name hono --rev 588ec13fa68ea44fed1b5e1b503341db2bf09d70 --exclude '^deno_dist/' --link https://github.com/honojs/hono --out packages/bench/results/2026-10-17-danger
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo <scratch>/hono-history --name hono-last-1000 --rev 588ec13fa68ea44fed1b5e1b503341db2bf09d70 --max-count 1000 --link https://github.com/honojs/hono --out packages/bench/results/2026-10-17-danger
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo <scratch>/hono-history --name hono-with-deno-dist --rev 588ec13fa68ea44fed1b5e1b503341db2bf09d70 --link https://github.com/honojs/hono --out packages/bench/results/2026-10-17-danger

The before counts of `fire_trident-all` come from the same command run on a checkout of `a5edad2`. FireTrident's commit ids change if its history is rewritten before publication.
