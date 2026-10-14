import { describe, expect, it } from "vitest";
import { removedLines } from "@fire_trident/core";
import { landed, withWriter } from "./writer.ts";

/**
 * The goal-conflict check on the real trunk writer: its trace of who wrote the lines a change removes, over landings it
 * recorded itself, and the `undoes` record a change approved over a goal conflict carries into its lineage note.
 */

const SEED = 'export const language = "python";\nexport const build = "pip install";\nexport const start = "python -m app";\nexport const health = "python up";\nexport const port = 8080;\n';
const RUST = 'export const language = "rust";\nexport const build = "cargo build";\nexport const start = "./orders";\nexport const health = "rust up";\nexport const port = 8080;\n';
const GO = 'export const language = "go";\nexport const build = "go build";\nexport const start = "./orders-go";\nexport const health = "go up";\nexport const port = 8080;\n';

describe("goal conflicts on the trunk writer", () => {
  it("names the landing and intent that wrote the lines a change removes, and nothing for lines trunk started with", async () => {
    await withWriter({ "src/backend.ts": SEED }, undefined, async (w) => {
      const rust = await w.proposal({ "src/backend.ts": RUST });
      const landing = landed(await w.land(rust));
      const blob = rust.writeSet[0]!.blob!;
      const answer = await w.trunk.removedLineOwners({ files: [{ path: "src/backend.ts", blob, removed: removedLines(RUST, GO) }], since: 0, landings: 200 });
      expect(answer.skipped).toEqual([]);
      expect(answer.owners).toEqual([
        { landingId: landing.id, at: landing.at, rank: 0, path: "src/backend.ts", removed: 4, lines: 4, intentId: rust.intentId, proposalId: rust.id },
      ]);
      // The port line came with trunk, before any landing: deleting the file undoes only the Rust landing's lines.
      const gone = await w.trunk.removedLineOwners({ files: [{ path: "src/backend.ts", blob, removed: removedLines(RUST, null) }], since: 0, landings: 200 });
      expect(gone.owners.map((o) => `${o.landingId} ${o.removed}/${o.lines}`)).toEqual([`${landing.id} 4/4`]);
      // Outside the window: nothing.
      const late = await w.trunk.removedLineOwners({ files: [{ path: "src/backend.ts", blob, removed: removedLines(RUST, GO) }], since: landing.at + 1, landings: 200 });
      expect(late.owners).toEqual([]);
    });
  });

  it("keeps what a change approved over a goal conflict undid in its lineage note, and nothing for other changes", async () => {
    await withWriter({ "src/backend.ts": SEED }, undefined, async (w) => {
      const rust = await w.proposal({ "src/backend.ts": RUST });
      const first = landed(await w.land(rust));
      const go = await w.proposal({ "src/backend.ts": GO });
      const undoes = [{ landingId: first.id, intentId: rust.intentId, path: "src/backend.ts", lines: 4 }];
      const second = landed(await w.land({ ...go, undoes }));
      const notes = await w.trunk.why("src/backend.ts");
      expect(notes.map((n) => n.landing.id)).toEqual([second.id, first.id]);
      expect(notes[0]!.note.proposals[0]!.undoes).toEqual(undoes);
      expect(notes[1]!.note.proposals[0]).not.toHaveProperty("undoes");
    });
  });
});
