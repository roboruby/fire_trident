import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { AgentInfo, ColonySnapshot, ExternalSource, Intent, LineageNote } from "@fire_trident/core";
import type { GitRepo } from "../../src/artifacts/git.ts";
import { EXTERNAL_WORDS, type DeclaredBy } from "../../src/colony/chain.ts";
import type { GithubIssue } from "../../src/colony/github.ts";
import { addAgent, api, colony, newColony, proposal, proposeEdit, tick, trunk } from "./helpers.ts";
import type { Assignment } from "./helpers.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * GitHub issues as intents through the real ColonyDO and the real trunk writer, with the issues handed to the colony as
 * api/issues.ts hands them over (no test reaches GitHub, and FT_GITHUB_TOKEN is not set, so nothing is posted): one
 * `external` intent per issue, skipped when imported again; an agent's take says a stranger wrote it; it lands with the
 * issue in the land context; and the trunk writer names the issue in the lineage note and the commit's Refs trailer.
 * The REST route's refusals that come before any GitHub call are checked through the harness worker.
 */

const ISSUE: GithubIssue = { number: 12, title: "Footer link points at the old docs", body: "The link in `src/footer.ts` is stale.", author: "octocat", labels: ["bug"] };
const EXT: ExternalSource = { kind: "github-issue", repo: "octo-org/site", number: 12, url: "https://github.com/octo-org/site/issues/12", author: "octocat" };

type Taken = Assignment & { declaredBy?: DeclaredBy };

describe("imported issues in a colony", () => {
  it("become external intents with their issue, are skipped when imported again, and reach an agent and the trunk writer as a stranger's text", async () => {
    const c = await newColony();
    const res = await colony(c.id).importIssues({ repo: "octo-org/site", issues: [ISSUE, { ...ISSUE, number: 13, body: "No paths here." }], by: "lee", tokenSet: false });
    expect(res.imported).toEqual([{ number: 12, intentId: expect.stringMatching(/^int_/), title: "Footer link points at the old docs (octo-org/site#12)", url: EXT.url, footprint: ["src/footer.ts"] }]);
    expect(res.skipped.map((s) => s.number)).toEqual([13]);
    const id = res.imported[0]!.intentId;

    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    const intent = snap.intents.find((i) => i.id === id) as Intent;
    expect(intent).toMatchObject({ source: "external", createdBy: "lee", priority: 1, status: "open", external: EXT });
    expect(intent.why.startsWith("From the public GitHub issue octo-org/site#12 (https://github.com/octo-org/site/issues/12), opened by @octocat.")).toBe(true);
    expect(intent.why).toContain("\n\n> The link in `src/footer.ts` is stale.");

    const again = await colony(c.id).importIssues({ repo: "octo-org/site", issues: [ISSUE], by: "lee", tokenSet: false });
    expect(again.imported).toEqual([]);
    expect(again.skipped).toEqual([{ number: 12, url: EXT.url, reason: `already imported as ${id}`, intentId: id }]);

    const agent: AgentInfo = await addAgent(c.id, "scout");
    const taken = (await api<Taken>("POST", `/colonies/${c.id}/agents/${agent.id}/take`)).body;
    expect(taken.intent.id).toBe(id);
    expect(taken.declaredBy).toEqual({ source: "external", by: "lee", model: null, chainDepth: 0, parentId: null, note: `lee imported this intent from a public issue, not a person in this colony: ${EXTERNAL_WORDS}` });

    // The harness has no AI binding, so the decide stage is off and the change is ready at once (decide tests cover review).
    const p = await proposeEdit(c.id, taken, agent.id);
    await tick(c.id, "src");
    expect(await proposal(c.id, p.id)).toMatchObject({ status: "landed" });
    const contexts = ((await trunk(c.id).state()) as { contexts?: string[] }).contexts ?? [];
    const ctx = JSON.parse(contexts.at(-1) ?? "null") as { intents: Record<string, { external?: ExternalSource; source?: string }> };
    expect(ctx.intents[id]).toMatchObject({ source: "external", createdBy: "lee", external: EXT });
  });

  it("the route refuses a bad request before it calls GitHub: no token, no repository, close without closeOnLand, an unknown colony", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/issues/import`, { repo: "octo-org/site" }, {})).status).toBe(401);
    expect(await api("POST", `/colonies/${c.id}/issues/import`, { repo: "octo-org" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("repo must name a GitHub repository as owner/name") } });
    expect(await api("POST", `/colonies/${c.id}/issues/import`, { repo: "octo-org/site", close: true })).toMatchObject({ status: 400, body: { error: expect.stringContaining("close needs closeOnLand") } });
    expect((await api("POST", "/colonies/no-such-colony/issues/import", { repo: "octo-org/site" })).status).toBe(404);
  });
});

describe("the trunk writer and an imported issue", () => {
  it("names the issue in the lineage note and puts Refs: owner/repo#n in the commit's trailers", async () => {
    await withWriter({ "src/footer.ts": "export const link = 'old';\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as { repo(): GitRepo; sql: SqlStorage };
      const p = await w.proposal({ "src/footer.ts": "export const link = 'new';\n" });
      const ctx = { intents: { [p.intentId]: { title: "Footer link points at the old docs (octo-org/site#12)", why: "From the public GitHub issue ...", source: "external" as const, createdBy: "lee", external: EXT } } };
      const l = landed(await w.trunk.land([p], ctx));
      const g = t.repo();
      const lines = (await git.readCommit({ fs: g.fs, dir: g.dir, oid: l.trunkSha })).commit.message.trimEnd().split("\n");
      const at = lines.indexOf("Refs: octo-org/site#12");
      expect(at).toBeGreaterThan(0);
      expect(lines[at - 1]).toBe("");
      expect(lines[at + 1]).toBe(`FT-Landing: ${l.id}`);
      expect(lines.at(-1)).toMatch(/^FT-Note: sha256:[0-9a-f]{64}$/);
      const note = JSON.parse(t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", l.id).one().note) as LineageNote;
      expect(note.proposals[0]!.intent).toMatchObject({ source: "external", createdBy: "lee", external: EXT });

      // An intent that is not imported: no Refs line, and no external in its note.
      const q = await w.proposal({ "src/footer.ts": "export const link = 'newer';\n" });
      const plain = landed(await w.trunk.land([q], { intents: { [q.intentId]: { title: "Plain", why: "w", source: "human" as const, createdBy: "lee" } } }));
      expect((await git.readCommit({ fs: g.fs, dir: g.dir, oid: plain.trunkSha })).commit.message).not.toContain("Refs:");
      expect(JSON.parse(t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", plain.id).one().note).proposals[0].intent.external).toBeUndefined();
    });
  });
});
