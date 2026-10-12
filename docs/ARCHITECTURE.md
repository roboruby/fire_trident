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
2. `ColonyDO.take(agentId)` builds candidates from open intents, reads the field from the relevant `RegionDO`s (repulsion from other agents' claims, admission), and picks one with the response-threshold rule (`core/threshold.ts`). It deposits `claim` marks on the intent's footprint and asks `PoolDO.lease` for a workspace.
3. The agent (`AgentDO`) clones trunk at `lease.baseSha` into a `@cloudflare/computer` Workspace using the read-only trunk token, reads files (each read is recorded with its blob id), edits with an LLM, commits, and force-pushes its commit to `main` of its own workspace repo with the workspace write token. The fork's prior content never matters. (At very large scale agents read from trunk mirrors instead of trunk, to respect per-repo git request limits.)
4. `ColonyDO.propose` records the proposal, computes the residual (paths changed outside the declared footprint), runs innate checks, and enqueues it in the lane of the proposal's primary region (`RegionDO.enqueue`).
5. On each lane tick (`RegionDO` alarm, interval from `core/batch.ts#laneIntervalMs`), the region asks `TrunkDO.blobsFor` for current trunk blobs, validates proposals with `core/occ.ts`, selects a batch with `core/batch.ts#selectBatch`, and calls `TrunkDO.land(batch)`. Stale proposals are returned to their agents with the exact delta.
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
- `take(agentId: Id): Promise<{ intent: Intent; lease: WorkspaceLease; rule?: Rule } | { wait: true; retryInMs: number; reason: string }>`
- `getProposal(id: Id): Promise<Proposal | null>` (agents poll their outcome)
- `getRule(id: Id): Promise<Rule | null>`
- `heartbeat(agentId: Id): Promise<void>` (refreshes claim marks)
- `propose(p: Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & { evidence?: Partial<Evidence> }): Promise<Proposal>`
- `updateProposal(id: Id, patch: Partial<Proposal>): Promise<void>` (called by RegionDO/TrunkDO)
- `onLanding(l: Landing): Promise<void>`
- `review(): Promise<Proposal[]>`, `decide(proposalId: Id, d: "approve" | "reject" | "return", reason: string, by: string): Promise<void>`
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

### PoolDO (name: colonyId)
Keeps a warm pool of workspace forks of trunk across the `ft-ws-*` namespaces, grown by fork trees (fork from existing forks so forks run in parallel across sources), refreshed to the current trunk on lease, and recycled after landing.
- `init(p: { colonyId: Id; trunk: RepoRef; target: number }): Promise<void>`
- `lease(agentId: Id, trunkSha: Sha): Promise<WorkspaceLease | null>`
- `release(agentId: Id): Promise<void>`
- `status(): Promise<{ ready: number; leased: number; forking: number; target: number }>`

### AgentDO (name: agentId)
An in-platform agent built on `@cloudflare/computer` (workspace + AI SDK tools) and Workers AI (or Claude when `ANTHROPIC_API_KEY` is set). It loops: take, work, propose, wait, repeat. Its `read` tool records the read set. It journals each step so a killed agent resumes.
- `start(p: { colonyId: Id; agentId: Id; model: string }): Promise<void>`
- `stop(): Promise<void>`, `status(): Promise<AgentInfo>`

### FireTridentMcp
An `agents/mcp` McpAgent exposing tools for external agents (Claude Code, Codex, Cursor): `join`, `sense`, `take`, `declare`, `checkout`, `read`, `propose`, `inbox`, `why`.

## Artifacts layout

- `ft-trunk` namespace (binding `ARTIFACTS`): `<colony>--trunk` and, later, lane repos `<colony>--lane-<region>`.
- `ft-ws-0..3` namespaces (bindings `WS0..WS3`): workspaces `<colony>--ws-<n>`, sharded by `n % 4` to spread the per-namespace control-plane limit.
- `ft-sessions` namespace (binding `SESSIONS`): one repo per in-platform agent session.

Measured in the spike (spike/RESULTS.md): import and fork are synchronous (about 1.3 s per fork, parallel even from one source); about 20% of forks issued within ~0.1 s of a push to the source fail with INTERNAL_ERROR and must be retried; git inside a Durable Object via `@cloudflare/computer` clones in ~350 ms, commits in ~90 ms, and pushes in ~300 ms; a commit built by tree surgery takes ~40 ms; forks copy every ref including notes (`defaultBranchOnly` is ignored); binding read calls need `main` or a full commit id (`HEAD` and `refs/...` return null); the server rejects pushes whose expected old value is stale (compare-and-swap) but accepts forced non-fast-forward pushes; the namespace push trigger starts a Workflow for every repo in the namespace (~0.5 s to instance, ~2.3 s to `run()`).

Facts the design relies on (from the docs and the spike): each repo is one Durable Object; git requests are limited per repo and control-plane calls per namespace; the binding reads but cannot write files, so writes go through git; there is no server-side merge, hook, or branch protection; Artifacts accepts non-fast-forward pushes, so only TrunkDO ever holds a trunk write token and it pushes with an expected old value.

## Live events

`ColonyEvent` (see `packages/core/src/types.ts`) is the single event shape for the UI and for internal fan-out. The UI first loads `ColonySnapshot`, then applies events from the WebSocket.

## Additional RPCs (as built)

- ColonyDO: `getColony`, `listRegions`, `getIntent`, `getAgent`, `registerAgents` (batch), `abandon(agentId, reason)`, `inbox(agentId, limit)`, `updateProposals` (batch), `recordDecision`, `landContext(intentIds, agentIds)` (compact lineage context for lanes).
- RegionDO: `reading(opts)` (optionally filtered by paths), `apply`, `dequeue`, `status`.
- TrunkDO: `init` accepts an optional `regionDepth`; `land(batch, ctx?)` takes compact lineage context (lanes pass it, so the writer never pulls a snapshot); `stats`, `flushNotes` (re-pushes any note whose push failed after its landing), `mirrorTo`, `refreshTokenIfNeeded`. TrunkDO does not call `onLanding`; the lane does.
- PoolDO: `stats`, `teardown`. Forks cannot cross namespaces, so each `ft-ws-N` namespace holds a seed repo `<colony>--seed` that workspaces fork from.
- AgentDO: `start({ colonyId, agentId, model?, kind?, name?, delayMs? })`; `status()` returns AgentInfo plus journal fields.
- `deprovisionTrunk()` in `artifacts/colony.ts` removes a colony's repos.
- MCP: `/mcp` (Streamable HTTP) and `/sse`, gated by `FT_MCP_TOKEN` when set (Bearer header or `?token=`).

## Decide: the reflex arc and the immune review (packages/worker/src/decide/)

A proposal enters `checking` and the decide engine routes it:

1. **Innate checks**: the rule re-check on the changed files, residual paths (changed but not in the declared footprint), and a mandatory "Not verified:" statement.
2. **System 1 (reflex)**: one Clef call (`@cf/cloudflare/clef`, typed noul/choice/score questions: needs_human, risk, touches_sensitive, off_intent, plus every matching antibody question). Confident answers act; uncertain ones escalate.
3. **System 2 (LLM)**: a second opinion from a different model family than the authoring agent (for example `@cf/openai/gpt-oss-120b`), strict JSON verdict.
4. **System 3 (human)**: the review queue.

**Two-signal gate**: a proposal lands without a human only with two independent confirmations bound to the same head commit (innate checks plus a System-2 approval or earned path autonomy) and a low p(needs_human). One signal returns it to its agent. Escalation to a human needs a detector hit plus damage or a capability change. **Regulation**: an alert budget caps human pages per hour; a detector marked not useful ≥10% goes advisory and >25% goes off. **Antibodies**: a human rejection mints an antibody (path matcher + yes/no question + threshold), committed to trunk as `.firetrident/antibodies/<id>.json` by `TrunkDO.systemCommit` with a lineage note; every later matching proposal is screened. **Vaccination meter**: `POST /api/colonies/:id/vaccinate {count}` injects sealed bad proposals of several threat classes through the normal path; they can never land, and recall per class is reported with a Wilson 95% interval (`GET /api/colonies/:id/vaccinate`).

Routes: `POST|GET /api/colonies/:id/vaccinate`, `GET /api/colonies/:id/immune`, `POST /api/colonies/:id/decide/policy`, `POST /api/colonies/:id/detectors/:did` (useful / not useful feedback). ColonyDO: `vaccinate`, `vaccineReport`, `immune`, `setDecidePolicy`, `detectorFeedback`. Every decision is recorded (`recordDecision`) and emitted, so the UI funnel shows reflex / LLM / human counts.
