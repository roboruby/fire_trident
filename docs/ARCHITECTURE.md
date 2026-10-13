# FireTrident architecture

FireTrident is a git platform for very large numbers of concurrent coding agents, built on Cloudflare Workers and Artifacts. It coordinates agents the way colonies do: through signals left in a shared environment, local decisions, and parallel integration, instead of locks and one merge queue.

## The model in one screen

- **Colony**: one codebase. A trunk repository in Artifacts plus the coordination state around it.
- **Field**: decaying marks on regions of the code (claim, need, trail, failure, danger). Agents read the field instead of messaging each other. Reading it costs the same no matter how many agents there are.
- **Intent**: what should change and why, declared before any code is written, with a predicted footprint (the paths it expects to touch).
- **Rule (morphology)**: a declared architecture rule. Every violation becomes a need in the field and an intent.
- **Workspace**: an Artifacts fork leased to one agent with a short-lived, workspace-scoped token. Agents never hold a trunk write token.
- **Proposal**: an intent's change: base and head commits in the workspace, the files written (write set), the files read (read set), declared footprint, and evidence.
- **Lane**: a region's integration queue. Each cycle it picks the largest set of non-conflicting, still-valid proposals and hands them to the trunk writer, which lands them as one commit.
- **Lineage**: every landed commit carries `FT-*` trailers and a JSON note under `refs/notes/firetrident` with the intent chain, read and write sets, decisions, and evidence.

## Request flow (an in-platform agent)

1. `ColonyDO.registerAgent` gives the agent an id.
2. `ColonyDO.take(agentId)` builds candidates from open intents, reads the field from the relevant `RegionDO`s, and picks one with the response-threshold rule (`core/threshold.ts`). Three signals shape the choice:
   - **Lateral inhibition**: a candidate whose exact footprint files carry live claims from other agents above a threshold (half a fresh claim by default) is skipped. Claims decay, so a silent agent's claim stops inhibiting after about two half-lives: there is no lock to release and nothing to deadlock.
   - **Co-change repulsion** (soft): TrunkDO mines trunk history into a Hebbian co-change map (`core/cochange.ts`, `trunk/cochange.ts`); candidates whose files usually change together with files other agents have claimed score lower.
   - **Admission**: `RegionDO.admit` checks the region's admission cap and deposits the agent's `claim` marks in one synchronous step, so concurrent takes cannot over-admit a region. Only then does `PoolDO.lease` hand out a workspace.

   The assignment also says what review will ask of the change (`review`, `agents/preview.ts`): the questions of up to five live antibodies whose path matchers cover the footprint, and the rules that cover it. An agent sees a pattern people rejected before it writes it.
3. The agent (`AgentDO`) clones trunk at `lease.baseSha` into a `@cloudflare/computer` Workspace using the read-only trunk token, reads files (each read is recorded with its blob id), edits with an LLM, commits, and force-pushes its commit to `main` of its own workspace repo with the workspace write token. The fork's prior content never matters. (At very large scale agents read from trunk mirrors instead of trunk, to respect per-repo git request limits.)
4. `ColonyDO.propose` records the proposal, computes the residual (paths changed outside the declared footprint), runs innate checks, and enqueues it in the lane of the proposal's primary region (`RegionDO.enqueue`).
5. On each lane tick (`RegionDO` alarm, interval from `core/batch.ts#laneIntervalMs`), the region asks `TrunkDO.blobsFor` for current trunk blobs, validates proposals with `core/occ.ts`, selects a batch with `core/batch.ts#selectBatch`, and calls `TrunkDO.land(batch)`. Stale proposals are returned to their agents with each stale path, the blob it read and the blob now on trunk.
6. `TrunkDO.land` reads each proposal's new blobs from its workspace repo (`readBlob` on the binding), writes them into its own git workspace, builds the new tree by replacing only the changed paths, commits with `FT-*` trailers, adds the lineage note, and pushes trunk and `refs/notes/firetrident` with the expected old value (compare-and-swap). It then reports the `Landing` to `ColonyDO.onLanding`, which updates intents, deposits `trail` marks, reinforces the agent's threshold for the region, and broadcasts events.

## Durable Objects and their RPC contracts

All are SQLite-backed (`new_sqlite_classes`). Callers use RPC on stubs (`env.COLONY.get(env.COLONY.idFromName(colonyId)).take(agentId)`). Types come from `@fire_trident/core`.

### ColonyDO (name: colonyId)
Owns colony config, intents, rules, agents, proposals index, review queue, antibodies, decision counters (the funnel), metrics, and the live WebSocket hub (hibernation API) for the UI.
- `init(p: { colonyId; name; trunk: RepoRef; trunkSha: Sha; source?; regionDepth? }): Promise<Colony>`
- `snapshot(): Promise<ColonySnapshot>`
- `addIntent(i: Omit<Intent, "id" | "status" | "createdAt">): Promise<Intent>` (also deposits `need` marks)
- `addRule(r: Omit<Rule, "id" | "createdAt">): Promise<{ rule: Rule; violations: number; intents: number }>`
- `registerAgent(a: { kind: AgentKind; name: string; model?: string }): Promise<AgentInfo>`
- `take(agentId: Id): Promise<{ intent: Intent; lease: WorkspaceLease; rule?: Rule; review?: ReviewPreview } | { wait: true; retryInMs: number; reason: string }>`
- `getProposal(id: Id): Promise<Proposal | null>` (agents poll their outcome)
- `getRule(id: Id): Promise<Rule | null>`
- `heartbeat(agentId: Id): Promise<void>` (refreshes claim marks)
- `propose(p: Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & { evidence?: Partial<Evidence> }): Promise<Proposal>`
- `updateProposal(id: Id, patch: Partial<Proposal>): Promise<void>` (called by RegionDO/TrunkDO)
- `onLanding(l: Landing): Promise<void>`
- `review(): Promise<Array<Proposal & { review?: ReviewView }>>` (each escalated proposal with its masked review view), `decide(proposalId: Id, d: "approve" | "reject" | "return", reason: string, by: string): Promise<void>`
- `emit(e: ColonyEvent): Promise<void>` (broadcast to UI sockets; also used by other DOs)
- `fetch(req)`: WebSocket upgrade for `/api/colonies/:id/live`

### RegionDO (name: `${colonyId}:${region}`)
Owns the field for one region and that region's lane.
- `configure(p: { colonyId: Id; region: string }): Promise<void>`
- `deposit(marks: Array<Omit<Mark, "id">>): Promise<void>`
- `clear(filter: { agentId?: Id; intentId?: Id; kind?: MarkKind; paths?: Path[] }): Promise<number>`
- `reading(): Promise<FieldReading>`
- `enqueue(p: Proposal): Promise<void>`
- `recordCause(e: { id: string; causeId?: string; at: number }): Promise<void>` (criticality governor)
- `alarm()`: lane tick

### TrunkDO (name: colonyId)
The only writer of trunk. Holds a `@cloudflare/computer` Workspace with trunk cloned, an index of trunk paths to blob ids, and the lineage tables.
- `init(p: { colonyId: Id; trunk: RepoRef }): Promise<{ trunkSha: Sha; files: number }>`
- `files(): Promise<Array<{ path: Path; size: number; blob: Sha }>>`
- `blobsFor(paths: Path[]): Promise<Record<Path, Sha | null>>`
- `readFile(path: Path): Promise<string | null>`
- `baseBlobs(baseSha: Sha, paths: Path[]): Promise<FileVersion[]>`
- `land(batch: Proposal[]): Promise<{ landing?: Landing; returned: Array<{ proposalId: Id; reason: string }> }>`
- `why(path: Path, line?: number): Promise<Array<{ landing: Landing; note: LineageNote }>>`
- `landings(limit?: number): Promise<Landing[]>`
- `revert(ref: string, p: { by: string; reason: string }): Promise<RevertResult>` (see "Changing direction")
- `markCertified(sha: Sha): Promise<boolean>` (see "Trunk certification")

### PoolDO (name: colonyId)
Keeps a warm pool of workspace forks of trunk across the `ft-ws-*` namespaces. Each namespace holds a seed repo that mirrors trunk `main`, and workspaces fork from their namespace's seed (forks cannot cross namespaces, and forking a repo just pushed fails about one time in five: spike/RESULTS.md facts 2 and 3). Workspaces are refreshed to the current trunk on lease and recycled after landing.
- `init(p: { colonyId: Id; trunk: RepoRef; target: number }): Promise<void>`
- `lease(agentId: Id, trunkSha: Sha): Promise<WorkspaceLease | null>`
- `release(agentId: Id): Promise<void>`
- `status(): Promise<{ ready: number; leased: number; forking: number; target: number }>`

### AgentDO (name: agentId)
An in-platform agent built on `@cloudflare/computer` (workspace + AI SDK tools) and Workers AI (or Claude when `ANTHROPIC_API_KEY` is set). It loops: take, work, propose, wait, repeat. Its `read` tool records the read set. It journals each step so a killed agent resumes.
- `start(p: { colonyId: Id; agentId: Id; model: string }): Promise<void>`
- `stop(): Promise<void>`, `status(): Promise<AgentInfo>`

### FireTridentMcp
An `agents/mcp` McpAgent exposing tools for external agents (any MCP client): `join`, `sense`, `take`, `declare`, `checkout`, `read`, `propose`, `inbox`, `release`, `why`. Every tool call heartbeats the agent's claims, so a slow external agent keeps its work; an agent silent for ten minutes loses its intent to the colony. `take` and `inbox` accept `wait` (the server waits for work or for the proposal's outcome). `take` returns git steps that need no shell state (no `cd` or `export`), and with `checkout` the questions review will ask of the change and the rules that cover it; `propose` records the agent's `notVerified` statement for review. Session state tolerates parallel tool calls.

## Artifacts layout

- `ft-trunk` namespace (binding `ARTIFACTS`): `<colony>--trunk` and, later, lane repos `<colony>--lane-<region>`.
- `ft-ws-0..3` namespaces (bindings `WS0..WS3`): workspaces `<colony>--ws-<n>`, sharded by `n % 4` to spread the per-namespace control-plane limit.
- `ft-sessions` namespace (binding `SESSIONS`): one repo per in-platform agent session.

Measured in the spike (spike/RESULTS.md): import and fork are synchronous (about 1.3 s per fork, parallel even from one source); about 20% of forks issued within ~0.1 s of a push to the source fail with INTERNAL_ERROR and must be retried; git inside a Durable Object via `@cloudflare/computer` clones in ~350 ms, commits in ~90 ms, and pushes in ~300 ms; a commit built by tree surgery takes ~40 ms; forks copy every ref including notes (`defaultBranchOnly` is ignored); binding read calls need `main` or a full commit id (`HEAD` and `refs/...` return null); the server rejects pushes whose expected old value is stale (compare-and-swap) but accepts forced non-fast-forward pushes; the namespace push trigger starts a Workflow for every repo in the namespace (~0.5 s to instance, ~2.3 s to `run()`).

Facts the design relies on (from the docs and the spike): each repo is one Durable Object; git requests are limited per repo and control-plane calls per namespace; the binding reads but cannot write files, so writes go through git; there is no server-side merge, hook, or branch protection; Artifacts accepts non-fast-forward pushes, so only TrunkDO ever holds a trunk write token and it pushes with an expected old value.

## Live events

`ColonyEvent` (see `packages/core/src/types.ts`) is the single event shape for the UI and for internal fan-out. The UI first loads `ColonySnapshot`, then applies events from the WebSocket.

## Additional RPCs (as built)

- ColonyDO: `getColony`, `listRegions`, `getIntent`, `getAgent`, `registerAgents` (batch), `abandon(agentId, reason)`, `inbox(agentId, limit, opts?)` (proposals and directives), `updateProposals` (batch), `recordDecision`, `landContext(intentIds, agentIds, proposalIds?)` (compact lineage context for lanes: intents with their direction, agents, recorded decisions). Changing direction: `amendIntent`, `withdrawIntent`, `retractRule`, `direct`, `recall`, `relay`, `intentHistory` (see "Changing direction").
- AgentDO: `direct({ directive, intent? })` (a directive pushed by the colony; see "Changing direction").
- RegionDO: `reading(opts)` (optionally filtered by paths), `apply`, `dequeue`, `status`.
- TrunkDO: `init` accepts an optional `regionDepth`; `land(batch, ctx?)` takes compact lineage context (lanes pass it, so the writer never pulls a snapshot); `stats`, `flushNotes` (re-pushes any note whose push failed after its landing), `mirrorTo`, `refreshTokenIfNeeded`. TrunkDO does not call `onLanding`; the lane does.
- PoolDO: `stats`, `teardown`. Forks cannot cross namespaces, so each `ft-ws-N` namespace holds a seed repo `<colony>--seed` that workspaces fork from.
- AgentDO: `start({ colonyId, agentId, model?, kind?, name?, delayMs? })`; `status()` returns AgentInfo plus journal fields.
- RegionDO: `configure({ colonyId, region, regionDepth })`; `admit` (atomic admission plus claim deposit, see request flow step 2); `landedFor(paths)` answers which landing last changed a path, so a stale return with no local cause records the landing in another region as its parent (the cascade detector sees cross-region causes).
- TrunkDO: `neighbors(paths)` and `cochangeStats()` read the co-change map; `landingsOf`, `systemCommit` (antibodies and reverts; a file may name the blob it expects to replace, and a mismatch refuses the whole commit).
- **Assumptions.** The decide stage records on each proposal the trunk files its new or rewritten relative imports resolve to (`assumptions`, its own writes excluded). `planCycle` returns a proposal whose assumption is gone from the virtual trunk (deleted on trunk, or by a batch ahead in the cycle) and one that would delete a assumption of a proposal accepted earlier in the cycle, so a deletion and a new import of the same file never both land in one cycle (a deletion that lands in a later cycle is caught by certification only). Only existence counts.
- `destroy()` on RegionDO, TrunkDO, PoolDO and AgentDO wipes the object's storage and alarms; `DELETE /api/colonies/:id` calls them.
- `deprovisionTrunk()` in `artifacts/colony.ts` removes a colony's repos.
- MCP: `/mcp` (Streamable HTTP) and `/sse`, gated by `FT_MCP_TOKEN` when set (Bearer header or `?token=`).

## Decide: the reflex arc and the immune review (packages/worker/src/decide/)

A proposal enters `checking` and the decide engine routes it:

1. **Innate checks**: the rule re-check on the changed files (every live rule, the intent's own first, up to 200), residual paths (changed but not in the declared footprint), a mandatory "Not verified:" statement, and hollow files: a new script file that is empty or holds only comments or placeholder bodies goes back.
2. **Deterministic proof**: every changed relative import is resolved against the trunk file tree. When only import specifiers changed and each still points at the same file, the rule re-check passes, the change stays inside its footprint and touches no sensitive path, the proof is a confirmation on its own and no model is consulted. A broken import is returned with the exact path. The resolution facts are passed to every model that is consulted, and no model opinion can override them.
3. **System 1 (reflex)**: one Clef call (`@cf/cloudflare/clef`, typed noul/choice/score questions: needs_human, risk, touches_sensitive, off_intent, plus every matching antibody question). Confident answers act; uncertain ones escalate.
4. **System 2 (LLM)**: consulted only when the deterministic proof is inconclusive and the reflex cannot act alone. A second opinion from a different model family than the authoring agent (`@cf/google/gemma-4-26b-a4b-it`, or `@cf/openai/gpt-oss-120b` when the author is Gemma), strict JSON verdict, behind a per-model concurrency and rate limiter with backoff and fallback (Workers AI caps large models at 20 requests a minute per account). Reviewers see up to 24,000 diff characters a file and 60,000 in all. An approval counts as a confirmation only when the layer saw every changed line; a change too large for its view goes to a person ("too large for model review"), and each layer's view (files shown of files changed, what was cut) is recorded with its decision. The state models see says who wrote the intent's why: a person, a rule, certification or an agent, whose why is a claim to check.
5. **System 3 (human)**: the review queue.

`propose` is idempotent: a repeat for the same agent, intent and head commit returns the existing proposal. Deterministic outcomes are recorded as their own checks in the evidence and in `decide.deterministic.*` metrics; they never count as reflex decisions in the funnel.

**Two-signal gate**: a proposal lands without a human only with two independent confirmations bound to the same head commit (innate checks plus a System-2 approval or earned path autonomy) and a low p(needs_human). Earned autonomy applies only to intents written by a person or a rule, and only when the reflex saw the whole change. One signal returns it to its agent. Escalation to a human needs a detector hit plus damage or a capability change. **Regulation**: an alert budget caps human pages per hour; a detector marked not useful ≥10% goes advisory and >25% goes off. **Danger patterns** (`danger.ts`): hits for new process, network, eval or crypto use are waived only when an intent written by a person or a rule asks for them; an agent's or a repair's text never waives them. In a repair intent from certification, any test-file change beyond imports is a must-human hit no policy or antibody can waive, and node:test's skip and todo forms, and assertions that disappear (commented-out ones do not count), are test-weakening. **Security returns**: a return for a security finding tells its agent only the class; the full reasons stay in the decision record and the review view, the proposal route withholds them from readers without the operator token, and the intent's next proposal goes to a person. **Antibodies**: a human rejection mints an antibody (path matcher + yes/no question + threshold) only when no existing antibody fired on the proposal (otherwise it counts a recurrence on the one that did), committed to trunk as `.firetrident/antibodies/<id>.json` by `TrunkDO.systemCommit` with a lineage note; every later matching proposal is screened, and the return reason names the antibody's question. Antibody files are authoritative: a landing that edits, renames or deletes one reloads or retires it. **Vaccination meter**: `POST /api/colonies/:id/vaccinate {count}` injects sealed bad proposals of several threat classes through the normal path; they can never land, and recall per class is reported with a Wilson 95% interval (`GET /api/colonies/:id/vaccinate`). The report separates vaccines returned (stopped by a model or a check) from vaccines escalated (sent to a person, whose decision the meter does not measure), and a vaccine whose second opinion was unavailable is an error, not a catch. **Review view**: for every escalated proposal the engine keeps a masked view in `decide_review` (each file's hunks up to 24,000 characters, 60,000 in all, the danger hits with line numbers, the residual paths; lines that may hold a secret are masked), the review queue serves it, and the web card and `ft review` lead with the lines to look at first.

Routes: `POST|GET /api/colonies/:id/vaccinate`, `GET /api/colonies/:id/immune`, `POST /api/colonies/:id/decide/policy`, `POST /api/colonies/:id/detectors/:did` (useful / not useful feedback). ColonyDO: `vaccinate`, `vaccineReport`, `immune`, `setDecidePolicy`, `detectorFeedback`. Every decision is recorded (`recordDecision`) and emitted, so the UI funnel shows reflex / LLM / human counts.

## Changing direction (chemotaxis)

A colony is steered the way cells follow a chemical gradient: when the gradient changes, cells re-orient. Here a human changes the gradient (amends an intent, withdraws it, retracts a rule, or sends an agent guidance), the field updates (needs evaporate, move or appear), and agents re-orient at their next step. Nothing is preempted by a lock or a queue. Agents also tell the colony what they are doing, so a human can see where to push. Pure helpers live in `colony/direction.ts` (colony side) and `agents/direction.ts` (agent side).

**Amend** (`PATCH /api/colonies/:id/intents/:iid {title?, why?, footprint?, priority?, reason, by?}`, `ColonyDO.amendIntent`, `ft intent amend`). The intent's `revision` goes up by one and the change is kept in `intent_revisions` (fields changed, before and after, reason, by, at). Need marks move with the footprint (strength = priority) and claims leave the paths it dropped; the holder's claim follows the paths it gained. A title, why or footprint change is **substantive**: changes in flight built on the older revision go back (`intent revised: r1 → r2, why changed (...)`), and the holder keeps the intent, claim and lease and redoes the work against the new revision. A priority-only amendment just moves the intent in the queue. Landed, withdrawn and sealed intents cannot be amended (409); `GET /api/colonies/:id/intents/:iid` (`ft intent show`) returns the intent with its revisions and directives.

**Withdraw** (`POST .../intents/:iid/withdraw {reason, by?}`, `ft intent withdraw`). The intent becomes `withdrawn` (kept, with the reason), its need marks evaporate and its claims clear, changes in flight go back (`withdrawn: ...`), and its holder goes idle and gives its lease back. Idempotent. **Retract a rule** (`DELETE /api/colonies/:id/rules/:rid {reason, by?}` or `?reason=`, `ft rule retract`): the rule stays in history (`retractedAt`, `retractedBy`, `retractReason`) but is no longer checked (the decide arc and agents skip it), its open violations stop counting, and every intent it created that has not landed is withdrawn. Landed work is never touched.

**Directives** (`POST /api/colonies/:id/agents/:aid/directive {message, intentId?, by?}`, `ColonyDO.direct`, `ft direct`). Free-text guidance for one agent, about the intent it holds unless `intentId` names another. Revisions and withdrawals reach the holder the same way, as directives of kind `revision` and `withdrawal`. An in-platform agent gets them pushed (`AgentDO.direct`); external agents read them in their inbox (`ColonyDO.inbox`, which the MCP `inbox` tool calls): a directive entry lines up with a proposal entry (`id`, `intentId`, `status: "directive"`, `reason` = what to do, `createdAt`). Reading a revision notice records that the agent saw that revision.

**How an in-platform agent re-orients** (`loop.ts`, `applyDirection`). Directives are kept in the agent's journal and acted on before its next step. A withdrawal ends the job (the colony already released the claim). A revision ends it too, and the next take hands back the same intent at the new revision. Guidance joins every later prompt for that intent (a "Directives from a human operator" block); work already produced is redone with it, after the agent recalls a proposal still in flight (`ColonyDO.recall`: returned as `superseded: ...`, intent, claim and lease kept). A directive that makes the step in flight moot (any withdrawal or revision of the job's intent, guidance while it produces or proposes) moves the agent's epoch, so the step halts at its next check and no more model calls go the old way.

**Stale direction never lands.** Three layers: (1) an amendment or withdrawal returns the changes in flight at once, and dequeues them from their lanes; (2) `ColonyDO.propose` refuses (409) a change built on an older substantive revision: the agent passes `intentRevision` (an external agent that passes none is held to the revision it last saw, until it reads the notice in its inbox); (3) the lane's pre-land check: one `landContext` call per tick returns each intent's status, revision and substantive amendments, and the lane sends back (`splitByDirection`) any change for a withdrawn intent or built on an older revision before it calls `TrunkDO.land`. A withdrawal that arrives after `TrunkDO.land` started loses the race: the change lands, and the intent shows landed. An amendment that loses that race keeps the intent: the change built on the older revision stays landed, and the intent goes back to open at the new revision for the next taker ("landed a change built on r1; r2 still to do"). Direction returns leave no failure mark, count as `redirected` (not `returned`), and never reopen the intent.

**Relay** (`POST /api/colonies/:id/agents/:aid/status {note}`, `ColonyDO.relay`). An agent's one-line "what I am doing now" is stored on the agent (`GET agents` and `ft agents` show it in the NOW column), emitted live (at most one event per agent per second), and recorded with its next proposal. In-platform agents relay as they enter each step and when they act on a directive (at most every 3 s; synthetic agents at most once a minute).

**Lineage.** At propose time the colony records the direction a change was built under in its evidence (`evidence.direction`: `intentRevision`, the amendments up to it, the human guidance the agent had for the intent, its last status note), so it lands in the lineage note under `refs/notes/firetrident`. `landContext(intentIds, agentIds, proposalIds)` also hands the lane each proposal's recorded decide-arc decisions (layer, kind, p, action, at, the question, who answered, a one-line answer; the latest 8 per proposal), which TrunkDO writes into the note's `decisions`. A deterministic proof that decided alone appears in the note's evidence checks (`deterministic: ...`, `gate`). `ft why` and the Why tab show the revision history, directives, note and the decide arc.

**Revert** (`POST /api/colonies/:id/landings/:ref/revert {reason, by?, redo?}`, `ColonyDO.revertLanding`, `ft revert`; `ref` is a landing id or a trunk commit of 7+ characters). A person undoes a landing as a new trunk commit that puts every path it wrote back to its blob from before (`trunk/revert.ts` plans it; `TrunkDO.revert` writes it through the serialized system-commit path). It is refused (409) when any of those paths has changed since, naming each path and the latest landing that moved it, or when it would delete a file that trunk files import, naming the importers; both checks run again inside the commit. The intents the landing completed come back as new intents (parent: the reverted intent, why: the reason first; `redo: false` declares none), and a rule's violations count again until they land. The revert commit carries `FT-Revert-Of` and a lineage note with `revert {of, commit, by, reason}`; certification runs on the result; a revert can itself be reverted, which withdraws the intents it declared again (ColonyDO keeps each revert in `reverts`).

**Events**: `amended`, `withdrawn`, `retracted`, `reverted`, `directive` and `status` (plus `intent` with status `withdrawn`). The Events tab groups the first five under Direction; the Intents tab shows an `rN` badge on amended intents and a withdrawn segment.

## Scale

Every agent talks to one ColonyDO, so the take path is built to stay cheap per call:

- **Shared field reads.** A take scores up to 200 open intents against the claims of the regions they touch. Each region's claim field is read once and shared by the takes running at the same time (`colony/views.ts`), so scoring a candidate costs map lookups instead of glob tests against every claimed path. Results equal core `repulsion`.
- **Take gate.** At most 128 takes score at once; more queue behind them (`TAKES_IN_FLIGHT`). Without the gate the object ran out of memory and reset at 5,000 agents. Waiting agents are paced (`WaitPacer`): each wait gets a retry time that keeps the whole waiting crowd near a fixed rate of takes a second, so idle agents do not retry in step.
- **Pushed outcomes.** When a proposal settles, the colony pushes the outcome to the agent (`AgentDO.outcome`), so in-platform agents stop polling `getProposal`.
- **Live claims only.** Stopping or reaping an agent clears its claims in every region, and admission counts only live claims, so a stopped run no longer holds a region's admission for its claims' decay time.
- **Lease book.** Leasing a workspace is pure SQL (`pool/slots.ts`). Each slot keeps one write token (two hours). A released slot keeps its lessee's token, so the same agent leasing it again needs no control-plane call. An idle slot gets its token revoked and a fresh one minted in the background. A token is never handed to a different agent.
- **Notes fanout.** Lineage notes use git's 2-character fanout layout. Notes written flat before it migrate a slice per flush. After the scale runs, stock git found a note on 5,894 of 5,894 landing commits.
- `FT_LAG_PROBE` (load tests only) makes ColonyDO log event-loop lag and stream it as `colony.lagMs`.

Measured on a preview (`packages/bench/results/2026-10-12-scale/`) with synthetic API agents (no model calls, review off, no work time, 64 regions), 120 s runs:

| Agents | Landings/min | Time to land p50 / p90 | Platform errors |
|---|---|---|---|
| 1,000 | 2,924 | 13.0 / 17.0 s | 0 |
| 2,000 | 2,714 | 14.8 / 19.5 s | 0 |
| 5,000 | 2,778 | 12.5 / 17.4 s | 0 from load; 78 of 50,368 calls failed in the first 33 s: the load generator's own DNS and connection errors, and one reset when the preview's code was updated (`live-n5000.json`) |

These runs predate the event record (see Replay). Their driver held a live feed open, so regions were already emitting field events to the colony; the record adds one batched insert per published batch. Before these changes, 1,000 agents reached 515 landings/min and the run stopped at 60 s with a 38% error rate. The next limit is TrunkDO, the single writer: every 3.4 to 3.9 s commit cycle hits the 200-proposal cap, so throughput no longer grows with agents, and about 6 s of queueing dominates time to land.

## Replay

ColonyDO records every event it publishes (`publish` in ColonyDO, `EventRecorder` in `colony/events.ts`) into a capped `events` table: a sequence number, a time, the event type and the event, the newest 100,000 kept. Field marks are not recorded (the replay derives the field from intents, claims and landings); metrics are sampled every 3 s while events flow, plus one trailing sample. Recording happens where events are published, so it does not depend on who is watching or how live delivery is batched; regions therefore keep emitting while a colony works, even with no viewer.

`GET /api/colonies/:id/events?after=<seq>&limit=<n>` pages the record. A colony that ran before recording existed answers with a timeline rebuilt from what it stores (`colony/replay.ts`: rules, intents with their times, agents, proposals and their decide outcomes, decisions, landings with their files, revisions and directives), labeled `reconstructed`; claim times and the deaths of reaped agents are estimated. The web app's `/c/:id?replay=1` feeds the record through the same reducer as live events, at 1× to 16× with a scrubber; director mode (`?director=1`) works on top of it.

## New projects (`ft new --spec`)

A spec (see `demo/new-project-spec.md`) declares the project's intents, the files each one builds on, the spec sections every agent receives, an optional model per intent, the architecture rules, and acceptance tests. `ft new` creates a colony with an empty trunk, adds the rules, and posts the intents in dependency order (parents and priorities make foundations land first). An in-platform agent waits until the files its intent builds on have landed, reads them, and writes files that must parse, keep every rule, use only TypeScript that Node can strip, and import only files and names that exist; each file gets up to three attempts with the failure as feedback. `demo/run_new_project.rb` runs the flow and verifies the result from a plain git clone.

## Plain-git access

A colony's trunk can be read with stock git and no account: `git clone https://<host>/git/<colony>.git`, then `git fetch origin refs/notes/firetrident:refs/notes/firetrident` for the lineage notes (`api/git-proxy.ts`, mounted at `/git/*`).

- Only `GET /git/<colony>.git/info/refs?service=git-upload-pack` and `POST /git/<colony>.git/git-upload-pack` are forwarded, to `<colony>--trunk` in `ft-trunk`. `git-receive-pack` (push) gets 403 with a plain-text reason that git prints as `remote: ...`; every other path is 404.
- Only colonies listed in `FT_PUBLIC_GIT` (comma-separated) are served; empty or unset turns the proxy off. The name in the path must be a colony slug (lowercase letters, digits and single hyphens, at most 48 characters), so no other repo is reachable.
- Read-only by construction: the Worker mints a read token for the trunk with `mintToken` (30 minutes, replaced 5 minutes before expiry, cached per isolate) and adds it upstream. Clients never see it. When the remote refuses the cached token, the ref advertisement retries once with a fresh one; a 401 is never passed on, because git would ask for a password.
- Protocol v2 passes through (`Git-Protocol`), and v0 still works. Bodies stream both ways with their content types. Gzip request bodies (git compresses requests over 1 KB) are decoded in the Worker, and a request body is capped at 4 MiB both as sent and after decoding (413).
- `/git/*` is in `run_worker_first`: without it, static assets answer GET requests under `/git/` with the UI.

Measured on a preview (2026-10-12) with a Hono trunk imported at depth 200 (583 files, 2.4 MB pack) and one landing: clone 1.9 s median over 5 runs; clone, notes fetch and `git log --notes=firetrident -3` together 2.9 s median.

## Trunk certification

Review decides whether a change may land; trunk certification checks that trunk still works. After landings the colony runs the project's own tests on trunk and records the result per commit (`packages/worker/src/certify/`).

- **When.** `ColonyDO.onLanding` (and FireTrident's own commits) only marks trunk as moved; no landing waits for tests. At most one certification runs at a time and it certifies trunk as it is when it starts, so when landings come faster than runs only the newest trunk is certified; runs start at least `minIntervalMs` (2 s) apart (`schedule.ts`).
- **What runs.** Every `*.test.ts` and `*.test.js` file (under `test/` or anywhere else) that imports `node:test` and reaches no package and no Node built-in the runner lacks (file system, processes, sockets); others are listed with the reason. One `TrunkDO.certifySnapshot` call lists trunk's `.ts`/`.js`/`.mjs`/`.json` files at one commit, and `TrunkDO.readBlobs` reads the test files and, level by level, what they import (at most 400 modules, 4 MB, 512 KB a file). TypeScript is transpiled with sucrase's typescript transform the way Node runs it: types erased, imports that are not `import type` kept, and enums, namespaces and parameter properties failing to load as under type stripping. Imports resolve exactly as written, so a missing file fails its importer, as under `node --test`.
- **How.** All test files run in one Dynamic Worker (`env.LOADER.load`, `nodejs_compat`, `globalOutbound: null`, CPU and wall-clock limits), each with its own copy of the modules it reaches (keys `t0/src/http.ts`, `t1/...`), as `node --test` gives each file a process. `node:test` imports go to a shim (`shim.ts`): test/it/describe/suite with nesting, the (name, options, fn) forms, skip/todo/only, async functions and done callbacks, `t.test` subtests, before/after/beforeEach/afterEach at file, suite and test level, `t.plan` with `t.assert`, `t.mock` (the runtime's) and per-test timeouts (10 s); `node:assert` and `node:assert/strict` are the runtime's own. Counts follow `node --test` (tests = pass + fail + cancelled + skipped + todo). Tests run one at a time, and start from the request rather than while modules load (module evaluation allows no timers), so a file that awaits its own tests at top level never finishes loading.
- **Reuse.** A test file's results are keyed by what it reaches (paths and blob ids of its import closure, the runner, the per-test limit): a run executes only the files whose key changed and reuses the rest, and a commit whose tested files all match an earlier run reuses that verdict (`reusedFrom`).
- **Results.** Stored per commit in ColonyDO (`green`, `red`, `error` or `skipped`), published as a `certify` event (so replays show it), and added to the certified landing's lineage note as `certification` (TrunkDO rewrites the note; its next notes flush pushes it, beside the landing cycles). Green sets `greenSha` and moves the trunk repository's `refs/heads/certified` to the commit (`TrunkDO.markCertified`: forward only, compare-and-swap on the remote; a reused verdict counts), so plain git can check out the last commit whose tests passed; red keeps the last green. A run is not green when it lost tests since the newest green run: a test file that ran then and did not run now (left out, unloadable or deleted), or a test that passed then and is now skipped, todo or gone. The lost files and tests are listed as failures, so the repair loop picks them up. The trunk bar shows a check or a cross on the head ("60/60 tests", "5 failing", names and errors on hover); `ft status`, `ft watch`, `ft why`, `ft certify` and the Why tab show the same.
- **Repair loop.** A red result with no repair intent open declares one (`repair.ts`): "Make the failing tests pass: <names>", source `certify`, priority 10 (spec intents use 1 to 5), footprint the source files the failing tests load (nearest first, at most 6), the failing test files and their other imports as "Builds on" context (the tests are the specification and are not to be edited; a writer that thinks a test is wrong gives the intent back with the reason), the failing tests with their errors and the spec context of the intents that wrote those files in its `why`. At most one is open, and at most `repairsPerHour` (3) are declared in an hour. A repair owes the tests it was declared for (`certify_repairs`): a run satisfies it only when each of them ran and passed, and until then the run is red and the repair stays open. Withdrawing a repair accepts its losses. Agents take it like any other need.
- **Switches.** `FT_TRUNK_TESTS` = `on` for a deployment (binding `LOADER`); per colony, `POST /api/colonies/:id/certify/policy {enabled, repair, repairsPerHour, timeoutMs, testTimeoutMs, minIntervalMs}`. `GET /api/colonies/:id/certifications[/:sha]` reads results; `POST /api/colonies/:id/certify` certifies the current trunk now.
- **Checked.** `test/certify/run.test.ts` runs fixture projects through the pipeline in Node and matches `node --test` count for count; `test/do/certify/` runs real Dynamic Workers. On the two production shortlinks trunks the counts equal a plain clone's `node --test`: 60 of 60, and 67 tests with 62 passing (the same five failures).
- **Measured on a preview (2026-10-12).** Certifying the 60-test shortlinks project took 121 ms from start to result (trunk index 26 ms, reads and transpiling 53 ms, Dynamic Worker 42 ms). Landing latency, two colonies side by side, 6 agents each landing a new test file (so every certification has new tests to run), 75 s runs in alternating order: time to land p50 1.26 and 1.23 s with certification on, 1.37 and 1.42 s off (p90 1.78 and 1.72 s on, 2.34 and 2.30 s off); certifications took 160 ms at p50 with suites up to 3,917 tests in 392 files. Without per-file reuse, rerunning every file added about 0.1 s to mean time to land under that load.
- **On production (2026-10-12).** Certifying `shortlinks-review` (the second run of the new-project spec, made before certification existed) took 267 ms and found the five failures a plain clone shows. The repair loop then ran on its own: the first repair intent landed 11.5 minutes later and left one router test failing, so the colony declared a second; one attempt at it was returned by the second opinion for compile errors and two were given back, and the fourth landed 67 minutes after the first certification. Trunk was certified green at 67 of 67, and a plain clone agrees (acceptance 7 of 7). Evidence: `packages/bench/results/2026-10-12-prod/shortlinks-review-certify-*`.

## Configuration and deployment

- Tuning variables: `FT_COCHANGE_WEIGHT` (co-change repulsion weight, 5 in production) and `FT_LATERAL_INHIBITION` (inhibition threshold as a fraction of a fresh claim, or `off`).
- `FT_TRUNK_TESTS`: `on` certifies trunk after landings with the colony's own tests (see "Trunk certification"); needs the `LOADER` Worker Loader binding (Dynamic Workers).
- `FT_PUBLIC_GIT`: colonies served read-only over plain git (see "Plain-git access"); production lists `hono,shortlinks,byo-demo`. A preview sets its own with `npx wrangler preview --name <x> --var FT_PUBLIC_GIT:<colony>`.
- Secrets: `FT_ADMIN_TOKEN` (mutating API routes), `FT_MCP_TOKEN` (`/mcp` and `/sse`), `ANTHROPIC_API_KEY` (optional Claude agents). Without its token, the API refuses writes and `/mcp` refuses connections (fail closed); `FT_OPEN_WRITES=1` lifts that for local development only and is never set on a deployment. A preview gets its own with `npx wrangler preview secret put FT_ADMIN_TOKEN --name <x>`.
- `wrangler.jsonc` has a `previews` block that mirrors every production binding, so `npx wrangler preview --name <x>` gives an isolated deployment with its own Durable Objects. Previews share the Artifacts namespaces with production, so a preview colony must not reuse a production colony's name.
