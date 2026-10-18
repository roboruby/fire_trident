import { describe, expect, it } from "vitest";
import { looksLikeSecret, maskExcerpt, scanDanger } from "../../src/decide/danger.ts";
import { MASKED, maskSecrets } from "../../src/trunk/mask.ts";

/**
 * Secret shapes the review found passing unmasked: payment-API keys and `glpat-` and `npm_` tokens (known token formats:
 * the danger scanner flags them in a change, and masking hides them), and, for masking only, a URL with a password, an
 * Authorization header's credentials and a credential name assigned a value anywhere in a line.
 */

// Built from pieces, so no token-shaped literal sits in this file.
const ALNUM = "4f9a8b7c6d5e4f3a2b1c0d9e";
const payment = (kind: "sk" | "rk", mode: "live" | "test"): string => [kind, mode, ALNUM].join("_");
const FORMATS = [payment("sk", "live"), payment("sk", "test"), payment("rk", "live"), payment("rk", "test"), ["glpat", "xY3_kP9-mQ2wL7vR4tZ8"].join("-"), ["npm", `${ALNUM}abcdef012345`].join("_")];

/** Hits of one new file. */
function hitsOf(path: string, text: string): string[] {
  return scanDanger([{ path, before: null, after: text }], { title: "Add a fixture", why: "", source: "human" }).map((h) => h.pattern);
}

describe("known token formats the review found", () => {
  it("look like a secret, quoted or bare", () => {
    for (const t of FORMATS) {
      expect(looksLikeSecret(`const key = ${JSON.stringify(t)};`), t.slice(0, 6)).toBe(true);
      expect(looksLikeSecret(`I used ${t} for the call`), t.slice(0, 6)).toBe(true);
    }
  });

  it("are flagged in a change as a known token format, in tests and comments too", () => {
    for (const t of FORMATS) expect(hitsOf("test/billing.test.ts", `// key: ${t}\n`), t.slice(0, 6)).toContain("secret:token-format");
  });

  it("are masked in a note's free text and hidden in an excerpt", () => {
    for (const t of FORMATS) {
      expect(maskSecrets(`Not verified: I paid with ${t} and it worked.`)).toBe(`Not verified: I paid with ${MASKED} and it worked.`);
      expect(maskExcerpt(`charge(${t})`)).not.toContain(ALNUM);
    }
  });

  it("leave short values, publishable keys and names that only start alike alone", () => {
    for (const text of [["sk", "live", "abc"].join("_"), ["pk", "live", ALNUM].join("_"), "glpat-short", "npm_config_registry=https://registry.example.org/", "npm_package_version"]) {
      expect(looksLikeSecret(text), text).toBe(false);
      expect(hitsOf("src/a.ts", `const x = 1; // ${text}\n`), text).not.toContain("secret:token-format");
    }
  });
});

// Masking-only shapes: credentials in a URL, an Authorization header's value, a credential name assigned a value.
const PASS = "Zx9vQ2mW7pL4";
const MASK_ONLY = [
  `https://deploy:${PASS}@git.example.com/org/repo.git`,
  `postgres://app:${PASS}@db.internal:5432/main`,
  `Authorization: Basic ${btoa(`user:${PASS}`)}`,
  `curl -H "Authorization: Bearer ${PASS}abcd" https://api.example.com`,
  `headers: { authorization: "Bearer ${PASS}" }`,
  `Proxy-Authorization: Basic ${PASS}`,
  `I ran it with FT_ADMIN_TOKEN=${PASS} npm test`,
  `export DB_PASSWORD=hunter2 && make`,
  "PASSWORD=correcthorsebattery",
  `AWS_SECRET_ACCESS_KEY=${PASS}/abc`,
  `GET /callback?code=1&access_token=${PASS}&state=x`,
  `client_secret = ${PASS} in the form`,
];

describe("masking-only secret shapes", () => {
  it("look like a secret, and masking hides the value", () => {
    for (const text of MASK_ONLY) {
      expect(looksLikeSecret(text), text).toBe(true);
      const masked = maskSecrets(`Not verified: ${text} worked.`);
      expect(masked, text).toContain(MASKED);
      expect(masked, text).not.toContain(PASS);
      expect(masked, text).not.toContain("hunter2");
      expect(masked, text).not.toContain("correcthorsebattery");
    }
  });

  it("are not a new secret in a change: a test fixture or a doc that holds them is not flagged as one", () => {
    const fixture = MASK_ONLY.map((l) => `  ${JSON.stringify(l)},`).join("\n");
    expect(hitsOf("test/fixtures/requests.ts", `export const LINES = [\n${fixture}\n];\n`).filter((p) => p.startsWith("secret:"))).toEqual([]);
    expect(hitsOf("docs/setup.md", `${MASK_ONLY.join("\n")}\n`).filter((p) => p.startsWith("secret:"))).toEqual([]);
  });

  it("leave references, placeholders, comparisons and plain URLs alone", () => {
    for (const text of [
      "const token = env.FT_ADMIN_TOKEN;",
      "const API_KEY = process.env.API_KEY;",
      'curl -H "Authorization: Bearer $FT_ADMIN_TOKEN" https://firetrident.com/api',
      "send Authorization: Bearer <token> with every write",
      "headers: { Authorization: `Bearer ${token}` }",
      "Authorization: Bearer tokens are checked in constant time",
      "FT_ADMIN_TOKEN=<your token> npm run live",
      "PASSWORD=${PASSWORD}",
      "MCP_TOKEN=$MCP_TOKEN ft join",
      "MAX_TOKENS=4096",
      "if (token === expected) return;",
      "API_KEY == other",
      "https://firetrident.com/api/colonies?limit=5",
      "git@github.com:org/repo.git",
      "https://user@example.com/path",
      "https://<user>:<password>@host/repo.git",
      "set password=changeme in the example",
      "the cache_key=user42 entry",
    ]) {
      expect(looksLikeSecret(text), text).toBe(false);
      expect(maskSecrets(text), text).toBe(text);
    }
  });
});
