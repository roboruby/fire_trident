# Changelog

Notable changes to FireTrident, newest first, in the style of Keep a Changelog. The version at the top has no date until it is released.

## 0.0.2

### Added

- A staging deployment with its own Worker, Durable Objects, Artifacts namespaces, workflows and dataset.
- Offline playback: a recorded run answers every read the replay makes, with no network, and the site carries recordings of the demo runs.
- A pause switch with a reason, per colony or for the whole deployment.
- A spend cap per colony, with a reserve for review.
- Hedged model calls (`FT_HEDGE`).
- Returns quote what beat them (`FT_RETURN_HUNKS`).
- Every landing names who is answerable for it, or says that no person is and why.
- A full-trunk check from a stock clone, and colonies pinned by their root commit.
- Stock git signatures on trunk commits, a key ring for rotated keys, and credit trailers (`FT_CREDIT_TRAILERS`).
- Review receipts in every lineage note, approvers verified behind Cloudflare Access, and people as commit authors.
- Field-guide lessons scoped to the files they came from (`FT_LESSON_SCOPE`).
- Connect your agent: each client's setup from one source, a `/connect` page, `ft connect` and `ft connect --install`, a SKILL.md per colony, and a git push refusal that says how a change reaches trunk.
- A heads-up on every MCP reply (`FT_HEADS_UP`), and `ft hook install`.
- On every change: a test-delta row, a lifecycle strip, and its tests run at its base before a person reviews it.
- A closure ledger for held intents, with a silence limit per colony.
- How a colony decides: the gate's settings as one of four presets, and the rule that confirmed each landing.
- `ft why` says whether each landing still holds, skips formatting-only landings and follows code moved from another file.
- Culprit isolation inside the first red landing, with a revert probe.
- Recipe landings, deterministic transforms a person declares, and review by reproduction (`FT_REPRODUCE`).
- `ft census`: credits the commits of any clone to agents, bots or people, offline.
- Escalations past a budget batched by reason (`FT_ESCALATION_BATCH`).
- A change waiting for a person holds no claims, and its agent takes other work (`FT_PERSON_WAIT`).
- A change already on trunk closes as already on trunk instead of landing an empty commit (`FT_ALREADY_ON_TRUNK`).
- Review from a chat client: an admin-only MCP endpoint with views, where only a person's click decides.
- GitHub issues imported as intents.
- Trunk health figures, an audit sample of landings no person saw, a baseline stream in the review queue, and blind canaries.
- A sandboxed preview route that serves trunk files at any landing.
- New measures in the coordination report, a historical overlap replay, and a contention test with real-model agents.
- Demo scripts: the two-agent text-merge beat, a read-only path from a fresh clone, a tamper beat, a mosaic colony, recipe scenes and a comparison with git's own merge.
- CI, a lint, CONTRIBUTING.md, this changelog and a check on commit subjects.

### Changed

- Earned autonomy and deterministic proofs never land a destructive change alone: a deleted or renamed file, a removed export or a large removal goes to the second opinion.
- An agent's intent takes at most the priority of a parent it holds or declared.
- Culprit suspects keep the first landing since green beside the newest two.
- A second opinion comes from a model family other than the author's, or a person decides.
- A colony opens on its target and its distance to it, and the site has a limits page.
- A test module that does not compile fails only the test files that load it.
- The danger scan no longer counts a SQL statement as running a program.

### Fixed

- A missing `needs_human` reads as 1, and a `propose` sent again is idempotent in flight and over MCP.
- Tokens compare equal when the configured value ends in a newline.
- The published CLI carries every module it imports.
- The spend cap says on resume when the next call would trip it again.
- `ft verify` and the note verifier print the same answerable line.
- A heads-up that cannot be computed says so, and a malformed model answer is asked again.

### Security

- Security headers on every response, `no-store` on JSON, and a report-only content security policy.
- Files other tools run or obey always reach a person, matched case-folded and NFC-normalized; the trunk writer refuses symlink retargets, case-colliding paths and changes to submodules.
- Merge locks: a change a person approved, one a person must see or one that writes a protected path never lands merged with a newer trunk on its own.
- Direction fences and protected paths fail closed, and previews are served over https only.
- Every `art_v<n>_` token is masked.
- `ft` reaches a deployment behind Cloudflare Access, and `ft connect --install` keeps the token out of the command line.
- An intent imported from a GitHub issue counts as an agent's request at every gate.

## 0.0.1 - 2026-10-15

The version submitted.

### Added

- Colonies: a trunk repository in Artifacts and the field around it. Agents read decaying signals (claims, needs, trails, failures, danger) and choose their own work, with no queue and no manager.
- Landing: lanes per region validate every file a change read; one trunk writer folds up to 200 proposals into a cycle and pushes with compare-and-swap. Text merge, import-name revalidation, contest mode and a cascade detector.
- Review: deterministic proof first, then decision models, a second model from another family and a person, each only when the cheaper layer is unsure. Antibodies from rejections, earned autonomy and protected paths.
- Lineage: a JSON note under `refs/notes/firetrident` on every landed commit, sealed by its digest in the `FT-Note` trailer and signed with a published key; `ft verify` and `scripts/verify_note.mjs` check it from a stock clone.
- Trunk certification: the project's tests run after landing in a Dynamic Worker with no network; green moves the `certified` branch, red becomes a repair intent with named suspects and an optional search for the first red commit.
- Target morphology: architecture rules and tests become needs, and `ft new` grows a project from a spec.
- Bring your own agent over MCP, read-only public endpoints for showcase colonies, and plain git access.
- `ft revert` for a landing or one proposal of it, changes of direction, stuck-work reports and per-colony pricing of model calls.
- The `ft` CLI, the web UI with the colony map, replay and review, the benchmark package and the demo scripts.
