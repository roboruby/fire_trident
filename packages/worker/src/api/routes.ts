import { spawnSwarm } from "../agents/swarm.ts";
import { provisionTrunk } from "../artifacts/colony.ts";
import { createApi } from "./app.ts";

/**
 * REST API, owned by stream S2 and mounted at /api by index.ts. Route table
 * (see docs/ARCHITECTURE.md and createApi in app.ts):
 *   POST /api/colonies                      create/import a colony
 *   GET  /api/colonies/:id                  ColonySnapshot
 *   GET  /api/colonies/:id/live             WebSocket of ColonyEvent
 *   GET  /api/colonies/:id/field            FieldReading[] (all regions) or ?region=
 *   POST /api/colonies/:id/intents          declare an intent
 *   POST /api/colonies/:id/rules            add a morphology rule (creates needs)
 *   POST /api/colonies/:id/agents           register an agent
 *   POST /api/colonies/:id/agents/:aid/take self-assign work + workspace lease
 *   POST /api/colonies/:id/agents/:aid/heartbeat
 *   POST /api/colonies/:id/proposals        propose a change
 *   GET  /api/colonies/:id/proposals/:pid   one proposal (poll its outcome)
 *   GET  /api/colonies/:id/why              ?path=&line=
 *   GET  /api/colonies/:id/review           review queue
 *   POST /api/colonies/:id/review/:pid      approve | reject | return
 *   POST /api/colonies/:id/swarm            spawn in-platform agents
 */
export const api = createApi({ provisionTrunk, spawnSwarm });
