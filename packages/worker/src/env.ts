import type { AccountsDO } from "./accounts/AccountsDO.ts";
import type { AgentDO } from "./agents/AgentDO.ts";
import type { CloudflareGrantDO } from "./cloudflare/GrantDO.ts";
import type { ColonyDO } from "./colony/ColonyDO.ts";
import type { FireTridentMcp } from "./mcp/FireTridentMcp.ts";
import type { PoolDO } from "./pool/PoolDO.ts";
import type { RegionDO } from "./region/RegionDO.ts";
import type { TrunkDO } from "./trunk/TrunkDO.ts";

/** Every binding the Worker has. Mirrors wrangler.jsonc; keep them in sync. */
export interface Env {
  ASSETS: Fetcher;
  COLONY: DurableObjectNamespace<ColonyDO>;
  REGION: DurableObjectNamespace<RegionDO>;
  TRUNK: DurableObjectNamespace<TrunkDO>;
  POOL: DurableObjectNamespace<PoolDO>;
  AGENT: DurableObjectNamespace<AgentDO>;
  MCP: DurableObjectNamespace<FireTridentMcp>;
  /** The deployment's accounts (accounts/AccountsDO.ts), one instance by name; read only while FT_ACCOUNTS is on. */
  ACCOUNTS?: DurableObjectNamespace<AccountsDO>;
  /**
   * Optional: the stored Cloudflare connections (cloudflare/GrantDO.ts), one object per FireTrident account (by name: the
   * account id). Each holds that account's Cloudflare OAuth tokens, encrypted with FT_GRANT_KEY. Absent, nobody can
   * connect Cloudflare and no colony has an owner's Workers AI.
   */
  CF_GRANTS?: DurableObjectNamespace<CloudflareGrantDO>;
  /** Trunks and lane repos (namespace ft-trunk). */
  ARTIFACTS: Artifacts;
  /** Workspace shards (namespaces ft-ws-0..3). Use workspaceBinding() to pick one. */
  WS0: Artifacts;
  WS1: Artifacts;
  WS2: Artifacts;
  WS3: Artifacts;
  /** Agent session repos (namespace ft-sessions). */
  SESSIONS: Artifacts;
  AI: Ai;
  INGEST: Workflow;
  VERIFY: Workflow;
  METRICS: AnalyticsEngineDataset;
  /** Version metadata: the Worker version serving a request (id, tag, upload time), for GET /api/about (front/about.ts). */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  FT_PUBLIC_URL: string;
  /**
   * Optional: the short git commit this deployment was built from, set by the deploy command
   * (`wrangler deploy --var FT_BUILD:$(git rev-parse --short HEAD)`). GET /api/about, every page's footer or top bar
   * and `ft status` show it as "build <commit>"; absent, they show the Worker version instead.
   */
  FT_BUILD?: string;
  FT_DEFAULT_MODEL: string;
  FT_BULK_MODEL: string;
  FT_REFLEX_MODEL: string;
  /**
   * Optional: hedged model calls, "on", or a comma-separated list of colony ids; absent or "off" is off. Where it covers
   * the colony, a model call with no answer after its call site's wait goes out once more (colony/hedge.ts): Clef, the
   * second opinion (to its next candidate model), antibody minting, the contest judge and jury, the conflict resolver
   * and in-platform agents. The first answer wins, the other copy is aborted, both copies' tokens count in the spend,
   * and the decision record (`hedged`) and the model's check say which copy answered. Metrics `hedge.<site>.sent` and
   * `hedge.<site>.copy` count copies sent and copies whose answer was used.
   */
  FT_HEDGE?: string;
  /**
   * Optional: the hedge's wait in ms, for every call site ("8000") or by site ("review=8000,agent=90000"; sites reflex,
   * review, judge, antibody, resolver, agent), held to 1 s .. 10 minutes; absent, each site's own (HEDGE_AFTER_MS).
   */
  FT_HEDGE_MS?: string;
  /** Secret: bearer token for mutating API routes. */
  FT_ADMIN_TOKEN?: string;
  /**
   * Optional: verified approvers behind Cloudflare Access (api/access.ts). FT_ACCESS_TEAM_DOMAIN is the Access team domain
   * ("<team>.cloudflareaccess.com") and FT_ACCESS_AUD the Application Audience (AUD) tag of the Access application in
   * front of this Worker. With both set, a person's review decision (POST /api/colonies/:id/review/:pid and the batch
   * route) verifies the Cf-Access-Jwt-Assertion header (RS256 against the team's keys at /cdn-cgi/access/certs, cached;
   * audience, expiry and issuer checked) and records the token's email as the approver, marked verified; without a valid
   * token the name the request states is recorded, marked stated. The plain Cf-Access-Authenticated-User-Email header is
   * never trusted. The admin token is still required for the write. Absent (either one), nothing is verified and every
   * decision's name is recorded as stated.
   */
  FT_ACCESS_TEAM_DOMAIN?: string;
  FT_ACCESS_AUD?: string;
  /**
   * Optional: accounts, "on"; absent or anything else is off (deployment-wide, never per colony). On, a person signs in
   * with GitHub (GET /auth/github/start; a new account needs an invite code the operator minted with POST
   * /api/accounts/invites), owns up to 3 colonies created from the account page (/account, POST /api/me/colonies; their
   * repositories and model calls on the person's own connected Cloudflare account), and mints tokens scoped to one of
   * them with a role (agent, reviewer, owner) that open its writes on the API and /mcp (accounts/). A colony with no owner
   * is an operator colony and behaves exactly as before, and the admin and MCP tokens keep working everywhere. Off, every
   * accounts route answers 404, no account UI appears, and the accounts object is never read.
   */
  FT_ACCOUNTS?: string;
  /** The GitHub OAuth app's client id for sign-in (a var); its callback URL is `${FT_PUBLIC_URL}/auth/github/callback`. */
  FT_GITHUB_CLIENT_ID?: string;
  /** Secret: the GitHub OAuth app's client secret. Sent only to github.com when a sign-in finishes, never logged. */
  FT_GITHUB_CLIENT_SECRET?: string;
  /**
   * Secret: at least 32 random characters. Signs the session cookie (HMAC-SHA-256) and seals the sign-in cookies
   * (AES-GCM), each under its own key derived with HKDF. Changing it signs everyone out. Without it, sign-in refuses.
   */
  FT_SESSION_KEY?: string;
  /**
   * Secret (optional): the key that signs lineage notes, an Ed25519 private key as a JWK JSON string
   * ({"kty":"OKP","crv":"Ed25519","d":"…","x":"…"}, with an optional "since": the ISO date it started signing). With it,
   * the trunk writer signs each landing commit it builds (an FT-Note-Signature trailer just above FT-Note, over the note's
   * digest, the commit's tree and its parent: trunk/signature.ts), its public key is published at
   * /.well-known/firetrident-keys.json, GET /api/about names its key id, and the note checks say whether each commit is
   * signed. The same key also signs each commit the stock git way (a gpgsig header holding an SSH signature, namespace
   * "git": trunk/gitsig.ts), so `git verify-commit` with gpg.format=ssh and the allowed signers published at
   * /.well-known/firetrident-allowed-signers checks it, and so do the note checks. Absent, landings stay unsigned and
   * nothing fails. Set and not such a key (logged once, never printed), landings stay unsigned and the note checks
   * (`ft verify`, GET /notes/verify's `signingProblem`) report it as a failure until it is fixed. With a key that loaded,
   * a signature that fails at landing time is never skipped: that cycle lands nothing (logged and counted) and its
   * changes are tried again.
   */
  FT_NOTE_KEY?: string;
  /**
   * Optional (public data, a var or a secret): the keys this deployment signed lineage notes with before FT_NOTE_KEY's,
   * as a JSON array of {"x": <raw Ed25519 public key, base64url>, "since": <ISO date, optional>, "until": <ISO date>}
   * (trunk/signature.ts). /.well-known/firetrident-keys.json and the allowed signers list each one with its window, and a
   * signature checks out when its key is listed and the key was signing at the commit's time, so a rotated key's older
   * signatures stay good. An entry that is not such a key is left out (logged once). Absent, only FT_NOTE_KEY is published.
   */
  FT_NOTE_KEYS_RETIRED?: string;
  /**
   * Optional: credit trailers on landing commits, "on", or a comma-separated list of colony ids; absent or "off" is off.
   * Above the FT trailers, each agent whose change the commit lands is a `Co-authored-by:` (its name and a no-reply
   * address made from its id and the colony, never a real mailbox), and each person who approved a change of it an
   * `Approved-by:` (trunk/credits.ts). FT-Note-Signature and FT-Note stay the last two lines.
   */
  FT_CREDIT_TRAILERS?: string;
  /** Optional: co-change repulsion weight (see ColonyDO; the simulator favors 5). */
  FT_COCHANGE_WEIGHT?: string;
  /** Optional: lateral inhibition threshold as a fraction of a fresh claim, or "off". */
  FT_LATERAL_INHIBITION?: string;
  /**
   * Optional: lateral inhibition by the strongest file, "on", or a comma-separated list of colony ids; absent or "off" is
   * off. Where it covers the colony, take() skips an open intent when one of its own files carries at least the
   * threshold of other agents' live claim, where off it sums the claims over all of the intent's files: summed, a silent
   * agent's claims on n shared files hold an intent for 5 * ln(2n) minutes, by the strongest file one half-life (about
   * 3.5 minutes) however many files overlap (colony/takemath.ts).
   */
  FT_INHIBIT_STRONGEST?: string;
  /**
   * Optional: the age cap, "on", or a comma-separated list of colony ids; absent or "off" is off. Where it covers the
   * colony, an open intent's age multiplier in take() (1 + ageMinutes / 10) stops at core AGE_FACTOR_CAP, so co-change
   * and import repulsion keep holding back an old intent while its coupled files are claimed; off, the multiplier grows
   * without bound (colony/takemath.ts).
   */
  FT_AGE_CAP?: string;
  /** Optional: import-aware repulsion weight in take() (imports and importers of claimed files); absent or 0 is off. */
  FT_IMPORT_WEIGHT?: string;
  /**
   * Optional: import-name revalidation, "on", or a comma-separated list of colony ids; absent or "off" is off. A change
   * stale only on files it read lands when the names it imports from them are still exported and each of those files only
   * gained top-level declarations since the version it read; otherwise it goes back naming the file and the line.
   */
  FT_REVALIDATE?: string;
  /**
   * Optional: text merge, "on", or a comma-separated list of colony ids; absent or "off" is off. A change stale only on
   * files it writes (trunk changed them after its base) lands when each of them merges cleanly, line by line, with the
   * version it would land on (core/textmerge.ts); otherwise it goes back as before, a conflict named in the reason.
   */
  FT_TEXT_MERGE?: string;
  /**
   * Optional: text merge's insertion rule, "on", or a comma-separated list of colony ids; absent or "off" is off. Where
   * text merge is on too, a file whose only conflicting hunks are lines both sides inserted at the same place of the base
   * lands as the union of the two insertions, trunk's lines first, leaving out the lines of the change trunk already
   * inserted there (core/insertions.ts); its merged entry records `rule: "insertions"`, and the trunk writer counts
   * `trunk.mergedInsertions`. Lines both insertions start or end with land once; a union that would land the same
   * construct twice is refused, and imports compare with their quotes made alike. A hunk that edits or deletes a base
   * line still sends the change back, naming the hunk.
   */
  FT_MERGE_INSERTIONS?: string;
  /**
   * Optional: already on trunk, "on", or a comma-separated list of colony ids; absent or "off" is off. A change that would
   * change nothing on the trunk it lands on (every file it writes already holds that content and every file it deletes is
   * already gone, after the changes landing ahead of it in the same cycle, its text merge included) lands no commit and
   * no note and is not returned: it closes as already on trunk (proposal status already_on_trunk, closure cause
   * already_on_trunk), naming where the content came from (the landing ahead of it in the cycle, else the landing that
   * last changed those files, else the trunk head), and its agent is told there is nothing to do (trunk/ontrunk.ts). Its
   * lane sends such a change on to the trunk writer instead of back as stale. Counted apart: `alreadyOnTrunk` in the
   * colony's metrics and `trunk.alreadyOnTrunk` per cycle. A retry of a change that did land still gets its landing.
   */
  FT_ALREADY_ON_TRUNK?: string;
  /**
   * Optional: the conflict resolver, "on", or a comma-separated list of colony ids; absent or "off" is off. A change that
   * text merge sent back for overlapping hunks is merged by the platform (colony/resolver.ts): one model call writes each
   * conflicting file keeping both changes, deterministic checks validate it, and it goes through the decide stage as a new
   * proposal for the same intent. When that fails, the return stands and the intent reopens as before.
   */
  FT_RESOLVER?: string;
  /** Optional: the model the conflict resolver calls; FT_DEFAULT_MODEL when absent ("default" and "bulk" name the server's models). */
  FT_RESOLVER_MODEL?: string;
  /**
   * Optional: return hunks, "on", or a comma-separated list of colony ids; absent or "off" is off. When a change goes back
   * because trunk moved files it read or wrote, its return quotes what beat it (colony/returnhunks.ts): each landing that
   * movedBy names carries its unified diff of each moved file (movedBy[].hunks: about 40 lines a file, 3 files a landing),
   * and a text merge conflict carries each contested region (contested: the base, trunk and own lines, from the base line
   * where it starts), at most 120 lines and 8,000 characters a return, masked where a line looks like a secret. The colony
   * asks the trunk writer once per batch of returns and waits at most a second; past that, the return goes out as before,
   * its landings named. Agents read the hunks in the take's lastReturn, the MCP inbox and the in-platform agent's redo
   * prompt (fenced as data there); review cards show them under what beat the intent's last change.
   */
  FT_RETURN_HUNKS?: string;
  /**
   * Optional: heads-up, "on", or a comma-separated list of colony ids; absent or "off" is off. Every MCP tool reply to an
   * agent that holds an intent carries, when there is something to say, `headsUp` (mcp/headsup.ts, colony/headsup.ts):
   * the landings since its lease base that changed files it read or will write (path, landing, intent title), and the
   * changes waiting to land whose write sets meet its read or write set (proposal, intent title), with `deliveredThrough`,
   * the newest landing it has been told of. The colony reads its landing path index and the oldest 200 in-flight
   * proposals (kept for two seconds; with more in flight the heads-up says how many it checked of how many); the session
   * keeps an answer for three seconds and waits at most 50 ms for one. The tool's answer always goes out: a reply whose
   * heads-up missed the 50 ms or failed carries `headsUp: { unavailable: "timeout" | "error", message }` instead, so no
   * field still means nothing to say. Its take and checkout add a git command that records the colony and agent in the
   * clone's local git config, which `ft hook check` reads. Its proposals carry what it was told (Proposal.toldOf); when
   * one goes back because trunk moved, its reason ends by saying whether and when the agent was told of the landing that
   * beat it, and /metrics counts the return as `headsUp.warned` (warned and proposed anyway) or `headsUp.unwarned` (could
   * not have known).
   */
  FT_HEADS_UP?: string;
  /**
   * Optional: model step-up, "on", or a comma-separated list of colony ids; absent or "off" is off. When an intent's
   * changes have come back twice since it last changed course (a landing or a substantive amendment), its next take asks
   * for the stronger model class ("default", FT_DEFAULT_MODEL) and says why (colony/stepup.ts): in-platform agents write
   * that attempt's files with it, and outside agents get it as advice. A third return still reaches the needs-you strip.
   */
  FT_MODEL_STEPUP?: string;
  /**
   * Optional: spend per intent, "on", or a comma-separated list of colony ids; absent or "off" is off. Every model call
   * is also counted for the intent it serves, as it happens (colony/intentspend.ts): in-platform agents count each call
   * under their job's intent in their journals, which the colony's spend book reads with their totals, and the decide
   * stage's reflex, second opinion and contest judge count theirs by proposal. GET /api/colonies/:id/intents/:iid/spend
   * prices one intent's calls; the snapshot and /metrics carry `intentSpend` for the Intents tab. Reads work without the
   * flag and show nothing for an intent nothing was counted for.
   */
  FT_INTENT_SPEND?: string;
  /**
   * Optional: the default spend cap, in dollars ("5", "12.50"); absent, empty or "off" means no default, as before. A
   * colony with no spend cap of its own is capped at this amount (colony/spendcap.ts): the same reservations, the same
   * review reserve (a tenth of it) and the same pause at the cap; its ledger starts at the colony's spend when the
   * default first applies, and counts everything the colony spent, before it too. A person's own cap (POST
   * /api/colonies/:id/spend-cap) always wins, above or below it, and removing that cap puts the default back. A value that
   * is not a dollar amount above 0 is ignored with a warning.
   */
  FT_DEFAULT_SPEND_CAP?: string;
  /**
   * Optional: the deletion guard, "on", or a comma-separated list of colony ids; absent or "off" is off. In a trunk
   * cycle that deletes files, a change goes back while a trunk file's import of a file it deletes would resolve to nothing.
   */
  FT_DELETION_GUARD?: string;
  /**
   * Optional: the export guard, "on", or a comma-separated list of colony ids; absent or "off" is off. In a trunk cycle
   * that changes script files, a change goes back while a script file imports a name it stops exporting (an importer
   * on trunk, or a file a change ahead of it in the cycle writes), unless the same change or one accepted ahead of it
   * rewrites that importer without the import; of a change that stops exporting a name and one that imports it anew in
   * the same cycle, the second goes back naming the first (trunk/plan.ts brokenExports). It fails open: what it cannot
   * read for sure is skipped and counted as `trunk.exportsUncovered`.
   */
  FT_EXPORT_GUARD?: string;
  /**
   * Optional: module recipes, "on", or a comma-separated list of colony ids; absent or "off" is off. Built-in recipes
   * (rename-identifier, replace-import, text-replace: POST /api/colonies/:id/recipes, `ft recipe`) need no flag. Where
   * this covers a colony and the deployment has a Worker Loader (LOADER), a person may also declare a `module` recipe:
   * their own `transform(path, text)` module, which the trunk writer runs in a sealed Dynamic Worker (no network, no
   * bindings) twice per batch and lands only when both runs agree (trunk/reciperunner.ts). Module recipes are not applied
   * to changes in flight: a change stale through one goes back as before.
   */
  FT_RECIPE_MODULES?: string;
  /**
   * Optional: review by reproduction, "on", or a comma-separated list of colony ids; absent or "off" is off. A proposal
   * may declare the recipe that made it (`recipe` on MCP and REST propose: a built-in kind, its version, arguments and
   * scope). Where this covers the colony, the decide stage replays that recipe on the change's base files, twice: the
   * files that equal the replay are proven (gate rule D5 lands a change they all are, with no model call), and only the
   * rest goes through the reflex arc, its diff against the replay (decide/reproduce.ts). Unknown, unpinned, module and
   * text-replace recipes, and a replay that differs between its runs, get ordinary review. The danger scan, protected
   * paths and the innate checks read the whole change either way. Off, a declared recipe is recorded and the change has
   * ordinary review.
   */
  FT_REPRODUCE?: string;
  /**
   * Optional: the goal-conflict check, "on", or a comma-separated list of colony ids; absent or "off" is off. In the
   * decide stage, a change that would undo lines a recent landing wrote for another intent (neither an ancestor nor a
   * descendant of its own; at least 3 lines and half of that landing's lines in the file) waits for a person instead of
   * landing, the reason naming the landing and its intent's why (decide/goalconflict.ts, core/goalconflict.ts). Recent:
   * the decide policy's goalConflictMinutes (60) and goalConflictLandings (200). The check fails open.
   */
  FT_GOAL_CONFLICT?: string;
  /**
   * Optional: escalation batching, "on", or a comma-separated list of colony ids; absent or "off" is off. The escalations
   * the hourly alert budget cannot send back (gate rules P1 to P4, M2, L5, L7, L8) get a budget of their own, the decide
   * policy's escalationBatchPerHour (60 an hour per colony; decide/batch.ts). Past it, each next one still waits for a
   * person, and the review queue (and ft review) shows the batchable ones that escalated for the same reason (the same
   * rule; for P1 the same danger patterns) as one card with their count and list: approve all, reject all, or open each.
   * Batchable: capability-only danger patterns, M2, L5, L7, L8. Never batched, one card each: auth, secret, governance,
   * handoff, a repair's test change, a loosened guard, a protected path, P2, P4 and a held merge. An answer for a
   * batch (POST /api/colonies/:id/review/batches/decide) is the person's decision on each change it lists; a rejection
   * mints one antibody, from the first change. Off, every escalation is its own card, as before.
   */
  FT_ESCALATION_BATCH?: string;
  /**
   * Optional: changes waiting for a person hold no files, "on", or a comma-separated list of colony ids; absent or "off"
   * is off. When a change is escalated to a person, or held for one under a merge lock, its agent's claim on the intent's
   * files is cleared and no heartbeat refreshes it, so open intents on those files are taken as if nobody held them. An
   * in-platform agent whose inline change waits for a person ends that job and takes other work; when the person
   * decides, the change lands, goes back or is held again under the merge lock by the ordinary rules
   * (colony/personwait.ts). Claims of work being written and of changes in review or in a lane are unchanged.
   */
  FT_PERSON_WAIT?: string;
  /**
   * Optional: quoted acceptance, "on", or a comma-separated list of colony ids; absent or "off" is off. For a change whose
   * intent carries an acceptance list (and was not written by trunk certification or the colony itself), the second
   * opinion answers each line as met, not met or unclear, and each "met" names a file and quotes a line of the diff it
   * was shown; the platform looks for each quote in the added and unchanged lines (decide/quotes.ts). Its approval counts
   * only when every line is met with a quote found there: a line not met returns the change naming it, an unclear one
   * sends it to a person. A line stating what must not be there ("No other file changes") has no line to quote: its met
   * counts on the model's word, and the record says so (basis). The acceptance list of the newest landing by another
   * intent on the files the change modifies is asked too, as keep lines: one not met returns the change naming it. The
   * decision and the lineage note keep each line with its verdict and quote.
   */
  FT_QUOTED_ACCEPTANCE?: string;
  /**
   * Optional: the review view, "on", or a comma-separated list of colony ids; absent or "off" is off. It works on the lines
   * quoted acceptance asks (FT_QUOTED_ACCEPTANCE), so it does nothing where that is off. Before any model, the decide stage
   * checks each acceptance and keep line that names a file and what it exports (a function signature, an interface, a type
   * alias, a constant, or that the file exists) by reading the files after the change, the changed files and the trunk files
   * the line names (decide/keepcheck.ts, decide/tsexports.ts): a line it proves is met, checked by FireTrident; a line it
   * disproves sends the change back with the exact mismatch (rule A1); a keep line that did not hold before the change either
   * is unclear and not asked; every other line goes to the second opinion as before. The second opinion is asked only the
   * lines left open, and then sees each changed file whole wherever it fits the review budgets (24,000 characters a file,
   * 60,000 in all), and a "met" counts with a quote found in the changed file after the change. Its review receipt digests
   * that view (decide/reviewview.ts).
   */
  FT_REVIEW_VIEW?: string;
  /**
   * Optional: the contest jury, "on", or a comma-separated list of colony ids; absent or "off" is off. Where it covers a
   * colony, contest mode compares two tied changes with a jury of two or three small models from different families (the
   * decide policy's `juryModels`, outside the contestants' families) instead of one judge model: each member is asked in
   * both orders at once, within the judge's deadline; a member whose answers agree casts a vote, one whose answers flip
   * with the order, times out or answers nothing usable counts for nobody; the side with more votes wins, and a split or
   * no vote is a tie broken as today (decide/jury.ts). The verdict names each member's vote in the loser's reason and
   * the winner's `contest` check, so the lineage note and `ft why` show it; members' tokens count in the judge layer of
   * the colony's spend, per model, and `contest.jury.majority`, `contest.jury.ties`, `contest.jury.consistent` and
   * `contest.jury.inconsistent` count the verdicts and votes.
   */
  FT_CONTEST_JURY?: string;
  /**
   * Optional: twin intents caught at declare, "on", or a comma-separated list of colony ids; absent or "off" is off. An
   * intent a person or an agent declares (POST /intents, MCP declare) whose normalized title words score at least 0.8
   * (Jaccard) against an intent open, claimed, proposed or landed in the last 30 minutes, and whose footprint overlaps
   * it, is not created: the answer is that intent with `duplicateOf`, `similar` and a note (REST 200 instead of 201),
   * unless the declare says `force: true` (core/twins.ts, colony/twins.ts). Rule intents, certification repairs, spec
   * imports (`ft new` declares with force) and the colony's own intents are never checked.
   */
  FT_TWINS?: string;
  /**
   * Optional: the intent chain gate, "on", or a comma-separated list of colony ids; absent or "off" is off. An
   * agent-declared intent (MCP declare, Agent2Agent, POST /intents with source agent) whose ancestry, parent by parent,
   * holds as many agent-declared intents as the decide policy's intentChainDepth (2: the third agent-declared intent in
   * a row) is held for a person before any agent can take it: an open report of kind "chain" on the intent says who
   * declared it and from what, GET /escalations and the Review tab show it, take offers it to no agent, and a person's
   * dismiss releases it or withdraw ends it (colony/chain.ts). The same gate holds the intents one agent declares past
   * the policy's intentFanout (5) in an hour, however shallow, since each reaches another agent. Who declared an intent
   * (TakeResult.declaredBy: its source, the declarer and its model, the chain depth) is shown at every take, flag or no flag.
   */
  FT_INTENT_CHAIN_GATE?: string;
  /**
   * Optional: the megafile alarm, "on", or a comma-separated list of colony ids; absent or "off" is off. A script file
   * that grew fast while many agents wrote it, or that changes keep colliding on, turns hot (core/hotness.ts): the
   * colony declares an intent to split it and holds the file (no other change may write it, no other intent covering
   * it is offered) until the split lands, is withdrawn or reported, or an hour passes (colony/megafile.ts).
   */
  FT_MEGAFILE?: string;
  /**
   * Optional: inline changes from outside, "on", or a comma-separated list of colony ids; absent or "off" is off. A
   * proposal may then carry the text of the files it writes (`contents` on POST /proposals, `files` on MCP propose)
   * instead of a commit pushed to its workspace, and the MCP server offers `files` and says so in its instructions.
   * The colony, the decide stage and the trunk writer handle an inline change whoever sends it (colony/inline.ts).
   */
  FT_INLINE?: string;
  /**
   * Optional: virtual checkouts for in-platform agents, "on", or a comma-separated list of colony ids; absent or "off" is
   * off. An agent then never clones: it reads trunk object by object through the ARTIFACTS binding at its lease base
   * (agents/virtual.ts) and proposes its change inline (Proposal.contents). A change over the inline limits, or with
   * binary content, is still committed and pushed to the agent's workspace.
   */
  FT_VIRTUAL_CHECKOUT?: string;
  /**
   * Optional: asynchronous trunk publishing, "on", or a comma-separated list of colony ids; absent or "off" is off.
   * A landing counts once the trunk writer records it; a publish loop beside the landing cycles pushes the recorded
   * commits to the trunk repository in order (trunk/publish.ts). Leases, `certified` and the lineage notes follow the
   * published head; lanes validate against the recorded one.
   */
  FT_ASYNC_PUBLISH?: string;
  /** Optional (load tests only): when set, ColonyDO logs event-loop lag and streams it as colony.lagMs. */
  FT_LAG_PROBE?: string;
  /**
   * Test hook (previews only; never set in production): the trunk writer sleeps this many milliseconds in each landing
   * cycle between its direction check and its push (at most 60 s), so a live check can withdraw an intent while its
   * change is mid-cycle (scripts/direction_race.rb). Read only when set.
   */
  FT_TEST_PUSH_DELAY_MS?: string;
  /**
   * Optional: colonies whose trunk anyone may clone and fetch read-only with plain git at
   * /git/<colony>.git (comma-separated colony ids). Empty or unset turns the proxy off.
   */
  FT_PUBLIC_GIT?: string;
  /**
   * Optional: colonies anyone's agent may ask about over a read-only, stateless MCP endpoint at /public/mcp, with no
   * token (comma-separated colony ids, parsed like FT_PUBLIC_GIT; there is no "on"): tools status, why, intent,
   * sense and impact, over read stubs only (mcp/public.ts). Empty or unset turns the endpoint off (404).
   */
  FT_PUBLIC_MCP?: string;
  /**
   * Optional bindings (Workers Rate Limiting, `ratelimits` in wrangler.jsonc): public reads counted per client address
   * and per colony, across POST /public/mcp (one count per JSON-RPC message, each tools/call also against its colony) and
   * the API's GET routes under /colonies (api/ratelimit.ts). wrangler.jsonc sets 1,200 reads a minute per address and
   * 3,000 per colony, counted per Cloudflare location, with namespaces 41001 and 41002 (staging 41011 and 41012). Over
   * either limit a read gets 429 with Retry-After; the admin token is not counted. Absent, nothing is limited (the public
   * MCP's per-isolate in-flight cap still holds).
   */
  PUBLIC_IP_LIMIT?: RateLimit;
  PUBLIC_COLONY_LIMIT?: RateLimit;
  /**
   * Optional: the Agent2Agent door for orchestrators, "on", or a comma-separated list of colony ids; absent or "off" is
   * off (404). A covered colony serves an agent card at GET /api/colonies/:id/.well-known/agent-card.json and JSON-RPC
   * at POST /api/colonies/:id/a2a (api/a2a.ts): SendMessage declares an intent and CancelTask withdraws one, both with
   * the admin token like POST /intents; GetTask and ListTasks follow intents as tasks to their landing commit, public
   * like every read.
   */
  FT_A2A?: string;
  /** Local development only: "1" lets writes and MCP through when their tokens are not configured. Never set it on a deployment. */
  FT_OPEN_WRITES?: string;
  /** Secret (optional): token MCP clients must present at /mcp and /sse. */
  FT_MCP_TOKEN?: string;
  /**
   * Secret (optional): a GitHub token for issue import (colony/issues.ts, api/issues.ts). Without it, POST
   * /api/colonies/:id/issues/import reads public repositories with GitHub's limit for reads without a token; with it,
   * the token's limit. It is also what the opt-in write-back needs: an import made with closeOnLand posts one comment
   * on each issue when its change lands (and closes it with close), only while this is set and GitHub says the token
   * may change that repository's issues. Sent only to api.github.com, never logged.
   */
  FT_GITHUB_TOKEN?: string;
/**
 * Optional (a var): the OAuth client id of this deployment's Cloudflare OAuth client, for "Connect Cloudflare" on the
 * account page (cloudflare/routes.ts; only with FT_ACCOUNTS on). The client is registered on Cloudflare with the
 * redirect URL FT_PUBLIC_URL + "/auth/cloudflare/callback", client_secret_post, the required scopes user-details.read,
 * account-settings.read, artifacts.read and artifacts.write, the optional scopes ai.read and ai.write, and
 * offline_access (without it Cloudflare issues no refresh token and a connection lasts one access token).
 */
FT_CF_CLIENT_ID?: string;
/** Secret (optional): that OAuth client's secret, sent only to dash.cloudflare.com's token and revoke endpoints, never logged. */
FT_CF_CLIENT_SECRET?: string;
/**
 * Secret (optional): key material for the stored Cloudflare tokens, at least 32 characters (`openssl rand -base64 32`).
 * Each record's AES-GCM key is derived from it with HKDF-SHA-256 and a salt of its own (cloudflare/seal.ts). Changing it
 * makes every stored connection unreadable: each shows as broken until its person connects again. Connecting Cloudflare
 * needs all three of FT_CF_CLIENT_ID, FT_CF_CLIENT_SECRET and FT_GRANT_KEY; without them it is off.
 */
FT_GRANT_KEY?: string;
  /**
   * Optional: a call budget for each MCP session at /mcp and /sse, "on" (4 tool calls a second, 20 at once after a
   * pause) or "<calls per second>,<burst>" such as "8,40"; absent, "off" or anything else is off. Global, since a
   * session may not have joined a colony yet. A call that finds its session's bucket empty answers rate_limit (429,
   * retryable after retryAfterMs, the time until a token is back) without running, so it never reaches the colony
   * (mcp/budget.ts). The bucket lives in the session object's memory: a new session starts with a full one. The
   * public read-only MCP (/public/mcp) keeps its own caps.
   */
  FT_AGENT_CALL_BUDGET?: string;
  /** Secret (optional): enables Claude agents via AI Gateway / Anthropic. */
  ANTHROPIC_API_KEY?: string;
  /** Dynamic Workers (Worker Loader): trunk certification runs each colony's own tests in one. */
  LOADER?: WorkerLoader;
  /** "on": certify trunk after landings by running the colony's own tests (each colony's policy can turn it off). */
  FT_TRUNK_TESTS?: string;
  /**
   * Optional: the field guide, "on", or a comma-separated list of colony ids; absent or "off" is off. An agent may leave
   * one lesson with a proposal (`lesson` on MCP and REST propose, a `LESSON:` line from in-platform agents); it reaches
   * other agents' takes, with its author, model and landing, once its change landed and the first certification of
   * trunk after it is green, or a person approves it (colony/guide.ts). Its landing reverted, a red certification naming
   * it, or a person's rejection drops it.
   */
  FT_FIELD_GUIDE?: string;
  /**
   * Optional: lesson scopes in the field guide's takes, "on", or a comma-separated list of colony ids; absent or "off" is
   * off. Every lesson keeps the files its change read and wrote with their blobs either way (colony/lessonscope.ts); where
   * this is on as well as FT_FIELD_GUIDE, a take ranks the lessons on its intent's footprint first, names the files of a
   * lesson's scope that landings changed since it was written (`movedSince`, with each landing and intent; prompts and the
   * MCP take say "Written before these files changed"), and leaves a lesson out once every file of its scope changed.
   */
  FT_LESSON_SCOPE?: string;
  /**
   * Optional: culprit finding, "on", or a comma-separated list of colony ids; absent or "off" is off. A red certification
   * names the landings that changed what its failing test files load since the last green commit (its `suspects`), and
   * its repair intent's why names them too.
   */
  FT_CULPRITS?: string;
  /**
   * Optional: the first red search, "on", or a comma-separated list of colony ids; absent or "off" is off. After a red
   * certification is recorded, its failing test files and what they load run alone on the commits since the last green
   * certification (from the trunk writer's landing log), halving the range each run, at most 8 runs and 60 s in all; the
   * result gains `firstRed` (the commit, its landing and intents, the proposals that changed what the tests load), a
   * `bisect` event says so, and the open repair intent's why names it (certify/bisect.ts). When that landing holds several
   * proposals, the culprit is isolated inside it, with a revert probe that proves cause (certify/isolate.ts, at most 10 runs
   * and 60 s). Never on a landing's path.
   */
  FT_BISECT?: string;
  /**
   * Optional: the red brake, "on", or a comma-separated list of colony ids; absent or "off" is off. While the latest
   * certification of trunk is red and its repair intent is open (colony/redbrake.ts): the repair goes to the first agent
   * that asks for work, whatever its region, and is written with the stronger model class ("default"); a ready change
   * that writes a file the failing test files load (their import closure, the cone) waits instead of going to its lane,
   * and its agent is told so in its inbox; changes outside the cone land as before and the repair is never held. Held
   * changes go on when trunk is green again, after 15 minutes of holding, when the repair's agent reports it to a person,
   * or when the repair failed twice (it then goes to a person with the failing tests). /metrics serves `redBrake`.
   */
  FT_RED_BRAKE?: string;
  /**
   * Optional: tests before landing, "on", or a comma-separated list of colony ids; absent or "off" is off. Where it
   * covers a colony whose certification is on, a change that writes a path the certify policy's `prelandPaths` match
   * (every change when they are empty) has the test files that reach it (at most 5) run on its base with its files laid
   * over it, in the decide stage before the gate, in the sandbox certification uses (certify/preland.ts): a test that
   * passed on trunk and fails with the change sends it back to its agent; a time-out (2 s), a runner problem, no trunk
   * result to compare with or 3 runs already going in the colony let it go on as before, recorded as not checked.
   * Takes the decide path with review off too. Never inside the trunk writer's cycle; landing still validates read sets.
   */
  FT_PRELAND?: string;
}

export const WORKSPACE_SHARDS = 4;
