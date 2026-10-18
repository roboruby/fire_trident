import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyDO } from "../../src/colony/ColonyDO.ts";
import { addAgent, addIntent, api, colony, fakeSha, newColony, take } from "./helpers.ts";

/**
 * Paths with control characters at intake (api/pathchars.ts): the API refuses them in its path fields, and the colony
 * refuses a change naming one however it arrived (here on the object itself, as MCP and in-platform agents call it), with a plain sentence; a change with ordinary paths is taken as before.
 */

describe("a change whose path holds a control character", () => {
  it("is refused at the API and at the colony's intake, naming the path", async () => {
    const c = await newColony();
    const agent = await addAgent(c.id);
    await addIntent(c.id, ["src/a.ts"]);
    const a = await take(c.id, agent.id);
    const body = (path: string) => ({
      intentId: a.intent.id,
      agentId: agent.id,
      workspace: a.lease.repo,
      baseSha: a.lease.baseSha,
      headSha: fakeSha(),
      writeSet: [{ path, blob: fakeSha() }],
      readSet: [],
      declared: { footprint: a.intent.footprint, summary: "edit" },
    });
    const res = await api<{ error: string }>("POST", `/colonies/${c.id}/proposals`, body("src/a\nb.ts"));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "invalid request: writeSet.0.path: a path cannot hold a control character (a newline, a tab, NUL, or another character below U+0020 or U+007F): rename the file without it, then send the request again",
    );
    // Called on the object itself, as MCP and the in-platform agents reach it.
    await runInDurableObject(colony(c.id), async (instance: ColonyDO) => {
      await expect(instance.propose({ colonyId: c.id, ...body("src/a\tb.ts"), evidence: {} } as never)).rejects.toThrow(
        '[ft:400] the path "src/a\\tb.ts" holds a control character (a newline, a tab, NUL, or another character below U+0020 or U+007F): rename the file without it, then propose again',
      );
    });
    const ok = await api<{ id: string; status: string }>("POST", `/colonies/${c.id}/proposals`, body("src/a.ts"));
    expect(ok.status).toBe(201);
  });
});
