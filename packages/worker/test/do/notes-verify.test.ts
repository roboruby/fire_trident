import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import { serializeNote } from "@fire_trident/core";
import type { LineageNote, NoteCertification, Sha } from "@fire_trident/core";
import { resolveLocal, type GitRepo } from "../../src/artifacts/git.ts";
import { sha256Hex, trailerDigest } from "../../src/trunk/digest.ts";
import { addNotes } from "../../src/trunk/notes.ts";
import { MODEL_USAGE_CHECK } from "../../src/trunk/provenance.ts";
import { withPublisher } from "./publisher.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * Provenance and tamper-evident notes through the real trunk writer: each landing's note says how its agents and models
 * are known, its commit carries the note's digest (FT-Note), and verifyNotes checks the notes on the trunk repository
 * against those digests. The trunk repository's notes ref is stood in for by a local ref the test writes.
 */

/** The private parts of the writer the test reads or stands in for. */
interface Internals {
  repo(): GitRepo;
  sql: SqlStorage;
  remoteNotesTip(): Promise<Sha | null>;
}

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const REMOTE = "refs/notes/remote-copy";
const certification = { status: "green", counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 }, failing: [] } as unknown as NoteCertification;

async function message(g: GitRepo, sha: Sha): Promise<string> {
  return (await git.readCommit({ fs: g.fs, dir: g.dir, oid: sha })).commit.message;
}

describe("lineage notes: provenance and the FT-Note trailer", () => {
  it("record how each agent and model are known, and seal the note into its commit", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const inside = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      inside.agentId = "agt_in";
      inside.evidence = { checks: [{ name: MODEL_USAGE_CHECK, ok: true, ms: 900, detail: `${MODEL}: 2 call(s), 300 input / 40 output tokens` }] };
      const outside = await w.proposal({ "src/b.ts": "export const b = 1;\n" });
      outside.agentId = "agt_ext";
      // An external agent's evidence naming a model and counts stays a declaration.
      outside.evidence = { checks: [{ name: MODEL_USAGE_CHECK, ok: true, ms: 1, detail: `${MODEL}: 9 call(s), 1 input / 1 output tokens` }] };
      const unknown = await w.proposal({ "src/c.ts": "export const c = 1;\n" });
      unknown.agentId = "agt_gone";
      const l = landed(
        await w.trunk.land([inside, outside, unknown], {
          agents: { agt_in: { kind: "internal", model: MODEL }, agt_ext: { kind: "external", model: "claude-sonnet-5-5", resumeKey: true } },
        }),
      );
      const text = t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", l.id).one().note;
      const note = JSON.parse(text) as LineageNote;
      expect(note.proposals.map((p) => [p.id, p.provenance])).toEqual([
        [inside.id, { author: "platform", auth: "platform", model: { evidence: "observed", name: MODEL, observed: [{ model: MODEL, calls: 2, inputTokens: 300, outputTokens: 40 }] } }],
        [outside.id, { author: "external", auth: "mcp", model: { evidence: "declared", name: "claude-sonnet-5-5" } }],
        // An agent the writer knows nothing about gets no provenance (nothing is claimed).
        [unknown.id, undefined],
      ]);
      const lines = (await message(t.repo(), l.trunkSha)).trimEnd().split("\n");
      expect(lines.slice(-2)).toEqual(["FT-Agent: agt_gone", `FT-Note: sha256:${await sha256Hex(text)}`]);
      expect(trailerDigest(await message(t.repo(), l.trunkSha))).toBe(await sha256Hex(text));
    });
  });

  it("let verifyNotes tell intact, certified, altered, pending, missing and unsealed notes apart", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const g = t.repo();
      const initial = w.head();
      let tip: Sha | null = null;
      t.remoteNotesTip = async () => tip;
      const publish = async (notes: Array<{ oid: string; note: string }>): Promise<void> => {
        await addNotes(g, { ref: REMOTE, notes, at: Date.now(), migrate: 0 });
        tip = await resolveLocal(g, REMOTE);
      };
      const stored = (id: string): string => t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", id).one().note;
      // The stood-in push journals nothing; a real one leaves each landing's row pending until its note is pushed.
      const due = (l: { id: string; trunkSha: Sha }): void =>
        void t.sql.exec("INSERT OR REPLACE INTO ft_journal (landing_id, state, commit_sha, parent_sha, data, created_at, updated_at) VALUES (?, 'pending_note', ?, '', '{}', 0, 0)", l.id, l.trunkSha);

      const first = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      due(first);
      // Nothing on the trunk repository yet, and the note's push is due.
      expect((await w.trunk.verifyNotes()).notes).toEqual([expect.objectContaining({ landingId: first.id, status: "pending", ownCopy: true })]);
      await publish([{ oid: first.trunkSha, note: stored(first.id) }]);
      let v = await w.trunk.verifyNotes();
      expect(v).toMatchObject({ notesTip: tip, counts: { intact: 1 } });
      expect(v.notes[0]?.trailer).toBe(await sha256Hex(stored(first.id)));

      // Certification rewrites the note after landing; old and new copies both check out.
      expect(await w.trunk.annotate(first.id, { certification })).toBe(true);
      expect((await w.trunk.verifyNotes()).notes[0]).toMatchObject({ status: "intact", ownCopy: true });
      await publish([{ oid: first.trunkSha, note: stored(first.id) }]);
      expect((await w.trunk.verifyNotes()).notes[0]).toMatchObject({ status: "intact", ownCopy: true });

      // Someone with write access to the repository rewrites the note.
      const note = JSON.parse(stored(first.id)) as LineageNote;
      await publish([{ oid: first.trunkSha, note: serializeNote({ ...note, proposals: note.proposals.map((p) => ({ ...p, model: "a-better-model" })) }) }]);
      v = await w.trunk.verifyNotes();
      expect(v.notes[0]).toMatchObject({ status: "altered", ownCopy: true });
      expect(v.counts).toEqual({ altered: 1 });

      // A newer landing whose note is not pushed: pending while its push is due, missing once nothing is due.
      const second = landed(await w.land(await w.proposal({ "src/b.ts": "export const b = 1;\n" })));
      due(second);
      expect((await w.trunk.verifyNotes()).notes.map((n) => [n.landingId, n.status])).toEqual([
        [second.id, "pending"],
        [first.id, "altered"],
      ]);
      t.sql.exec("DELETE FROM ft_journal");
      expect((await w.trunk.verifyNotes(1)).notes).toEqual([expect.objectContaining({ landingId: second.id, status: "missing" })]);

      // A landing recorded before commits carried the trailer.
      t.sql.exec("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES ('lnd_before', ?, ?, 0, '{}')", initial, initial);
      expect((await w.trunk.verifyNotes(1)).notes[0]).toMatchObject({ landingId: "lnd_before", status: "no-trailer" });
    });
  });

  it("read the trunk repository's notes ref at most every 15 s, and keep no failed read", async () => {
    await withWriter({ "src/a.ts": "a\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as { authed: (fn: unknown) => Promise<unknown> };
      let calls = 0;
      let down = true;
      // The ref advertisement of the trunk repository, stood in for where the writer makes its git calls.
      t.authed = async () => {
        calls++;
        if (down) throw new Error("connection reset");
        return [{ ref: "refs/notes/firetrident", oid: "a".repeat(40) }];
      };
      await expect(w.trunk.verifyNotes()).rejects.toThrow(/^\[ft:502\] the trunk repository's notes ref could not be read: connection reset/);
      down = false;
      expect((await w.trunk.verifyNotes()).notesTip).toBe("a".repeat(40));
      expect((await w.trunk.verifyNotes()).notesTip).toBe("a".repeat(40));
      expect(calls).toBe(2);
    });
  });

  it("seal a system commit's note the same way", async () => {
    await withPublisher({ "src/a.ts": "a\n" }, { publish: "on" }, async (w) => {
      const sys = await w.systemCommit(".firetrident/antibodies/ab_1.json", '{"id":"ab_1"}\n');
      const text = w.rows<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", sys.id)[0]!.note;
      const g = (w.trunk as unknown as Internals).repo();
      const lines = (await message(g, sys.trunkSha)).trimEnd().split("\n");
      expect(lines.slice(-2)).toEqual([`FT-Landing: ${sys.id}`, `FT-Note: sha256:${await sha256Hex(text)}`]);
      await w.settle();
    });
  });
});
