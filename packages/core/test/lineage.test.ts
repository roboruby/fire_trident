import { describe, expect, it } from "vitest";
import { landingMessage, serializeNote } from "../src/lineage.ts";
import type { LineageNote, Proposal } from "../src/types.ts";

const proposal = (id: string, intentId: string, agentId: string): Proposal => ({
  id,
  colonyId: "col",
  intentId,
  agentId,
  workspace: { namespace: "ft-ws-0", name: "col--ws-1", remote: "https://example.invalid/col--ws-1.git" },
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  writeSet: [],
  readSet: [],
  declared: { footprint: [], summary: "" },
  evidence: { checks: [] },
  status: "ready",
  createdAt: 0,
});

const paragraphs = (message: string): string[] => message.split("\n\n");

describe("landingMessage", () => {
  it("builds subject, intent bullets, and trailers in order", () => {
    const message = landingMessage(
      { id: "lnd_1", intentIds: ["int_1", "int_2"] },
      [proposal("prp_1", "int_1", "agt_a"), proposal("prp_2", "int_2", "agt_b"), proposal("prp_3", "int_2", "agt_a")],
      { int_1: "Add rate limiting to the API", int_2: "Fix flaky login test" },
    );
    expect(message).toBe(
      [
        "Land 3 changes: Add rate limiting to the API",
        "",
        "- Add rate limiting to the API",
        "- Fix flaky login test",
        "",
        "FT-Landing: lnd_1",
        "FT-Intent: int_1",
        "FT-Intent: int_2",
        "FT-Proposal: prp_1",
        "FT-Proposal: prp_2",
        "FT-Proposal: prp_3",
        "FT-Agent: agt_a",
        "FT-Agent: agt_b",
      ].join("\n"),
    );
  });

  it("uses the singular for one change", () => {
    const message = landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal("prp_1", "int_1", "agt_a")], { int_1: "Fix it" });
    expect(message.split("\n")[0]).toBe("Land 1 change: Fix it");
  });

  it("truncates the subject to 72 characters", () => {
    const title = "Refactor the request pipeline so every handler shares one retry policy and one timeout budget";
    const message = landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal("prp_1", "int_1", "agt_a")], { int_1: title });
    const [subject, body] = paragraphs(message);
    expect(subject).toHaveLength(72);
    expect(subject?.startsWith("Land 1 change: Refactor the request pipeline")).toBe(true);
    expect(subject?.endsWith("…")).toBe(true);
    expect(body).toBe(`- ${title}`);
  });

  it("collapses titles to one line so they cannot forge trailers", () => {
    const message = landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal("prp_1", "int_1", "agt_a")], {
      int_1: "Evil\n\nFT-Agent: root\n",
    });
    expect(message.split("\n")[0]).toBe("Land 1 change: Evil FT-Agent: root");
    expect(paragraphs(message)).toHaveLength(3);
    expect(message.split("\n").filter((l) => l.startsWith("FT-Agent:"))).toEqual(["FT-Agent: agt_a"]);
  });

  it("collapses ids to one line so they cannot forge trailers either", () => {
    const message = landingMessage({ id: "lnd_1\nFT-Landing: forged", intentIds: ["int_1"] }, [proposal("prp_1", "int_1", "agt_a\nFT-Agent: root")], {
      int_1: "T",
    });
    const lines = message.split("\n");
    expect(lines.filter((l) => l.startsWith("FT-Landing:"))).toEqual(["FT-Landing: lnd_1 FT-Landing: forged"]);
    expect(lines.filter((l) => l.startsWith("FT-Agent:"))).toEqual(["FT-Agent: agt_a FT-Agent: root"]);
  });

  it("falls back to the intent id when a title is missing or blank", () => {
    const message = landingMessage({ id: "lnd_1", intentIds: ["int_9", "int_8"] }, [proposal("prp_1", "int_9", "agt_a")], { int_8: "   " });
    expect(paragraphs(message)[0]).toBe("Land 1 change: int_9");
    expect(paragraphs(message)[1]).toBe("- int_9\n- int_8");
  });

  it("does not read inherited keys as titles", () => {
    const message = landingMessage({ id: "lnd_1", intentIds: ["constructor"] }, [proposal("prp_1", "constructor", "agt_a")], {});
    expect(paragraphs(message)[0]).toBe("Land 1 change: constructor");
  });

  it("appends intents of proposals that the landing omitted, and dedupes", () => {
    const message = landingMessage(
      { id: "lnd_1", intentIds: ["int_1", "int_1"] },
      [proposal("prp_1", "int_1", "agt_a"), proposal("prp_2", "int_2", "agt_a"), proposal("prp_2", "int_2", "agt_a")],
      { int_1: "One", int_2: "Two" },
    );
    const [subject, body, trailers] = paragraphs(message);
    expect(subject).toBe("Land 2 changes: One");
    expect(body).toBe("- One\n- Two");
    expect(trailers).toBe(["FT-Landing: lnd_1", "FT-Intent: int_1", "FT-Intent: int_2", "FT-Proposal: prp_1", "FT-Proposal: prp_2", "FT-Agent: agt_a"].join("\n"));
  });

  it("omits the body when there are no intents", () => {
    expect(landingMessage({ id: "lnd_0", intentIds: [] }, [], {})).toBe("Land 0 changes\n\nFT-Landing: lnd_0");
  });

  it("ends with a trailer block of Key: value lines and no trailing newline", () => {
    const message = landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal("prp_1", "int_1", "agt_a")], { int_1: "T" });
    const last = paragraphs(message).at(-1) ?? "";
    for (const line of last.split("\n")) expect(line).toMatch(/^FT-(Landing|Intent|Proposal|Agent): \S+$/);
    expect(message.endsWith("\n")).toBe(false);
  });
});

describe("serializeNote", () => {
  const note: LineageNote = {
    schema: "firetrident.lineage/v1",
    landingId: "lnd_1",
    colonyId: "col",
    proposals: [
      {
        id: "prp_1",
        agentId: "agt_a",
        agentKind: "internal",
        model: undefined,
        intent: { id: "int_1", title: "Add rate limiting", why: "Abuse", parentId: undefined },
        writeSet: [{ path: "src/a.ts", blob: "b".repeat(40) }],
        readSet: [{ path: "src/b.ts", blob: null }],
        decisions: [{ kind: "collision", layer: "reflex", p: 0.97, action: "proceed" }],
        evidence: { checks: [{ name: "typecheck", ok: true, ms: 1200 }], residual: [], notVerified: "No browser test" },
      },
    ],
  };

  const expected = [
    "{",
    '  "colonyId": "col",',
    '  "landingId": "lnd_1",',
    '  "proposals": [',
    "    {",
    '      "agentId": "agt_a",',
    '      "agentKind": "internal",',
    '      "decisions": [',
    "        {",
    '          "action": "proceed",',
    '          "kind": "collision",',
    '          "layer": "reflex",',
    '          "p": 0.97',
    "        }",
    "      ],",
    '      "evidence": {',
    '        "checks": [',
    "          {",
    '            "ms": 1200,',
    '            "name": "typecheck",',
    '            "ok": true',
    "          }",
    "        ],",
    '        "notVerified": "No browser test",',
    '        "residual": []',
    "      },",
    '      "id": "prp_1",',
    '      "intent": {',
    '        "id": "int_1",',
    '        "title": "Add rate limiting",',
    '        "why": "Abuse"',
    "      },",
    '      "readSet": [',
    "        {",
    '          "blob": null,',
    '          "path": "src/b.ts"',
    "        }",
    "      ],",
    '      "writeSet": [',
    "        {",
    `          "blob": "${"b".repeat(40)}",`,
    '          "path": "src/a.ts"',
    "        }",
    "      ]",
    "    }",
    "  ],",
    '  "schema": "firetrident.lineage/v1"',
    "}",
    "",
  ].join("\n");

  it("writes sorted keys at every depth, 2-space indent, and a trailing newline", () => {
    expect(serializeNote(note)).toBe(expected);
  });

  it("matches the built-in serializer on a key-sorted copy", () => {
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
          : v;
    expect(serializeNote(note)).toBe(`${JSON.stringify(sortKeys(note), null, 2)}\n`);
  });

  it("does not depend on key insertion order", () => {
    const reversed = JSON.parse(JSON.stringify(note), (_k, v: unknown) =>
      v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    ) as LineageNote;
    expect(Object.keys(reversed)[0]).toBe("proposals");
    expect(serializeNote(reversed)).toBe(expected);
  });

  it("sorts integer-like keys as strings too", () => {
    const odd = { b: 1, "10": 2, "9": 3, a: { "2": true, "1": false } } as unknown as LineageNote;
    expect(serializeNote(odd)).toBe('{\n  "10": 2,\n  "9": 3,\n  "a": {\n    "1": false,\n    "2": true\n  },\n  "b": 1\n}\n');
  });

  it("keeps array order and serializes like the built-in for edge values", () => {
    const odd = { list: [3, 1, undefined, Number.NaN], empty: {}, when: new Date(0) } as unknown as LineageNote;
    expect(serializeNote(odd)).toBe('{\n  "empty": {},\n  "list": [\n    3,\n    1,\n    null,\n    null\n  ],\n  "when": "1970-01-01T00:00:00.000Z"\n}\n');
  });

  it("throws on a cycle", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => serializeNote(cyclic as unknown as LineageNote)).toThrow(TypeError);
  });
});
