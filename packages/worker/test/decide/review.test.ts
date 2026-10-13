import { describe, expect, it } from "vitest";
import { scanDanger } from "../../src/decide/danger.ts";
import { fileDiff } from "../../src/decide/diff.ts";
import { buildReviewView, maskHunks, parseReviewView, REVIEW_FILE_CHARS, REVIEW_TOTAL_CHARS, type ReviewFile } from "../../src/decide/review.ts";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
const person = { title: "Add the route", why: "", source: "human" as const };

/** The view of these files, with the danger hits the scanner finds in them. */
function view(files: ReviewFile[], residual: string[] = []) {
  return buildReviewView({ files, danger: scanDanger(files.map((f) => ({ path: f.path, before: f.before, after: f.after })), person), residual });
}

describe("buildReviewView", () => {
  it("shows the change in FileDiff's hunk format, with its danger patterns and residual", () => {
    const before = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    const after = "export async function add(a: number, b: number) {\n  await fetch('https://x.example/log');\n  return a + b;\n}\n";
    const v = view([{ path: "src/add.ts", before, after }], ["README.md"]);
    expect(v.filesChanged).toBe(1);
    expect(v.files[0]).toEqual({ path: "src/add.ts", status: "modified", added: 2, removed: 1, hunks: fileDiff("src/add.ts", before, after).hunks, truncated: false });
    expect(v.danger).toEqual([{ path: "src/add.ts", line: 2, cls: "capability", pattern: "capability:network", label: expect.stringContaining("capability (network) at src/add.ts:2") }]);
    expect(v.residual).toEqual(["README.md"]);
  });

  it("masks every line carrying a secret hit, and the hit's excerpt", () => {
    const after = `export const TOKEN = "${TOKEN}";\nconsole.log('[debug] auth', process.env.GITHUB_TOKEN);\nexport const ok = 1;\n`;
    const v = view([{ path: "src/config.ts", before: null, after }]);
    const text = JSON.stringify(v);
    expect(text).not.toContain(TOKEN.slice(4));
    expect(text).not.toContain("process.env.GITHUB_TOKEN");
    expect(v.files[0]!.hunks).toContain("+export const ok = 1;");
    expect(v.files[0]!.hunks.split("\n").filter((l) => l.includes("masked")).length).toBe(2);
    expect(v.danger.every((d) => d.cls !== "secret" || d.label.endsWith(": (masked)"))).toBe(true);
  });

  it("masks what secret patterns match anywhere: context, removed lines, test files, and whole key blocks", () => {
    const before = `const a = 1;\nconst t = '${TOKEN}';\nconst b = 2;\n`;
    const after = "const a = 1;\nconst b = 3;\n";
    expect(JSON.stringify(view([{ path: "test/a.test.ts", before, after }]))).not.toContain(TOKEN.slice(4));
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7x9\nqzW1abcdefg\n-----END RSA PRIVATE KEY-----\n";
    const hunks = view([{ path: "fixtures/key.txt", before: null, after: key }]).files[0]!.hunks;
    expect(hunks).not.toContain("MIIE");
    expect(hunks).not.toContain("qzW1");
  });

  it("never shows the content of a secrets file", () => {
    const v = view([{ path: ".env", before: null, after: "DATABASE_URL=postgres://u:hunter2@db/x\nPORT=8080\n" }]);
    expect(v.files[0]!.hunks).not.toContain("hunter2");
    expect(v.files[0]!.hunks).not.toContain("8080");
  });

  it("cuts each file to 24,000 characters and the whole view to 60,000, marking what was cut", () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = "${"y".repeat(60)}";`).join("\n");
    const files: ReviewFile[] = Array.from({ length: 12 }, (_, i) => ({ path: `src/m${i}.ts`, before: null, after: big(400) }));
    const v = buildReviewView({ files, danger: [], residual: [] });
    expect(v.files.every((f) => f.hunks.length <= REVIEW_FILE_CHARS)).toBe(true);
    expect(v.files.reduce((n, f) => n + f.hunks.length, 0)).toBeLessThanOrEqual(REVIEW_TOTAL_CHARS);
    expect(v.files.every((f) => f.truncated)).toBe(true);
    expect(v.files[0]!.hunks.endsWith("\n… (truncated)")).toBe(true);
    expect(v.files.at(-1)!.hunks).toBe("");
    const small = buildReviewView({ files: [{ path: "src/a.ts", before: null, after: big(3) }], danger: [], residual: [] });
    expect(small.files[0]!.truncated).toBe(false);
  });

  it("keeps the masked marker with its diff prefix", () => {
    expect(maskHunks("src/a.ts", `@@ -0,0 +1,2 @@\n+const t = '${TOKEN}';\n+const ok = 1;`)).toBe("@@ -0,0 +1,2 @@\n+… (masked: this line may hold a secret)\n+const ok = 1;");
    expect(maskHunks("src/a.ts", "@@ -1,2 +1,2 @@\n x\n-y\n+z", new Set([2]))).toBe("@@ -1,2 +1,2 @@\n x\n-y\n+… (masked: this line may hold a secret)");
  });
});

describe("parseReviewView", () => {
  it("round-trips a view and refuses anything else", () => {
    const v = view([{ path: "src/a.ts", before: null, after: "export const a = 1;\n" }]);
    expect(parseReviewView(JSON.stringify(v))).toEqual(v);
    expect(parseReviewView("not json")).toBeNull();
    expect(parseReviewView('{"files": "x"}')).toBeNull();
    expect(parseReviewView(null)).toBeNull();
    expect(parseReviewView('{"files":[{"path":1}],"filesChanged":1,"danger":[],"residual":[2,"a"]}')).toEqual({
      files: [{ path: "", status: "", added: 0, removed: 0, hunks: "", truncated: false }],
      filesChanged: 1,
      danger: [],
      residual: ["a"],
    });
  });
});
