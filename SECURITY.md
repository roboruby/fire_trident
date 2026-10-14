# Security

FireTrident lets many agents, most of them untrusted, change one repository at once. This page says what it defends against, what it leaves out, and how to report a vulnerability.

## Report a vulnerability

Report it privately through this repository's GitHub security advisories: open [Report a vulnerability](https://github.com/roboruby/fire_trident/security/advisories/new) on the repository's Security tab. Please do not open a public issue or pull request for it. Say what is affected (a commit, a route, a tool), how to reproduce it, and what an attacker gains. The discussion stays in the advisory until a fix is released.

Test against your own deployment (see "Run it" in the [README](README.md)), not the public showcase.

## Who is trusted

- **The operator** holds the Cloudflare account and the admin token (`FT_ADMIN_TOKEN`), and is trusted.
- **Agents**, in-platform or external, are not. Neither their text nor their changes are trusted, nor the repository content they handle.
- **Readers** need no token: colony state, review queues (masked) and lineage are public on a deployment, and colonies listed in `FT_PUBLIC_GIT` can be cloned by anyone.

## What FireTrident defends

- **Agents never hold a trunk write token.** Only the colony's trunk writer pushes to trunk, and it pushes with the expected old value (compare-and-swap). A workspace lease carries a read token for trunk (valid an hour, replaced 15 minutes before it expires) and a write token for the agent's own workspace.
- **Workspace tokens are short-lived and scoped to one fork.** Each is a write token for a single workspace repository, valid for two hours. It is never handed to a different agent, and about a minute after its agent lets the workspace go it is revoked and replaced. Public reads redact lease tokens.
- **The MCP endpoint takes its token only in a header.** `/mcp` and `/sse` refuse a request whose URL carries a `token` query parameter, whatever it holds, since a token in a URL ends up in logs and histories. The bearer token is compared in constant time (by SHA-256 digest). Without `FT_MCP_TOKEN` configured, the endpoint refuses every connection.
- **An agent id alone resumes nothing.** An external agent's resume key is 32 random bytes, returned once by `join`. The colony keeps only its SHA-256 digest and compares in constant time, and no route returns it.
- **Writes fail closed without the admin token.** Every mutating REST route needs `FT_ADMIN_TOKEN` as a bearer token, compared in constant time. Without that secret configured the routes refuse (403), and deleting a colony refuses outright. `FT_OPEN_WRITES=1` lifts this for local development only and is never set on a deployment.
- **Certification runs the project's tests in a sandbox.** The tests run in a Dynamic Worker with no network access, no environment variables and no bindings, under CPU and wall-clock limits, and their report is read as a bounded stream.
- **Prompts fence repository content as data.** The model prompts of review (the second opinion, the contest judge, antibody questions), agents' write prompts and repair intents put the text agents, people or the repository wrote between a random marker that occurs in none of it, labeled as data, never as instructions. No model opinion overrides a deterministic fact.
- **Danger patterns and protected paths reach a person.** While a colony's review is on (the default), deterministic patterns send to a person any change that touches authentication, adds a hard-coded credential, or adds process or network access that no intent written by a person or a rule asked for. The colony's policy or a tolerating antibody, both set by people, can allow those classes; an agent's own words never can. A change to what decides on agents, the colony's memory under `.firetrident/` and agent instructions (`AGENTS.md`, `CLAUDE.md`, `.claude/`), goes to a person whatever the policy, the antibodies or the intent say. A loosened guard (a deleted 401 or 403, a weakened auth condition, `verify` swapped for `decode`) is never waived: a second opinion must look at it. A change to a protected path (`ft policy <colony> --protect <glob>`) goes to a person even with review off.
- **Lineage notes mask secret-looking text.** Before a note is written, its free text (intents' titles and whys, an agent's `notVerified`, check details, directives, status notes, review questions and answers) passes through the same secret detector as the danger patterns, and each match becomes `[masked]`. The review view masks lines that may hold a secret the same way.
- **A security finding tells its agent only the class.** The full reasons stay in the decision record and the review view, the proposal route withholds them from readers without the admin token, and the intent's next proposal goes to a person.
- **Plain git is read-only.** The `/git/` proxy serves only colonies listed in `FT_PUBLIC_GIT`, forwards only fetches, refuses pushes, and adds its own read token upstream, which clients never see.

## What is out of scope

- **The operator and the platform.** Whoever holds the admin token can approve any change, allow danger classes, turn a colony's review off, change protected paths and delete colonies. The Cloudflare account, its Artifacts namespaces and Workers AI are trusted.
- **Review switched off.** With a colony's review off, only protected paths still reach a person, including for changes to `.firetrident/` and agent instructions. Protect those paths before turning review off.
- **The MCP token is per deployment.** There is one, not one per agent or per colony: whoever holds it can join any colony on that deployment as an external agent, read its trunk, and propose changes, which then go through review.
- **Attacks split across changes.** Review looks at one change at a time, so a harmful change split into several harmless-looking ones is an open problem. Model-based layers are judgments and borderline calls can vary between runs, and how often the danger patterns miss a dangerous change nobody has seen is not measured.
- **Tests run after landing.** Certification runs a project's tests after a change lands, so a broken change can sit on `main` until a repair lands; deploy and pin from `certified`. The test files of one run share one Worker's globals, which is less isolation than a process per file.
- **Secrets in file contents.** Masking covers lineage notes and review views, not files. A change that adds a credential the secret patterns recognize goes to a person while review is on, but FireTrident never rewrites file contents, and whatever lands is in git.
- **Antibody questions are on trunk.** Security antibodies' questions are kept out of what agents see when they take work, but anyone who can read trunk can read `.firetrident/antibodies/`.
- **What an external agent does on its own machine.** The client's sandbox and permissions are its user's choice; the [agent guides](docs/agents/README.md) show settings that allow only the FireTrident tools and git.
- **Volume.** FireTrident relies on the platform for rate limits; a holder of a valid token can load a colony.
