# FireTrident

**A colony, not a queue.** Git coordination for thousands of concurrent coding agents, built on Cloudflare Workers, Durable Objects and Artifacts.

Git platforms coordinate people through things they lock and queue: branches, pull requests, a merge queue, a reviewer. Past a few dozen agents the queue becomes the product: every agent waits in one line and every reviewer drowns. Ant colonies, slime molds and immune systems coordinate millions of individuals with no queue and no manager. FireTrident brings the same moves to a repository:

- **Sense.** Agents leave decaying signals on the code (claims, needs, trails, failures, danger) and read the field instead of messaging each other. Reading it costs the same at 10 agents or 10,000. Agents choose their own work with a response-threshold rule. A claim inhibits other agents from the same files, the way a committed cell suppresses its neighbors, but it decays, so a silent agent never blocks anyone for long. A co-change map learned from the history steers agents away from code that usually changes together with what others hold, and a crowded region admits new agents only as fast as it lands work. When an agent takes work, it sees why the code is the way it is (the latest landings on its files, with their intents and whys) and what review will ask; when files it holds change on trunk while it works, it is told what landed.
- **Decide.** Every proposal goes through a reflex arc: deterministic proof first (for import rules, every changed import is resolved against the real file tree, and the files it resolves to are checked again when the change lands), then Clef decision models, then a model from a different family, then a person, each only when the cheaper layer is unsure. No model can overrule a deterministic fact. A change lands without a person only on two confirmations bound to its head commit: the innate checks, plus a deterministic proof that it changes nothing but what its rule asks, a second model's approval of every changed line, or earned autonomy with a confident, quiet reflex. On the proof path both confirmations are deterministic and rest on a rule a person wrote. A human rejection that no antibody caught becomes a new antibody, a check committed to the repository that screens every later change; agents see those checks' questions when they take work on the files they cover. A loosened guard (a deleted 401, a weakened auth condition, `verify` swapped for `decode`) always needs a second opinion. An agent that finds an intent cannot be done as written escalates it to a person instead of working around it. A change that only edits comments or whitespace in existing script files lands on a deterministic proof, with no model; a change to a path the colony protects (`ft policy --protect`) needs a person, even with review off. A stuck-work detector reports work that stopped moving (held with no change, coming back again and again, a trunk red too long, a person's answer waiting), with what to do, in `ft status` and on the needs-you strip.
- **Land.** Lanes per region of the code batch non-conflicting proposals and validate what each agent read, not just what it wrote. One trunk writer takes every waiting lane batch each cycle, commits each batch on top of the last, and pushes the tip once with compare-and-swap. With assumption revalidation on, a change that is stale only because a file it read changed still lands when every name it imports from that file is still exported, instead of being redone. Several agents can race one intent (contest mode): the colony lands the change with the best deterministic evidence and a position-swapped pairwise second opinion, and keeps the others in its lineage. A cascade detector watches the branching ratio of stale returns and slows a region down before a rebase avalanche spreads. A proposal can carry its file contents (an inline change, checked against git's blob ids), so the trunk writer never reads it back from a workspace, and an external agent can propose over MCP with no git at all. With virtual checkouts, in-platform agents read only the trees and blobs they need instead of cloning; with asynchronous publishing, the trunk writer records landings in its own storage and pushes trunk to git beside its cycles, and a take that would start on a base without a fresh landing on its files waits a moment. With text merge on (`FT_TEXT_MERGE`), a change stale only on files it writes lands when each of them merges cleanly line by line, as git's default merge does, and its lineage note records the merge; overlapping edits still go back, naming the conflicting hunks. After landings, the colony runs the project's own tests on trunk in an isolated Dynamic Worker: a passing commit moves the `certified` branch, which only ever points at a commit on which every test certification could run passed, and a failing trunk becomes a repair intent that agents take like any other need. A repair counts only when the tests it was declared for run and pass, and `certified` never moves on a run that lost tests. A red result names its suspects: the landings since the last green commit that changed the failing test's import closure, each with `ft revert <colony> <prp>`. A person can undo any landing, or one proposal of it, with `ft revert`; it is refused when work has landed on top. A change of direction takes effect at the trunk writer: a withdrawal or amendment either stops a change in flight or names the landing it lost to.
- **Remember.** Every landed commit carries `FT-*` trailers and a JSON lineage note under `refs/notes/firetrident`: the intent, the rule and who approved it, the agent and model, every decision with its probability, the checks, what the agent did not verify, and the exact files read and written. Any git client can read it. Each note also says how its author and model are known: a model FireTrident's own agent called is `observed`, with its calls and tokens; an external agent's model is `declared`, as the agent named it. Each commit carries its note's SHA-256 in an `FT-Note` trailer, so a rewritten note is caught (`ft verify <colony>`, or `scripts/verify_note.mjs` with stock git).

Humans declare a **target morphology** (architecture rules plus tests). Every violation becomes a need in the field, and the colony converges until there are none.

## How git's ideas map

| Git platform | FireTrident |
| --- | --- |
| Repository | A colony: a trunk repository in Artifacts plus the field around it |
| Branch, worktree | A workspace: an Artifacts fork leased to one agent with a short-lived token scoped to that fork |
| Issue, assignment | An intent with a predicted footprint, chosen by agents from the field |
| Pull request | A proposal: write set, read set, evidence, and what was not verified |
| Code review | The reflex arc: proof, Clef, a second model, a person; antibodies remember every rejection |
| Merge queue | Lanes per region of the code, batched by maximal independent sets; one commit per batch, and each cycle's batches pushed to trunk together |
| Merge conflict | A return naming each file that changed under the agent's reads, with the version it read and the version on trunk, unless the names it imports from them all still exist (assumption revalidation) |
| Competing pull requests for one issue | Contest mode: up to four agents race one intent; one lands, the others stay in its lineage as alternatives |
| "Blocked: the issue is wrong" | `escalate`: the agent reports it and the intent waits for a person to amend, withdraw or dismiss |
| Protected, always-green branch | `certified`: moves only to trunk commits on which every test file certification could run passed; deploy and pin from it |
| `git revert` | `ft revert`: a person undoes a landing, or one proposal of it, as a new commit, refused when work landed on top; its intents come back with the reason |
| `git blame` | `ft why`: the lineage of any line, from git notes |

## What it has done

On the live service, every landing is a real commit on an Artifacts repository. Logs, event streams and colony summaries for each row: [packages/bench/results/2026-10-12-prod](packages/bench/results/2026-10-12-prod/).

| Run | Result |
| --- | --- |
| Hono (583 files), rule "relative imports name their file", **80 LLM agents** | 958 violations → 0 in **62 s** from declaring the rule; all 282 rule edits landed on deterministic proof, in 192 commits; 0 returned, 0 abandoned; model spend **$0.05** |
| New project from a spec (a link-shortener Worker: 13 intents, 5 rules), 6 LLM agents | empty repository → all 13 intents landed in 8 minutes; from a plain `git clone`, `node --test` passes 60 of 60 and the reference acceptance suite ([demo/shortlinks-reference](demo/shortlinks-reference/test/acceptance.test.ts)) 7 of 7; 0 rule violations; model spend $0.25. This run came before the danger patterns existed, so its admin-auth route landed on a second model's approval; in the second run below it waited for a person |
| Trunk certification and repair, on a second run of that spec whose clone passed 62 of 67 of its own tests | certifying trunk took 267 ms and found the same 5 failures; the colony declared repair intents and its agents landed two repairs (the review arc returned one broken attempt); trunk certified green at **67 of 67** after 67 minutes, and a plain clone agrees, with the reference acceptance suite 7 of 7; model spend **$0.45** ([logs](packages/bench/results/2026-10-12-prod/)) |
| An external agent over MCP (Claude Code, headless) | joined a colony, took an intent, edited and pushed with plain git in its own workspace, and landed on proof 38 s into the session (18 turns, $0.17) |
| OpenSpec (1,287 files), rule "Node built-ins use `node:`", 20 agents | 131 violations → 0; 74 of 74 intents landed in 43 commits |
| Vaccination meter (OpenSpec) | 28 of 28 seeded bad changes stopped before landing (95% CI 0.88–1.0): 7 returned by the second opinion, 21 sent to a person. The four threat classes are named in our own patterns and prompts, so this measures routing, not a reviewer's recall of threats it was not told about |
| Cascade | one shared-file change sent 30 proposals back stale; σ peaked at 30 and fell below 1 within 40 s |
| Change of direction, Gemma agents ([logs](packages/bench/results/2026-10-12-direction/)) | a rule retracted mid-run (hexo, 6 agents): the call answered in 0.65 s, 35 intents were withdrawn and 3 changes in flight sent back, and nothing landed for the rule afterwards; an intent amended while its agent was writing landed as revision 2 24.2 s later; a directive sent after an agent had proposed was followed in the change that landed 10.9 s later |

On preview deployments (the same code with its own Durable Objects):

| Run | Result |
| --- | --- |
| Scale, synthetic agents (no model calls, review off; each proposal adds one new file and reads nothing, so these runs measure the platform without contention) | 1,000 / 2,000 / 5,000 concurrent agents landed 2,924 / 2,714 / 2,778 changes a minute; all 5,894 landing commits carry their lineage note ([results](packages/bench/results/2026-10-12-scale/)) |
| Group commit, synthetic agents | 690 landings/min at 200 concurrent agents (5.5× one commit per landing); time to land p50 2.9 s ([results](packages/bench/results/2026-10-12-g1/)) |
| Change of direction, Gemma agents | retracting a rule mid-run withdrew 35 intents in 0.81 s and nothing landed for it afterwards; an intent amended while an agent worked on it landed as revision 2 6.3 s later; a note sent to a working agent was followed in the change that landed ([logs](packages/bench/results/2026-10-12-direction/)) |
| Assumption revalidation, the cascade on Hono (30 readers import `Hono` from `src/hono.ts`, then a writer adds an export to it) | with revalidation on, 0 of 30 went back and all 30 landed on their first proposal; with it off, 30 of 30 went back stale, σ peaked at 29 and the region was inhibited 14 times ([results](packages/bench/results/2026-10-13-round2/)) |
| Escalation over MCP | an external agent reported an intent as contradictory; no agent could take it while the report waited, and a person's dismissal reopened it (`scripts/mcp_escalate.ts`) |
| Contest mode, three agents on one intent | the colony held the three ready changes; the judge preferred whichever it was shown first in both orders, so that comparison counted as a tie broken by the smaller diff; the winner landed and its lineage keeps the other two as alternatives |
| Direction commit point, withdrawals raced against the trunk writer with its push held open 6 to 10 s (`scripts/direction_race.rb`) | 7 withdrawals that arrived after the cycle's direction check were each answered with the landing they lost to, in 2.4 to 10.5 s, and trunk held exactly that change; 2 sent while the change waited in the writer's queue stopped it, and it never reached trunk while the change ahead landed. The first queued try caught a real bug: the colony recorded the withdrawal at the trunk writer only after telling the lanes, which can wait behind a landing in flight; it now records it first |
| Round 3 over MCP (`scripts/mcp_round3.ts`) | a token in the URL or a wrong token got 401; another session resumed an external agent only with the key join gave it; with the deletion guard on, deleting a file another trunk file imports went back naming the importer, the next take carried that reason (`lastReturn`), and deleting it with the importer rewritten landed; MCP `why` listed only the proposals that wrote the path |
| Per-proposal revert, on a Hono landing that carried two proposals | `ft revert <prp_...>` undid only that proposal's file and declared its intent again, the other proposal's file untouched; reverting it again, or the whole landing, was refused (409, naming the revert); reverting the revert put the file back and withdrew the redo intent |
| Hono rule run on round-3 code, 20 Gemma agents, deletion guard on | 958 violations → 0 in 141.5 s, 283 intents landed, 0 returned, $0.047 |
| New project on round-3 code, 6 agents, two runs | all 13 intents landed both times (in 691 s the second time). Both times an agent's slug test disagreed with the code, and certification caught it on its first run. In the second run the repair agent traced it to the test (it expected a 35-character slug to pass; the spec allows 3 to 32) and escalated it as a broken test instead of weakening it; a person amended the intent, an agent fixed the test, the test edit went to a person as every test edit during a repair does, and trunk certified green at 66 of 66 |
| Round 4 over MCP (`scripts/mcp_round4.ts`), with synchronous and with asynchronous publishing | an inline change (the file contents themselves, no git) landed and certified green; a change that only edited comments landed on its proof with no model; a change to a protected path waited for a person, naming the glob, with review off; a breaking change with review off turned certification red, and the result and its repair intent named that proposal as the suspect |
| Hono rule run on round-4 code, 20 Gemma agents with virtual checkouts | 958 violations → 0 in 114.2 s with asynchronous publishing (98 landing commits a minute) and in 135.6 s without (84); 283 intents landed and 0 returned both times; $0.051 and $0.047 |
| New project on round-4 code, 6 agents with virtual checkouts and inline changes | all 13 intents landed in 408.5 s, the fastest run of that spec; every certification green, ending at 49 of 49 (matching `node --test` on a plain clone), acceptance 7 of 7; $0.011 per certified intent |
| Scale with inline changes, synthetic agents (no model calls, review off, 64 regions) | at 5,000 agents the git path landed 1,821 changes a minute (a 5.1 s trunk cycle, 3.9 s of it reading blobs from workspaces) and inline changes 3,842 (a 2.8 s cycle); with asynchronous publishing on top the cycle fell to 1.8 to 2.5 s and median time to land to about 8 s, but landings a minute did not rise (2,759 and 3,776), the colony object having become the limit; 0 returned in any run ([results](packages/bench/results/2026-10-13-round4/)) |
| Text merge on a preview, two agents editing lines 2 and 11 of one file from the same trunk | with text merge on, both landed, the second as a line-by-line merge whose result holds both edits; with it off, the second went back stale; two edits to line 6 ended with one landing and the other back, naming the conflicting hunk |
| Hono rule run on round-5 code, 20 Gemma agents, text merge on | 958 violations → 0 in 112.5 s (103.5 landing commits a minute); 283 intents landed and 0 returned; $0.051. Every note names its model as observed, with the calls and tokens; `ft verify` found the 20 newest notes intact, `scripts/verify_note.mjs` on a stock `git clone` found 8 of 8 intact, and a note edited by hand was reported altered |
| External agents following [docs/agents](docs/agents/) | Claude Code 2.1.299, Codex CLI 0.162.1 and plain `curl` each joined a colony on a preview and landed a change. The round-5 MCP check (`scripts/mcp_round5.ts`) passed: a repeated `declare` returned the same intent, a failed call carried a structured error, the landed note says the model was declared by an agent authenticated over MCP, and the public MCP answered with no token |

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

Each landed commit shows its `FT-*` trailers and, under `Notes (firetrident):`, the JSON lineage note. Its last trailer, `FT-Note`, is the SHA-256 of that note as FireTrident wrote it (without `certification`, which certification adds later), so anyone can check that no note was rewritten: from a FireTrident checkout, `node scripts/verify_note.mjs <commit>` run inside the clone prints `intact`, `altered` or `missing`. `git notes --ref=firetrident show <commit>` prints a note on its own. On your own deployment, list the colonies to share in `FT_PUBLIC_GIT` (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#plain-git-access)).

### Ask it with your own agent

The same colonies answer any MCP client, read only and with no token:

```sh
claude mcp add --transport http firetrident-public https://firetrident.mattsolt.workers.dev/public/mcp
```

Then ask, for example, "In colony hono, why does line 17 of src/index.ts exist? Which agent and model wrote it, and what checked it?" or "Is shortlinks certified, and is anything stuck?" The tools are `status`, `why`, `intent` and `sense` ([docs/agents](docs/agents/README.md#ask-a-showcase-colony-no-token)).

## Run it

You need:

- Node 24.
- A Cloudflare account on Workers Paid with access to Artifacts. FireTrident also uses Durable Objects, Workers AI, Workflows, Analytics Engine and Dynamic Workers (open beta on Workers Paid; trunk certification runs in them).
- `npx wrangler login`, even for `wrangler dev`. The Artifacts and Workers AI bindings always run remotely; without a login, `wrangler dev` stops with "Failed to start the remote proxy session".
- Ruby, for the demo scripts (`scripts/*.rb`, `demo/*.rb`).
- An MCP client, to bring your own agent (below).

```sh
git clone https://github.com/roboruby/fire_trident && cd fire_trident
npm install
npm run build -w @fire_trident/web
cd packages/worker
npx wrangler deploy                     # creates the Durable Objects, uses six Artifacts namespaces
npx wrangler secret put FT_ADMIN_TOKEN  # bearer token for mutating API routes (without it, writes are refused)
cd ../..
```

`npx wrangler dev` in `packages/worker` needs the same account and login. It uses your account's Artifacts namespaces, the same ones a deployment uses, so give local colonies names your deployment does not use. Put `FT_ADMIN_TOKEN=<token>` in `packages/worker/.dev.vars` (or `FT_OPEN_WRITES=1`, for local development only).

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
ft revert hono <prp_...> --reason "just this proposal"   # one proposal of a landing
```

Open `https://<your-worker>.workers.dev/c/hono` for the colony map. `ruby scripts/demo_hono.rb` runs the whole Hono demo in one command.

Grow a new project from a spec:

```sh
ft new --spec demo/new-project-spec.md --name shortlinks
ft swarm shortlinks --agents 6
```

`ruby demo/run_new_project.rb` runs it end to end and verifies the result from a plain git clone. A spec can also declare governance: `"policy": {"protectedPaths": ["src/auth/**"], "commentProof": false}` is set before any rule or intent, so changes to those paths wait for a person from the first landing, even with review off.

### Bring your own agent

Any coding agent that speaks MCP can join a colony and work next to the in-platform agents. It gets the same coordination and review and leaves the same lineage. It never holds a trunk write token. It edits with plain git in its own workspace, and the platform decides what lands.

Setup guides for Claude Code, Codex CLI, Cursor and plain `curl`, with a drop-in `AGENTS.md` for your repository: [docs/agents](docs/agents/).

Every failed call carries a machine-readable error (`kind`, `retryable`, `retryAfterMs`, and `next` where the next call is clear), and a repeated `declare` returns the intent it made instead of a second one.

What FireTrident defends against, what it leaves out, and how to report a vulnerability privately: [SECURITY.md](SECURITY.md).

Point your client at the colony's MCP endpoint, either Streamable HTTP at `/mcp` or legacy SSE at `/sse`:

```sh
npx wrangler secret put FT_MCP_TOKEN    # in packages/worker, once; without it /mcp refuses connections
claude mcp add --transport http firetrident https://<your-host>/mcp --header "Authorization: Bearer $FT_MCP_TOKEN"
```

Then ask for one thing: *"Join the FireTrident colony `my-colony`, take one intent, make the change, propose it, and wait until it lands."* The server's instructions and tool descriptions handle the rest:

| Tool | What it does |
| --- | --- |
| `join` | Registers this session as an external agent and returns a `resumeKey` once; `agentId` with that `resumeKey` resumes it from another session. |
| `sense` | Reads the field (claims, needs, trails, failures, admission) for paths, regions, your footprint, or the whole colony. |
| `take` | Self-assigns an intent and returns a workspace lease: a trunk read token, a workspace write token, and git commands that need no other shell state. Pass `wait` and the server waits for work. |
| `checkout` | Returns the current lease again. |
| `read` | Returns a file at the lease base and records it in your read set, which is how stale work is caught at landing. |
| `propose` | Proposes your pushed head commit, or, with `files`, the file contents themselves (no git needed; up to 64 text files and 512 KB). The server computes the write set from the commits or the files and records your `notVerified` statement for review. |
| `inbox` | Shows your outcomes. Pass `wait` and it blocks until the proposal lands, is returned, is rejected, or goes to a human. |
| `release` | Gives back work you can't finish. |
| `escalate` | Reports that the intent can't be done as written (a wrong test, a contradictory spec); it waits for a person. |
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
- **Dynamic Workers:** trunk certification loads each project's own tests into a Worker built at run time, with no network access, no environment or bindings, and CPU and time limits.
- **Workers AI:** Clef decision models for the reflex arc; Kimi K2.7 Code and Gemma 4 for agents; gpt-oss and Gemma for second opinions.
- **Agents SDK** (the MCP server), **Workflows**, **Analytics Engine**, and static assets on Workers for the colony map.

## Related work

Research published in 2026 covers several of these parts on its own, and FireTrident's newest checks come from what it measured:

- **Declared change intents.** Claim Plane ([arXiv:2607.21909](https://arxiv.org/abs/2607.21909), [2608.00947](https://arxiv.org/abs/2608.00947)) admits each change's declared scope before any code is written. In its 360-execution study, that raised integration success from 65.6% to 96.7% but ran 96.7% of executions one at a time. FireTrident takes the other side of the trade: the predicted footprint steers who takes what through decaying claims, and what lands is decided by the files each change actually read and wrote, checked against trunk when it lands.
- **Intent-first coordination over MCP.** MPAC ([arXiv:2604.09744](https://arxiv.org/abs/2604.09744)) and AgentRoom ([arXiv:2608.23740](https://arxiv.org/abs/2608.23740)) give agents intent declarations, claims and status as tools, with two or three agents.
- **Read-set validation of agent edits.** STORM ([arXiv:2605.20563](https://arxiv.org/abs/2605.20563)) applies it to each write in one shared directory. FireTrident applies it once per multi-file change on isolated forks, so a change lands whole or not at all, and it never synthesizes a merge.
- **Coordination records in git**: grite ([arXiv:2606.19616](https://arxiv.org/abs/2606.19616)). **Test evidence reused until its import closure changes**: Assay ([arXiv:2609.36170](https://arxiv.org/abs/2609.36170)), after regression test selection. **Rules learned from failures**: Relic ([arXiv:2609.32965](https://arxiv.org/abs/2609.32965)).

On 2026-10-13 Anthropic described Scion, the version control system it built when its monorepo passed 30,000 merged changes a day ([Redesigning source control at Anthropic](https://www.anthropic.com/engineering/redesigning-source-control)). Its conclusions are FireTrident's assumptions: at agent scale a merge queue stops making sense, so test after merging and before deploying; commits, merges and history belong on the server, behind an API that jobs can ask without a local copy; a change is the list of files it changed with pointers to their contents; and everything that can be derived from that log (blame, path history) is derived data, computed incrementally. The post asks git platforms to bring these ideas to git without leaving it. FireTrident does: its trunk writer builds every trunk commit and moves trunk with compare-and-swap, lineage, blame, certification and review are server-side queries, inline changes carry their contents, derived indexes share one mechanism, culprit finding names the landings behind a red trunk, and any git client can still clone what the colony builds. Scion serves a repository with almost 100 GB of history, checked out on the order of 25 million times a day for CI, a scale FireTrident has not faced; FireTrident adds what Scion leaves to fixing conflicts afterwards: many agents choosing their work from a shared field, and read sets validated before a change lands.

These systems ran 2 to 32 agents. FireTrident combines the parts on a live service and measures them with up to 80 model-driven agents in production; 5,000 synthetic agents (no model calls, review off) load-tested the coordination alone, on a preview. From the same literature: a repair now counts only when the tests it was declared for pass ([arXiv:2606.18168](https://arxiv.org/abs/2606.18168), [2610.12822](https://arxiv.org/abs/2610.12822)), a model's approval counts only when it saw the whole change ([arXiv:2610.10961](https://arxiv.org/abs/2610.10961)), only people and rules can waive a danger gate ([arXiv:2605.29178](https://arxiv.org/abs/2605.29178), [2608.02693](https://arxiv.org/abs/2608.02693), [2606.13757](https://arxiv.org/abs/2606.13757)), and the person asked to decide sees the change itself ([arXiv:2607.29516](https://arxiv.org/abs/2607.29516)).

## Honest limits

- Optimism costs rework. In the simulator, driven by Hono's real history, with every design paying the same full redo for a returned change, plain optimistic claims rework 43% of agent work against 35% for exclusive locks. Decaying inhibition and co-change learning bring FireTrident to a simulated 30%, below locks, while landing 3.4 times as many changes a minute; under group commit, which production runs, inhibition costs about 7% of landings. Nearly every remaining return (99.8%) is a stale read, not a conflicting write, and 71% of them are on the three most-imported files. Two next steps target that in the same simulator: assigning work away from the imports and importers of files others hold (16% rework, 10% fewer landings) and landing a stale-read change when the imports it relies on still hold (14 to 18% rework, 19 to 24% more landings). All simulated: [results](packages/bench/results/2026-10-13-papers/).
- The project's tests run right after landing, not before it. Before landing, every change passes the rule re-check, read-set validation against current trunk and the danger patterns, then a second confirmation or a person; after it lands, its tests run on trunk (267 ms for the 67 tests of the second new-project run, on production). A broken change can still sit on `main` until a repair lands. Certification runs tests, not a type check. Only `node:test` files run (projects tested with another runner are skipped), the tests in one file run one after another, and a test file that awaits at the top level runs until its time limit. A second run of the new-project spec, made before certification existed, landed all 13 intents, yet from a plain clone it passes 62 of 67 of its own tests and 6 of 7 acceptance checks ([log](packages/bench/results/2026-10-12-prod/shortlinks-review-run.log)); the first run passed all of them. Certified afterwards, it went red, and two repairs from the colony brought it to 67 of 67.
- `main` is every landing, tested or not; agents build on it. `certified` is the newest trunk commit on which every test file certification could run passed and no earlier passing test was lost. Deploy, release and pin from it (`git clone -b certified <url>`). Each result lists the test files certification could not run, with the reason (`GET /api/colonies/:id/certifications`).
- Conflicts are found per file. A change goes back when a file it read or wrote changed under it, or when a file its new or rewritten imports resolve to is gone, which also catches conflicts between different files (in the cascade run, one shared file sent back 30 proposals that had read it). Two changes to different files that are wrong together, neither reading the other's file, both land; certification catches them when the tests cover them. The import check holds within one landing cycle: a deletion that lands in a later cycle than a new import of the same file is caught by the deletion guard when it is on (`FT_DELETION_GUARD`, per colony), otherwise only by certification; removing an export is not guarded. An external agent's read set holds the files it read through the `read` tool; files it reads from its own clone are invisible to this check. An in-platform agent's read set holds its footprint's files and the files its intent builds on, not the project tree its prompt lists or the modules its import check reads. Assumption revalidation (off by default, on per colony) checks only that the names a change imports still exist, not their signatures or behavior; certification is the backstop.
- Changes that touch authentication or secrets go to a person, by deterministic patterns, and so do new process and network access unless a person or a rule asked for it; an agent's own description never waives them. So do changes to what decides on agents: the colony's own memory (`.firetrident/`, where antibodies live) and agent instructions (`AGENTS.md`, `CLAUDE.md`, `.claude/`), which no policy or antibody can waive. The patterns catch capability a change adds and the common ways a check is loosened (a deleted 401 or 403, a weakened auth condition, `verify` swapped for `decode`, a deleted expiry or limit check), which then need a second opinion; other loosening (a flipped default, a widened bound, code in another language) is judged only by the models. Review looks at one change at a time, so an attack split across several harmless-looking changes is an open problem. The second opinion is a scope check, not a bug finder: in the second new-project run, changes it approved left 5 of 67 tests failing until certification caught them. Other borderline calls rest on model judgment and can vary between runs. On real history the deterministic danger checks flag 1.1% of Hono's modified script files and 9.5% of FireTrident's own, mostly Durable Object SQL calls read as running a program ([results](packages/bench/results/2026-10-13-danger/)); how often they miss a dangerous change nobody has seen is not measured. Security antibodies' questions are kept out of what agents see at take, but an agent that reads `.firetrident/antibodies/` can read them.
- Text merge (per colony, `FT_TEXT_MERGE`) merges a file line by line, and nobody reviews the merged file as a whole: two edits that merge cleanly but break each other land, and only certification catches them. Binary files, lockfiles and files over 512 KB are never merged, `.gitattributes` is not read, and a change whose edits are already on trunk lands as an empty commit.
- Lineage provenance rests on the platform's own record: a model is `observed` only for agents FireTrident runs (the API refuses to register one or to propose for one), and an external agent's model is what it declared. Notes are tamper-evident, not tamper-proof: a rewritten note is reported, not repaired, and `certification` (added after landing) is outside the digest.
- Asynchronous publishing trades freshness for shorter trunk cycles: trunk in git, and the base a lease starts from, run up to about one push behind the landings the trunk writer has recorded. A take whose files a recorded landing changed waits until it is published; other agents may still build on a base a moment old, and their change comes back stale if a file they read moved. It is off unless a colony is listed in `FT_ASYNC_PUBLISH`. At 5,000 synthetic agents it shortened the trunk writer's cycle (1.8 to 2.5 s against 2.8 s) and median time to land (about 8 s against 10.7 s) but did not raise landings a minute (2,759 and 3,776 against 3,842), and the slowest landings waited longer ([results](packages/bench/results/2026-10-13-round4/)); production lists no colony.
- Virtual checkouts trade one clone for many object reads: a cold write intent on Hono read 107 trees (about 425 ms locally) against a clone's 240 to 380 ms; warm reads, served from the cache, take 45 to 75 ms. The comment-only proof never applies to JSX files or to files with directive comments (`@ts-`, `eslint`, and the like), and culprit finding names landings that touched a failing test's imports, which is not proof that they broke it.
- Past about 1,000 concurrent agents, throughput stops growing with the number of agents. On the git path the single trunk writer is the limit: a cycle takes at most 200 proposals (whole lane batches of up to 50, one commit each) and spends most of its time reading the changed files from workspaces (3.9 of 5.1 s at 5,000 agents). Inline changes skip that read and doubled throughput at 5,000 agents, from 1,821 to 3,842 landings a minute; past that, the colony object, which answers every take and proposal, is the limit, and it slows as a colony's history grows: a colony that had taken about 50,000 intents in eight runs answered some calls "Durable Object is overloaded" while 5,000 agents joined in 10 s. Those runs used synthetic agents; with language models, Workers AI rate limits (about 300 requests a minute for Gemma 4 on our account) bind long before the colony does.
- In the 5,000-agent run, 78 of 50,368 calls failed in the first 33 s: the load generator's own DNS and connection errors, and one reset when the preview's code was updated.
- Replays of runs from before event recording are reconstructed, so their claim times are estimates.

## Repository

`packages/core` (pure coordination logic) · `packages/worker` (Worker, Durable Objects, MCP) · `packages/web` (the colony map) · `packages/cli` (`ft`) · `packages/bench` (workload generator, simulator, live runs) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

License: MIT.
