# Deterministic danger checks on fire_trident-all history

295 non-merge commits walked (`a5edad267b5a8fe065a406bdbcfc54f263ccf097`), 50f143c89b (2026-10-12) to a5edad267b (2026-10-17). Command: `node --experimental-transform-types packages/bench/src/danger/history.ts --repo . --name fire_trident-all --rev a5edad267b5a8fe065a406bdbcfc54f263ccf097 --out packages/bench/results/2026-10-17-danger`

Selection: non-merge commits from git log --no-merges (rename detection off), each against its parent; modified (M) regular files with new content, scripts (.js .jsx .mjs .cjs .ts .tsx .mts .cts), not tests (decide/signals.ts isTestPath), not matched by --exclude. Checks: decide/danger.ts scanDanger on each file with no intent (danger patterns, loosened guards, governance paths), the default policy's allowances (none), then triageDanger; texts read under the decide stage's limits (512 KiB, a NUL in the first 8 KiB, invalid UTF-8); flagged = a must-human hit or a danger signal.

| Measure | Count |
| --- | --- |
| Modified script files (all) | 1340 |
| Left out as tests | 233 |
| Left out by --exclude | 0 |
| Mode change only, or not a regular file | 0 |
| Files scanned (commit and path) | 1107 |
| Distinct paths scanned | 210 |
| Texts the decide stage would not read | 0 |
| Files flagged | 20 |
| Flagged: sent to a person | 12 |
| Flagged: danger signals only (a second opinion must look) | 8 |
| Commits with a scanned file | 188 |
| Commits with a flagged file | 16 |

- Files flagged: 20 of 1107 (1.8%, 95% CI 1.2% to 2.8%)
- Files sent to a person: 12 of 1107 (1.1%, 95% CI 0.6% to 1.9%)
- Loosened guard: 5 of 1107 (0.5%, 95% CI 0.2% to 1.1%)
- Commits with a flagged file: 16 of 188 (8.5%, 95% CI 5.3% to 13.4%)

## By danger class

| Class | Files | Share of files scanned | Hits |
| --- | --- | --- | --- |
| auth | 7 | 7 of 1107 (0.6%, 95% CI 0.3% to 1.3%) | 12 |
| loosened-guard | 5 | 5 of 1107 (0.5%, 95% CI 0.2% to 1.1%) | 5 |
| crypto | 4 | 4 of 1107 (0.4%, 95% CI 0.1% to 0.9%) | 5 |
| capability | 4 | 4 of 1107 (0.4%, 95% CI 0.1% to 0.9%) | 7 |
| secret | 1 | 1 of 1107 (0.1%, 95% CI 0.0% to 0.5%) | 1 |
| test-weakening | 1 | 1 of 1107 (0.1%, 95% CI 0.0% to 0.5%) | 1 |

## By pattern

| Pattern | Files | Hits |
| --- | --- | --- |
| auth:unauthorized | 6 | 6 |
| crypto:primitive | 4 | 5 |
| capability:network | 4 | 4 |
| loosened-guard:weakened-condition | 3 | 3 |
| auth:authorization-header | 2 | 2 |
| auth:bearer-scheme | 2 | 3 |
| capability:process | 1 | 3 |
| secret:logged | 1 | 1 |
| loosened-guard:deleted-limit-check | 1 | 1 |
| loosened-guard:removed-expiry-check | 1 | 1 |
| test-weakening:skip-or-only | 1 | 1 |
| auth:admin-gate | 1 | 1 |

## Paths flagged most often

| Path | Commits flagged |
| --- | --- |
| packages/worker/src/api/app.ts | 5 |
| packages/worker/src/api/vaccinate.ts | 2 |
| packages/web/src/App.tsx | 1 |
| packages/web/src/tour/Tour.tsx | 1 |
| packages/worker/src/agents/gitfs.ts | 1 |
| packages/worker/src/colony/ColonyDO.ts | 1 |
| packages/worker/src/decide/danger.ts | 1 |
| packages/worker/src/index.ts | 1 |
| packages/worker/src/mcp/gate.ts | 1 |
| packages/worker/src/mcp/tools.ts | 1 |
| packages/worker/src/region/RegionDO.ts | 1 |
| packages/worker/src/trunk/signature.ts | 1 |
| scripts/goal_conflict.ts | 1 |
| scripts/signed_notes.ts | 1 |
| scripts/verify_note.mjs | 1 |

## Flagged files

| Commit | Path | Tier | Hits |
| --- | --- | --- | --- |
| a67db55691 | packages/worker/src/trunk/signature.ts | second-opinion | crypto:primitive line 224: `const signBytes = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign(ALG, privateKey, data));`; crypto:primitive line 276: `await crypto.subtle.importKey("raw", fromBase64url(x), { name: ALG }, false, ["verify"]);` |
| a67db55691 | scripts/signed_notes.ts | person | capability:network line 134: `const signers = await fetch(SIGNERS_URL);`; capability:process line 225: `const verifyCommit = (commit: string) => spawnSync("git", ["-C", dir, "-c", "gpg.format=ssh", "-c", 'gpg.ssh.allowedSignersFile=${signersFi…`; capability:process line 228: `const raw = execFileSync("git", ["-C", dir, "cat-file", "commit", sha]);`; and 1 more |
| 91de86d207 | packages/worker/src/api/app.ts | second-opinion | loosened-guard:weakened-condition line 82: `if (!m \|\| !(await tokensEqual(m[1] ?? "", expected))) -> if (!m \|\| !(await bearerMatches(m[1] ?? "", expected)))` |
| 91de86d207 | packages/worker/src/api/vaccinate.ts | second-opinion | loosened-guard:weakened-condition line 34: `if (!m \|\| !(await sameSecret(m[1] ?? "", expected))) -> if (!m \|\| !(await bearerMatches(m[1] ?? "", expected)))` |
| 91de86d207 | packages/worker/src/mcp/gate.ts | second-opinion | loosened-guard:weakened-condition line 22: `if (!m \|\| !(await tokensEqual(m[1] ?? "", expected))) -> if (!m \|\| !(await bearerMatches(m[1] ?? "", expected)))` |
| d7021a0283 | packages/web/src/tour/Tour.tsx | person | capability:network line 130: `fetch('/api/colonies/${encodeURIComponent(store.colonyId)}${suffix}', { headers: { accept: "application/json" } }).then((res) => (res.ok ? …` |
| 705e20c093 | scripts/verify_note.mjs | person | capability:network line 46: `doc = /^https?:\/\//.test(keysFrom) ? await fetch(keysFrom).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ${r.status}')))) …`; crypto:primitive line 52: `const idOf = (k) => createHash("sha256").update(Buffer.from(k, "base64url")).digest("hex").slice(0, 16);` |
| 0722300b5f | scripts/goal_conflict.ts | person | secret:logged line 45: `console.error("   or: FT_MCP_TOKEN=<redacted> FT_ADMIN_TOKEN=<redacted> node scripts/goal_conflict.ts --url <deployment> --demo <colony>");` |
| 501ad217d2 | packages/worker/src/mcp/tools.ts | second-opinion | crypto:primitive line 269: `const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));` |
| 20890ebfd2 | packages/worker/src/api/app.ts | person | auth:unauthorized line 479: `throw ftError(403, 'agent ${b.agentId} is an in-platform agent; it proposes through the platform, not this API');` |
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
