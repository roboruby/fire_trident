import { describe, expect, it } from "vitest";
import { serializeNote, type LineageNote } from "@fire_trident/core";
import { sealNote } from "../../worker/src/trunk/digest.ts";
import { helpText, parseCommand } from "../src/args.ts";
import {
  antibodyProblems,
  canonicalJson,
  cloneVerify,
  defaultTamperField,
  fieldPath,
  fieldText,
  noteDigest,
  noteState,
  noteWrites,
  parseRawDiff,
  revertProblems,
  rootRow,
  tamperLine,
  tamperNote,
  writeProblems,
  type DiffEntry,
} from "../src/clonecheck.ts";
import { colors } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";

/** The clone checks' logic (clonecheck.ts): the note as the trunk writer seals it, the tampered copy, the write sets, the arguments. */

const c = colors(false);
const sha = (ch: string): string => ch.repeat(40);

const note = (extra: Record<string, unknown> = {}): LineageNote =>
  ({
    schema: "firetrident.lineage/v1",
    landingId: "lnd_1",
    colonyId: "demo",
    proposals: [
      {
        id: "prp_1",
        agentId: "agt_1",
        agentKind: "internal",
        model: "test-model",
        intent: { id: "int_1", title: "Fix «the» thing", why: "tests\nfail" },
        writeSet: [{ path: "src/a.ts", blob: sha("a") }, { path: "src/gone.ts", blob: null }],
        readSet: [{ path: "src/a.ts", blob: sha("b") }],
        decisions: [
          { kind: "collision", layer: "reflex", p: 0.97, action: "land" },
          { kind: "triage", layer: "llm", p: 0.9, action: "approve", by: "review-model" },
          { kind: "triage", layer: "human", p: 1, action: "approve", by: "matt" },
        ],
        evidence: { checks: [{ name: "danger patterns", ok: true, ms: 0 }], numbers: [1.5, -2, 1e21], "10": "integer-like key" },
      },
    ],
    ...extra,
  }) as unknown as LineageNote;

describe("the note as the trunk writer seals it", () => {
  it("is serializeNote's text, and its digest is sealNote's, with or without certification", async () => {
    for (const n of [note(), note({ certification: { status: "green", at: 5 } })]) {
      expect(`${canonicalJson(n)}\n`).toBe(serializeNote(n));
      const { certification: _c, ...rest } = n as LineageNote & { certification?: unknown };
      expect(noteDigest(n as unknown as Record<string, unknown>)).toBe((await sealNote(rest as LineageNote)).digest);
      expect(noteDigest(n as unknown as Record<string, unknown>)).toBe((await sealNote(n)).digest);
    }
  });

  it("reads a note's bytes as intact, altered or missing", async () => {
    const n = note();
    const { text, digest } = await sealNote(n);
    expect(noteState(text, digest)).toBe("intact");
    expect(noteState(null, digest)).toBe("missing");
    expect(noteState(text.replace('"matt"', '"mallory"'), digest)).toBe("altered");
    expect(noteState(JSON.stringify(n), digest)).toBe("altered");
    expect(noteState(`${text}\n`, digest)).toBe("altered");
    expect(noteState("not json", digest)).toBe("altered");
    expect(noteState('"a string"\n', digest)).toBe("altered");
  });
});

describe("the tampered copy", () => {
  it("changes a person's approval first, and the copy is caught", async () => {
    const { text, digest } = await sealNote(note());
    const t = tamperNote(text, digest);
    expect(t).toEqual({ ok: true, field: "proposals[0].decisions[2].by", from: "matt", to: "mallory", caught: true });
    expect(tamperLine(t)).toBe("tampered copy: altered (proposals[0].decisions[2].by changed from matt to mallory): the digest no longer matches");
    // The note itself is untouched.
    expect(noteState(text, digest)).toBe("intact");
  });

  it("falls back to a model's approval, then a read blob id, then a written one, then the landing id: each copy caught", async () => {
    const base = note();
    const p = base.proposals[0]!;
    const cases: Array<[LineageNote, string]> = [
      [{ ...base, proposals: [{ ...p, decisions: p.decisions.filter((d) => d.layer !== "human") }] }, "proposals[0].decisions[1].by"],
      [{ ...base, proposals: [{ ...p, decisions: [] }] }, "proposals[0].readSet[0].blob"],
      [{ ...base, proposals: [{ ...p, decisions: [], readSet: [{ path: "x", blob: null }] }] }, "proposals[0].writeSet[0].blob"],
      [{ ...base, proposals: [] }, "landingId"],
    ];
    for (const [n, field] of cases) {
      const { text, digest } = await sealNote(n);
      const t = tamperNote(text, digest);
      expect(t).toMatchObject({ ok: true, field, caught: true });
    }
    const { text, digest } = await sealNote({ ...base, proposals: [{ ...p, decisions: [] }] });
    expect(tamperNote(text, digest)).toEqual({ ok: true, field: "proposals[0].readSet[0].blob", from: sha("b"), to: `${sha("b").slice(0, -1)}a`, caught: true });
  });

  it("takes another field, and says when a copy is not caught or cannot be made", async () => {
    const { text, digest } = await sealNote(note({ certification: { status: "green" } }));
    expect(tamperNote(text, digest, "proposals.0.decisions.0.p")).toMatchObject({ ok: true, field: "proposals[0].decisions[0].p", from: 0.97, to: 1.97, caught: true });
    expect(tamperNote(text, digest, "proposals[0].evidence.checks[0].ok")).toMatchObject({ from: true, to: false, caught: true });
    const outside = tamperNote(text, digest, "certification.status");
    expect(outside).toMatchObject({ ok: true, caught: false });
    expect(tamperLine(outside)).toBe("tampered copy: intact (certification.status changed from green to mallory): the digest still matches, so this check cannot see that change");
    expect(tamperLine(tamperNote(text, digest, "proposals[3].by"))).toBe("tampered copy: none (the note has no field proposals[3].by)");
    expect(tamperLine(tamperNote(text, digest, "proposals[0].intent"))).toBe("tampered copy: none (proposals[0].intent holds an object; pick a field that holds one value)");
    expect(tamperLine(tamperNote(null, digest))).toBe("tampered copy: none (the commit has no note to copy)");
    expect(tamperLine(tamperNote("{", digest))).toBe("tampered copy: none (the note is not JSON)");
    expect(tamperLine(tamperNote(text, digest, "proposals[0].intent.why"))).toBe("tampered copy: altered (proposals[0].intent.why changed from tests fail to mallory): the digest no longer matches");
    expect(defaultTamperField({})).toBeNull();
  });

  it("reads field paths in either form", () => {
    expect(fieldPath("proposals[0].decisions[1].by")).toEqual(["proposals", 0, "decisions", 1, "by"]);
    expect(fieldPath("proposals.0.decisions.1.by")).toEqual(["proposals", 0, "decisions", 1, "by"]);
    expect(fieldPath("a[1][2]")).toEqual(["a", 1, 2]);
    for (const bad of ["", "a..b", "a[x]", "a]"]) expect(fieldPath(bad)).toBeNull();
    expect(fieldText(["proposals", 0, "decisions", 1, "by"])).toBe("proposals[0].decisions[1].by");
  });
});

describe("the write sets against the commit", () => {
  const d = (path: string, oldBlob: string | null, newBlob: string | null, modes = ["100644", "100644"]): DiffEntry => ({
    path,
    oldMode: oldBlob === null ? "000000" : modes[0]!,
    newMode: newBlob === null ? "000000" : modes[1]!,
    oldBlob,
    newBlob,
  });

  it("reads git diff-tree -r -z output", () => {
    const raw = `:100644 100644 ${sha("1")} ${sha("2")} M\0src/a b.ts\0:000000 100644 ${"0".repeat(40)} ${sha("3")} A\0new.ts\0:100644 000000 ${sha("4")} ${"0".repeat(40)} D\0old.ts\0`;
    expect(parseRawDiff(raw)).toEqual([d("src/a b.ts", sha("1"), sha("2")), d("new.ts", null, sha("3")), d("old.ts", sha("4"), null)]);
    expect(parseRawDiff("")).toEqual([]);
  });

  it("unions the proposals' write sets, a later entry over an earlier one", () => {
    const n = note();
    const two = { ...n, proposals: [n.proposals[0]!, { ...n.proposals[0]!, id: "prp_2", writeSet: [{ path: "b.ts", blob: sha("c") }, { path: "src/a.ts", blob: sha("d") }] }] };
    expect([...noteWrites(two as unknown as Record<string, unknown>)]).toEqual([["src/a.ts", sha("d")], ["src/gone.ts", null], ["b.ts", sha("c")]]);
  });

  it("matches a commit that changes exactly what the note says, a deletion included, and a write of unchanged content", () => {
    const expected = new Map<string, string | null>([["a.ts", sha("a")], ["gone.ts", null], ["same.ts", sha("s")]]);
    expect(writeProblems(expected, [d("a.ts", sha("0"), sha("a")), d("gone.ts", sha("g"), null)], new Map([["same.ts", sha("s")]]))).toEqual([]);
  });

  it("names an extra path, another blob, a deletion either way, and a write the commit does not hold", () => {
    const expected = new Map<string, string | null>([["a.ts", sha("a")], ["gone.ts", null], ["b.ts", sha("b")], ["same.ts", sha("s")]]);
    expect(writeProblems(expected, [d("a.ts", sha("0"), sha("e")), d("extra.sh", null, sha("f")), d("gone.ts", sha("g"), sha("h")), d("b.ts", sha("1"), null)], new Map())).toEqual([
      `a.ts: the commit writes ${sha("e").slice(0, 12)}, the note says it wrote ${sha("a").slice(0, 12)}`,
      `extra.sh: the commit writes ${sha("f").slice(0, 12)}, and no write set in the note names it`,
      `gone.ts: the commit writes ${sha("h").slice(0, 12)}, the note says it deleted it`,
      `b.ts: the commit deletes it, the note says it wrote ${sha("b").slice(0, 12)}`,
      `same.ts: the commit leaves it absent, the note says it wrote ${sha("s").slice(0, 12)}`,
    ]);
    expect(writeProblems(new Map([["gone.ts", null]]), [], new Map([["gone.ts", sha("g")]]))).toEqual([`gone.ts: the commit leaves it at ${sha("g").slice(0, 12)}, the note says it deleted it`]);
  });

  it("names a mode the trunk writer never writes", () => {
    const expected = new Map<string, string | null>([["run.sh", sha("a")], ["new.sh", sha("b")]]);
    expect(writeProblems(expected, [d("run.sh", sha("0"), sha("a"), ["100644", "100755"]), d("new.sh", null, sha("b"), ["", "100755"])], new Map())).toEqual([
      "run.sh: its mode changed from 100644 to 100755, which a landing never does",
      "new.sh: added with mode 100755, where a landing adds files as 100644",
    ]);
  });

  it("checks an antibody commit against the file its note names, and a revert against the commit it reverts", () => {
    const ab = ".firetrident/antibodies/ab_1.json";
    expect(antibodyProblems(ab, [d(ab, null, sha("a"))])).toEqual([]);
    expect(antibodyProblems(ab, [d(ab, null, sha("a")), d("src/evil.ts", null, sha("e"))])).toEqual([`src/evil.ts: the commit writes ${sha("e").slice(0, 12)}, and the antibody note names only ${ab}`]);
    expect(antibodyProblems(ab, [])).toEqual([`${ab}: the antibody note names it, and the commit does not change it`]);
    const target = [d("a.ts", sha("1"), sha("2")), d("new.ts", null, sha("3"))];
    expect(revertProblems([d("a.ts", sha("2"), sha("1")), d("new.ts", sha("3"), null)], target, sha("t"), true)).toEqual([]);
    expect(revertProblems([d("a.ts", sha("2"), sha("9"))], target, sha("t"), true)).toEqual([
      `a.ts: the commit writes ${sha("9").slice(0, 12)}, and before ${sha("t").slice(0, 12)} it was ${sha("1").slice(0, 12)}`,
      `new.ts: ${sha("t").slice(0, 12)} changed it, and the revert does not put it back`,
    ]);
    // A revert of one proposal puts back only that proposal's files.
    expect(revertProblems([d("a.ts", sha("2"), sha("1"))], target, sha("t"), false)).toEqual([]);
    expect(revertProblems([d("other.ts", sha("2"), sha("1"))], target, sha("t"), false)).toEqual([`other.ts: the commit writes ${sha("1").slice(0, 12)}, and ${sha("t").slice(0, 12)}, the commit it reverts, did not change it`]);
  });
});

describe("arguments", () => {
  it("asks the server without clone options, and checks the clone with any of them", () => {
    expect(cloneVerify({}, ["web"])).toBeNull();
    expect(parseCommand(["verify", "web", "--limit", "50"])).toMatchObject({ ok: true, command: { name: "verify", colony: "web", limit: 50 } });
    expect(parseCommand(["verify", "--all", "--from", "main", "--limit", "500", "--keys", "k.json", "--colony", sha("A"), "--tamper", "--dir", "../web"])).toEqual({
      ok: true,
      flags: { json: false, dryRun: false },
      command: { name: "verify-clone", all: true, from: "main", limit: 500, keys: "k.json", colonyRoot: sha("a"), tamper: true, dir: "../web" },
    });
    expect(parseCommand(["verify", "--tamper", "--tamper-field", "proposals[0].readSet[0].blob"])).toMatchObject({ ok: true, command: { name: "verify-clone", all: false, tamper: true, tamperField: "proposals[0].readSet[0].blob" } });
    expect(parseCommand(["verify", "--commit", "HEAD~2"])).toMatchObject({ ok: true, command: { name: "verify-clone", commit: "HEAD~2" } });
  });

  it("refuses options that do not make one check, with what to do instead", () => {
    const err = (argv: string[]): string => {
      const p = parseCommand(argv);
      return p.ok ? "" : p.error;
    };
    expect(err(["verify", "web", "--all"])).toContain("to check colony web through the server, run ft verify web");
    expect(err(["verify", "--commit", "HEAD", "--all"])).toContain("give one of them");
    expect(err(["verify", "--from", "HEAD"])).toContain("give --all too");
    expect(err(["verify", "--limit", "5", "--tamper"])).toContain("give --all too");
    expect(err(["verify", "--all", "--limit", "0"])).toContain("--limit must be a whole number");
    expect(err(["verify", "--tamper-field", "by"])).toContain("give --tamper too");
    expect(err(["verify", "--tamper", "--tamper-field", "a..b"])).toContain("field path");
    expect(err(["verify", "--all", "--colony", "abc123"])).toContain("full root commit");
  });

  it("documents the clone checks", () => {
    const help = helpText("verify");
    for (const s of ["--all", "--tamper", "--tamper-field", "--colony", "--keys", "--from", "--commit", "--dir", "scripts/verify_note.mjs"]) expect(help).toContain(s);
    expect(helpText()).toContain("verify --all");
  });
});

describe("the root in ft status", () => {
  it("shows the colony's root commit, and nothing for an answer without one", () => {
    expect(rootRow({ colonyId: "web", rootSha: sha("f"), shallow: false, at: 1 }, c)).toBe(`root       ${sha("f")} · the first commit of trunk; pin a clone with ft verify --all --colony`);
    expect(rootRow({ colonyId: "web", rootSha: sha("f"), shallow: true, at: 1 }, c)).toContain("the oldest commit the import kept");
    for (const odd of [undefined, null, {}, { rootSha: null, detail: "x" }, { rootSha: "f\u001b[2J" }]) expect(rootRow(odd, c)).toBeNull();
  });

  it("reads GET /root after the summary, and a server without it shows none", async () => {
    const snapshot = { colony: { id: "web", name: "web", trunk: { namespace: "n", name: "web--trunk", remote: "r" }, trunkSha: sha("a"), createdAt: 0, regionDepth: 1 } };
    const run = async (routes: Record<string, unknown>): Promise<string[]> => {
      const out: string[] = [];
      const io: Io = {
        env: { FT_URL: "https://ft.test", NO_COLOR: "1" },
        stdout: (l) => void out.push(l),
        stderr: () => {},
        isTTY: false,
        fetch: (async (input: string | URL | Request) => {
          const body = routes[new URL(String(input)).pathname];
          return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        readFile: async () => "",
        sleep: async () => {},
        now: () => 0,
        WebSocket: globalThis.WebSocket,
        onInterrupt: () => {},
      };
      expect(await main(["status", "web"], io)).toBe(0);
      return out;
    };
    expect(await run({ "/api/colonies/web": snapshot, "/api/colonies/web/root": { colonyId: "web", rootSha: sha("f"), shallow: false, at: 1 } })).toContain(
      `root       ${sha("f")} · the first commit of trunk; pin a clone with ft verify --all --colony`,
    );
    expect((await run({ "/api/colonies/web": snapshot })).join("\n")).not.toContain("root ");
  });
});
