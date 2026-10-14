import { describe, expect, it } from "vitest";
import { serializeNote } from "@fire_trident/core";
import type { LineageNote, Sha } from "@fire_trident/core";
import { resolveLocal, type GitRepo } from "../../src/artifacts/git.ts";
import { addNotes } from "../../src/trunk/notes.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * One landing's lineage note through the real trunk writer: verifyLanding checks that landing's note on the trunk
 * repository against its commit's FT-Note trailer (the badge on every note in the web app), and landingNote hands the
 * diff route the landing with the writer's copy of its note. The trunk repository's notes ref is stood in for by a local
 * ref the test writes, as in notes-verify.test.ts.
 */

interface Internals {
  repo(): GitRepo;
  sql: SqlStorage;
  remoteNotesTip(): Promise<Sha | null>;
}

const REMOTE = "refs/notes/remote-copy";

describe("one landing's note", () => {
  it("is checked alone, by landing id or by its commit, whatever landed after it", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const g = t.repo();
      let tip: Sha | null = null;
      t.remoteNotesTip = async () => tip;
      const stored = (id: string): string => t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", id).one().note;
      const publish = async (notes: Array<{ oid: string; note: string }>): Promise<void> => {
        await addNotes(g, { ref: REMOTE, notes, at: Date.now(), migrate: 0 });
        tip = await resolveLocal(g, REMOTE);
      };

      const first = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      const second = landed(await w.land(await w.proposal({ "src/b.ts": "export const b = 1;\n" })));
      await publish([{ oid: first.trunkSha, note: stored(first.id) }]);

      const byId = await w.trunk.verifyLanding(first.id);
      expect(byId).toMatchObject({ notesTip: tip, counts: { intact: 1 } });
      expect(byId?.notes).toEqual([expect.objectContaining({ landingId: first.id, trunkSha: first.trunkSha, status: "intact", ownCopy: true })]);
      expect((await w.trunk.verifyLanding(first.trunkSha.slice(0, 9)))?.notes.map((n) => n.landingId)).toEqual([first.id]);
      // The newer landing's note never reached the trunk repository; nothing is due, so it is missing.
      expect((await w.trunk.verifyLanding(second.id))?.notes).toEqual([expect.objectContaining({ landingId: second.id, status: "missing", ownCopy: true })]);

      // Its push is due: pending.
      t.sql.exec("INSERT OR REPLACE INTO ft_journal (landing_id, state, commit_sha, parent_sha, data, created_at, updated_at) VALUES (?, 'pending_note', ?, '', '{}', 0, 0)", second.id, second.trunkSha);
      expect((await w.trunk.verifyLanding(second.id))?.notes[0]?.status).toBe("pending");

      // Rewritten on the trunk repository: altered, while the writer's own copy still matches.
      const note = JSON.parse(stored(first.id)) as LineageNote;
      await publish([{ oid: first.trunkSha, note: serializeNote({ ...note, proposals: note.proposals.map((p) => ({ ...p, model: "a-better-model" })) }) }]);
      expect((await w.trunk.verifyLanding(first.id))?.notes[0]).toMatchObject({ status: "altered", ownCopy: true });

      // Unknown landings, ambiguous or malformed references: none.
      for (const ref of ["lnd_gone", "0000000", "main", "", "lnd_x'; DROP TABLE ft_landings; --"]) expect(await w.trunk.verifyLanding(ref)).toBeNull();
    });
  });

  it("says a landing from before the trailer landed before notes were sealed", async () => {
    await withWriter({ "src/a.ts": "a\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      t.remoteNotesTip = async () => null;
      const initial = w.head();
      t.sql.exec("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES ('lnd_before', ?, ?, 7, '{}')", initial, initial);
      expect((await w.trunk.verifyLanding("lnd_before"))?.notes).toEqual([expect.objectContaining({ landingId: "lnd_before", trunkSha: initial, at: 7, status: "no-trailer" })]);
    });
  });

  it("is handed to the diff route with its landing, or as none when the writer kept no note", async () => {
    await withWriter({ "src/a.ts": "a\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const l = landed(await w.land(await w.proposal({ "src/a.ts": "b\n" })));
      const found = await w.trunk.landingNote(l.id);
      expect(found?.landing).toEqual(l);
      expect(found?.note?.landingId).toBe(l.id);
      expect(found?.note?.proposals[0]?.writeSet).toEqual([{ path: "src/a.ts", blob: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
      expect((await w.trunk.landingNote(l.trunkSha))?.landing.id).toBe(l.id);

      // A landing recorded without its note, and with a record that has lost its fields: the columns still name it.
      const initial = w.head();
      t.sql.exec("INSERT INTO ft_landings (id, trunk_sha, parent_sha, at, data) VALUES ('lnd_bare', ?, ?, 9, 'not json')", "e".repeat(40), initial);
      expect(await w.trunk.landingNote("lnd_bare")).toEqual({
        landing: expect.objectContaining({ id: "lnd_bare", trunkSha: "e".repeat(40), parentSha: initial, at: 9, paths: [], proposalIds: [] }),
        note: null,
      });
      expect(await w.trunk.landingNote("lnd_nothing")).toBeNull();
    });
  });
});
