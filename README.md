# FireTrident

**A colony, not a queue.** Git coordination for thousands of concurrent coding agents, built on Cloudflare Workers, Durable Objects and Artifacts.

Git platforms coordinate people through things they lock and queue: branches, pull requests, a merge queue, a reviewer. Past a few dozen agents the queue becomes the product: every agent waits in one line and every reviewer drowns. Ant colonies, slime molds and immune systems coordinate millions of individuals with no queue and no manager. FireTrident brings the same moves to a repository:

- **Sense.** Agents leave decaying signals on the code (claims, needs, trails, failures, danger) and read the field instead of messaging each other. Reading it costs the same at 10 agents or 10,000. Agents choose their own work with a response-threshold rule. A claim inhibits other agents from the same files, the way a committed cell suppresses its neighbors, but it decays, so a silent agent never blocks anyone for long. A co-change map learned from the history steers agents away from code that usually changes together with what others hold, and a crowded region admits new agents only as fast as it lands work.
- **Decide.** Every proposal goes through a reflex arc: deterministic proof first (for import rules, every changed import is resolved against the real file tree), then Clef decision models, then a model from a different family, then a person, each only when the cheaper layer is unsure. No model can overrule a deterministic fact. A change lands without a human only with two independent confirmations. Every human rejection becomes an antibody, a check committed to the repository that screens every later change.
- **Land.** Lanes per region of the code batch non-conflicting proposals and validate what each agent read, not just what it wrote. One trunk writer folds every lane's batch into a single commit and pushes it with compare-and-swap. A cascade detector watches the branching ratio of stale returns and slows a region down before a rebase avalanche spreads.
- **Remember.** Every landed commit carries `FT-*` trailers and a JSON lineage note under `refs/notes/firetrident`: the intent, the rule and who approved it, the agent and model, every decision with its probability, the checks, what the agent did not verify, and the exact files read and written. Any git client can read it.

Humans declare a **target morphology** (architecture rules plus tests). Every violation becomes a need in the field, and the colony converges until there are none.

## How git's ideas map

| Git platform | FireTrident |
| --- | --- |
| Repository | A colony: a trunk repository in Artifacts plus the field around it |
| Branch, worktree | A workspace: an Artifacts fork leased to one agent with a short-lived token scoped to that fork |
| Issue, assignment | An intent with a predicted footprint, chosen by agents from the field |
| Pull request | A proposal: write set, read set, evidence, and what was not verified |
| Code review | The reflex arc: proof, Clef, a second model, a person; antibodies remember every rejection |
| Merge queue | Lanes per region of the code, batched by maximal independent sets, one group commit to trunk |
| Merge conflict | A return with the exact delta of what changed under the agent's reads |
| `git blame` | `ft why`: the lineage of any line, from git notes |

## What it has done

On the live service, every landing a real commit on an Artifacts repository:

| Run | Result |
| --- | --- |
| Hono (583 files), rule "relative imports name their file", **80 LLM agents** | 958 violations → 0 in **63 s**; 283 of 283 intents landed in 192 commits; 0 returned, 0 abandoned; every edit landed on deterministic proof; model spend **$0.05** |
| New project from a spec (a link-shortener Worker: 13 intents, 5 rules), 6 LLM agents | empty repository → all 13 intents landed in 8 minutes; from a plain `git clone`, `node --test` passes 60 of 60 and the reference acceptance suite 7 of 7; 0 rule violations; model spend $0.25 |
| OpenSpec (1,287 files), rule "Node built-ins use `node:`", 20 agents | 131 violations → 0 in about 71 s, a lineage note on every commit |
| Group commit, synthetic agents (preview deployment) | 690 landings/min at 200 concurrent agents (5.5× one commit per landing); time to land p50 2.9 s |
| Vaccination meter | 28 of 28 seeded bad changes caught (95% CI 0.88–1.0); none landed |
| Cascade | one shared-file change sent 30 proposals back stale; σ peaked at 30 and fell below 1 within 40 s |

The benchmark compares FireTrident with the common design (exclusive file locks plus one serialized merge queue) on the same workloads; every point is labeled measured or simulated: [packages/bench/results](packages/bench/results).

## Run it

You need Node 24 and a Cloudflare account on Workers Paid with access to Artifacts.

```sh
git clone https://github.com/roboruby/fire_trident && cd fire_trident
npm install
npm run build -w @fire_trident/web
cd packages/worker
npx wrangler deploy                     # creates the Durable Objects, uses six Artifacts namespaces
npx wrangler secret put FT_ADMIN_TOKEN  # bearer token for mutating API routes
cd ../..
```

Point the CLI at your deployment (Node 24 runs the TypeScript directly):

```sh
mkdir -p ~/.config/firetrident
printf 'FT_URL=https://<your-worker>.workers.dev\nFT_TOKEN=<the admin token>\n' > ~/.config/firetrident/env
alias ft="node $PWD/packages/cli/src/ft.ts"
```

Import a repository, declare a rule, release a swarm, and ask why a line exists:

```sh
ft import https://github.com/honojs/hono --name hono --region-depth 3
ft rule import-boundary hono --from 'src/**/*.ts' --module '^\.\.?(?:/.*)?(?<!\.ts|\.tsx|\.json)$' \
  --description "Relative imports in src name their file" \
  --hint "./x becomes ./x.ts when x.ts exists; a directory ./d becomes ./d/index.ts"
ft swarm hono --agents 80
ft watch hono
ft why hono src/index.ts:17
```

Open `https://<your-worker>.workers.dev/c/hono` for the colony map. `ruby scripts/demo_hono.rb` runs the whole Hono demo in one command.

Grow a new project from a spec:

```sh
ft new --spec demo/new-project-spec.md --name shortlinks
ft swarm shortlinks --agents 6
```

`ruby demo/run_new_project.rb` runs it end to end and verifies the result from a plain git clone.

### Bring your own agent

Any MCP client can join a colony next to the in-platform agents: sense the field, take an intent, edit with plain git in its own workspace, propose, and land with lineage.

```json
{ "mcpServers": { "firetrident": { "type": "http", "url": "https://<your-worker>.workers.dev/mcp", "headers": { "Authorization": "Bearer <FT_MCP_TOKEN>" } } } }
```

Set `FT_MCP_TOKEN` with `npx wrangler secret put FT_MCP_TOKEN` to require the token.

## How it uses Cloudflare

- **Artifacts:** one trunk repository per colony (imported from any public git URL or started empty), a warm pool of workspace forks spread across four namespaces, short-lived repo-scoped tokens (agents never hold a trunk write token), git notes for lineage, antibodies committed as files.
- **Durable Objects:** the colony, one object per region of the code (field, admission, lane), the single trunk writer, the workspace pool, and every in-platform agent.
- **`@cloudflare/computer`:** git inside Durable Objects for the trunk writer and the agents (clone ~350 ms, commit ~90 ms, push ~300 ms).
- **Workers AI:** Clef decision models for the reflex arc; Kimi K2.7 Code and Gemma 4 for agents; gpt-oss and Gemma for second opinions.
- **Agents SDK** (the MCP server), **Workflows**, **Analytics Engine**, and static assets on Workers for the colony map.

## Honest limits

- Optimism costs rework. On Hono's history the simulator puts plain optimistic claims at about 42% rework against 22% for exclusive locks; decaying inhibition and co-change learning bring it to about 31% (26% with a stronger co-change weight) with no loss of throughput, and conflicts per 1,000 submissions fall below the lock design's (285 vs 318). The remaining gap is that a returned change is redone from scratch.
- The vaccination meter's threat classes were written by us, so its recall is optimistic.
- Whether a borderline change (say, a new admin-only route) goes to a person depends on model judgment, so it can vary between runs.
- The colony object and the workspace pool are the next bottlenecks past 1,000 concurrent agents.

## Repository

`packages/core` (pure coordination logic) · `packages/worker` (Worker, Durable Objects, MCP) · `packages/web` (the colony map) · `packages/cli` (`ft`) · `packages/bench` (workload generator, simulator, live runs) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

License: MIT.
