# Glossary

The code, the API and the CLI name FireTrident's parts after natural systems that coordinate through shared signals (ant colonies, immune systems). The docs use plain terms first; this page maps each name to what it is and where it lives. Paths are under `packages/`.

## Coordination

| Name in the code | What it is | Where |
| --- | --- | --- |
| Colony | One repository under coordination: its trunk repository in Artifacts plus the coordination state around it. The API and CLI call it a colony (`/api/colonies/:id`, `ft status <colony>`). | `worker/src/colony/ColonyDO.ts` |
| Field | The coordination state agents read instead of messaging each other: fading marks on the files and regions of the code. | `core/src/field.ts`, `worker/src/region/RegionDO.ts` |
| Mark | One signal in the field, of five kinds, each fading with its own time constant. | `core/src/field.ts` (`TAU_MS`) |
| Claim | A claim lease: the mark an agent holds on its intent's files while it works. It fades over minutes unless the agent's calls renew it. | `core/src/field.ts` |
| Need | An open intent's pull on agents: its priority, growing with age. It never fades; it ends when the intent is met. | `core/src/field.ts`, `core/src/threshold.ts` |
| Trail | A mark left on the files a landing changed, kept for reading (`sense`, the map, replays), not for choosing work. | `core/src/field.ts` |
| Failure, danger | A failure mark is left on an intent's files when its agent gave the intent up, went silent or was stopped, or review or a person sent its change back; it is for reading. Danger marks push takes away from their files. | `core/src/field.ts` |
| Lateral inhibition | The claim-lease exclusion at take: an intent whose files carry other agents' live claims above half a fresh claim is passed over. The name also covers path-disjoint batching in the lanes. | `core/src/threshold.ts` (`LATERAL_INHIBITION`), `core/src/batch.ts`, `FT_LATERAL_INHIBITION` |
| Response threshold | How an agent chooses among open intents: the stronger an intent's pull against the agent's threshold for its region, the likelier the take; each landing lowers that threshold. | `core/src/threshold.ts` |
| Hebbian co-change map | The co-change map: which files change together in the trunk's history, used to steer takes away from files that move with ones others hold. | `core/src/cochange.ts`, `worker/src/trunk/cochange.ts`, `FT_COCHANGE_WEIGHT` |
| Admission | A region's cap on working agents, which grows with how fast the region lands work. | `core/src/threshold.ts` (`admissionOpen`), `RegionDO.admit` |
| Swarm | A set of in-platform agents released on a colony (`ft swarm`, `POST /api/colonies/:id/swarm`). | `worker/src/agents/` |
| Target morphology | The target state people declare: architecture rules plus tests. Every rule violation becomes an open intent. | `core/src/morph.ts`, `worker/src/morph/scan.ts`, `ft rule` |
| Chemotaxis | A change of direction: a person withdraws or amends an intent, retracts a rule, or sends a directive to the agent working on it. | `worker/src/colony/direction.ts`, `worker/src/trunk/direction.ts` |
| Cascade, branching ratio (σ) | The stale-return cascade detector: how many returns each return causes; above 1, a region is slowed down. | `core/src/sigma.ts` |
| Megafile | A shared file that grew fast while many agents wrote it: the colony holds it and declares an intent to split it. | `core/src/hotness.ts`, `worker/src/colony/megafile.ts`, `FT_MEGAFILE` |
| Field guide | Lessons: one-line lessons agents leave with a change, shown to later agents once the change certifies green or a person approves it. | `worker/src/colony/guide.ts`, `FT_FIELD_GUIDE` |
| Census | `ft census`: credits commits and lines in any git clone to agents, bots or people, offline. | `cli/src/census.ts` |

## Review

| Name in the code | What it is | Where |
| --- | --- | --- |
| Reflex arc | The review pipeline: deterministic checks, then the Clef decision models, then a second model from another family, then a person, each only when the cheaper layer is unsure. | `worker/src/decide/engine.ts`, `worker/src/decide/gate.ts` |
| Reflex | The first model layer of review: the Clef decision models' typed questions. | `worker/src/decide/reflex.ts` |
| Innate checks | The deterministic checks every proposal gets when it is proposed, before review. | `worker/src/colony/innate.ts` |
| Antibody | A persisted rejection rule: a check minted from a person's rejection that no earlier rule caught, committed to the repository under `.firetrident/antibodies/`, and asked of every later change it matches. | `worker/src/decide/antibodies.ts`, `DecideEngine.mintAntibody` |
| Vaccination meter, vaccinate | Seeded negative cases: sealed known-bad changes of named threat classes sent through review to measure where it routes them. They can never land. | `worker/src/decide/vaccine.ts`, `worker/src/api/vaccinate.ts`, `ft vaccinate` |
| Blind canaries | Seeded known-bad changes mixed into the human review queue to measure what reviewers catch; off by default. | `worker/src/decide/canary.ts`, policy `canaryRate` |
| Immune report, `ft immune` | Review standing per region: which regions have earned autonomy, the persisted rejection rules, the detectors and the alert budget. | `cli/src/immune.ts`, `GET /api/colonies/:id/immune` |
| Earned autonomy | A region where enough changes landed approved by a proof, a second opinion or a person that the first model layer may land a change alone. | `worker/src/decide/gate.ts`, policy `autonomyAfter` |
| Probation | Detector demotion: a detector overruled too often becomes advisory, then off. | `worker/src/decide/policy.ts` (`probation`) |

## Landing and after

These names are plain already; they are listed so the docs and the code read the same.

| Name in the code | What it is | Where |
| --- | --- | --- |
| Intent | One piece of work: what should change and why, with the files it expects to touch (its footprint). | `core/src/types.ts` |
| Proposal | An intent's change: its files written and read, with the blob of each, and its evidence. | `core/src/types.ts` |
| Lane | A region's queue of changes waiting to land, batched path-disjoint. | `worker/src/region/RegionDO.ts`, `core/src/batch.ts` |
| Trunk writer | The single serialized writer of trunk: it commits each lane batch and pushes trunk with compare-and-swap. | `worker/src/trunk/TrunkDO.ts` |
| Certification | Testing after landing: the project's own tests on trunk in a sealed Dynamic Worker; a passing commit moves `certified`. | `worker/src/certify/certifier.ts` |
| Culprits, suspects | The landings since the last green commit that changed what a failing test loads. | `worker/src/certify/culprit.ts` |
| First red commit | The bisect over the landings since green that finds the first commit the failing tests fail on. | `worker/src/certify/bisect.ts` |
| Lineage note | The JSON note on each landed commit under `refs/notes/firetrident`, sealed by its SHA-256 in the `FT-Note` trailer. | `worker/src/trunk/landing-note.ts`, `worker/src/trunk/digest.ts` |
