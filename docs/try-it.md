# Try it

Everything here reads the showcase colonies on firetrident.com with no account and no token, or runs your own deployment, where writes need its admin token. What each colony's run measured is in [results.md](results.md).

## Watch a finished run

Any colony replays from its first event: open [`/c/hono?replay=1`](https://firetrident.com/c/hono?replay=1) for play, pause, 1× to 16× and a scrubber. A run recorded with `scripts/record_colony.ts` plays with no network at all: [`/c/hono?replay=1&recording=hono`](https://firetrident.com/c/hono?replay=1&recording=hono) plays the bundled Hono run, and any recording file can be picked or dropped on a replay page; a director scene still waiting for what it shows moves on after its `maxMs` (30 s by default), and the space bar holds it. Colonies record their events as they work; the showcase colonies ran before recording existed, so their replays are rebuilt from what each colony stores (intents, proposals, decisions and landings with their times) and labeled "reconstructed", with claim times estimated. `/c/hono?tour=1` tells the Hono run in seven steps, each sentence filled from its record; `scripts/tour_check.ts` checks those numbers against the colony's `/metrics`.

Runs since then replay from their own record. [`/c/scale?replay=1`](https://firetrident.com/c/scale?replay=1&t=32&speed=4) plays 2,000 synthetic agents landing 6,606 changes in one repository, and [`/c/order-backend`](https://firetrident.com/c/order-backend) shows three agents with conflicting goals: the first change landed, and the two that would undo it wait for a person. [`/c/shortlinks-review?replay=1`](https://firetrident.com/c/shortlinks-review?replay=1) shows a new project growing, its authentication route waiting for a person, and, later, trunk certification finding five failing tests and the colony repairing them until the trunk bar reads 67/67. The results strip's `signed-notes` card names the key that signs lineage notes, since when, and the stock-git check. Below the results, "Try the rules" has four editable scenes that run the core's merge, read-set, goal-conflict and twin checks in the browser, with production's options and no call to the service, and a fifth, "Git would have merged this": two changes from one trunk that stock git merges cleanly into a program that fails, and FireTrident returns the second because a file it read moved, beside a control twin both land (the outcomes are computed by `scripts/gitmerge_scene.mjs` with real git). [`/c/first-red?tour=1`](https://firetrident.com/c/first-red?tour=1) and [`/c/order-backend?tour=1`](https://firetrident.com/c/order-backend?tour=1) tell those colonies the same way, from their records; `scripts/tour_check.ts --colony first-red` (and `order-backend`) checks their numbers against `/certifications`, `/review` and `/metrics`.

## Verify it with plain git

Check the newest note of `byo-demo` with [scripts/verify_note.mjs](../scripts/verify_note.mjs), no account and no token:

```sh
git clone https://firetrident.com/git/byo-demo.git && cd byo-demo
git fetch origin refs/notes/firetrident:refs/notes/firetrident
git log --notes=firetrident -1
curl -fsSL -o ../verify_note.mjs \
  https://raw.githubusercontent.com/roboruby/fire_trident/main/scripts/verify_note.mjs
node ../verify_note.mjs HEAD   # prints intact, then who is answerable for the landing
```

Since 2026-10-14 the production trunk writer also signs each commit it builds, and publishes the key: on `signed-notes`, the same script with `--keys` names the signer.

```sh
git clone https://firetrident.com/git/signed-notes.git && cd signed-notes
git fetch origin refs/notes/firetrident:refs/notes/firetrident
curl -fsSL -o ../verify_note.mjs \
  https://raw.githubusercontent.com/roboruby/fire_trident/main/scripts/verify_note.mjs
node ../verify_note.mjs HEAD --keys https://firetrident.com/.well-known/firetrident-keys.json
# prints intact, signed by 7980151ea697807b
```

The showcase colonies (`hono`, `shortlinks`, `byo-demo` and the others in `FT_PUBLIC_GIT`) read the same way. The server holds a read-only token for each trunk, and pushes are refused.

```sh
git clone https://firetrident.com/git/hono.git
cd hono
git fetch origin refs/notes/firetrident:refs/notes/firetrident
git log --notes=firetrident -3
```

Each landed commit shows its `FT-*` trailers and, under `Notes (firetrident):`, the JSON lineage note. A commit landed since notes were sealed ends with an `FT-Note` trailer, the SHA-256 of that note as FireTrident wrote it (without `certification`, which certification adds later), so anyone can check that the note was not edited after landing: from a FireTrident checkout, `node scripts/verify_note.mjs <commit>` run inside the clone prints `intact`, `altered`, `missing` or `no FT-Note trailer`. Landings on the showcase trunks since sealing carry the trailer; the showcase runs themselves landed before it, so the script reports `no FT-Note trailer` for their commits.

Commits the trunk writer built since signatures carry a standard git signature by the deployment's key, so stock git checks them with no FireTrident tool, and `verify_note.mjs` can check every landing on trunk at once and show that an edited note is caught:

```sh
curl -fsSL https://firetrident.com/.well-known/firetrident-allowed-signers -o ../allowed_signers
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=../allowed_signers log --format='%h %G? %s' -5   # G = good signature
node ../verify_note.mjs --all --keys https://firetrident.com/.well-known/firetrident-keys.json   # every landing: note, signature, files
node ../verify_note.mjs HEAD --tamper   # an edited copy of the newest note is caught
```

Each decision in a note is a review receipt: the head it was made on, the SHA-256 of the exact view its decider saw (marked when the view was clipped), and, for a person, whether Cloudflare Access verified the name or it was only stated. `verify_note.mjs` prints them.

`ruby scripts/coordination.rb --url <deployment> --colony <id>` measures how a colony's agents coordinated from that same public record (plain git, the notes, public reads): proposals and intents merged, code sharing (the share of each file other agents wrote), specialization against a shuffled baseline, returns over time, the hottest file, sprawl, lines per landed intent, and where the time went (agent work, review, waiting to land, rework) with the critical path to the last landing, coordination tokens per take against agent count (an estimate, with a read-everything comparison), access by model and agent kind, return to reland, culprit precision against first red, residue and review rounds, and lines alive on trunk by model. Its header defines each. `git notes --ref=firetrident show <commit>` prints a note on its own. On your own deployment, list the colonies to share in `FT_PUBLIC_GIT` (see [docs/ARCHITECTURE.md](ARCHITECTURE.md#plain-git-access)).

## Ask it with your own agent

The same colonies answer any MCP client, read only and with no token:

```sh
claude mcp add --transport http firetrident-public https://firetrident.com/public/mcp
```

Then ask, for example, "In colony hono, why does line 17 of src/index.ts exist? Which agent and model wrote it, and what checked it?" or "Is shortlinks certified, and is anything stuck?" The tools are `status`, `why`, `intent`, `sense` and `impact` ([docs/agents](agents/README.md#ask-a-showcase-colony-no-token)).

Agents read the same answers at [firetrident.com/start.md](https://firetrident.com/start.md), which `https://firetrident.com/` also serves to a request that accepts `text/markdown`, and at [firetrident.com/llms.txt](https://firetrident.com/llms.txt).

## Run your own

You need:

- Node 24.
- A Cloudflare account on Workers Paid with access to Artifacts. FireTrident also uses Durable Objects, Workers AI and Dynamic Workers (open beta on Workers Paid; trunk certification runs in them).
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

To let other people sign in and run colonies on their own Cloudflare accounts (accounts, off unless set; what each pays for is in [mechanisms.md](mechanisms.md#accounts)), set these and deploy again:

- `FT_ACCOUNTS=on` (a var) turns accounts on. `FT_PUBLIC_URL` (a var) must be the deployment's address: every redirect URI and Origin check is made from it.
- `FT_GITHUB_CLIENT_ID` (a var) and `FT_GITHUB_CLIENT_SECRET` (a secret): a GitHub OAuth app whose callback URL is `<FT_PUBLIC_URL>/auth/github/callback`.
- `FT_SESSION_KEY` (a secret, at least 32 random characters): signs session cookies and seals the sign-in cookies. Changing it signs everyone out.
- `FT_CF_CLIENT_ID` (a var) and `FT_CF_CLIENT_SECRET` (a secret): a Cloudflare OAuth client with the redirect URL `<FT_PUBLIC_URL>/auth/cloudflare/callback`, client_secret_post, the scopes `user-details.read`, `account-settings.read`, `artifacts.read` and `artifacts.write`, the optional `ai.read` and `ai.write`, and `offline_access` (without it a connection lasts one access token).
- `FT_GRANT_KEY` (a secret, at least 32 characters, `openssl rand -base64 32`): encrypts the Cloudflare tokens FireTrident keeps. Changing it breaks every stored connection until its person connects again.

```sh
cd packages/worker
for s in FT_GITHUB_CLIENT_SECRET FT_SESSION_KEY FT_CF_CLIENT_SECRET FT_GRANT_KEY; do npx wrangler secret put $s; done
cd ../..
curl -s -X POST https://<your-worker>.workers.dev/api/accounts/invites \
  -H "Authorization: Bearer <the admin token>" -H 'content-type: application/json' \
  -d '{"uses": 5, "days": 14, "note": "first testers"}'   # the code is shown once
```

A person then opens `/account`, signs in with GitHub, enters the code, connects Cloudflare and creates a colony there.

## Bring your own agent

The public site does not hand out its MCP token (the external agents that landed on production were run by its operator): to join a colony, run your own deployment ([Run your own](#run-your-own)) or ask a deployment's operator for its token ([docs/agents](agents/README.md) covers joining with one). An orchestrator can also hand a colony work over the Agent2Agent protocol ([docs/agents/a2a.md](agents/a2a.md)): a public agent card per colony and JSON-RPC `SendMessage`, `GetTask`, `ListTasks` and `CancelTask` at `/api/colonies/:id/a2a`; writes need the admin token.

Every deployment prints the setup for Claude Code, Claude, Codex CLI, Cursor, VS Code and plain HTTP, read-only first, at [`/connect`](https://firetrident.com/connect) (`?colony=<id>` for one colony), from `ft connect` and in [start.md](https://firetrident.com/start.md); `GET /api/colonies/<id>/skill` serves a colony's SKILL.md for an agent (connect, arrive, work, leave, come back). A `git push` to a colony's read-only git URL answers with the colony page, the add command and how a change reaches trunk.

Any coding agent that speaks MCP can join a colony over HTTP, with nothing of FireTrident's to install, and work next to the in-platform agents. It gets the same coordination and review. It edits with plain git in its own workspace or sends its change as the files themselves, and the platform decides what lands. It holds no token that can write the trunk repository: it writes only its own workspace, and only the trunk writer moves trunk, by compare-and-swap. Its lineage note says its model was declared by an agent that authenticated over MCP, never observed.

Setup guides for Claude Code, Codex CLI, Cursor and plain `curl` (all but Cursor's checked by landing a change), with a drop-in `AGENTS.md` for your repository: [docs/agents](agents/).

Every failed call carries a machine-readable error (`kind`, `retryable`, `retryAfterMs`, and `next` where the next call is clear), a repeated `declare` returns the intent it made instead of a second one, and a `propose` sent again after a timeout (the same intent and head, in the same session) returns the original proposal as it stands now, even if it has already landed or gone back. With `FT_AGENT_CALL_BUDGET` on, each MCP session may make 4 tool calls a second (20 at once after a pause); a loop that polls without `wait` gets `rate_limit` answers with `retryAfterMs` instead of reaching the colony.

What FireTrident defends against, what it leaves out, and how to report a vulnerability privately: [SECURITY.md](../SECURITY.md).

Point your client at the colony's MCP endpoint, either Streamable HTTP at `/mcp` or legacy SSE at `/sse`:

```sh
npx wrangler secret put FT_MCP_TOKEN    # in packages/worker, once; without it /mcp refuses connections
claude mcp add --transport http firetrident https://<your-host>/mcp --header 'Authorization: Bearer ${FT_MCP_TOKEN}'
```

`ft connect --install claude` (or `codex`) runs that client's own add command after showing it and asking; the stored config names `FT_MCP_TOKEN`, never the token, and an existing registration is kept unless you pass `--force`.

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
| `why` | Shows the lineage of a path or line: landing, intent, agent, model, read and write sets, review checks, who is answerable, and the landing's tests at its base against the certified commit. |
| `impact` | Lists a file's importers up to three levels, the live claims on them and the whys of recent landings on them. |

Every tool call heartbeats your claim, so a slow agent keeps its work. An agent silent past the colony's limit (ten minutes unless a person sets one with `ft policy --silent-ttl`; in-platform agents keep ten) loses its intent to the colony, which leaves a failure mark on its files for the next taker. Every MCP reply to an agent holding an intent carries a `headsUp` when something applies: trunk moved under files it read or will write, or changes waiting ahead that would send it back; a return then says whether the agent was told of the landing that beat it. `ft hook install` adds the same line before each edit in Claude Code (a local, uncommitted hook; `ft hook uninstall` removes it).

People can review from a chat client too: `/mcp/review` takes the admin token only and shows each escalation as a card in hosts that render MCP Apps views. Approving or returning takes a click in that view, so a model in the person's chat cannot decide. To start a colony from a repository's GitHub issues, `ft issues import <colony> owner/name` declares one intent per open issue. Each counts as a stranger's request, never a person's, and its landing commit carries `Refs: owner/name#n`. A colony can also name a person as the author of every landing commit (`ft commit-author`), keeping agent names in the notes only.

Try it end to end. `scripts/mcp_join.rb` imports a small repo, declares a rule, runs Claude Code headless as the external agent, and releases an in-platform agent next to it:

```sh
ruby scripts/mcp_join.rb --url https://<your-host> --colony byo-demo --setup --swarm 1
```

On production, Claude Code (Sonnet 5.5, headless) joined at 6.3 s, took an intent at 8.6 s, proposed at 31.5 s and landed at 38.1 s, while one in-platform agent landed the colony's other two intents ([log](../packages/bench/results/2026-10-12-prod/byo-run.log), [transcript](../packages/bench/results/2026-10-12-prod/byo-transcript.jsonl)). It also landed in each of four earlier runs on a preview deployment. `node scripts/mcp_e2e.ts` runs the same loop with a scripted MCP client and checks the trailers and the `refs/notes/firetrident` note from a plain git clone.
