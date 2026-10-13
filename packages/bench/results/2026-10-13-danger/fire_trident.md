# Deterministic danger checks on fire_trident history

80 non-merge commits walked (`555f92a249f7f66419d063142565abd7f3843e83`), 50f143c89b (2026-10-12) to 555f92a249 (2026-10-13). Command: `node --experimental-transform-types packages/bench/src/danger/history.ts --repo . --name fire_trident --rev 555f92a249f7f66419d063142565abd7f3843e83 --out packages/bench/results/2026-10-13-danger`

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
| Files flagged | 31 |
| Flagged: sent to a person | 28 |
| Flagged: danger signals only (a second opinion must look) | 3 |
| Commits with a scanned file | 60 |
| Commits with a flagged file | 21 |

- Files flagged: 31 of 326 (9.5%, 95% CI 6.8% to 13.2%)
- Files sent to a person: 28 of 326 (8.6%, 95% CI 6.0% to 12.1%)
- Loosened guard: 2 of 326 (0.6%, 95% CI 0.2% to 2.2%)
- Commits with a flagged file: 21 of 60 (35.0%, 95% CI 24.2% to 47.6%)

## By danger class

| Class | Files | Share of files scanned | Hits |
| --- | --- | --- | --- |
| capability | 22 | 22 of 326 (6.7%, 95% CI 4.5% to 10.0%) | 166 |
| auth | 6 | 6 of 326 (1.8%, 95% CI 0.8% to 4.0%) | 11 |
| loosened-guard | 2 | 2 of 326 (0.6%, 95% CI 0.2% to 2.2%) | 2 |
| crypto | 1 | 1 of 326 (0.3%, 95% CI 0.1% to 1.7%) | 1 |
| test-weakening | 1 | 1 of 326 (0.3%, 95% CI 0.1% to 1.7%) | 1 |

## By pattern

| Pattern | Files | Hits |
| --- | --- | --- |
| capability:process | 21 | 165 |
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
| packages/worker/src/colony/ColonyDO.ts | 12 |
| packages/worker/src/api/app.ts | 3 |
| packages/worker/src/region/RegionDO.ts | 3 |
| packages/worker/src/pool/PoolDO.ts | 2 |
| packages/worker/src/trunk/TrunkDO.ts | 2 |
| packages/web/src/App.tsx | 1 |
| packages/worker/src/agents/gitfs.ts | 1 |
| packages/worker/src/api/vaccinate.ts | 1 |
| packages/worker/src/certify/certifier.ts | 1 |
| packages/worker/src/colony/direction.ts | 1 |
| packages/worker/src/decide/danger.ts | 1 |
| packages/worker/src/decide/store.ts | 1 |
| packages/worker/src/index.ts | 1 |
| packages/worker/src/pool/slots.ts | 1 |

## Flagged files

| Commit | Path | Tier | Hits |
| --- | --- | --- | --- |
| 9887501e05 | packages/worker/src/decide/danger.ts | person | auth:unauthorized line 547: `if (AUTH_DENIAL.test(t) && DENIAL_CONTEXT.test(t)) return { status: /\b401\b\|unauthori[sz]ed/i.test(t) ? "401" : "403", thrown };`; crypto:primitive line 509: `const CONSTANT_TIME = /\b(?:timingSafeEqual\|timingSafeCompare\|constantTimeEqual\|constantTimeCompare\|safeCompare\|secureCompare\|safeEqual)\s*…` |
| 3a6ed0322a | packages/worker/src/colony/ColonyDO.ts | second-opinion | loosened-guard:deleted-limit-check line 2865: `removed: if (shared instanceof CallLimiter)` |
| e8012ba62e | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 2162: `this.sql.exec("UPDATE intents SET contest = ? WHERE id = ?", seats, intent.id);`; capability:process line 2230: `if (this.sql.exec("SELECT 1 FROM proposals WHERE agent_id = ? AND intent_id = ? AND status IN ('pending', 'checking', 'ready', 'escalated')…`; capability:process line 2317: `const won = this.sql.exec("UPDATE intents SET status = 'claimed', assigned_to = ?, updated_at = ? WHERE id = ? AND status = 'open' RETURNIN…`; and 21 more |
| a5d42a9a6f | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 1290: `this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, escalation = ?, escalation_open = 1, updated_at = ? WHERE id = ?", J…`; capability:process line 1291: `this.sql.exec("INSERT OR REPLACE INTO intent_escalations (intent_id, at, agent_id, kind, report, resolved) VALUES (?, ?, ?, ?, ?, NULL)", r…`; capability:process line 1296: `this.sql.exec("UPDATE agents SET state = 'idle', intent_id = NULL, workspace = NULL WHERE id = ?", agentId);`; and 5 more |
| a5d42a9a6f | packages/worker/src/colony/direction.ts | person | capability:process line 70: `const rows = (sql.exec('PRAGMA table_info(${table})') as { toArray?: () => unknown[] } \| null)?.toArray?.();` |
| cf7c20b52c | packages/worker/src/certify/certifier.ts | person | capability:process line 593: `this.host.sql.exec("UPDATE certify_repairs SET state = 'satisfied' WHERE state NOT IN ('satisfied', 'released')");`; capability:process line 769: `if (old.get(path) !== data) this.host.sql.exec("INSERT OR REPLACE INTO certify_baseline (path, data) VALUES (?, ?)", path, data);`; capability:process line 772: `for (const path of old.keys()) this.host.sql.exec("DELETE FROM certify_baseline WHERE path = ?", path);` |
| c1ee436a18 | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 3179: `this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, row.id);` |
| e627797174 | packages/worker/src/decide/store.ts | person | capability:process line 128: `if (!has) sql.exec('ALTER TABLE ${table} ADD COLUMN ${column} ${decl}');`; capability:process line 358: `this.sql.exec("UPDATE antibodies SET recurrences = COALESCE(recurrences, 0) + 1, last_recurrence = ? WHERE id = ?", proposalId, id);` |
| 2636553d55 | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 1762: `if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decide_review'").toArray().length === 0) return views;` |
| 320dd908a8 | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 880: `this.sql.exec("INSERT OR REPLACE INTO reverts (landing_id, of, redo, restored, at) VALUES (?, ?, ?, ?, ?)", res.landing.id, res.reverted.id…`; capability:process line 891: `this.sql.exec("UPDATE rules SET open_violations = MAX(0, open_violations - ?) WHERE id = ?", r.violations, r.ruleId);` |
| 0b48ae324a | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 877: `for (const r of restored) this.sql.exec("UPDATE rules SET open_violations = open_violations + ? WHERE id = ?", r.violations, r.ruleId);` |
| 93fdf0814f | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 1961: `this.sql.exec("UPDATE colony SET green_sha = ?", sha);` |
| 93fdf0814f | packages/worker/src/trunk/TrunkDO.ts | person | capability:process line 426: `this.sql.exec('UPDATE ft_notes SET note = ? WHERE landing_id = ?', text, landingId);` |
| e2d1db9016 | packages/worker/src/api/app.ts | person | auth:authorization-header line 86: `const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");`; auth:bearer-scheme line 86: `const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");` |
| 29902e189f | packages/worker/src/api/app.ts | person | auth:unauthorized line 77: `return json({ error: "forbidden: writes need FT_ADMIN_TOKEN configured on the server" }, 403);` |
| 29902e189f | packages/worker/src/api/vaccinate.ts | person | auth:unauthorized line 41: `return json({ error: "forbidden: writes need FT_ADMIN_TOKEN configured on the server" }, 403);` |
| 29902e189f | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 1938: `this.sql.exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?", RECORD_KEEP);` |
| 29902e189f | packages/worker/src/pool/slots.ts | person | capability:process line 213: `this.sql.exec('UPDATE ft_pool_ws SET state = 'failed', error = ? WHERE n = ? AND state = 'ready'', 'workspace vanished: ${message}', row.n);` |
| 24b8e8d7a4 | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 717: `this.sql.exec("INSERT INTO intent_acks (intent_id, agent_id, revision, at) VALUES (?, ?, ?, ?) ON CONFLICT(intent_id, agent_id) DO NOTHING"…`; capability:process line 767: `this.sql.exec("UPDATE rules SET retracted_at = ?, retracted_by = ?, retract_reason = ?, open_violations = 0 WHERE id = ?", now, by, reason,…`; capability:process line 839: `this.sql.exec("UPDATE agents SET note = ?, note_at = ?, last_seen = ? WHERE id = ?", text, now, now, agentId);`; and 14 more |
| 24b8e8d7a4 | packages/worker/src/region/RegionDO.ts | second-opinion | loosened-guard:removed-expiry-check line 714: `if (!isExpired(toMark(r), now)) -> if (markValue(toMark(r), now) >= bar)` |
| 09d17c900c | packages/worker/src/region/RegionDO.ts | person | capability:process line 649: `this.sql.exec("DELETE FROM landed_paths WHERE at < ?", now - PATH_LANDING_KEEP_MS);`; capability:process line 650: `this.sql.exec("DELETE FROM pending_causes WHERE at < ?", now - SIGMA_KEEP_MS);`; capability:process line 957: `this.sql.exec("INSERT OR IGNORE INTO causes (id, cause_id, at) VALUES (?, NULL, ?)", id, at);`; and 4 more |
| 15238ddf89 | packages/worker/src/agents/gitfs.ts | person | capability:network line 111: `const res = await fetch(req.url, {` |
| 15238ddf89 | packages/worker/src/pool/PoolDO.ts | person | capability:process line 92: `this.sql.exec('ALTER TABLE ft_pool_ws ADD COLUMN last_agent TEXT');`; capability:process line 188: `this.sql.exec('UPDATE ft_pool_ws SET state = 'ready', agent_id = NULL, last_agent = ?, token_id = NULL, leased_at = NULL, released_at = ? W…` |
| 1c67f21746 | packages/web/src/App.tsx | second-opinion | test-weakening:skip-or-only line 84: `fit();` |
| d235cf4822 | packages/worker/src/api/app.ts | person | auth:unauthorized line 64: `if (!c.env.FT_ADMIN_TOKEN) return json({ error: "forbidden: this route needs FT_ADMIN_TOKEN configured on the server" }, 403);`; auth:admin-gate line 65: `return requireAdmin(c, next);` |
| d235cf4822 | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 783: `this.sql.exec("UPDATE intents SET status = 'proposed', updated_at = ? WHERE id = ? AND status = 'claimed'", now, fresh.id);`; capability:process line 1064: `this.sql.exec("UPDATE agents SET last_seen = ?, state = 'idle' WHERE id = ?", Date.now(), known);`; capability:process line 1103: `this.sql.exec("UPDATE intents SET status = 'abandoned', updated_at = ? WHERE id = ?", now, intent.id);`; and 9 more |
| 652597b880 | packages/worker/src/index.ts | person | auth:authorization-header line 26: `const header = req.headers.get("authorization") ?? "";`; auth:bearer-scheme line 27: `const bearer <redacted> header.startsWith("Bearer ") ? header.slice(7) : "";`; auth:bearer-scheme line 29: `return bearer <redacted> expected \|\| query === expected;`; and 1 more |
| b64dcc1ed4 | packages/worker/src/pool/PoolDO.ts | person | capability:process line 84: `this.sql.exec('CREATE TABLE IF NOT EXISTS ft_pool_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');`; capability:process line 88: `this.sql.exec('CREATE INDEX IF NOT EXISTS ft_pool_ws_state ON ft_pool_ws (state)');`; capability:process line 89: `this.sql.exec('CREATE INDEX IF NOT EXISTS ft_pool_ws_agent ON ft_pool_ws (agent_id)');`; and 18 more |
| b64dcc1ed4 | packages/worker/src/trunk/TrunkDO.ts | person | capability:process line 112: `this.sql.exec('CREATE TABLE IF NOT EXISTS ft_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');`; capability:process line 113: `this.sql.exec('CREATE TABLE IF NOT EXISTS ft_files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL, mode TEXT NOT NULL)');`; capability:process line 120: `this.sql.exec('CREATE TABLE IF NOT EXISTS ft_notes (landing_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, note TEXT NOT NULL)');`; and 15 more |
| 6b2447ebee | packages/worker/src/colony/ColonyDO.ts | person | capability:process line 504: `this.sql.exec("UPDATE agents SET last_seen = ?, state = CASE WHEN state = 'dead' THEN 'idle' ELSE state END WHERE id = ?", now, agentId);`; capability:process line 591: `this.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", now, agentId);`; capability:process line 614: `this.sql.exec("UPDATE intents SET status = 'open', assigned_to = NULL, updated_at = ? WHERE id = ?", now, row.id);`; and 24 more |
| 6b2447ebee | packages/worker/src/region/RegionDO.ts | person | capability:process line 480: `this.sql.exec("INSERT OR IGNORE INTO log (id, kind, at) VALUES (?, ?, ?)", id, kind, at);`; capability:process line 496: `this.sql.exec("DELETE FROM marks WHERE mkey IN (SELECT value FROM json_each(?))", JSON.stringify(part));`; capability:process line 498: `this.sql.exec("DELETE FROM log WHERE at < ?", now - LOG_KEEP_MS);`; and 11 more |
