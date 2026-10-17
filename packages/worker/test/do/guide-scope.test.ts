import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { GuideLesson, GuideTake, LessonReceipt, Path, Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, externalLanding, fakeSha, newColony, proposal, take, tick, trunk, type Assignment } from "./helpers.ts";

/**
 * Lesson scopes through the Durable Objects (FT_FIELD_GUIDE with FT_LESSON_SCOPE, colony/lessonscope.ts): a lesson left
 * with a proposal keeps the files it read and wrote with their blobs; once another landing changes one of them, the next
 * take on that file carries the lesson first, naming the file with the landing and intent that changed it; once every
 * file of its scope changed, takes leave it out. With FT_LESSON_SCOPE off, takes carry it unmarked, as before.
 */

type GuideView = { active: Array<Record<string, unknown>>; candidates?: GuideLesson[] };

/** Set variables as the colony's ColonyDO sees them (the harness binds neither flag, so both are off by default). */
async function setEnv(colonyId: string, vars: Record<string, string>): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, ...vars };
  });
}

/** Propose new blobs for `writes`, having read `reads` at the lease's base, with a lesson when given. */
async function proposeWith(colonyId: string, a: Assignment, agentId: string, writes: Path[], reads: Path[], lesson?: string): Promise<Proposal & { lesson?: LessonReceipt }> {
  const res = await api<Proposal & { lesson?: LessonReceipt }>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: writes.map((path) => ({ path, blob: fakeSha() })),
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, [...writes, ...reads]),
    declared: { footprint: a.intent.footprint, summary: "edit" },
    ...(lesson !== undefined ? { lesson } : {}),
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function adminGuide(colonyId: string): Promise<GuideView> {
  const res = await api<GuideView>("GET", `/colonies/${colonyId}/guide`);
  expect(res.status).toBe(200);
  return res.body;
}

describe("lesson scopes (FT_FIELD_GUIDE with FT_LESSON_SCOPE)", () => {
  it("stores the scope, marks a moved file with its landing and intent at the next take, and leaves the lesson out once every file moved", async () => {
    const c = await newColony();
    await setEnv(c.id, { FT_FIELD_GUIDE: c.id });
    const writer = await addAgent(c.id, "writer");
    await addIntent(c.id, ["src/lib/util.ts"], { assignedTo: writer.id });
    const a = await take(c.id, writer.id);
    const p = await proposeWith(c.id, a, writer.id, ["src/lib/util.ts"], ["src/lib/env.ts"], "util.ts helpers are pure: they never read src/lib/env.ts.");
    expect(p.lesson?.status).toBe("candidate");
    expect(await tick(c.id, "src")).toBe(true);
    const landed = await proposal(c.id, p.id);
    expect(landed.status).toBe("landed");

    // The scope: the file written with the blob that landed, the file only read with the blob it had (none: it is new).
    const [candidate] = (await adminGuide(c.id)).candidates!;
    expect(candidate!.scope).toEqual({ writes: [{ path: "src/lib/util.ts", blob: p.writeSet[0]!.blob }], reads: [{ path: "src/lib/env.ts", blob: null }] });
    expect((await api("POST", `/colonies/${c.id}/guide/${p.lesson!.lessonId}`, { action: "approve", by: "matt" })).status).toBe(200);

    // Another intent rewrites util.ts and lands.
    const second = await addAgent(c.id, "second");
    await addIntent(c.id, ["src/lib/util.ts"], { assignedTo: second.id, title: "Read the region from the env" });
    const b = await take(c.id, second.id);
    expect((b as Assignment & { guide?: GuideTake }).guide?.lessons).toEqual([expect.not.objectContaining({ movedSince: expect.anything() })]);
    const q = await proposeWith(c.id, b, second.id, ["src/lib/util.ts"], []);
    expect(await tick(c.id, "src")).toBe(true);
    const moved = await proposal(c.id, q.id);
    expect(moved.status).toBe("landed");

    // FT_LESSON_SCOPE off: the take carries it unmarked, as before.
    const plain = await addAgent(c.id, "plain");
    await addIntent(c.id, ["docs/plain.md"], { assignedTo: plain.id });
    const unmarked = ((await take(c.id, plain.id)) as Assignment & { guide?: GuideTake }).guide?.lessons ?? [];
    expect(unmarked.map((e) => e.id)).toEqual([p.lesson!.lessonId]);
    expect(unmarked[0]).not.toHaveProperty("movedSince");

    // On: the next take on util.ts carries the lesson first, written before util.ts changed, with what changed it.
    await setEnv(c.id, { FT_LESSON_SCOPE: "on" });
    const third = await addAgent(c.id, "third");
    await addIntent(c.id, ["src/lib/util.ts"], { assignedTo: third.id });
    const t = (await take(c.id, third.id)) as Assignment & { guide?: GuideTake };
    expect(t.guide?.lessons).toEqual([
      expect.objectContaining({
        id: p.lesson!.lessonId,
        onFootprint: true,
        movedSince: [{ path: "src/lib/util.ts", landingId: moved.landingId, at: expect.any(Number), intentId: b.intent.id, title: "Read the region from the env" }],
      }),
    ]);

    // env.ts changes too: every file of its scope moved, so takes leave the lesson out (it is still active).
    await externalLanding(c.id, { "src/lib/env.ts": "export const region = process.env.REGION;\n" });
    const fourth = await addAgent(c.id, "fourth");
    await addIntent(c.id, ["docs/readme.md"], { assignedTo: fourth.id });
    expect(((await take(c.id, fourth.id)) as Assignment & { guide?: GuideTake }).guide).toEqual({ lessons: [] });
    expect((await adminGuide(c.id)).active.map((e) => e.id)).toEqual([p.lesson!.lessonId]);
  });
});
