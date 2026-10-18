import { describe, expect, it } from "vitest";
import { CONTROL_PATH, controlPathProblem } from "../../src/api/pathchars.ts";
import { IntentBody, ProposalBody, WhyQuery } from "../../src/api/schemas.ts";

const SHA = "a".repeat(40);
const proposal = (path: string) => ({ intentId: "int_1", agentId: "agt_1", workspace: { namespace: "ft-ws-0", name: "w", remote: "https://example.invalid/w.git" }, baseSha: SHA, headSha: SHA, writeSet: [{ path, blob: SHA }] });

describe("paths with control characters", () => {
  it("are refused in every API path field with one plain sentence, wherever the character is", () => {
    for (const path of ["src/a\nb.ts", "src/a.ts\n", "\tsrc/a.ts", "src/a\u0000.ts", "src/a\u001b[31m.ts", "src/a\u007f.ts", "src/a\r.ts"]) {
      const parsed = ProposalBody.safeParse(proposal(path));
      expect(parsed.success, JSON.stringify(path)).toBe(false);
      expect(parsed.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([`writeSet.0.path: ${CONTROL_PATH}`]);
    }
    expect(ProposalBody.safeParse({ ...proposal("src/a.ts"), readSet: [{ path: "src/b\n.ts", blob: SHA }] }).success).toBe(false);
    expect(IntentBody.safeParse({ title: "t", footprint: ["src/a\nb.ts"] }).success).toBe(false);
    expect(WhyQuery.safeParse({ path: "src/a\tb.ts" }).success).toBe(false);
    expect(CONTROL_PATH).toMatch(/^a path cannot hold a control character .*: rename the file without it, then send the request again$/);
  });

  it("leave every other path as it was: spaces trimmed, Unicode and punctuation kept", () => {
    expect(ProposalBody.parse(proposal("  src/a b.ts  ")).writeSet[0]!.path).toBe("src/a b.ts");
    for (const path of ["src/é/ü.ts", "docs/naïve résumé.md", "a/[x]/(y)/#z.ts", "emoji/🙂.txt"]) expect(ProposalBody.parse(proposal(path)).writeSet[0]!.path).toBe(path);
  });

  it("are named by the colony's intake check, whichever way a change arrived", () => {
    expect(controlPathProblem(["src/a.ts", "src/b\nc.ts", "src/d\te.ts"])).toBe(
      'the path "src/b\\nc.ts" holds a control character (a newline, a tab, NUL, or another character below U+0020 or U+007F): rename the file without it, then propose again',
    );
    expect(controlPathProblem(["src/a.ts", "é.ts", undefined, 3])).toBeNull();
  });
});
