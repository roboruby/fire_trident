# Deterministic danger checks on hono-last-1000 history

1000 non-merge commits walked (`588ec13fa68ea44fed1b5e1b503341db2bf09d70`, at most 1000), 8c5463f62b (2024-06-06) to 588ec13fa6 (2026-10-13). Command: `node --experimental-transform-types packages/bench/src/danger/history.ts --repo <scratch>/hono-history --name hono-last-1000 --rev 588ec13fa68ea44fed1b5e1b503341db2bf09d70 --max-count 1000 --link https://github.com/honojs/hono --out packages/bench/results/2026-10-17-danger`

Selection: non-merge commits from git log --no-merges (rename detection off), each against its parent; modified (M) regular files with new content, scripts (.js .jsx .mjs .cjs .ts .tsx .mts .cts), not tests (decide/signals.ts isTestPath), not matched by --exclude. Checks: decide/danger.ts scanDanger on each file with no intent (danger patterns, loosened guards, governance paths), the default policy's allowances (none), then triageDanger; texts read under the decide stage's limits (512 KiB, a NUL in the first 8 KiB, invalid UTF-8); flagged = a must-human hit or a danger signal.

| Measure | Count |
| --- | --- |
| Modified script files (all) | 1906 |
| Left out as tests | 769 |
| Left out by --exclude | 0 |
| Mode change only, or not a regular file | 0 |
| Files scanned (commit and path) | 1137 |
| Distinct paths scanned | 217 |
| Texts the decide stage would not read | 0 |
| Files flagged | 12 |
| Flagged: sent to a person | 6 |
| Flagged: danger signals only (a second opinion must look) | 6 |
| Commits with a scanned file | 690 |
| Commits with a flagged file | 11 |

- Files flagged: 12 of 1137 (1.1%, 95% CI 0.6% to 1.8%)
- Files sent to a person: 6 of 1137 (0.5%, 95% CI 0.2% to 1.1%)
- Loosened guard: 5 of 1137 (0.4%, 95% CI 0.2% to 1.0%)
- Commits with a flagged file: 11 of 690 (1.6%, 95% CI 0.9% to 2.8%)

## By danger class

| Class | Files | Share of files scanned | Hits |
| --- | --- | --- | --- |
| auth | 5 | 5 of 1137 (0.4%, 95% CI 0.2% to 1.0%) | 6 |
| loosened-guard | 5 | 5 of 1137 (0.4%, 95% CI 0.2% to 1.0%) | 7 |
| crypto | 2 | 2 of 1137 (0.2%, 95% CI 0.0% to 0.6%) | 3 |
| capability | 1 | 1 of 1137 (0.1%, 95% CI 0.0% to 0.5%) | 1 |

## By pattern

| Pattern | Files | Hits |
| --- | --- | --- |
| loosened-guard:weakened-condition | 3 | 4 |
| auth:bearer-scheme | 2 | 2 |
| auth:credential-compare | 2 | 3 |
| crypto:primitive | 2 | 3 |
| auth:authorization-header | 1 | 1 |
| loosened-guard:deleted-401-return | 1 | 2 |
| loosened-guard:deleted-throw | 1 | 1 |
| capability:network | 1 | 1 |

## Paths flagged most often

| Path | Commits flagged |
| --- | --- |
| src/utils/jwt/jwt.ts | 3 |
| src/middleware/etag/index.ts | 2 |
| src/middleware/bearer-auth/index.ts | 1 |
| src/middleware/cache/index.ts | 1 |
| src/middleware/cors/index.ts | 1 |
| src/middleware/csrf/index.ts | 1 |
| src/middleware/jwk/jwk.ts | 1 |
| src/middleware/jwt/jwt.ts | 1 |
| src/utils/jwt/jws.ts | 1 |

## Flagged files

| Commit | Path | Tier | Hits |
| --- | --- | --- | --- |
| 5463db2735 | src/middleware/jwk/jwk.ts | person | auth:bearer-scheme line 82: `if (parts.length !== 2 \|\| parts[0].toLowerCase() !== 'bearer') {` |
| 5463db2735 | src/middleware/jwt/jwt.ts | person | auth:bearer-scheme line 83: `if (parts.length !== 2 \|\| parts[0].toLowerCase() !== 'bearer') {` |
| 568c2ecc1d | src/middleware/cache/index.ts | person | auth:authorization-header line 142: `if (c.req.method !== 'GET' \|\| c.req.raw.headers.has('Authorization')) {` |
| 66fe9feec2 | src/middleware/cors/index.ts | person | auth:credential-compare line 123: `if (opts.origin !== '*' \|\| opts.credentials) {`; auth:credential-compare line 161: `if (opts.origin !== '*' \|\| opts.credentials) {` |
| 96d2a89c57 | src/middleware/bearer-auth/index.ts | second-opinion | loosened-guard:deleted-401-return line 162: `removed: if (!headerToken) { await throwHTTPException(c, 401, '${wwwAuthenticatePrefix}realm="${realm}"', options.noAuthenticationHeaderMes…`; loosened-guard:deleted-401-return line 200: `removed: if (!equal) { await throwHTTPException(c, 401, '${wwwAuthenticatePrefix}error="invalid_token"', options.invalidTokenMessage \|\| 'Un…` |
| 95ae4d3721 | src/utils/jwt/jwt.ts | second-opinion | loosened-guard:deleted-throw line 161: `removed: if (opts.aud && !matched) { throw new JwtTokenAudience(opts.aud, payload.aud)` |
| 117d0a413f | src/middleware/csrf/index.ts | second-opinion | loosened-guard:weakened-condition line 136: `if (!isSafeMethodRe.test(c.req.method) && isRequestedByFormElem…) gained !isAllowedSecFetchSite(c.req.header('sec-fetch-site'), c)` |
| cf0e01ee9e | src/utils/jwt/jwt.ts | second-opinion | loosened-guard:weakened-condition line 123: `if (payload.nbf && payload.nbf > now) -> if (opts.nbf && payload.nbf && payload.nbf > now)`; loosened-guard:weakened-condition line 126: `if (payload.exp && payload.exp <= now) -> if (opts.exp && payload.exp && payload.exp <= now)` |
| d6757c7241 | src/middleware/etag/index.ts | second-opinion | crypto:primitive line 38: `if (crypto && crypto.subtle) {`; crypto:primitive line 40: `crypto.subtle.digest(` |
| 438983b3bb | src/middleware/etag/index.ts | second-opinion | crypto:primitive line 63: `crypto.subtle.digest(` |
| 6837649cd1 | src/utils/jwt/jwt.ts | person | capability:network line 130: `const response = await fetch(options.jwks_uri, init)` |
| 0a99bd3e74 | src/utils/jwt/jws.ts | person | auth:credential-compare line 53: `if (key.type !== 'private' && key.type !== 'secret') {`; loosened-guard:weakened-condition line 53: `if (key.type !== 'private') -> if (key.type !== 'private' && key.type !== 'secret')` |
