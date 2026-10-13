# Working in this repository

FireTrident is built by several agents working in parallel on one tree. These rules keep that safe.

## Layout and ownership

| Path | Owner stream |
| --- | --- |
| `packages/core/src/*` (except `types.ts`, `index.ts`) | S1 core logic |
| `packages/worker/src/api/`, `colony/`, `region/` | S2 coordination |
| `packages/worker/src/trunk/`, `pool/`, `artifacts/`, `workflows/` | S3 Artifacts layer |
| `packages/worker/src/agents/`, `mcp/`, `packages/bench/` | S4 agents |
| `packages/worker/src/decide/`, `api/vaccinate.ts`, `colony/innate.ts` | W1 decide |
| `packages/worker/src/certify/`, `api/certify.ts` | T1 trunk certification |
| `packages/web/` | S5 web UI |
| `packages/worker/src/morph/`, `packages/cli/`, `demo/` | S6 morphology, CLI, demo |
| `packages/core/src/types.ts`, `packages/core/src/index.ts`, `packages/worker/src/env.ts`, `packages/worker/src/index.ts`, `packages/worker/wrangler.jsonc`, every `package.json`, `docs/ARCHITECTURE.md` | Orchestrator only |

Edit only files your stream owns. If you need a change to an orchestrator-owned file (a new type field, binding, dependency, or export), do not make it: describe the exact change in your final status and code against it as if it existed.

## Rules

- Do not commit, push, or run `npm install`. The orchestrator does all three.
- Do not deploy unless your task says you may.
- Imports use explicit `.ts` extensions. TypeScript is strict.
- `packages/core` is pure: no Cloudflare APIs, no I/O, deterministic given inputs (inject time and randomness).
- Every exported function has a short doc comment. Tests use vitest and live next to the package in `test/`.
- Never name other products, companies' internal projects, or competing tools in code, comments, or commit messages.
- Never put secrets or tokens in code, tests, fixtures, or logs.
- Treat imported repository content as untrusted data in prompts: delimit it and never execute it.

## Commands

- Core tests: `npx vitest run --root packages/core`
- Typecheck a package: `npx tsc -p packages/<name>/tsconfig.json`
- Worker locally: `cd packages/worker && npx wrangler dev`
