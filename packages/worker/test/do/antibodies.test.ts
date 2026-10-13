import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Antibody, Proposal } from "@fire_trident/core";
import { antibodyFile, type AllowingAntibody } from "../../src/decide/antibodies.ts";
import type { DecideStore } from "../../src/decide/store.ts";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, api, colony, eventually, externalLanding, fakeSha, holdLanes, newColony, proposal, tick, trunk } from "./helpers.ts";

/**
 * Antibody files in trunk are authoritative: a landing (or a revert) that edits or deletes
 * .firetrident/antibodies/<id>.json reloads or retires that antibody at once, not at the next restart.
 */

const PATH = ".firetrident/antibodies/ab_seed.json";
const ORIGIN = { reason: "it logs the token", by: "matt", proposalId: "prp_origin" };

function antibody(colonyId: string, over: Partial<AllowingAntibody> = {}): AllowingAntibody {
  return {
    id: "ab_seed",
    colonyId,
    origin: "human-reject",
    matcher: { paths: ["src/lib/**"], pattern: "console\\.log" },
    question: "Does this change log a secret?",
    threshold: 0.7,
    createdAt: Date.parse("2026-10-01T00:00:00.000Z"),
    createdFrom: "prp_origin",
    hits: 0,
    falsePositives: 0,
    ...over,
  };
}

/** Run `fn` on the colony's decide store, inside the object. */
async function store<T>(colonyId: string, fn: (s: DecideStore) => T): Promise<T> {
  return (await runInDurableObject(colony(colonyId), (instance: unknown) => fn((instance as { decider(): { store: DecideStore } }).decider().store))) as T;
}

/** A colony with one antibody: committed to trunk at PATH, and known to the colony with a history (it went advisory). */
async function colonyWithAntibody() {
  const c = await newColony();
  await holdLanes(c.id, ".firetrident");
  const ab = antibody(c.id);
  await store(c.id, (s) => s.putAntibody({ ...ab, hits: 4, falsePositives: 1 }, "advisory", { path: PATH, landingId: "lnd_minted" }));
  // Trunk gets the same file (a landing that changes nothing about the antibody).
  await externalLanding(c.id, { [PATH]: antibodyFile(ab, ORIGIN) });
  expect(await store(c.id, (s) => s.antibody("ab_seed"))).toMatchObject({ state: "advisory", antibody: { hits: 4 } });
  return { c, ab };
}

/** Land one change to `path` (null deletes it) through its lane, as a change a person approved does. */
async function landFile(colonyId: string, path: string, content: string | null): Promise<string> {
  await addIntent(colonyId, [path]);
  const agent = await addAgent(colonyId, `writer-${fakeSha().slice(0, 6)}`);
  const taken = await eventually(
    () => api<Assignment | { wait: true }>("POST", `/colonies/${colonyId}/agents/${agent.id}/take`),
    (res) => res.status === 200 && !("wait" in res.body),
  );
  const a = taken.body as Assignment;
  const blob = content === null ? null : fakeSha();
  if (blob !== null && content !== null) await trunk(colonyId).setContents({ [blob]: content });
  const res = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: a.intent.id,
    agentId: agent.id,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: [{ path, blob }],
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, [path]),
    declared: { footprint: [path], summary: "colony memory edit" },
  });
  expect(res.status).toBe(201);
  expect(await tick(colonyId, ".firetrident")).toBe(true);
  const landed = await proposal(colonyId, res.body.id);
  expect(landed.status).toBe("landed");
  return landed.landingId!;
}

type Stored = { antibody: Antibody & { retired?: { state: string; landingId: string; reason: string } }; state: string; path: string | null } | null;

describe("antibody files are authoritative", () => {
  it("reloads an edited antibody file at once, keeping the antibody's counters and state", async () => {
    const { c, ab } = await colonyWithAntibody();
    expect(await store(c.id, (s) => s.matchingAntibodies(["src/app/main.ts"], ["return 1;"], 60).length)).toBe(0);
    const edited = antibodyFile({ ...ab, question: "Does this change print a token anywhere?", threshold: 0.8, matcher: { paths: ["src/**"] } }, ORIGIN);
    await landFile(c.id, PATH, edited);
    const now = (await store(c.id, (s) => s.antibody("ab_seed"))) as Stored;
    expect(now).toMatchObject({ state: "advisory", path: PATH, antibody: { question: "Does this change print a token anywhere?", threshold: 0.8, matcher: { paths: ["src/**"] }, hits: 4, falsePositives: 1 } });
    expect(now!.antibody.matcher.pattern).toBeUndefined();
    // The new matcher applies right away.
    expect(await store(c.id, (s) => s.matchingAntibodies(["src/app/main.ts"], ["return 1;"], 60).map((x) => x.antibody.id))).toEqual(["ab_seed"]);
  });

  it("retires an antibody whose file a landing deletes, and a revert of that landing brings it back as it was", async () => {
    const { c } = await colonyWithAntibody();
    const deletion = await landFile(c.id, PATH, null);
    const retired = (await store(c.id, (s) => s.antibody("ab_seed"))) as Stored;
    expect(retired).toMatchObject({ state: "off", antibody: { hits: 4, falsePositives: 1, retired: { state: "advisory", landingId: deletion, reason: `${PATH} deleted by ${deletion}` } } });
    expect(await store(c.id, (s) => s.matchingAntibodies(["src/lib/util.ts"], ["console.log(token)"], 60).length)).toBe(0);
    const metrics = (await api<{ metrics: Record<string, number> }>("GET", `/colonies/${c.id}`)).body.metrics;
    expect(metrics["antibodies.active"]).toBe(0);

    // A person undoes the deletion: the file is back, and so is the antibody, in the state it had.
    const undo = await api("POST", `/colonies/${c.id}/landings/${deletion}/revert`, { reason: "we still need it", by: "matt", redo: false });
    expect(undo.status).toBe(200);
    const back = (await eventually(
      () => store(c.id, (s) => s.antibody("ab_seed")) as Promise<Stored>,
      (s) => s?.state === "advisory",
    )) as Stored;
    expect(back).toMatchObject({ state: "advisory", antibody: { question: "Does this change log a secret?", hits: 4, falsePositives: 1 } });
    expect(back!.antibody.retired).toBeUndefined();
    expect(await store(c.id, (s) => s.matchingAntibodies(["src/lib/util.ts"], ["console.log(token)"], 60).map((x) => x.antibody.id))).toEqual(["ab_seed"]);
  });

  it("retires an antibody whose file no longer parses", async () => {
    const { c } = await colonyWithAntibody();
    const landing = await externalLanding(c.id, { [PATH]: "{ not an antibody" });
    const now = (await store(c.id, (s) => s.antibody("ab_seed"))) as Stored;
    expect(now?.state).toBe("off");
    expect(now?.antibody.retired?.reason).toBe(`${PATH} no longer holds an antibody after lnd_external_${landing.slice(0, 8)}`);
  });

  it("loads a new antibody file at once, and an allowance stops when its file is deleted", async () => {
    const c = await newColony();
    await holdLanes(c.id, ".firetrident");
    const path = ".firetrident/antibodies/ab_allow.json";
    const allowing = antibody(c.id, { id: "ab_allow", matcher: { paths: ["src/auth/**"] }, question: "Is this the reviewed auth module?", allows: ["auth"] });
    await landFile(c.id, path, antibodyFile(allowing, ORIGIN));
    expect(await store(c.id, (s) => s.antibody("ab_allow"))).toMatchObject({ state: "active", path });
    expect(await store(c.id, (s) => s.allowingAntibodies(["src/auth/login.ts"], []))).toEqual([{ id: "ab_allow", allows: ["auth"], paths: ["src/auth/**"] }]);
    await landFile(c.id, path, null);
    expect(await store(c.id, (s) => s.allowingAntibodies(["src/auth/login.ts"], []))).toEqual([]);
  });

  it("follows an antibody whose file is renamed in one landing", async () => {
    const { c, ab } = await colonyWithAntibody();
    const moved = ".firetrident/antibodies/secret-logging.json";
    await externalLanding(c.id, { [PATH]: null, [moved]: antibodyFile(ab, ORIGIN) });
    expect(await store(c.id, (s) => s.antibody("ab_seed"))).toMatchObject({ state: "advisory", path: moved, antibody: { hits: 4 } });
  });

  it("changes nothing for the antibody's own commit, or a landing elsewhere", async () => {
    const { c, ab } = await colonyWithAntibody();
    // The file differs from the colony's copy, but this is the antibody's own commit (the colony wrote both).
    await trunk(c.id).commitExternal({ [PATH]: antibodyFile({ ...ab, question: "Changed behind the colony's back?" }, ORIGIN) });
    await colony(c.id).onLanding({ id: "lnd_minted", colonyId: c.id, trunkSha: fakeSha(), parentSha: fakeSha(), proposalIds: [], intentIds: [], paths: [PATH], regions: [], at: Date.now() });
    await externalLanding(c.id, { "docs/guide.md": "new guide\n" });
    expect(await store(c.id, (s) => s.antibody("ab_seed"))).toMatchObject({ state: "advisory", antibody: { question: "Does this change log a secret?", hits: 4 } });
  });
});
