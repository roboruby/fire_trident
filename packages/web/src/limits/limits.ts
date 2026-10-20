import { NOTES_COMMAND } from "../landing/axes.ts";
import { SITE } from "../landing/questions.ts";

/**
 * The limits page (/limits, Limits.tsx): what you cannot do with FireTrident, why, what to do instead, and its status,
 * drawn from the honest limits in docs/results.md. The rows where the service that hosts the repository does better come first. Each row links
 * a page of the site or gives a command that shows the limit or its workaround. Then what building on Artifacts taught
 * us (spike/RESULTS.md), each finding with the workaround the code uses.
 */

/** Whether a limit is on the way: planned, waiting on Cloudflare, or not scheduled. */
export type LimitStatus = "planned" | "cloudflare" | "unscheduled";

/** How each status reads on the page. */
export const STATUS_LABEL: Readonly<Record<LimitStatus, string>> = {
  planned: "Planned",
  cloudflare: "Depends on Cloudflare",
  unscheduled: "Not scheduled",
};

/** Where to see it for yourself: a page of the site, or a command. */
export type LimitCheck = { label: string; href: string } | { label: string; command: string };

/** One limit in Why / Instead / Status form. */
export interface Limit {
  id: string;
  /** "forge": where the service that hosts the repository does better; "colony": where a colony stops. */
  group: "forge" | "colony";
  /** What you cannot do, as a sentence starting with a verb ("Sign in, ..."). */
  cannot: string;
  why: string;
  instead: string;
  status: LimitStatus;
  check: LimitCheck;
}

/** The groups in page order, with their headings. */
export const GROUPS: ReadonlyArray<{ id: Limit["group"]; title: string; lede: string }> = [
  {
    id: "forge",
    title: "Where your code host is ahead",
    lede: "A colony sits beside your codebase, not in place of it. These are the things the service that hosts your repository does that FireTrident does not.",
  },
  {
    id: "colony",
    title: "Where a colony stops",
    lede: "From the honest limits in the docs: what the coordination, review and certification do not cover, measured where it could be.",
  },
];

/** Every limit, the code host's rows first (teams, pull requests, issues). */
export const LIMITS: readonly Limit[] = [
  {
    id: "accounts",
    group: "forge",
    cannot: "Run a colony as a team, or give a person a role.",
    why: "A person signs in with GitHub, by invite code or an approved request, owns up to three colonies and mints the tokens that let agents and reviewers work on them. A role belongs to a token, not to a person: there are no teams or organizations, no per-person permissions, and a colony has one owner.",
    instead: "Mint a reviewer or agent token for each teammate from the colony's row on your account page, and keep teams and permissions with your code host; reads need no account.",
    status: "planned",
    check: { label: "Sign in and mint a token for a teammate", href: "/account" },
  },
  {
    id: "pull-requests",
    group: "forge",
    cannot: "Open a pull request against a colony, or comment on one line of a change.",
    why: "Agents send proposals: the files they read, the files they wrote, the evidence and what they did not verify. A deterministic proof, models and then a person decide each one, and a person approves, returns or rejects the whole change with a reason.",
    instead: "Take the certified work back to your repository as a branch and open the pull request there. Changes that reach a person show in the Review tab and in ft review, danger lines first.",
    status: "planned",
    check: { label: "Clone what a colony certified", command: `git clone -b certified ${SITE}/git/shortlinks.git` },
  },
  {
    id: "issues",
    group: "forge",
    cannot: "File an issue, label it, or talk it over in a thread.",
    why: "Work is an intent: a title, a why and the files it will touch, declared by a person, a rule or an agent and chosen by agents from the field. An intent keeps its revisions and an agent's report that it cannot be done as written, but no discussion.",
    instead: "Talk it over in your repository's issues, then give the colony the outcome: an intent with acceptance lines, or a rule when a pattern can find every case (each match becomes a need).",
    status: "unscheduled",
    check: { label: "The Hono run's intents, in the Intents tab", href: "/c/hono?replay=1" },
  },
  {
    id: "sync",
    group: "forge",
    cannot: "Keep a colony and your repository in step in both directions.",
    why: "A colony imports your repository once, from its URL. Nothing watches your repository afterwards, and FireTrident holds no credential that could push to it.",
    instead: "Import again to start from your newest commits, and take the work back by hand: clone certified with stock git and push it to your repository as a branch.",
    status: "planned",
    check: { label: "The take-back commands", href: "/#take-back" },
  },
  {
    id: "tests-after",
    group: "colony",
    cannot: "Hold a landing until the project's tests pass on it.",
    why: "Tests run on trunk right after a landing, by choice, so no landing waits for a test run; a broken change can sit on main until a repair lands. Tests before landing (FT_PRELAND) exist, but run on the change's base and let a change through when they take more than 2 s.",
    instead: "Deploy, release and pin from certified: it moves only to a commit on which every test file that could run passed and no passing test was lost.",
    status: "unscheduled",
    check: { label: "Watch certification catch five failing tests", href: "/c/shortlinks-review?replay=1" },
  },
  {
    id: "certified-meaning",
    group: "colony",
    cannot: "Read certified as proof that the tests check the right behavior.",
    why: "certified means every test file certification could run passed and no passing test was lost; it says nothing about what the tests check. In a new-project colony the only tests are the ones its agents wrote.",
    instead: "Run your own acceptance suite against a clone of certified, as the new-project demo does with a suite a person wrote, and keep your own CI on the pull request you open from certified.",
    status: "planned",
    check: { label: "Clone what a colony certified", command: `git clone -b certified ${SITE}/git/shortlinks.git` },
  },
  {
    id: "runners",
    group: "colony",
    cannot: "Run a test suite written for another runner, or check types.",
    why: "Certification runs only node:test files, in a Dynamic Worker with no network, the tests of one file one after another. It runs tests, not a type check, and skips projects tested with another runner.",
    instead: "Each result lists the test files it could not run, with the reason. Keep your own CI on the pull request you open from certified.",
    status: "planned",
    check: { label: "A colony's certification results, with what was left out", command: "npx fire_trident certify shortlinks" },
  },
  {
    id: "culprit-coverage",
    group: "colony",
    cannot: "Tell from a red result whether culprit finding looked at everything.",
    why: "Suspects come from at most 10 failing test files and 32 of the files each one loads, and a lookup that fails or takes more than 3 s leaves a red result with no suspects, which reads the same as one that found none. No answer says that its record was incomplete.",
    instead: "Treat suspects as leads: the first red commit search (FT_BISECT) runs the failing tests at earlier commits, names the first that fails, and says when it ends inconclusive. Read a suspect's change before you revert it.",
    status: "planned",
    check: { label: "Watch the first red commit search", href: "/c/first-red?tour=1" },
  },
  {
    id: "cross-file",
    group: "colony",
    cannot: "Catch two changes to different files that are wrong together.",
    why: "Conflicts are found per file: a change goes back when a file it read or wrote changed under it. Two changes to different files, neither reading the other's, both land.",
    instead: "Certification catches them when the tests cover them. The deletion and export guards (FT_DELETION_GUARD, FT_EXPORT_GUARD) catch a removed file or export that another file still imports.",
    status: "planned",
    check: { label: "See a read catch what git merges", href: "/#try-gitmerge" },
  },
  {
    id: "read-ahead",
    group: "colony",
    cannot: "Send back a change because a file it only read is rewritten just after it lands.",
    why: "A change is checked against the files it read when it lands. One that only read a file can land in the same cycle just ahead of the change that rewrites that file: it was valid on the trunk it read, and nothing sends it back afterwards.",
    instead: "Certification runs the project's tests on the trunk that holds both changes, so deploy from certified. Before changing a file others build on, ft impact lists the files that import it and who works on them now.",
    status: "planned",
    check: { label: "What a change to a file reaches", command: "npx fire_trident impact hono src/hono-base.ts" },
  },
  {
    id: "split-attack",
    group: "colony",
    cannot: "Catch an attack split across several harmless-looking changes.",
    why: "Review looks at one change at a time.",
    instead: "Protect the paths that matter: a change that writes, deletes or renames a protected path goes to a person whatever its intent says. Changes that touch authentication or secrets go to a person by deterministic patterns.",
    status: "unscheduled",
    check: { label: "Protect a path (admin token)", command: 'ft policy <colony> --protect "src/auth/**"' },
  },
  {
    id: "comment-only",
    group: "colony",
    cannot: "Have a person or a model read a comment-only change, or fence an intent's text as data.",
    why: "A change that only edits comments or whitespace in existing script files lands on a deterministic proof that no model or person reads, so its text reaches the next agent that reads the file unreviewed. An intent's title and why are the agent's instructions, so they cannot be fenced as data the way repository files are.",
    instead: "Turn the comment-only proof off for a colony to send those changes through review, and keep the intents agents follow to people and rules: the chain gate (FT_INTENT_CHAIN_GATE) holds a chain of agent-declared intents for a person.",
    status: "planned",
    check: { label: "Turn the comment-only proof off (admin token)", command: "ft policy <colony> --comment-proof off" },
  },
  {
    id: "raw-approvals",
    group: "colony",
    cannot: "Have earned autonomy and detector probation learn from how approvals turned out.",
    why: "Every landing a deterministic proof, a second opinion or a person approved counts toward its region's autonomy, and every approval of a flagged change counts against the detector that flagged it, even when that landing later turns certification red or is reverted. Only a rejection or an escalation revokes autonomy.",
    instead: "Raise autonomyAfter in the colony's decide policy (up to 1,000) to keep the reflex from landing alone, and read which regions earned autonomy, and what revoked it, in ft immune.",
    status: "planned",
    check: { label: "Earned autonomy per region", command: "npx fire_trident immune hono" },
  },
  {
    id: "text-merge",
    group: "colony",
    cannot: "Have anyone read a text-merged file as a whole before it lands.",
    why: "Text merge lands edits to different lines of one file without review of the merged result, so two edits that merge cleanly but break each other land.",
    instead: "Certification is the backstop. A change a person approved, one with a danger pattern, or one on a protected path never lands merged on its own: the merge goes back to a person with both diffs.",
    status: "unscheduled",
    check: { label: "Run the text merge in your browser", href: "/#try-merge" },
  },
  {
    id: "scale",
    group: "colony",
    cannot: "Grow one colony's throughput past about 1,000 concurrent agents.",
    why: "The single trunk writer, then the colony object that answers every take and proposal, is the limit: inline changes reached 3,842 landings a minute at 5,000 synthetic agents, and a colony with a long history answered some calls as overloaded.",
    instead: "Run up to about 1,000 agents in one colony, with inline changes on (FT_INLINE): they doubled throughput at 5,000 agents.",
    status: "planned",
    check: { label: "Replay 2,000 agents landing 6,606 changes", href: "/c/scale?replay=1&t=32&speed=4" },
  },
  {
    id: "namespaces",
    group: "colony",
    cannot: "Count on several busy colonies scaling together on one deployment.",
    why: "Colonies have their own Durable Objects but share the Artifacts namespaces, whose control-plane calls are limited per namespace. Several colonies working at once have not been measured.",
    instead: "Workspaces are already spread over four namespaces. Give a busy colony its own deployment until several at once are measured.",
    status: "cloudflare",
    check: { label: "Every colony on the site, with live counters", command: "npx fire_trident colonies" },
  },
  {
    id: "model-rate",
    group: "colony",
    cannot: "Run hundreds of model-driven agents at full speed.",
    why: "Workers AI allows about 300 requests a minute per model on this account (20 for some larger models), which binds long before the colony does.",
    instead: "Bring your own agents over MCP, each with its own model, and load-test a colony with synthetic agents, which make no model calls.",
    status: "cloudflare",
    check: { label: "Start synthetic agents (admin token)", command: "ft swarm <colony> --agents 2000 --kind synthetic" },
  },
  {
    id: "model-contention",
    group: "colony",
    cannot: "Point to a model-driven run in which many changes came back stale at landing.",
    why: "In the one model-driven run built to contend, sixteen intents on one module, fourteen landed, one change came back for a merge conflict and none stale; on the Hono rule each intent edits its own file, and contest mode picks one change before any lands. Contention at landing in volume was measured with synthetic or scripted agents the script placed (the cascade, import-name revalidation, text merge, goal conflicts) and in the simulator.",
    instead: "Read each headline run's models, review setting and overlap in docs/results.md before comparing numbers, and measure a colony's own code sharing and returns with scripts/coordination.rb.",
    status: "planned",
    check: { label: "A run's code sharing and returns, from its public record", command: `ruby scripts/coordination.rb --url ${SITE} --colony hono` },
  },
  {
    id: "waiting",
    group: "colony",
    cannot: "Know how long agents wait to land on tasks that take hours.",
    why: "On the round-7 Hono run agents spent 61% of claim-to-landing time waiting to land, at a median of 2.3 s, but every measured task took seconds to minutes; waiting on tasks that take hours has not been measured.",
    instead: "Measure your own colony: scripts/coordination.rb splits the time to each landing into agent work, review, waiting to land and rework, from the public record.",
    status: "unscheduled",
    check: { label: "Where a run's time went", command: `ruby scripts/coordination.rb --url ${SITE} --colony hono` },
  },
  {
    id: "notes",
    group: "colony",
    cannot: "Prove a lineage note was not rewritten together with its commit.",
    why: "Notes are tamper-evident, not tamper-proof: the FT-Note trailer binds a note to its commit, so a commit and its note rewritten together in a copy still check intact.",
    instead: "Check against the colony's own trunk, and check signatures against the key the deployment publishes at /.well-known/firetrident-keys.json.",
    status: "unscheduled",
    check: { label: "Read the newest note with stock git", command: NOTES_COMMAND },
  },
  {
    id: "event-record",
    group: "colony",
    cannot: "Replay a colony's whole history from its event record.",
    why: "The record keeps a colony's newest 100,000 events and prunes the oldest, and a batch of events whose write fails is logged and lost.",
    instead: "Every landing stays in the trunk's git history with its lineage note: clone the trunk and read the notes for anything the record no longer holds.",
    status: "planned",
    check: { label: "Read the newest note with stock git", command: NOTES_COMMAND },
  },
  {
    id: "held-claims",
    group: "colony",
    cannot: "Count on the colony taking work back from an agent that keeps calling tools without working.",
    why: "Every tool call renews the agent's claims, so it holds its intent however little it does; only ten minutes of silence takes the intent back. The stuck-work detector reports an intent held for 10 minutes with no change, but it only reports.",
    instead: "Read the stuck list in ft status or on the needs-you strip, then stop the agent with ft stop (admin token), which releases its claims.",
    status: "planned",
    check: { label: "A colony's status, stuck work included", command: "npx fire_trident status hono" },
  },
  {
    id: "agent-text",
    group: "colony",
    cannot: "Keep agents from passing messages to each other through the text they write.",
    why: "Intent whys and lessons reach other agents, labeled as data with their author and model. That is a channel through which agents could coordinate among themselves, and nothing reads it for that.",
    instead: "Leave the field guide off where a colony does not need it (FT_FIELD_GUIDE), reject lessons you do not want in ft guide, and turn the chain gate on (FT_INTENT_CHAIN_GATE) so a chain of agent-declared intents waits for a person.",
    status: "unscheduled",
    check: { label: "A colony's field guide (admin token to decide)", command: "ft guide <colony>" },
  },
];

/** One thing building on Artifacts taught us (spike/RESULTS.md), and what the code does about it. */
export interface Lesson {
  id: string;
  title: string;
  finding: string;
  workaround: string;
}

/** What Artifacts taught us, from the spike's measurements and the design facts it settled. */
export const ARTIFACTS_LESSONS: readonly Lesson[] = [
  {
    id: "fork-after-push",
    title: "Forks right after a push can fail",
    finding: "A fork made right after a push to its source failed 2 times in 10 with an internal error, and left no repository behind. 18 s later, none failed.",
    workaround: "Workspaces fork from a seed at least 2 s after its last push, and a fork that fails is retried after 0.5, 1, 2 and 4 s under the same name.",
  },
  {
    id: "compare-and-swap",
    title: "Pushes compare and swap, but do not protect main",
    finding: 'A push with a stale old value is refused ("stale ref"), but the server does not enforce fast-forward: a forced push was accepted and dropped a commit from main.',
    workaround: "Only the trunk writer holds a trunk write token, and it pushes with the expected old value: a lost race is reported, never a lost commit.",
  },
  {
    id: "no-hooks",
    title: "No server-side hooks",
    finding: "There is no server-side hook, merge or branch protection, no atomic push of several refs and no push options; the push trigger starts a Workflow about 2.3 s after the push (median).",
    workaround: "Every check runs before the trunk writer pushes. A landing is two ref updates, trunk then notes, so the writer journals each landing and pushes a missing note again; the FT-* trailers land atomically with the code.",
  },
  {
    id: "per-namespace",
    title: "Limits per namespace",
    finding: "Git requests are limited per repository and control-plane calls per namespace, so one namespace of workspaces would cap how fast a colony can fork.",
    workaround: "Workspaces are sharded by number over four namespaces (ft-ws-0 to ft-ws-3), so a burst of forks for one colony draws on four limits, not one.",
  },
];
