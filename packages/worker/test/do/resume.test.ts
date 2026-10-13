import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyDO } from "../../src/colony/ColonyDO.ts";
import { newResumeKey, resumeDigest } from "../../src/mcp/resume.ts";
import { addAgent, api, colony, newColony } from "./helpers.ts";

/**
 * External agents that join over MCP get a resume key: the colony keeps only its SHA-256 digest,
 * and another session acts as the agent again only with the key (agent ids are public).
 */

/** Every row of every table of the colony's storage, as JSON (the platform's own tables only). */
async function storageText(colonyId: string): Promise<string> {
  return runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) => {
    const sql = state.storage.sql;
    const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name);
    return JSON.stringify(tables.filter((t) => !t.startsWith("_cf") && !t.startsWith("sqlite_")).map((t) => sql.exec(`SELECT * FROM "${t}"`).toArray()));
  });
}

describe("resume keys of external agents", () => {
  it("keep only the key's digest, and resume the agent with that key alone", async () => {
    const c = await newColony();
    const key = newResumeKey();
    const agent = await colony(c.id).registerAgent({ kind: "external", name: "laptop", resumeKey: key });
    expect(agent).toMatchObject({ kind: "external", name: "laptop" });
    const rows = await runInDurableObject(colony(c.id), (_instance: unknown, state: DurableObjectState) => state.storage.sql.exec("SELECT agent_id, digest FROM agent_keys").toArray());
    expect(rows).toEqual([{ agent_id: agent.id, digest: await resumeDigest(key) }]);
    expect(await storageText(c.id)).not.toContain(key);

    expect(await colony(c.id).resumeAgent(agent.id, key)).toMatchObject({ agent: { id: agent.id, kind: "external", name: "laptop" } });
    expect(await colony(c.id).resumeAgent(agent.id, newResumeKey())).toEqual({ refused: "wrong-key" });
    expect(await colony(c.id).resumeAgent(agent.id, await resumeDigest(key))).toEqual({ refused: "wrong-key" });
    expect(await colony(c.id).resumeAgent(agent.id, "")).toEqual({ refused: "wrong-key" });
    expect(await colony(c.id).resumeAgent("agt_nobody", key)).toEqual({ refused: "unknown" });
  });

  it("refuse agents registered without a key (before resume keys, or through the REST API) and in-platform agents", async () => {
    const c = await newColony();
    const rest = await api<{ id: string }>("POST", `/colonies/${c.id}/agents`, { name: "via-rest", kind: "external" });
    expect(rest.status).toBe(201);
    expect(await colony(c.id).resumeAgent(rest.body.id, newResumeKey())).toEqual({ refused: "no-key" });
    const synthetic = await addAgent(c.id);
    expect(await colony(c.id).resumeAgent(synthetic.id, newResumeKey())).toEqual({ refused: "unknown" });
    // Called on the instance: a refusal over RPC would also surface as an unhandled rejection in the runner.
    await runInDurableObject(colony(c.id), async (instance: ColonyDO) => {
      await expect(instance.registerAgent({ kind: "synthetic", name: "bot", resumeKey: newResumeKey() })).rejects.toThrow(/only external agents have resume keys/);
      await expect(instance.registerAgent({ kind: "external", name: "weak", resumeKey: "short" })).rejects.toThrow(/invalid resume key/);
      await expect(instance.registerAgent({ kind: "external", name: "huge", resumeKey: "k".repeat(201) })).rejects.toThrow(/invalid resume key/);
    });
    expect(JSON.stringify((await api("GET", `/colonies/${c.id}/agents?all=1`)).body)).not.toMatch(/"bot"|"weak"|"huge"/);
  });

  it("never show the key or its digest in the snapshot, the agent listing or an agent's own record", async () => {
    const c = await newColony();
    const key = newResumeKey();
    const digest = await resumeDigest(key);
    const agent = await colony(c.id).registerAgent({ kind: "external", name: "laptop", resumeKey: key });
    for (const path of [`/colonies/${c.id}`, `/colonies/${c.id}/agents?all=1`, `/colonies/${c.id}/events?source=recorded`]) {
      const res = await api("GET", path);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(key);
      expect(text).not.toContain(digest);
    }
    expect(JSON.stringify(await api("GET", `/colonies/${c.id}/agents?all=1`))).toContain(agent.id);
    const own = JSON.stringify(await colony(c.id).getAgent(agent.id));
    expect(own).toContain(agent.id);
    expect(own).not.toContain(digest);
  });
});
