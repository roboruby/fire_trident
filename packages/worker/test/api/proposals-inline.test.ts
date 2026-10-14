import { describe, expect, it } from "vitest";
import type { FileVersion } from "@fire_trident/core";
import { INLINE_LIMITS, blobId, changesetId } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import { ProposalBody } from "../../src/api/schemas.ts";
import type { Env } from "../../src/env.ts";

/** POST /api/colonies/:id/proposals with `contents` (an inline change), behind FT_INLINE. */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

/** An env whose COLONY answers propose by echoing what it received. */
function env(vars: Partial<Env>): { env: Env; received: unknown[] } {
  const received: unknown[] = [];
  const stub = {
    // The route first asks whether the agent is an in-platform one (those propose through the platform); none here is.
    getAgent: async () => null,
    propose: async (p: Record<string, unknown>) => (received.push(p), { ...p, id: "prp_1", status: "ready", createdAt: 0, evidence: { checks: [] } }),
  };
  const COLONY = { idFromName: (n: string) => n, get: () => stub };
  return { env: { FT_ADMIN_TOKEN: "s3cret", COLONY, ...vars } as unknown as Env, received };
}

const BASE = "b".repeat(40);
const TEXT = "export const a = 1;\n";
const writeSet: FileVersion[] = [{ path: "src/a.ts", blob: blobId(TEXT) }];
const body = {
  intentId: "int_1",
  agentId: "agt_1",
  workspace: { namespace: "ft-ws-0", name: "col--ws-0", remote: "https://ws.invalid/col--ws-0.git" },
  baseSha: BASE,
  headSha: changesetId(BASE, writeSet),
  writeSet,
  contents: { [blobId(TEXT)]: TEXT },
};

async function post(e: Env, payload: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await createApi(deps).request("/colonies/col/proposals", { method: "POST", headers: { authorization: "Bearer s3cret", "content-type": "application/json" }, body: JSON.stringify(payload) }, e);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("proposals route: inline changes", () => {
  it("passes the contents to the colony where FT_INLINE turns them on", async () => {
    for (const setting of ["on", "other, col"]) {
      const { env: e, received } = env({ FT_INLINE: setting });
      const res = await post(e, body);
      expect(res.status).toBe(201);
      expect(received[0]).toMatchObject({ colonyId: "col", headSha: body.headSha, writeSet, contents: body.contents });
    }
  });

  it("refuses contents where FT_INLINE is absent, off or names other colonies, and the colony never sees them", async () => {
    for (const setting of [undefined, "off", "other"]) {
      const { env: e, received } = env(setting === undefined ? {} : { FT_INLINE: setting });
      const res = await post(e, body);
      expect(res.status).toBe(409);
      expect(res.json.error).toMatch(/^inline changes are off for this colony \(FT_INLINE\)/);
      expect(received).toEqual([]);
    }
  });

  it("leaves a proposal without contents as it was", async () => {
    const { env: e, received } = env({});
    const { contents: _contents, ...git } = body;
    const res = await post(e, { ...git, headSha: "c".repeat(40) });
    expect(res.status).toBe(201);
    expect(received[0]).not.toHaveProperty("contents");
  });

  it("checks the shape: blob ids as keys, texts within a file's limit, at most 64 of them", () => {
    expect(ProposalBody.safeParse(body).success).toBe(true);
    expect(ProposalBody.safeParse({ ...body, contents: { "not-a-blob": TEXT } }).success).toBe(false);
    expect(ProposalBody.safeParse({ ...body, contents: { [blobId(TEXT)]: 7 } }).success).toBe(false);
    expect(ProposalBody.safeParse({ ...body, contents: { [blobId(TEXT)]: "x".repeat(INLINE_LIMITS.fileBytes + 1) } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: INLINE_LIMITS.files + 1 }, (_, i) => [blobId(String(i)), String(i)]));
    const parsed = ProposalBody.safeParse({ ...body, contents: many });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("at most 64 files");
  });
});
