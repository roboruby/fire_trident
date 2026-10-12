# Demo repository candidates

Which real public TypeScript repository the swarm remodels live in the video, and which rule it enforces. Researched 2026-10-12: 54 repos screened through the GitHub API, 18 shallow-cloned to `~/Desktop/save/firetrident/demo-candidates/` and analyzed read-only. No candidate's install, build, test, or other code was run. Suite times below are estimates from test counts and CI config, not measurements.

Counting follows the checker's semantics: forbid-pattern counts one violation per matching line, forbid-import counts one per import specifier. Every pattern below was re-run with JavaScript `RegExp` semantics on the pinned commits.

Confirmed with FireTrident's own checker (`scanFiles` in `packages/worker/src/morph/scan.ts`, which calls core `checkFile`) on the same commits. Hono's video rule gives 958 violations in 282 files, against 955 in 281 from the regex count. Hono's conservative variant gives exactly 587 in 158. OpenSpec gives exactly 131 in 74, and applying its `replacement` to every flagged line leaves 0, with no doubled `node:node:`. The colony drafts one intent per violating file, so Hono's video rule puts about 282 intents in the field.

## Recommendation

| | Primary | Backup |
| --- | --- | --- |
| Repo | [honojs/hono](https://github.com/honojs/hono) @ `552ea02` (2026-10-11) | [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) @ `9111a76` (2026-10-06) |
| License, stars | MIT, 32.5k | MIT, 71.7k |
| Rule | Relative imports name their file (`./x` → `./x.ts`, `./dir` → `./dir/index.ts`) | Node built-ins use the `node:` protocol (`'fs'` → `'node:fs'`) |
| Source files (src/, non-test) | 189 in 69 directories | 210 in 28 directories |
| Violations | **≈955 in 281 of 312 files**, forbid-import over all of `src/` (tests included). Conservative variant: 587 in 158 of 189 non-test files | **131 in 74 of 210 files** |
| Spread | 68 directories (non-test variant: 67 of the 69 non-test directories); per file median 3, max 14 | 14 of 28 directories (57 of the 74 files are under `src/core`) |
| Deterministic `replacement` | **None is safe**: 81 of the 587 non-test hits are directory imports that need `/index.ts`, and a blind `.ts` append breaks them. LLM agents only. | **Yes, a pure rename**: `$1$2node:$3$2`, which leaves 0 violations with no doubled prefixes |
| Test runner | Vitest 5 (repo uses its `vp` wrapper), 124 test files, about 2,860 cases, no services | Vitest, 217 test files, about 4,010 cases; 58 files spawn child processes, mostly the built CLI |
| Est. suite time | about 15-30 s for the main projects, plus about 10-20 s typecheck | minutes: it builds the CLI first, runs at most 4 forked workers, and CI allows 15 min |
| Working tree | about 6.3 MB, 583 files | about 12.6 MB, 1,287 files |

**Why Hono.** It is the web framework most identified with Workers. Its source spreads across 69 directories (adapters, middleware, helpers, routers, JSX, utils), so the colony map is rich, and the rule lights up almost all of it. The rule is real for Hono, not invented for the demo:

- `jsr.json` publishes `src/` to JSR with `"unstable": ["sloppy-imports"]`, because core imports omit extensions.
- Hono's own Deno and Netlify adapter packages already import with explicit `.ts` (`adapters/deno/tsconfig.json` sets `allowImportingTsExtensions`).
- Its Deno runtime tests already import `../../src/context.ts` and `../../src/helper/adapter/index.ts`.

Each fix is file-local and mechanical, but an agent has to tell files from directories, which is honest work for an LLM agent. Tests, typecheck, and the counter verify it.

**Why OpenSpec as backup.** It is a different repo, a different rule kind, and a different failure mode. It is also on theme: spec-driven development for AI coding assistants. Its rule has a safe deterministic replacement, so synthetic agents can run it at any scale. Its weakness is the slow suite.

**Tiebreaker (deterministic replacement).** Only OpenSpec's rule has one. Hono still wins for the video on spread (281 vs 74 files, 68 vs 14 directories) and suite speed. For synthetic-agent scale runs, the OpenSpec rule is the one that can be fixed without an LLM.

## Primary: Hono, explicit file extensions

### Commands

```sh
ft import https://github.com/honojs/hono --name hono --branch main --pool 200 --region-depth 3

# Video rule: import-boundary kind, all of src/ including colocated tests (≈955 violations, 281 files)
ft rule import-boundary hono \
  --from 'src/**/*.ts' --from 'src/**/*.tsx' \
  --module '^\.\.?(?:/.*)?(?<!\.ts|\.tsx|\.json)$' \
  --hint 'Name the file in every relative import: ./x becomes ./x.ts when x.ts exists; a directory ./d becomes ./d/index.ts (".", ".." and "../.." are directories). Check the tree. Change nothing else.' \
  --description 'Relative imports in src name their file, so Hono runs on Deno, JSR and Node built-in TypeScript without the unstable sloppy-imports flag.'
```

**Import with `--region-depth 3`.** Every violating file is under `src/`, so at the default depth of 1 the whole rule lands in one region: one lane and a flat map. Measured on the violating files:

| Depth | Violating regions (of all regions) | Largest regions (files) |
| --- | --- | --- |
| 1 | 1 (10) | 282 |
| 2 | 10 (46) | 62, 53, 44, 41 |
| 3 | 66 (127) | 23, 20, 18, 14 |

Depth 3 spreads the swarm and the landing lanes across the map, such as `src/middleware/cors` and `src/helper/cookie`.

Conservative variant (forbid-pattern, non-test files only, also catches the 5 `declare module '../..'` augmentations): 587 violations in 158 files. `\x27` is a JavaScript RegExp escape for `'`, which avoids shell quote juggling.

```sh
ft rule add hono \
  --pattern '(?:\bfrom\s*|\bimport\s*\(?\s*|\bdeclare\s+module\s+)["\x27]\.{1,2}(?:/[^"\x27]*)?(?<!\.ts|\.tsx|\.json)["\x27]' \
  --include 'src/**/*.ts' --include 'src/**/*.tsx' \
  --exclude 'src/**/*.test.ts' --exclude 'src/**/*.test.tsx' \
  --hint '(same as above)' --description '(same as above)'
```

No `--replacement`, as explained above.

### Distribution (non-test variant)

By area: `src/adapter` 34 files, `src/middleware` 33, `src/jsx` 25, `src/helper` 23, `src/router` 15, `src/utils` 11, `src` root 8, `src/client` 4, `src/validator` 3, `src/preset` 2. Per file: median 3, p90 8, max 14. That makes small, fast proposals and suits many concurrent agents.

### Intents around the swarm

1. **Before the swarm (one human-approved intent; must land first).** Add `"rewriteRelativeImportExtensions": true` to `tsconfig.base.json`. Hono is on TS 6.0.3 plus a TS 7 preview, and since TS 5.7 that option permits `.ts` specifiers in emitting builds and rewrites them to `.js` on emit. If `tsc -p tsconfig.spec.json` still reports TS5097, also set `"allowImportingTsExtensions": true` in `tsconfig.spec.json`, which is `noEmit`, the same as `adapters/deno/tsconfig.json`. Without this step every proposal fails typecheck.
2. **The swarm** drives the counter to 0.
3. **After the swarm (one human-approved intent).** Remove `"unstable": ["sloppy-imports"]` from `jsr.json`. That is the payoff line for the video.

### Per-file fix recipe (agent)

1. For each flagged specifier, resolve it against the file's directory:
   - if `<spec>.ts` exists, append `.ts` (or `.tsx`);
   - otherwise, if `<spec>/index.ts` exists, append `/index.ts`;
   - `.`, `..`, and `../..` are always directories.
2. Apply the same rewrite to `export … from`, side-effect `import '…'`, and `declare module '…'` lines.
3. Change nothing else: no reordering, reformatting, or type changes.
4. Self-check before proposing: the rule reports 0 for the file, and every rewritten path exists in the tree.

### Verify

Run in the workspace sandbox. Do not use `npm ci`: Hono has no package-lock and declares `pnpm@12.6.0`.

```sh
corepack enable && pnpm install --frozen-lockfile
pnpm exec tsc -p tsconfig.spec.json
pnpm exec vitest run --project main --project jsx-runtime-default --project jsx-runtime-dom --coverage.enabled=false
# per proposal, faster: pnpm exec vitest related <changed files> --run --coverage.enabled=false
```

Done means the violation count is 0, both commands are green on trunk, and `pnpm run build` (vp pack + publint) passes once at the end.

### Risks

- **Prerequisite ordering.** The tsconfig intent must land before any rule intent.
- **Pipeline pre-flight.** Before recording, hand-convert one file on a scratch fork and run typecheck, tests, and build. In particular, check that `dist/types` does not keep `.ts` specifiers.
- **Directory imports.** The 81 directory imports (14% of non-test hits) are the main way agents fail, by blindly appending `.ts`. Typecheck and tests catch it, and the proposal is returned. That could even be shown as the immune response working.
- **Module augmentations.** Five `declare module '../..'` augmentations (jwt, timing, language, secure-headers, request-id) must point at `'../../index.ts'` so `ContextVariableMap` still merges. tsc catches mistakes. The import-boundary variant does not count these lines, so they ride along with each file's fix.
- **Runtime test projects.** A plain `vitest run` also starts the runtime projects in `runtime-tests/*` (node, workerd, fastly), which need extra runtimes. Scope the run to the projects above.
- **Coverage.** `coverage.enabled` is `true` by default, so disable it for speed.
- **Upstream churn.** Hono changes daily. The numbers here are for `552ea02`, and the import pins whatever commit is current at import time. Re-count after import (the rule's own violation count does this).

## Backup: OpenSpec, `node:` protocol

### Commands

```sh
ft import https://github.com/Fission-AI/OpenSpec --name openspec --branch main --pool 100 --region-depth 3

ft rule add openspec \
  --pattern '(\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*)(["\x27])(path|fs/promises|fs|os|module|child_process|crypto|url|http|https|util|events|stream|readline|zlib|assert|buffer|net|tty|worker_threads|perf_hooks|timers|v8|vm|dns|querystring|string_decoder|async_hooks)\2' \
  --flags g \
  --include 'src/**/*.ts' \
  --replacement '$1$2node:$3$2' \
  --hint "Import Node built-ins with the node: protocol ('fs' becomes 'node:fs'). If a test mocks the bare name (vi.mock('child_process')), rename it in the same change." \
  --description 'Node built-ins are imported with the node: protocol, so an npm package can never shadow them.'
```

Equivalent import-boundary form: `--from 'src/**/*.ts' --module '^(path|fs/promises|fs|os|module|child_process|crypto|url|http|https)$'` also gives 131 violations, but carries no replacement.

### Facts

- Modules: `path` 72, `fs` 36, `os` 7, `module` 5, `child_process` 4, `crypto` 3, `url`, `fs/promises`, `http`, `https` 1 each.
- Regions: at depth 1 all 74 files are one region (`src`). Depth 3 gives 13 violating regions, the largest with 35 files, so import with `--region-depth 3`.
- 70 specifiers in `src` already use `node:`, so the rule finishes a convention the repo half follows.
- `engines.node >= 20.19.0`, so the rename is semantically identical.

### Per-file fix

Apply the replacement to each flagged line; synthetic agents can do this alone.

One coupled file needs an LLM touch or a second rule line: `src/commands/feedback.ts` imports bare `child_process`, and `test/commands/feedback.test.ts` mocks bare `'child_process'`. Rename both in one proposal, unless Vitest's builtin normalization makes the mock apply to both names. Verify that once.

### Verify

```sh
pnpm install --frozen-lockfile
pnpm run build   # mandatory: test/helpers/run-cli.ts reuses a stale dist/ if one exists
pnpm exec vitest run
```

### Risks

- **Slow suite.** 58 test files spawn child processes (mostly the built CLI), workers are capped at 4, and CI allows 15 minutes. Use `vitest related` per proposal and the full suite only to certify green.
- **Repo weight.** The working tree is twice Hono's, including a 368 KB test file.

## Other finalists: rule and replacement status

| Repo | Best rule found | Count | Safe per-line replacement? | Why not chosen |
| --- | --- | --- | --- | --- |
| trpc/trpc | Explicit extensions | 625 lines / 167 files | No (directory imports) | No natural motivation (no Deno/JSR flag); suite of 447 test files |
| tremorlabs/tremor | Drop `React.forwardRef` (React 19) | 93 / 39 files | No | The repo is on React 18, so removing forwardRef breaks refs; last commit 2025-10-10 |
| mswjs/msw | `console.*` → existing `devUtils` | 82 / 16 files | No (needs an import; message prefix changes) | Too few files; 113 console-spy lines in 22 test files assert exact output |
| vercel-labs/json-render | `console.warn/error` in renderers | 81 / 32 files, 14 packages | No | No shared helper exists to migrate to, so not file-local; deprecations are compat aliases with few call sites |
| TypeStrong/typedoc, hexojs/hexo | `node:` protocol | typedoc 69/49, hexo 46/36 | Yes (same as backup) | Mocha suites; fewer violations than OpenSpec |

## Screening table

`src` = non-test TS/JS files outside docs, examples, and build dirs, counted from the GitHub tree API. `dirs` = directories containing them. `tree` = checkout size in MB.

| Repo | Stars | License | src | dirs | tree | Runner | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| honojs/hono | 32.5k | MIT | 223 | 78 | 4.8 | vitest | **Primary** (src/ alone: 189 files) |
| Fission-AI/OpenSpec | 71.7k | MIT | 213 | 30 | 9.6 | vitest | **Backup** (slow suite) |
| trpc/trpc | 40.7k | MIT | 242 | 64 | 7.1 | vitest | Cloned; no natural rule at scale |
| mswjs/msw | 18.3k | MIT | 107 | 28 | 3.3 | vitest | Cloned; console rule too narrow, tests assert output |
| alibaba/hooks | 15.0k | MIT | 135 | 91 | 1.7 | vitest | Cloned; clean (console 18/12 files), no rule |
| vercel-labs/json-render | 18.6k | Apache-2.0 | 294 | 78 | 9.1 | vitest | Cloned; no replacement target |
| apify/apify-mcp-server | 10.7k | MIT | 164 | 34 | 3.8 | vitest | Cloned; clean (console 41/9 files) |
| honojs/middleware | 1.0k | MIT | 165 | 69 | 2.5 | vitest | Cloned; extensions 202/80 files but no JSR motivation |
| modelcontextprotocol/typescript-sdk | 13.6k | MIT→Apache (in transition) | 212 | 44 | 10.2 | vitest | Cloned; mixed-license transition, console concentrated (95 in 6 files) |
| tremorlabs/tremor | 3.7k | Apache-2.0 | 95 | 43 | 1.8 | vitest | Cloned; React 18 blocks forwardRef rule |
| changesets/changesets | 12.5k | MIT | 86 | 36 | 2.5 | vitest | Cloned; has own logger, but console only 12/6 files |
| lerna-lite/lerna-lite | 0.6k | MIT | 214 | 45 | 3.0 | vitest | Cloned; clean console; `.then` → async 196/34 needs judgment; low profile |
| conventional-changelog | 8.5k | ISC | 86 | 20 | 3.3 | vitest | Cloned; `node:` only 26/16 files |
| TypeStrong/typedoc | 8.4k | Apache-2.0 | 209 | 29 | 5.1 | mocha | Cloned; `node:` 69/49, mocha |
| hexojs/hexo | 41.8k | MIT | 149 | 24 | 1.5 | mocha | Cloned; `node:` 46/36, mocha |
| probot/probot | 9.6k | ISC | 54 | 10 | 0.6 | vitest | Cloned; already `node:`, small |
| homebridge/homebridge | 25.5k | Apache-2.0 | 76 | 6 | 4.1 | vitest | Cloned; already `node:`, 58 of 76 files under `src/matter` |
| raineorshine/npm-check-updates | 10.3k | Apache-2.0 | 114 | 7 | 1.7 | vitest | Cloned; already `node:`, flat |
| typestack/class-validator | 11.8k | MIT | 161 | 22 | 1.0 | jest | 115 of 161 files under `src/decorator`; not cloned |
| unjs/h3 | 5.5k | MIT | 90 | 10 | 2.3 | vitest | Few directories |
| googleapis/release-please | 7.6k | Apache-2.0 | 225 | 32 | 8.1 | mocha | Tests need a compile first; 3.3 MB snapshot file |
| boardgameio/boardgame.io | 12.5k | MIT | 82 | 20 | 4.3 | jest | Small (82 src files); not cloned |
| SBoudrias/Inquirer.js | 21.6k | MIT | 81 | 33 | 1.4 | vitest | Small packages, no rule |
| openai/openai-agents-js | 3.9k | MIT | 371 | 57 | 18.0 | vitest | Large tree, 352 KB test file |
| colinhacks/zod | 44.1k | MIT | 240 | 22 | 14.8 | vitest | 75 of 240 are bench files; type-level code |
| wxt-dev/wxt | 10.6k | MIT | 217 | 67 | 4.0 | bun | Bun-driven workspace tests |
| pmndrs/jotai | 21.3k | MIT | 33 | 5 | 2.9 | vitest | Too small |
| google-gemini/gemini-cli | 107.3k | Apache-2.0 | 1130 | 124 | 103.9 | vitest | Far too large (104 MB, 55 MB fixture) |
| cloudflare/agents | 5.8k | MIT | 628 | 127 | 27.3 | vitest | Too large (734 KB source file) |
| fabricjs/fabric.js | 31.5k | MIT | 317 | 50 | 60.1 | vitest | 60 MB tree (video and image fixtures) |
| webpro-nl/knip | 12.4k | ISC | 580 | 233 | 15.4 | custom node runner | Too large: 580 src plus 4,122 test and fixture files |
| recharts/recharts | 27.6k | MIT | 431 | 60 | 99.9 | vitest | 100 MB tree (visual snapshots) |

Also screened and rejected on shape, size, or runner: unjs/unstorage, unjs/c12, toss/es-toolkit (868 src), MichalLytek/type-graphql (12.9 MB of gifs), vega/ts-json-schema-generator, listr2, adonisjs/core (japa), ChromeDevTools/chrome-devtools-mcp (needs Chrome), withastro/flue, sindresorhus/got (ava), cloudflare/mcp-server-cloudflare, t3-oss/create-t3-app (no tests), inngest/inngest-js (GPL-3.0), resend/react-email (144 MB), modelcontextprotocol/inspector, cloudflare/sandbox-sdk, mcp-use (119 MB), typestack/class-transformer, immutable-js, chartist, microsoft/inshellisense, google/clasp.

## Reproduce

Clones (shallow, `GIT_LFS_SKIP_SMUDGE=1`, hooks disabled) are in `~/Desktop/save/firetrident/demo-candidates/`. Pinned commits: hono `552ea024250093a48071b3ded9710de4c6e05f14`, OpenSpec `9111a7654d7800391459431fff4eaf66e33a3d2e`.

To re-count without the platform, run a short script that reads each file as text and applies `new RegExp(pattern).test(line)`. Do not install or run anything inside a clone. Some clones carry `.tool-versions` and package scripts, so keep the working directory outside them.
