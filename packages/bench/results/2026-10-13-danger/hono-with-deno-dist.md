# Deterministic danger checks on hono-with-deno-dist history

2794 non-merge commits walked (`588ec13fa68ea44fed1b5e1b503341db2bf09d70`), 4a68b0d8d7 (2021-12-15) to 588ec13fa6 (2026-10-13). Command: `node --experimental-transform-types packages/bench/src/danger/history.ts --repo <scratch>/hono-history --name hono-with-deno-dist --rev 588ec13fa68ea44fed1b5e1b503341db2bf09d70 --link https://github.com/honojs/hono --out packages/bench/results/2026-10-13-danger`

Selection: non-merge commits from git log --no-merges (rename detection off), each against its parent; modified (M) regular files with new content, scripts (.js .jsx .mjs .cjs .ts .tsx .mts .cts), not tests (decide/signals.ts isTestPath), not matched by --exclude. Checks: decide/danger.ts scanDanger on each file with no intent (danger patterns, loosened guards, governance paths), the default policy's allowances (none), then triageDanger; texts read under the decide stage's limits (512 KiB, a NUL in the first 8 KiB, invalid UTF-8); flagged = a must-human hit or a danger signal.

| Measure | Count |
| --- | --- |
| Modified script files (all) | 6971 |
| Left out as tests | 1973 |
| Left out by --exclude | 0 |
| Mode change only, or not a regular file | 1 |
| Files scanned (commit and path) | 4997 |
| Distinct paths scanned | 466 |
| Texts the decide stage would not read | 0 |
| Files flagged | 55 |
| Flagged: sent to a person | 22 |
| Flagged: danger signals only (a second opinion must look) | 33 |
| Commits with a scanned file | 1876 |
| Commits with a flagged file | 36 |

- Files flagged: 55 of 4997 (1.1%, 95% CI 0.8% to 1.4%)
- Files sent to a person: 22 of 4997 (0.4%, 95% CI 0.3% to 0.7%)
- Loosened guard: 19 of 4997 (0.4%, 95% CI 0.2% to 0.6%)
- Commits with a flagged file: 36 of 1876 (1.9%, 95% CI 1.4% to 2.6%)

## By danger class

| Class | Files | Share of files scanned | Hits |
| --- | --- | --- | --- |
| loosened-guard | 19 | 19 of 4997 (0.4%, 95% CI 0.2% to 0.6%) | 27 |
| crypto | 19 | 19 of 4997 (0.4%, 95% CI 0.2% to 0.6%) | 38 |
| auth | 17 | 17 of 4997 (0.3%, 95% CI 0.2% to 0.5%) | 29 |
| capability | 5 | 5 of 4997 (0.1%, 95% CI 0.0% to 0.2%) | 5 |

## By pattern

| Pattern | Files | Hits |
| --- | --- | --- |
| crypto:primitive | 19 | 37 |
| auth:unauthorized | 7 | 14 |
| loosened-guard:weakened-condition | 5 | 6 |
| loosened-guard:deleted-401-throw | 5 | 11 |
| capability:network | 4 | 4 |
| auth:bearer-scheme | 3 | 5 |
| loosened-guard:deleted-throw | 3 | 3 |
| auth:credential-compare | 2 | 3 |
| loosened-guard:deleted-401-return | 2 | 3 |
| auth:admin-gate | 2 | 2 |
| auth:constant-time-compare | 2 | 4 |
| loosened-guard:deleted-guard | 2 | 2 |
| loosened-guard:removed-constant-comparison | 2 | 2 |
| auth:authorization-header | 1 | 1 |
| crypto:weak | 1 | 1 |
| capability:import-network | 1 | 1 |

## Paths flagged most often

| Path | Commits flagged |
| --- | --- |
| src/middleware/jwt/index.ts | 8 |
| deno_dist/middleware/jwt/index.ts | 5 |
| src/utils/jwt/jwt.ts | 5 |
| src/middleware/bearer-auth/index.ts | 4 |
| deno_dist/middleware/bearer-auth/index.ts | 3 |
| deno_dist/utils/cookie.ts | 2 |
| deno_dist/utils/jwt/jwt.ts | 2 |
| src/middleware/basic-auth/index.ts | 2 |
| src/middleware/etag/index.ts | 2 |
| src/utils/cookie.ts | 2 |
| src/utils/crypto.ts | 2 |
| deno_dist/client/client.ts | 1 |
| deno_dist/middleware/basic-auth/index.ts | 1 |
| deno_dist/middleware/secure-headers/index.ts | 1 |
| deno_dist/router/reg-exp-router/router.ts | 1 |
| deno_dist/utils/crypto.ts | 1 |
| example/basic/index.js | 1 |
| src/client/client.ts | 1 |
| src/context.ts | 1 |
| src/middleware/cache/index.ts | 1 |

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
| 1b2a4c0800 | src/middleware/jwt/index.ts | second-opinion | loosened-guard:deleted-401-throw line 7: `removed: if (parts.length !== 2) { throw new HTTPException(401, {message: errDescription, res: unauthorizedResponse({ctx, error: 'invalid_r…` |
| 869cf28372 | deno_dist/middleware/secure-headers/index.ts | second-opinion | crypto:primitive line 115: `crypto.getRandomValues(buffer)` |
| 869cf28372 | src/middleware/secure-headers/index.ts | second-opinion | crypto:primitive line 114: `crypto.getRandomValues(buffer)` |
| 7425ffb3ca | deno_dist/middleware/bearer-auth/index.ts | person | auth:admin-gate line 63: `equal = await options.verifyToken(match[1], c)` |
| 7425ffb3ca | src/middleware/bearer-auth/index.ts | person | auth:admin-gate line 63: `equal = await options.verifyToken(match[1], c)` |
| 91265c8f49 | deno_dist/middleware/jwt/index.ts | second-opinion | loosened-guard:deleted-401-throw line 41: `removed: if (parts.length !== 2) { throw new HTTPException(401, {res: unauthorizedResponse({ctx, error: 'invalid_request', errDescription: …`; loosened-guard:deleted-401-throw line 58: `removed: if (!token) { throw new HTTPException(401, {res: unauthorizedResponse({ctx, error: 'invalid_request', errDescription: 'no authoriz…` |
| 91265c8f49 | src/middleware/jwt/index.ts | second-opinion | loosened-guard:deleted-401-throw line 41: `removed: if (parts.length !== 2) { throw new HTTPException(401, {res: unauthorizedResponse({ctx, error: 'invalid_request', errDescription: …`; loosened-guard:deleted-401-throw line 58: `removed: if (!token) { throw new HTTPException(401, {res: unauthorizedResponse({ctx, error: 'invalid_request', errDescription: 'no authoriz…` |
| 53b1653fa0 | deno_dist/utils/jwt/jwt.ts | second-opinion | loosened-guard:weakened-condition line 141: `if (encodedSignature !== tokenParts[2]) -> if (!verified)` |
| 53b1653fa0 | src/utils/jwt/jwt.ts | second-opinion | loosened-guard:weakened-condition line 141: `if (encodedSignature !== tokenParts[2]) -> if (!verified)` |
| 47f5c545f2 | deno_dist/client/client.ts | person | capability:network line 148: `return new WebSocket(targetUrl)` |
| 47f5c545f2 | src/client/client.ts | person | capability:network line 148: `return new WebSocket(targetUrl)` |
| 5fa31858be | deno_dist/middleware/jwt/index.ts | second-opinion | loosened-guard:deleted-401-throw line 40: `removed: if (parts.length !== 2) { throw new HTTPException(401, {res})`; loosened-guard:deleted-401-throw line 55: `removed: if (!token) { throw new HTTPException(401, {res})`; loosened-guard:deleted-401-throw line 73: `removed: if (!payload) { throw new HTTPException(401, {res})` |
| 5fa31858be | src/middleware/jwt/index.ts | second-opinion | loosened-guard:deleted-401-throw line 40: `removed: if (parts.length !== 2) { throw new HTTPException(401, {res})`; loosened-guard:deleted-401-throw line 55: `removed: if (!token) { throw new HTTPException(401, {res})`; loosened-guard:deleted-401-throw line 73: `removed: if (!payload) { throw new HTTPException(401, {res})` |
| f4ff712796 | deno_dist/middleware/bearer-auth/index.ts | person | auth:constant-time-compare line 53: `equal = await timingSafeEqual(options.token, match[1], options.hashFunction)`; auth:constant-time-compare line 56: `if (await timingSafeEqual(token, match[1], options.hashFunction)) {`; crypto:primitive line 53: `equal = await timingSafeEqual(options.token, match[1], options.hashFunction)`; and 1 more |
| f4ff712796 | src/middleware/bearer-auth/index.ts | person | auth:constant-time-compare line 53: `equal = await timingSafeEqual(options.token, match[1], options.hashFunction)`; auth:constant-time-compare line 56: `if (await timingSafeEqual(token, match[1], options.hashFunction)) {`; crypto:primitive line 53: `equal = await timingSafeEqual(options.token, match[1], options.hashFunction)`; and 1 more |
| d6ec48ee02 | deno_dist/utils/cookie.ts | second-opinion | crypto:primitive line 20: `return await crypto.subtle.importKey('raw', secretBuf, algorithm, false, ['sign', 'verify'])`; crypto:primitive line 25: `const signature = await crypto.subtle.sign(algorithm.name, key, new TextEncoder().encode(value))`; crypto:primitive line 39: `return await crypto.subtle.verify(algorithm, secret, signature, new TextEncoder().encode(value))`; and 1 more |
| d6ec48ee02 | src/utils/cookie.ts | second-opinion | crypto:primitive line 20: `return await crypto.subtle.importKey('raw', secretBuf, algorithm, false, ['sign', 'verify'])`; crypto:primitive line 25: `const signature = await crypto.subtle.sign(algorithm.name, key, new TextEncoder().encode(value))`; crypto:primitive line 39: `return await crypto.subtle.verify(algorithm, secret, signature, new TextEncoder().encode(value))`; and 1 more |
| 35246d0de6 | deno_dist/utils/cookie.ts | second-opinion | crypto:primitive line 19: `const key = await crypto.subtle.importKey('raw', encoder.encode(secret), algorithm, false, [`; crypto:primitive line 23: `const signature = await crypto.subtle.sign(algorithm.name, key, encoder.encode(value))` |
| 35246d0de6 | src/utils/cookie.ts | second-opinion | crypto:primitive line 19: `const key = await crypto.subtle.importKey('raw', encoder.encode(secret), algorithm, false, [`; crypto:primitive line 23: `const signature = await crypto.subtle.sign(algorithm.name, key, encoder.encode(value))` |
| d00a47ef70 | deno_dist/middleware/basic-auth/index.ts | person | auth:unauthorized line 64: `throw new HTTPException(401, { res })` |
| d00a47ef70 | deno_dist/middleware/bearer-auth/index.ts | person | auth:unauthorized line 37: `throw new HTTPException(401, { res })`; auth:unauthorized line 60: `throw new HTTPException(401, { res })` |
| d00a47ef70 | deno_dist/middleware/jwt/index.ts | person | auth:unauthorized line 31: `throw new HTTPException(401, { res })`; auth:unauthorized line 46: `throw new HTTPException(401, { res })`; auth:unauthorized line 64: `throw new HTTPException(401, { res })` |
| d00a47ef70 | src/middleware/basic-auth/index.ts | person | auth:unauthorized line 64: `throw new HTTPException(401, { res })` |
| d00a47ef70 | src/middleware/bearer-auth/index.ts | person | auth:unauthorized line 37: `throw new HTTPException(401, { res })`; auth:unauthorized line 60: `throw new HTTPException(401, { res })` |
| d00a47ef70 | src/middleware/jwt/index.ts | person | auth:unauthorized line 31: `throw new HTTPException(401, { res })`; auth:unauthorized line 46: `throw new HTTPException(401, { res })`; auth:unauthorized line 64: `throw new HTTPException(401, { res })` |
| d12a11937b | deno_dist/router/reg-exp-router/router.ts | second-opinion | loosened-guard:deleted-throw line 193: `removed: if (!verifyDuplicateParam([routes[i], routes[j]])) { throw new Error('Duplicate param name')` |
| d12a11937b | src/router/reg-exp-router/router.ts | second-opinion | loosened-guard:deleted-throw line 193: `removed: if (!verifyDuplicateParam([routes[i], routes[j]])) { throw new Error('Duplicate param name')` |
| 7345b8105d | deno_dist/utils/crypto.ts | second-opinion | crypto:primitive line 33: `const value = await createHash(chuck.value \|\| '', algorithm)` |
| 7345b8105d | src/utils/crypto.ts | second-opinion | crypto:primitive line 33: `const value = await createHash(chuck.value \|\| '', algorithm)` |
| 9f2a270c28 | deno_dist/middleware/jwt/index.ts | second-opinion | loosened-guard:removed-constant-comparison line 35: `if (parts.length !== 2) -> if (!token)` |
| dab3c26878 | src/middleware/jwt/index.ts | second-opinion | loosened-guard:removed-constant-comparison line 35: `if (parts.length !== 2) -> if (!token)` |
| 230d265429 | deno_dist/middleware/jwt/index.ts | second-opinion | crypto:primitive line 11: `if (!crypto.subtle \|\| !crypto.subtle.importKey) {`; crypto:primitive line 12: `throw new Error(''crypto.subtle.importKey' is undefined. JWT auth middleware requires it.')` |
| 230d265429 | deno_dist/utils/jwt/jwt.ts | second-opinion | crypto:primitive line 75: `if (!crypto.subtle \|\| !crypto.subtle.importKey) {`; crypto:primitive line 76: `throw new Error(''crypto.subtle.importKey' is undefined. JWT auth middleware requires it.')` |
| adc9cf80cf | src/middleware/jwt/index.ts | second-opinion | crypto:primitive line 11: `if (!crypto.subtle \|\| !crypto.subtle.importKey) {`; crypto:primitive line 12: `throw new Error(''crypto.subtle.importKey' is undefined. JWT auth middleware requires it.')` |
| adc9cf80cf | src/utils/jwt/jwt.ts | second-opinion | crypto:primitive line 75: `if (!crypto.subtle \|\| !crypto.subtle.importKey) {`; crypto:primitive line 76: `throw new Error(''crypto.subtle.importKey' is undefined. JWT auth middleware requires it.')` |
| d2a4b2dfb1 | src/utils/crypto.ts | second-opinion | crypto:weak line 21: `const algorithm: Algorithm = { name: 'MD5', alias: 'md5' }`; crypto:primitive line 22: `const hash = await createHash(data, algorithm)` |
| 92793399a3 | src/middleware/jwt/index.ts | person | auth:unauthorized line 16: `status: 401,`; auth:unauthorized line 27: `status: 401,` |
| e774e0760f | src/middleware/jwt/index.ts | person | auth:bearer-scheme line 18: `'WWW-Authenticate': 'Bearer <redacted>"${ctx.req.url}",error="invalid_request",error_description="no authorization included in request"',`; auth:bearer-scheme line 29: `'WWW-Authenticate': 'Bearer <redacted>"${ctx.req.url}",error="invalid_request",error_description="no authorization included in request"',`; auth:bearer-scheme line 47: `'WWW-Authenticate': 'Bearer <redacted>"${ctx.req.url}",error="invalid_token",error_description="token verification failure"',` |
| 62b9238601 | src/middleware/basic-auth/index.ts | second-opinion | loosened-guard:deleted-401-return line 75: `removed: if (requestUser) { ctx.res = new Response('Unauthorized', {status: 401, headers: {'WWW-Authenticate': 'Basic realm="' + options.re…` |
| d5280a1e0a | src/utils/buffer.ts | second-opinion | crypto:primitive line 44: `if (crypto && crypto.subtle) {`; crypto:primitive line 45: `const buffer = await crypto.subtle.digest(`; crypto:primitive line 57: `const hash = crypto.createHash('sha256').update(a).digest('hex')`; and 1 more |
| 1b54eb0fac | src/context.ts | person | capability:import-network line 0: `imports http` |
| cb4f3d6282 | src/util.ts | second-opinion | crypto:primitive line 54: `export const timingSafeEqual = async (a: any, b: any) => {`; crypto:primitive line 55: `const sa = await crypto.subtle.digest(`; crypto:primitive line 62: `const sb = await crypto.subtle.digest(` |
| 303db32e66 | example/basic/index.js | person | capability:network line 40: `const response = await fetch('https://example.com/')` |
