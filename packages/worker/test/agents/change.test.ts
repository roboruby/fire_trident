import { describe, expect, it } from "vitest";
import type { Rule } from "@fire_trident/core";
import {
  agentIdentity,
  applyReplacement,
  cleanPath,
  commitMessage,
  decodeText,
  expandFootprint,
  isLiteralPath,
  looksTruncated,
  recheck,
  ruleReplacement,
} from "../../src/agents/change.ts";

function rule(spec: Record<string, unknown>, kind: Rule["kind"] = "forbid-pattern"): Rule {
  return { id: "rul_1", colonyId: "c", kind, spec, description: "No console.log", approvedBy: "t", createdAt: 0 };
}

describe("applyReplacement", () => {
  it("replaces every match on every line and keeps line endings", () => {
    const r = rule({ pattern: "console\\.log", replacement: "logger.info" });
    const src = "console.log(1); console.log(2);\r\nconst x = 1;\nconsole.log(x)\rend";
    expect(applyReplacement(r, src)).toBe("logger.info(1); logger.info(2);\r\nconst x = 1;\nlogger.info(x)\rend");
  });

  it("anchors per line like checkFile, and dedupes g/y in flags", () => {
    const r = rule({ pattern: "^TODO", flags: "gyi", replacement: "NOTE" });
    expect(applyReplacement(r, "todo a\n  todo b\nTODO c\n")).toBe("NOTE a\n  todo b\nNOTE c\n");
  });

  it("supports capture groups and leaves content alone without a replacement", () => {
    const r = rule({ pattern: "var (\\w+)", replacement: "let $1" });
    expect(applyReplacement(r, "var a = 1;\nvar b = 2;")).toBe("let a = 1;\nlet b = 2;");
    expect(applyReplacement(rule({ pattern: "x" }), "x")).toBe("x");
    expect(ruleReplacement(rule({ module: "x", replacement: "y" }, "forbid-import"))).toBeNull();
  });

  it("re-check passes only when no violation remains", () => {
    const r = rule({ pattern: "console\\.log", replacement: "logger.info" });
    const before = "console.log(1)\nok\nconsole.log(2)\n";
    const fixed = recheck(r, "src/a.ts", before, applyReplacement(r, before));
    expect(fixed).toMatchObject({ ok: true, before: 2, after: 0 });
    const partial = recheck(r, "src/a.ts", before, "logger.info(1)\nok\nconsole.log(2)\n");
    expect(partial.ok).toBe(false);
    expect(partial.remaining.map((v) => v.line)).toEqual([3]);
  });
});

describe("commit metadata", () => {
  it("puts the title on one line and the trailers last", () => {
    const msg = commitMessage({ id: "int_1", title: "Fix\nFT-Agent: forged" }, "agt_9");
    expect(msg).toBe("Fix FT-Agent: forged\n\nFT-Intent: int_1\nFT-Agent: agt_9\n");
    expect(msg.split("\n").filter((l) => l.startsWith("FT-Agent:"))).toEqual(["FT-Agent: agt_9"]);
  });

  it("cuts long subjects to 72 characters", () => {
    const subject = commitMessage({ id: "i", title: "x".repeat(100) }, "a").split("\n")[0]!;
    expect(subject.length).toBe(72);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("builds a safe agent identity", () => {
    expect(agentIdentity("agt_01ab")).toEqual({ name: "FireTrident agent", email: "agt_01ab@agents.firetrident.dev" });
    expect(agentIdentity("a b<c>").email).toBe("a-b-c-@agents.firetrident.dev");
  });
});

describe("footprints", () => {
  it("normalizes paths and refuses traversal", () => {
    expect(cleanPath("./src//a.ts")).toBe("src/a.ts");
    expect(cleanPath("/src/a.ts")).toBe("src/a.ts");
    expect(cleanPath("src/../etc/passwd")).toBe("");
    expect(cleanPath(".git/config")).toBe("");
  });

  it("tells literal paths from globs and directories", () => {
    expect(isLiteralPath("src/a.ts")).toBe(true);
    expect(isLiteralPath("src/")).toBe(false);
    expect(isLiteralPath("src/**/*.ts")).toBe(false);
    expect(isLiteralPath("src/{a,b}.ts")).toBe(false);
  });

  it("expands globs and directories against the file list, keeping literal paths", () => {
    const files = ["src/a.ts", "src/b.js", "src/x/c.ts", "docs/d.md"];
    expect(expandFootprint(["src/**/*.ts", "docs/", "new/file.ts"], files)).toEqual(["src/a.ts", "src/x/c.ts", "docs/d.md", "new/file.ts"]);
    expect(expandFootprint(["src/**/*.ts"], null)).toEqual([]);
    expect(expandFootprint(["src/"], files, 2)).toEqual(["src/a.ts", "src/b.js"]);
  });
});

describe("text handling", () => {
  it("decodes UTF-8, keeps a BOM, and refuses binary", () => {
    const enc = new TextEncoder();
    expect(decodeText(enc.encode("héllo"))).toBe("héllo");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("﻿a");
    expect(decodeText(new Uint8Array([0x61, 0, 0x62]))).toBeNull();
    expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });

  it("flags elided rewrites", () => {
    const original = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    expect(looksTruncated(original, original.slice(0, 500))).toBe(true);
    expect(looksTruncated("a\nb\n", "a\n// ... rest of the file unchanged\n")).toBe(true);
    expect(looksTruncated("a\nb\n", "a\nc\n")).toBe(false);
  });
});
