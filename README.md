# FireTrident

**A colony, not a queue.** Git coordination for thousands of concurrent coding agents, built on Cloudflare Workers, Durable Objects and Artifacts.

Git platforms coordinate people through things they lock and queue: branches, pull requests, a merge queue, a reviewer. Past a few dozen agents the queue becomes the product: every agent waits in one line and every reviewer drowns. Ant colonies, slime molds and immune systems coordinate millions of individuals with no queue and no manager. FireTrident brings the same moves to a repository:

- **Sense.** Agents leave decaying signals on the code (claims, needs, trails, failures, danger) and read the field instead of messaging each other. Reading it costs the same at 10 agents or 10,000. Agents choose their own work with a response-threshold rule. A claim inhibits other agents from the same files, the way a committed cell suppresses its neighbors, but it decays, so a silent agent never blocks anyone for long. A co-change map learned from the history steers agents away from code that usually changes together with what others hold, and a crowded region admits new agents only as fast as it lands work.
- **Decide.** Every proposal goes through a reflex arc: deterministic proof first (for import rules, every changed import is resolved against the real file tree, and the files it resolves to are checked again when the change lands), then Clef decision models, then a model from a different family, then a person, each only when the cheaper layer is unsure. No model can overrule a deterministic fact. A change lands without a human only with two independent confirmations, and a model's approval counts only when it saw the whole change. A human rejection that no antibody caught becomes a new antibody, a check committed to the repository that screens every later change; agents see those checks' questions when they take work on the files they cover.
- **Land.** Lanes per region of the code batch non-conflicting proposals and validate what each agent read, not just what it wrote. One trunk writer folds every lane's batch into a single commit and pushes it with compare-and-swap. A cascade detector watches the branching ratio of stale returns and slows a region down before a rebase avalanche spreads. After landings, the colony runs the project's own tests on trunk in an isolated Dynamic Worker: a passing commit moves the `certified` branch, which only ever points at a commit whose tests passed, and a failing trunk becomes a repair intent that agents take like any other need. A repair counts only when the tests it was declared for run and pass, and `certified` never moves on a run that lost tests. A person can undo any landing with `ft revert`; it is refused when work has landed on top.
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
| Merge conflict | A return naming each file that changed under the agent's reads, with the version it read and the version on trunk |
| Protected, always-green branch | `certified`: moves only to trunk commits whose own tests passed |
| `git revert` | `ft revert`: a person undoes a landing as a new commit, refused when work landed on top; its intents come back with the reason |
| `git blame` | `ft why`: the lineage of any line, from git notes |

## What it has done

On the live service, every landing is a real commit on an Artifacts repository. Logs, event streams and colony summaries for each row: [packages/bench/results/2026-10-12-prod](packages/bench/results/2026-10-12-prod/).

| Run | Result |
| --- | --- |
| Hono (583 files), rule "relative imports name their file", **80 LLM agents** | 958 violations → 0 in **62 s** from declaring the rule; all 282 rule edits landed on deterministic proof, in 192 commits; 0 returned, 0 abandoned; model spend **$0.05** |
| New project from a spec (a link-shortener Worker: 13 intents, 5 rules), 6 LLM agents | empty repository → all 13 intents landed in 8 minutes; from a plain `git clone`, `node --test` passes 60 of 60 and the reference acceptance suite ([demo/shortlinks-reference](demo/shortlinks-reference/test/acceptance.test.ts)) 7 of 7; 0 rule violations; model spend $0.25 |
| Trunk certification and repair, on a second run of that spec whose clone passed 62 of 67 of its own tests | certifying trunk took 267 ms and found the same 5 failures; the colony declared repair intents and its agents landed two repairs (the review arc returned one broken attempt); trunk certified green at **67 of 67** after 67 minutes, and a plain clone agrees, with the reference acceptance suite 7 of 7; model spend **$0.45** ([logs](packages/bench/results/2026-10-12-prod/)) |
| An external agent over MCP (Claude Code, headless) | joined a colony, took an intent, edited and pushed with plain git in its own workspace, and landed on proof 38 s into the session (18 turns, $0.17) |
| OpenSpec (1,287 files), rule "Node built-ins use `node:`", 20 agents | 131 violations → 0; 74 of 74 intents landed in 43 commits |
| Vaccination meter (OpenSpec) | 28 of 28 seeded bad changes stopped before landing (95% CI 0.88–1.0): 7 returned by the second opinion, 21 sent to a person. The four threat classes are named in our own patterns and prompts, so this measures routing, not a reviewer's recall of threats it was not told about |
| Cascade | one shared-file change sent 30 proposals back stale; σ peaked at 30 and fell below 1 within 40 s |

On preview deployments (the same code with its own Durable Objects):

| Run | Result |
| --- | --- |
| Scale, synthetic agents (no model calls, review off; each proposal adds one new file and reads nothing, so these runs measure the platform without contention) | 1,000 / 2,000 / 5,000 concurrent agents landed 2,924 / 2,714 / 2,778 changes a minute; all 5,894 landing commits carry their lineage note ([results](packages/bench/results/2026-10-12-scale/)) |
| Group commit, synthetic agents | 690 landings/min at 200 concurrent agents (5.5× one commit per landing); time to land p50 2.9 s ([results](packages/bench/results/2026-10-12-g1/)) |
| Change of direction, Gemma agents | retracting a rule mid-run withdrew 35 intents in 0.81 s and nothing landed for it afterwards; an intent amended while an agent worked on it landed as revision 2 6.3 s later; a note sent to a working agent was followed in the change that landed ([logs](packages/bench/results/2026-10-12-direction/)) |

The benchmark compares FireTrident with the common design (exclusive file locks plus one serialized merge queue) on the same workloads; every point is labeled measured or simulated: [packages/bench/results](packages/bench/results).

## Watch a finished run

Any colony replays from its first event: open [`/c/hono?replay=1`](https://firetrident.mattsolt.workers.dev/c/hono?replay=1) for play, pause, 1× to 16× and a scrubber. Colonies record their events as they work; the showcase colonies ran before recording existed, so their replays are rebuilt from what each colony stores (intents, proposals, decisions and landings with their times) and labeled "reconstructed", with claim times estimated.

Runs since then replay from their own record. [`/c/shortlinks-review?replay=1`](https://firetrident.mattsolt.workers.dev/c/shortlinks-review?replay=1) shows a new project growing, its authentication route waiting for a person, and, later, trunk certification finding five failing tests and the colony repairing them until the trunk bar reads 67/67.

## Verify it with plain git

The showcase colonies (`hono`, `shortlinks`, `byo-demo`) can be read with stock git. You need no account and no token. The server holds a read-only token for each trunk, and pushes are refused.

```sh
git clone https://firetrident.mattsolt.workers.dev/git/hono.git
cd hono
git fetch origin refs/notes/firetrident:refs/notes/firetrident
git log --notes=firetrident -3
```

Each landed commit shows its `FT-*` trailers and, under `Notes (firetrident):`, the JSON lineage note. `git notes --ref=firetrident show <commit>` prints a note on its own. On your own deployment, list the colonies to share in `FT_PUBLIC_GIT` (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#plain-git-access)).

## Run it

You need Node 24 and a Cloudflare account on Workers Paid with access to Artifacts.

```sh
git clone https://github.com/roboruby/fire_trident && cd fire_trident
npm install
npm run build -w @fire_trident/web
cd packages/worker
npx wrangler deploy                     # creates the Durable Objects, uses six Artifacts namespaces
npx wrangler secret put FT_ADMIN_TOKEN  # bearer token for mutating API routes (without it, writes are refused)
cd ../..
```

For `wrangler dev`, put `FT_ADMIN_TOKEN=<token>` in `packages/worker/.dev.vars` (or `FT_OPEN_WRITES=1`, for local development only).

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
ft revert hono <landing> --reason "why it should not have landed"
```

Open `https://<your-worker>.workers.dev/c/hono` for the colony map. `ruby scripts/demo_hono.rb` runs the whole Hono demo in one command.

Grow a new project from a spec:

```sh
ft new --spec demo/new-project-spec.md --name shortlinks
ft swarm shortlinks --agents 6
```

`ruby demo/run_new_project.rb` runs it end to end and verifies the result from a plain git clone.

### Bring your own agent

Any coding agent that speaks MCP can join a colony and work next to the in-platform agents. It gets the same coordination and review and leaves the same lineage. It never holds a trunk write token. It edits with plain git in its own workspace, and the platform decides what lands.

Point your client at the colony's MCP endpoint, either Streamable HTTP at `/mcp` or legacy SSE at `/sse`:

```sh
npx wrangler secret put FT_MCP_TOKEN    # in packages/worker, once; without it /mcp refuses connections
claude mcp add --transport http firetrident https://<your-host>/mcp --header "Authorization: Bearer $FT_MCP_TOKEN"
```

Then ask for one thing: *"Join the FireTrident colony `my-colony`, take one intent, make the change, propose it, and wait until it lands."* The server's instructions and tool descriptions handle the rest:

| Tool | What it does |
| --- | --- |
| `join` | Registers this session as an external agent (or resumes one by `agentId`). |
| `sense` | Reads the field (claims, needs, trails, failures, admission) for paths, regions, your footprint, or the whole colony. |
| `take` | Self-assigns an intent and returns a workspace lease: a trunk read token, a workspace write token, and git commands that need no other shell state. Pass `wait` and the server waits for work. |
| `checkout` | Returns the current lease again. |
| `read` | Returns a file at the lease base and records it in your read set, which is how stale work is caught at landing. |
| `propose` | Proposes your pushed head commit. The server computes the write set from the commits and records your `notVerified` statement for review. |
| `inbox` | Shows your outcomes. Pass `wait` and it blocks until the proposal lands, is returned, is rejected, or goes to a human. |
| `release` | Gives back work you can't finish. |
| `declare` | Adds a follow-up intent. |
| `why` | Shows the lineage of a path or line: landing, intent, agent, model, read and write sets, review checks. |

Every tool call heartbeats your claim, so a slow agent keeps its work. An agent silent for ten minutes loses its intent to the colony.

Try it end to end. `scripts/mcp_join.rb` imports a small repo, declares a rule, runs Claude Code headless as the external agent, and releases an in-platform agent next to it:

```sh
ruby scripts/mcp_join.rb --url https://<your-host> --colony byo-demo --setup --swarm 1
```

On production, Claude Code (Sonnet 5.5, headless) joined at 6.3 s, took an intent at 8.6 s, proposed at 31.5 s and landed at 38.1 s, while one in-platform agent landed the colony's other two intents ([log](packages/bench/results/2026-10-12-prod/byo-run.log), [transcript](packages/bench/results/2026-10-12-prod/byo-transcript.jsonl)). It also landed in each of four earlier runs on a preview deployment. `node scripts/mcp_e2e.ts` runs the same loop with a scripted MCP client and checks the trailers and the `refs/notes/firetrident` note from a plain git clone.

## How it uses Cloudflare

- **Artifacts:** one trunk repository per colony (imported from any public git URL or started empty), a warm pool of workspace forks spread across four namespaces, short-lived repo-scoped tokens (agents never hold a trunk write token), git notes for lineage, antibodies committed as files, and a read-only git endpoint that serves the showcase trunks to stock git.
- **Durable Objects:** the colony, one object per region of the code (field, admission, lane), the single trunk writer, the workspace pool, and every in-platform agent.
- **`@cloudflare/computer`:** git inside Durable Objects for the trunk writer and the agents (clone ~350 ms, commit ~90 ms, push ~300 ms).
- **Dynamic Workers:** trunk certification loads each project's own tests into a Worker built at run time, with no network access and CPU and time limits.
- **Workers AI:** Clef decision models for the reflex arc; Kimi K2.7 Code and Gemma 4 for agents; gpt-oss and Gemma for second opinions.
- **Agents SDK** (the MCP server), **Workflows**, **Analytics Engine**, and static assets on Workers for the colony map.

## Related work

Research published in 2026 covers several of these parts on its own, and FireTrident's newest checks come from what it measured:

- **Declared change intents.** Claim Plane ([arXiv:2607.21909](https://arxiv.org/abs/2607.21909), [2608.00947](https://arxiv.org/abs/2608.00947)) admits each change's declared scope before any code is written. In its 360-execution study, that raised integration success from 65.6% to 96.7% but ran 96.7% of executions one at a time. FireTrident takes the other side of the trade: the predicted footprint steers who takes what through decaying claims, and what lands is decided by the files each change actually read and wrote, checked against trunk when it lands.
- **Intent-first coordination over MCP.** MPAC ([arXiv:2604.09744](https://arxiv.org/abs/2604.09744)) and AgentRoom ([arXiv:2608.23740](https://arxiv.org/abs/2608.23740)) give agents intent declarations, claims and status as tools, with two or three agents.
- **Read-set validation of agent edits.** STORM ([arXiv:2605.20563](https://arxiv.org/abs/2605.20563)) applies it to each write in one shared directory. FireTrident applies it once per multi-file change on isolated forks, so a change lands whole or not at all, and it never synthesizes a merge.
- **Coordination records in git**: grite ([arXiv:2606.19616](https://arxiv.org/abs/2606.19616)). **Test evidence reused until its import closure changes**: Assay ([arXiv:2609.36170](https://arxiv.org/abs/2609.36170)), after regression test selection. **Rules learned from failures**: Relic ([arXiv:2609.32965](https://arxiv.org/abs/2609.32965)).

These systems ran 2 to 32 agents. FireTrident combines the parts on a live service and measures them with thousands. From the same literature: a repair now counts only when the tests it was declared for pass ([arXiv:2606.18168](https://arxiv.org/abs/2606.18168), [2610.12822](https://arxiv.org/abs/2610.12822)), a model's approval counts only when it saw the whole change ([arXiv:2610.10961](https://arxiv.org/abs/2610.10961)), only people and rules can waive a danger gate ([arXiv:2605.29178](https://arxiv.org/abs/2605.29178), [2608.02693](https://arxiv.org/abs/2608.02693), [2606.13757](https://arxiv.org/abs/2606.13757)), and the person asked to decide sees the change itself ([arXiv:2607.29516](https://arxiv.org/abs/2607.29516)).

## Honest limits

- Optimism costs rework. In the simulator, driven by Hono's real history, with every design paying the same full redo for a returned change, plain optimistic claims rework 43% of agent work against 35% for exclusive locks. Decaying inhibition and co-change learning bring FireTrident to 30%, below locks, while landing 3.4 times as many changes a minute; under group commit, which production runs, inhibition costs about 7% of landings. Nearly every remaining return (99.8%) is a stale read, not a conflicting write, and 71% of them are on the three most-imported files. Two next steps target that in the same simulator: assigning work away from the imports and importers of files others hold (16% rework, 10% fewer landings) and landing a stale-read change when the imports it relies on still hold (14 to 18% rework, 19 to 24% more landings). All simulated: [results](packages/bench/results/2026-10-13-papers/).
- The project's tests run right after landing, not before it. Before landing, every change passes the rule re-check, read-set validation against current trunk and the danger patterns, and then either the proof, two independent confirmations or a person; its tests then run on trunk, in about a quarter of a second for the new project. A broken change can still sit on `main` until a repair lands, but `certified` only moves to commits whose tests passed. Certification runs tests, not a type check. Only `node:test` files run (projects tested with another runner are skipped), the tests in one file run one after another, and a test file that awaits at the top level runs until its time limit. A second run of the new-project spec, made before certification existed, landed all 13 intents, yet from a plain clone it passes 62 of 67 of its own tests and 6 of 7 acceptance checks ([log](packages/bench/results/2026-10-12-prod/shortlinks-review-run.log)); the first run passed all of them. Certified afterwards, it went red, and two repairs from the colony brought it to 67 of 67.
- Conflicts are found per file. A change goes back when a file it read or wrote changed under it, or when a file its imports resolve to is gone, which also catches conflicts between different files (in the cascade run, one shared file sent back 30 proposals that had read it). Two changes to different files that are wrong together, neither reading the other's file, both land; certification catches them when the tests cover them. The import check holds within one landing cycle: a deletion that lands in a later cycle than a new import of the same file is caught only by certification. An external agent's read set holds the files it read through the `read` tool; files it reads from its own clone are invisible to this check.
- Changes that touch authentication or secrets go to a person, by deterministic patterns, and so do new process and network access unless a person or a rule asked for it; an agent's own description never waives them. So do changes to what decides on agents: the colony's own memory (`.firetrident/`, where antibodies live) and agent instructions (`AGENTS.md`, `CLAUDE.md`, `.claude/`), which no policy or antibody can waive. The patterns catch capability a change adds, not a check it loosens: a deleted guard or a relaxed comparison is judged only by the models. Review looks at one change at a time, so an attack split across several harmless-looking changes is an open problem. The second opinion is a scope check, not a bug finder: in the second new-project run, changes it approved left 5 of 67 tests failing until certification caught them. Other borderline calls rest on model judgment and can vary between runs.
- Past about 1,000 concurrent agents, throughput stops growing. The single trunk writer commits every 3.4 to 3.9 s and caps each commit at 200 proposals, so 5,000 agents land no faster than 1,000 and wait about 6 s in its queue. Those runs used synthetic agents; with language models, Workers AI rate limits (about 300 requests a minute for Gemma 4 on our account) bind long before the colony does.
- In the 5,000-agent run, 78 of 50,368 calls failed in the first 33 s: the load generator's own DNS and connection errors, and one reset when the preview's code was updated.
- Replays of runs from before event recording are reconstructed, so their claim times are estimates.

## Repository

`packages/core` (pure coordination logic) · `packages/worker` (Worker, Durable Objects, MCP) · `packages/web` (the colony map) · `packages/cli` (`ft`) · `packages/bench` (workload generator, simulator, live runs) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

License: MIT.
