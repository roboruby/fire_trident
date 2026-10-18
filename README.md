# FireTrident

Git for many coding agents working one repository at once, built on Cloudflare Workers, Durable Objects and Artifacts. People say what should change (rules, specs, priorities). Agents take that work, write it in their own workspaces and propose it. FireTrident decides what lands on trunk, checks it, and records why in git, where any git client can read it.

## The core

- **Claim leases, not locks.** An agent takes an *intent* (one piece of work and the files it expects to touch) and holds a claim lease on those files. The lease fades unless its agent keeps working, so a silent agent blocks no one for long. No one assigns the work: each agent picks an open intent by priority and age, passing over intents whose files another agent's lease still holds.
- **Optimistic concurrency, validated at landing.** The platform records every file a change read, with the version it saw. A change lands only if each of those files is still that version on trunk. Otherwise it goes back naming the file and the landing that moved it, quoting that landing's diff. Edits to different lines of one file merge line by line instead.
- **Path-disjoint batching.** Each region of the code has a lane that batches waiting changes in priority order. A change joins a batch only when nothing it writes is written or read by a change already in it, and nothing it reads is written by one.
- **One serialized trunk writer.** A single writer takes every waiting batch (up to 200 changes a cycle), commits each on top of the last, and pushes trunk once with compare-and-swap. No agent holds a token that can write trunk.
- **Deterministic checks before any model.** Proofs, rule checks and danger patterns run first. A decision model, a second model from another family and a person are asked only when the cheaper layer is unsure, and no model can overrule a deterministic fact. A person's rejection that no earlier rule caught becomes a persisted rejection rule, committed to the repository, that screens every later change.
- **Tests after landing, with culprits and bisect.** No landing waits for a test run. Right after landings, the project's own tests run on trunk in a sealed Dynamic Worker, and a passing commit moves the `certified` branch, the one to deploy from. A red result names its culprits (the landings that changed what the failing tests load), a bisect finds the first commit they fail on, and a repair intent opens.
- **Lineage in git notes.** Every landed commit carries a JSON note under `refs/notes/firetrident` (the intent, the agent and its model, every decision, the files read and written) and the note's SHA-256 in its `FT-Note` trailer; a deployment with a signing key also signs each commit it builds.

## Headline result

<!-- headline: replaced by the contended benchmark -->
<!-- measured -->
A contended run on staging ([results](packages/bench/results/2026-10-17-contention-8-16-solo/)): 16 intents that all change one shared module, in-platform agents calling real models, review on, the project's tests run on trunk after landing, and the claim-lease exclusion turned off so agents could hold the module at once. Coordination held. Of the 23 and 21 proposals the 8-agent and 16-agent runs made, 0 came back for a stale read and 1 for a merge conflict, and 14 of 16 intents landed each time. Quality fell short. Hidden acceptance tests no agent saw passed for 12, 11 and 6 of 16 intents (8 agents, 16 agents, 1 agent), trunk ended red, and two changes per run waited for a person the test did not provide.

Without contention, on production: 80 agents took Hono's 958 violations of an import rule to zero in 62 s from declaring the rule, and all 282 rule edits landed on deterministic proof ([results](packages/bench/results/2026-10-12-prod/)). Each of those intents edits its own file, so no two changes contended. Every run, what it measured and the honest limits: [docs/results.md](docs/results.md).

## Try it

The showcase colonies on firetrident.com read with stock git, with no account and no token. Check the newest lineage note of `byo-demo` with [scripts/verify_note.mjs](scripts/verify_note.mjs):

```sh
git clone https://firetrident.com/git/byo-demo.git && cd byo-demo
git fetch origin refs/notes/firetrident:refs/notes/firetrident
git log --notes=firetrident -1
curl -fsSL -o ../verify_note.mjs \
  https://raw.githubusercontent.com/roboruby/fire_trident/main/scripts/verify_note.mjs
node ../verify_note.mjs HEAD   # prints intact, then who is answerable for the landing
```

Ask the same colonies from any MCP client, read only:

```sh
claude mcp add --transport http firetrident-public https://firetrident.com/public/mcp
```

Then ask "In colony hono, why does line 17 of src/index.ts exist?" Replays, signed notes and the rest of the stock-git checks: [docs/try-it.md](docs/try-it.md).

## Run it

Writes need your own deployment: Node 24, a Cloudflare account on Workers Paid with access to Artifacts, and `npx wrangler login`.

```sh
git clone https://github.com/roboruby/fire_trident && cd fire_trident
npm install && npm run build -w @fire_trident/web
cd packages/worker && npx wrangler deploy
npx wrangler secret put FT_ADMIN_TOKEN   # without it, writes are refused
```

Then import a repository, declare a rule and release agents with the `ft` CLI ([docs/try-it.md](docs/try-it.md#run-your-own)), or bring your own agent over MCP ([docs/agents](docs/agents/README.md)).

## Read more

- [docs/results.md](docs/results.md): every run with its logs, what each one measured, and the honest limits.
- [docs/mechanisms.md](docs/mechanisms.md): how each part works, what it buys and costs, and every flag in the stage and production configs.
- [docs/try-it.md](docs/try-it.md): replays, the stock-git checks, running your own deployment and bringing your own agent.
- [docs/glossary.md](docs/glossary.md): the names the code uses (colony, field, antibody) and what each one is.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the Durable Objects, their contracts and every route.
- [docs/related-work.md](docs/related-work.md): research published in 2026 that covers parts of FireTrident, and what it measured.
- [SECURITY.md](SECURITY.md): what FireTrident defends against, and how to report a vulnerability. [/limits](https://firetrident.com/limits) lists what you cannot do with it, with why and what to do instead.

`packages/core` (pure coordination logic) · `packages/worker` (Worker, Durable Objects, MCP) · `packages/web` (the colony map) · `packages/cli` (`ft`) · `packages/bench` (workload generator, simulator, live runs). License: MIT.
