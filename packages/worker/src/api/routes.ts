import { spawnSwarm } from "../agents/swarm.ts";
import { provisionTrunk } from "../artifacts/colony.ts";
import { createApi } from "./app.ts";

/**
 * REST API, mounted at /api by index.ts. Route table (see docs/ARCHITECTURE.md
 * and createApi in app.ts):
 *   GET    /api/colonies                      every colony with live counters
 *   POST   /api/colonies                      create/import a colony
 *   GET    /api/colonies/:id                  ColonySnapshot (+ series)
 *   DELETE /api/colonies/:id                  delete a colony (admin token required)
 *   GET    /api/colonies/:id/live             WebSocket of ColonyEvent
 *   GET    /api/colonies/:id/field            FieldReading[] (all regions) or ?region=
 *   GET    /api/colonies/:id/metrics          metrics, funnel, violations, series, spend (the model calls this platform made)
 *   GET    /api/colonies/:id/events           the event record for replays (?after=<seq>&limit=<n>)
 *   POST   /api/colonies/:id/intents          declare an intent
 *   GET    /api/colonies/:id/intents/:iid     one intent with its revisions and directives (and its model spend)
 *   GET    /api/colonies/:id/intents/:iid/spend  what the intent's model calls cost (FT_INTENT_SPEND)
 *   GET    /api/colonies/:id/intents/:iid/lifecycle  the intent's lifecycle strip, declared to merged by a person
 *   PATCH  /api/colonies/:id/intents/:iid     amend an intent (revision + 1)
 *   POST   /api/colonies/:id/intents/:iid/withdraw  withdraw an intent
 *   POST   /api/colonies/:id/rules            add a morphology rule (creates needs)
 *   DELETE /api/colonies/:id/rules/:rid       retract a rule (its unlanded intents withdrawn)
 *   GET    /api/colonies/:id/agents           list agents (state, intent, model, journal step)
 *   POST   /api/colonies/:id/agents           register an agent
 *   POST   /api/colonies/:id/agents/:aid/take self-assign work + workspace lease
 *   POST   /api/colonies/:id/agents/:aid/heartbeat
 *   POST   /api/colonies/:id/agents/:aid/stop stop one agent
 *   POST   /api/colonies/:id/agents/:aid/directive  send an agent free-text guidance
 *   POST   /api/colonies/:id/agents/:aid/status     an agent relays what it is doing now
 *   GET    /api/colonies/:id/agents/:aid/inbox      an agent's proposals and directives
 *   POST   /api/colonies/:id/proposals        propose a change
 *   GET    /api/colonies/:id/proposals/:pid   one proposal (poll its outcome)
 *   GET    /api/colonies/:id/why              ?path=&line=
 *   GET    /api/colonies/:id/review           review queue
 *   POST   /api/colonies/:id/review/:pid      approve | reject | return
 *   POST   /api/colonies/:id/swarm            spawn in-platform agents
 *   POST   /api/colonies/:id/swarm/stop       stop every running in-platform agent
 *   GET    /api/colonies/:id/spend-cap        the spend cap; POST { usd, reviewReserveUsd? } sets it, { usd: null } removes it
 */
export const api = createApi({ provisionTrunk, spawnSwarm });
