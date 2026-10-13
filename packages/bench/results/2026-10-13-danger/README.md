# Danger checks on real history, 2026-10-13

How often the decide stage's deterministic danger checks fire on ordinary, accepted commits. `packages/bench/src/danger/history.ts` walks a local git repository, takes every modified script file that is not a test, and runs on its text before and after the commit the same functions the decide engine calls before any model (`decide/danger.ts`: danger patterns, loosened guards, governance paths), fed the way the engine feeds them. No network, no models, no colony; the detectors were not changed.

A file is **flagged** when the deterministic stage would not let it land on its own: a hit that sends it to a person (auth, secret, a capability nothing asked for, governance), or a danger signal that a second opinion or a person must clear (a loosened guard, crypto, test weakening). Each file is checked on its own with no intent, so nothing is asked for: the strictest reading. On a colony, an intent a person or a rule wrote can ask for a process, network, eval or crypto capability; nothing waives a loosened guard.

## Runs

| Run | Range | Non-merge commits | Files scanned | Flagged | Sent to a person | Loosened guard | Commits flagged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [fire_trident](fire_trident.md) | all history up to `555f92a` (2026-10-12 to 2026-10-13) | 80 | 326 | 31 (9.5%, 95% CI 6.8% to 13.2%) | 28 (8.6%) | 2 (0.6%, CI 0.2% to 2.2%) | 21 of 60 |
| [hono](hono.md) | all history up to `588ec13` (2021-12-15 to 2026-10-13), `deno_dist/` left out | 2,794 | 3,559 | 38 (1.1%, CI 0.8% to 1.5%) | 16 (0.4%) | 13 (0.4%, CI 0.2% to 0.6%) | 34 of 1,838 |
| [hono-last-1000](hono-last-1000.md) | the last 1,000 non-merge commits up to `588ec13` (2024-06-06 to 2026-10-13) | 1,000 | 1,137 | 12 (1.1%, CI 0.6% to 1.8%) | 6 (0.5%) | 5 (0.4%, CI 0.2% to 1.0%) | 11 of 690 |
| [hono-with-deno-dist](hono-with-deno-dist.md) | as `hono`, with `deno_dist/` | 2,794 | 4,997 | 55 (1.1%, CI 0.8% to 1.4%) | 22 (0.4%) | 19 (0.4%) | 36 of 1,876 |

Files scanned count each (commit, path) once. Every flagged file, with its hits (pattern, line, excerpt) and, for Hono, a link to the line at that commit, is in the run's JSON; the markdown files list them too.

## What fires

- **fire_trident: 21 of its 31 flagged files are SQL statements.** Every one of the 165 `capability:process` hits is a Durable Object SQLite call, `this.sql.exec("UPDATE ...")`, which the process pattern reads as `exec("...")`, so a change that adds a SQL statement is sent to a person as new process capability. Of the 21 flagged commits, 9 are flagged by something else. The other 10 flagged files: the platform's own auth code (bearer and admin-token checks in `api/app.ts`, `api/vaccinate.ts`, `index.ts`: 5 files), the detector's own source (`decide/danger.ts`, its 401 and constant-time patterns), a `fetch(` in the agents' git HTTP client (`agents/gitfs.ts`), a local function `fit()` that scales the web page to the window read as a focused test, and two loosened guards that are not security checks (a removed `instanceof CallLimiter` branch read as a deleted limit check, and `isExpired(...)` replaced by a score threshold read as a removed expiry check).
- **Hono: 38 of 3,559 files (1.1%), 31 of them under auth, JWT, JWK, CSRF, CORS, cookie, secure-headers, crypto or etag paths.** Loosened guard: 13 files in 13 commits, 12 in JWT, bearer-auth, basic-auth, CSRF or signed-cookie code and one in the router (a duplicate-parameter check). Among them: the JWT middleware moved to another file (`1b2a4c0800`, 2024-05-24), read as a deleted 401 throw; new arguments to two existing 401 responses in bearer-auth (`96d2a89c57`, 2025-11-14), read as deleted 401s; and JWT `exp` and `nbf` checks made conditional on options (`cf0e01ee9e`), a change a person would want to see. The other flagged files are auth code (401 responses, bearer parsing, the cache middleware's new Authorization-header check, a CORS `credentials` option read as a credential comparison), crypto use (`crypto.subtle` and hashes for etags, signed cookies, timing-safe compares and a CSP nonce), and new network capability (a `fetch(` of a JWKS URI, a `WebSocket` in the client, an `http` import, an example's `fetch(`).
- **Hono's newest 251 non-merge commits (all after 2026-05-19) flag nothing.** The newest flagged commit is the 252nd from the head.

These are alarms on commits the projects accepted, so the flagged rate is an upper bound on false alarms: some flagged changes are exactly what a person should see.

## Against the old claim

`docs/ARCHITECTURE.md` says: "A sweep over 14,777 modified files of real history fired on 0.6% (nearly all in auth or permission code) and never on Hono's last 222 commits." No script or results for it were committed. Measured here with a committed script: the loosened-guard detector fires on 13 of 3,559 modified Hono script files (0.4%, 95% CI 0.2% to 0.6%), 12 of the 13 in auth, JWT, CSRF or signed-cookie code, and on 2 of 326 fire_trident files (0.6%), neither a security check; nothing fires in Hono's newest 251 commits. All the deterministic danger checks together flag 1.1% of Hono's modified script files and 9.5% of fire_trident's, most of fire_trident's from the SQL pattern above.

## Method

- Commits: `git log --no-merges` over the range (merges' own conflict resolutions are not read), each diffed against its parent with rename detection off, so a rename is a deletion and an addition, as a colony sees it.
- Files: modified (status M) regular files whose content changed, scripts (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`), not tests (`decide/signals.ts` `isTestPath`), not matched by `--exclude`. Added and deleted files are not scanned.
- Checks: `scanDanger` on one file with no intent, the default policy's allowances (none), then `triageDanger` (`packages/bench/src/danger/checks.ts`). Texts are read under the decide stage's limits (over 512 KiB, a NUL in the first 8 KiB, or not UTF-8: not read); no text was over them here. A colony's own allowances and tolerating antibodies are not applied.
- `deno_dist/`: Hono kept a generated copy of `src/` in the repository until 2024-05-24 (1,438 modified entries); the main run leaves it out, and the run with it shows the same rate.
- Excerpts are the detector's own (secret-looking values masked), passed through the bench redaction (`output.ts` `publishable`).

## Reproduce

Hono was cloned on 2026-10-13 at 18:43 UTC; `--rev` pins the head used. From the repository root (`--disable-warning` only silences Node's notice about the type transform; `decide/danger.ts` needs the transform):

    git clone --no-checkout https://github.com/honojs/hono <scratch>/hono-history
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo . --name fire_trident --rev 555f92a249f7f66419d063142565abd7f3843e83 --out packages/bench/results/2026-10-13-danger
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo <scratch>/hono-history --name hono --rev 588ec13fa68ea44fed1b5e1b503341db2bf09d70 --exclude '^deno_dist/' --link https://github.com/honojs/hono --out packages/bench/results/2026-10-13-danger
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo <scratch>/hono-history --name hono-last-1000 --rev 588ec13fa68ea44fed1b5e1b503341db2bf09d70 --max-count 1000 --link https://github.com/honojs/hono --out packages/bench/results/2026-10-13-danger
    node --experimental-transform-types --disable-warning=ExperimentalWarning packages/bench/src/danger/history.ts --repo <scratch>/hono-history --name hono-with-deno-dist --rev 588ec13fa68ea44fed1b5e1b503341db2bf09d70 --link https://github.com/honojs/hono --out packages/bench/results/2026-10-13-danger

Each run takes 3 to 25 s. The fire_trident range is all of its history up to the round 2 main (`555f92a`); its commit ids change if that history is rewritten before publication.

The same checks run on a labeled corpus of changes with `packages/bench/src/danger/evaluate.ts <corpus.json> --out <dir>` (catch rate and false-alarm rate with Wilson 95% intervals); `packages/bench/data/danger-sample-corpus.json` shows the format and measures nothing.
