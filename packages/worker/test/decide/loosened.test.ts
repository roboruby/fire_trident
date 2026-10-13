import { describe, expect, it } from "vitest";
import type { IntentSource } from "@fire_trident/core";
import { antibodyAllows } from "../../src/decide/antibodies.ts";
import { applyAllowances, dangerLabels, loosenedGuards, scanDanger, triageDanger } from "../../src/decide/danger.ts";
import { gate, type GateInput, type ReflexSignals, type SecondOpinion } from "../../src/decide/gate.ts";
import { DEFAULT_POLICY } from "../../src/decide/policy.ts";

/** The loosened-guard hits of one modified file, as "pattern@line" (line in the new text). */
function loosened(path: string, before: string, after: string): string[] {
  return loosenedGuards(path, before, after).map((h) => `${h.pattern.slice("loosened-guard:".length)}@${h.line}`);
}

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

// A bearer-auth middleware in the demo colony's style: a missing header and a wrong token both answer 401.
const BEARER = lines(
  "export const bearerAuth = (options: BearerAuthOptions): MiddlewareHandler => {",
  "  return async function bearerAuth(c, next) {",
  "    const headerToken = c.req.header(options.headerName || HEADER)",
  "    if (!headerToken) {",
  "      // No Authorization header",
  "      await throwHTTPException(c, 401, `${prefix} realm=\"${realm}\"`, options.noAuthenticationHeaderMessage || 'Unauthorized')",
  "    } else {",
  "      let equal = false",
  "      if ('verifyToken' in options) {",
  "        equal = await options.verifyToken(headerToken, c)",
  "      } else if (typeof options.token === 'string') {",
  "        equal = await timingSafeEqual(options.token, headerToken, options.hashFunction)",
  "      }",
  "      if (!equal) {",
  "        // Invalid Token",
  "        await throwHTTPException(",
  "          c,",
  "          401,",
  "          `${prefix} error=\"invalid_token\"`,",
  "          options.invalidTokenMessage || 'Unauthorized'",
  "        )",
  "      }",
  "    }",
  "    await next()",
  "  }",
  "}",
);
const BEARER_PATH = "src/middleware/bearer-auth/index.ts";
const INVALID_TOKEN_BLOCK = /      if \(!equal\) \{\n[\s\S]*?\n      \}\n/;

// A JWT verify in the same style: algorithm, expiry, issuer and signature checks, each a throw.
const VERIFY = lines(
  "export const verify = async (token: string, publicKey: SignatureKey, opts: VerifyOptions): Promise<JWTPayload> => {",
  "  const { alg, iss, exp = true } = opts",
  "  const { header, payload } = decode(token)",
  "  if (header.alg !== alg) {",
  "    throw new JwtAlgorithmMismatch(alg, header.alg)",
  "  }",
  "  const now = Math.floor(Date.now() / 1000)",
  "  if (exp && payload.exp !== undefined) {",
  "    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now) {",
  "      throw new JwtTokenExpired(token)",
  "    }",
  "  }",
  "  if (iss) {",
  "    if (!payload.iss) {",
  "      throw new JwtTokenIssuer(iss, null)",
  "    }",
  "    if (typeof iss === 'string' && payload.iss !== iss) {",
  "      throw new JwtTokenIssuer(iss, payload.iss)",
  "    }",
  "  }",
  "  const verified = await verifying(publicKey, alg, signaturePart(token), headerPayload(token))",
  "  if (!verified) {",
  "    throw new JwtTokenSignatureMismatched(token)",
  "  }",
  "  return payload",
  "}",
);
const VERIFY_PATH = "src/utils/jwt/jwt.ts";

// A JWT middleware that verifies the token, then answers 401 when no payload came back.
const JWT_MIDDLEWARE = lines(
  "import { HTTPException } from '../../http-exception'",
  "import { Jwt } from '../../utils/jwt'",
  "export const jwt = (options: JwtOptions): MiddlewareHandler => {",
  "  return async function jwt(ctx, next) {",
  "    const token = readToken(ctx, options)",
  "    if (!token) {",
  "      throw new HTTPException(401, { message: 'no authorization included in request' })",
  "    }",
  "    let payload",
  "    try {",
  "      payload = await Jwt.verify(token, options.secret, {",
  "        alg: options.alg,",
  "        ...verifyOpts,",
  "      })",
  "    } catch (e) {",
  "      cause = e",
  "    }",
  "    if (!payload) {",
  "      throw new HTTPException(401, { message: 'Unauthorized', cause })",
  "    }",
  "    ctx.set('jwtPayload', payload)",
  "    await next()",
  "  }",
  "}",
);
const JWT_PATH = "src/middleware/jwt/jwt.ts";

describe("loosened guards: the forms it recognizes", () => {
  it("bearer auth: the token comparison loosened in place, a condition added to the 401", () => {
    const after = BEARER.replace("      if (!equal) {", "      if (!equal && !c.req.header('x-preview')) {");
    expect(loosened(BEARER_PATH, BEARER, after)).toEqual(["weakened-condition@14"]);
    expect(loosenedGuards(BEARER_PATH, BEARER, after)[0]!.excerpt).toBe("if (!equal) -> if (!equal && !c.req.header('x-preview'))");
  });

  it("bearer auth: the constant-time comparison removed, whether replaced by === or by nothing", () => {
    const loose = BEARER.replace("equal = await timingSafeEqual(options.token, headerToken, options.hashFunction)", "equal = options.token === headerToken");
    expect(loosened(BEARER_PATH, BEARER, loose)).toEqual(["constant-time-compare-removed@12"]);
    const gone = BEARER.replace("equal = await timingSafeEqual(options.token, headerToken, options.hashFunction)", "equal = true");
    expect(loosened(BEARER_PATH, BEARER, gone)).toEqual(["constant-time-compare-removed@12"]);
  });

  it("bearer auth: the invalid-token 401 deleted, anchored on the line before where it stood", () => {
    const hits = loosenedGuards(BEARER_PATH, BEARER, BEARER.replace(INVALID_TOKEN_BLOCK, ""));
    expect(hits.map((h) => `${h.pattern}@${h.line}`)).toEqual(["loosened-guard:deleted-401-return@13"]);
    expect(hits[0]!.excerpt).toBe("removed: if (!equal) { await throwHTTPException(c, 401, `${prefix} error=\"invalid_token\"`, options.invalidTokenMessage || 'Unauthorized')");
  });

  it("JWT middleware: verify swapped for decode", () => {
    const after = JWT_MIDDLEWARE.replace(/      payload = await Jwt\.verify\(token, options\.secret, \{\n[\s\S]*?\n      \}\)\n/, "      payload = Jwt.decode(token).payload\n");
    expect(loosened(JWT_PATH, JWT_MIDDLEWARE, after)).toEqual(["verify-to-decode@11"]);
    expect(loosened("src/auth.ts", lines("export const sub = (token, env) => jwt.verify(token, env.JWT_SECRET).sub"), lines("export const sub = (token, env) => jwt.decode(token).sub"))).toEqual(["verify-to-decode@1"]);
  });

  it("JWT middleware: the 401 for a token that did not verify deleted", () => {
    const after = JWT_MIDDLEWARE.replace("    if (!payload) {\n      throw new HTTPException(401, { message: 'Unauthorized', cause })\n    }\n", "");
    expect(loosened(JWT_PATH, JWT_MIDDLEWARE, after)).toEqual(["deleted-401-throw@17"]);
  });

  it("JWT verify: an issuer check deleted, or a signature check whose throw became a log line", () => {
    const issuer = VERIFY.replace("    if (typeof iss === 'string' && payload.iss !== iss) {\n      throw new JwtTokenIssuer(iss, payload.iss)\n    }\n", "");
    expect(loosened(VERIFY_PATH, VERIFY, issuer)).toEqual(["deleted-throw@16"]);
    const logged = VERIFY.replace("    throw new JwtTokenSignatureMismatched(token)", "    console.warn('signature mismatch')");
    expect(loosened(VERIFY_PATH, VERIFY, logged)).toEqual(["deleted-throw@23"]);
  });

  it("JWT verify: the expiry check deleted, or its comparison dropped from the condition", () => {
    const deleted = VERIFY.replace(/  if \(exp && payload\.exp !== undefined\) \{\n[\s\S]*?\n  \}\n(?=  if \(iss\))/, "");
    expect(loosened(VERIFY_PATH, VERIFY, deleted)).toEqual(["deleted-expiry-check@7"]);
    const dropped = VERIFY.replace(" || payload.exp <= now) {", ") {");
    const hits = loosenedGuards(VERIFY_PATH, VERIFY, dropped);
    expect(hits.map((h) => `${h.pattern}@${h.line}`)).toEqual(["loosened-guard:removed-expiry-check@9"]);
    expect(hits[0]!.excerpt).toContain("dropped payload.exp <= now");
  });

  it("deleted 401/403 answers: a one-line admin check, a path guard, and one commented out", () => {
    const route = lines("app.delete('/posts/:id', async (c) => {", "  const user = c.get('user')", "  if (!isAdmin(user)) return c.text('Forbidden', 403)", "  await deletePost(c.req.param('id'))", "  return c.body(null, 204)", "})");
    expect(loosened("src/routes/posts.ts", route, route.replace("  if (!isAdmin(user)) return c.text('Forbidden', 403)\n", ""))).toEqual(["deleted-403-return@2"]);
    expect(loosenedGuards("src/routes/posts.ts", route, route.replace("  if (!isAdmin(user)) return c.text('Forbidden', 403)\n", ""))[0]!.excerpt).toBe("removed: if (!isAdmin(user)) return c.text('Forbidden', 403)");
    const asset = lines("export function resolveAsset(root: string, requested: string): string {", "  const full = path.resolve(root, requested)", "  if (!full.startsWith(root + path.sep)) {", "    throw new HTTPException(403, { message: 'Forbidden' })", "  }", "  return full", "}");
    expect(loosened("src/static.ts", asset, asset.replace(/  if \(!full[\s\S]*?\n  \}\n/, ""))).toEqual(["deleted-403-throw@2"]);
    const check = lines("export function check(user: User) {", "  if (!isAdmin(user)) throw new HTTPException(403)", "  return user", "}");
    expect(loosened("src/check.ts", check, check.replace("  if (!isAdmin", "  // if (!isAdmin"))).toEqual(["deleted-403-throw@2"]);
  });

  it("weakened conditions: an inverted check, === turned into ==, a constant comparison dropped, an allowance widened", () => {
    const deny = (cond: string): string => lines("export function check(user: User, token: string, expected: string) {", `  if (${cond}) {`, "    throw new HTTPException(403)", "  }", "  return user", "}");
    expect(loosened("src/check.ts", deny("!isAdmin(user)"), deny("isAdmin(user)"))).toEqual(["inverted-condition@2"]);
    expect(loosened("src/check.ts", deny("token !== expected"), deny("token != expected"))).toEqual(["loose-equality@2"]);
    expect(loosened("src/check.ts", deny("!user || user.role !== 'admin'"), deny("!user"))).toEqual(["removed-constant-comparison@2"]);
    expect(loosened("src/check.ts", deny("!isAdmin(user)"), deny("!user"))).toEqual(["weakened-condition@2"]);
    const allow = (cond: string): string => lines("export const admin = async (c, next) => {", `  if (${cond}) return next()`, "  return c.text('Forbidden', 403)", "}");
    expect(loosened("src/admin.ts", allow("c.get('role') === 'admin'"), allow("c.get('role') === 'admin' || c.req.query('debug') === '1'"))).toEqual(["weakened-condition@2"]);
  });

  it("deleted checks: a rate limit, a session expiry, and a session guard that redirects", () => {
    const login = lines("export async function login(c) {", "  const attempts = await countAttempts(c)", "  if (attempts >= MAX_LOGIN_ATTEMPTS) {", "    return c.text('Too many requests', 429)", "  }", "  return signIn(c)", "}");
    expect(loosened("src/login.ts", login, login.replace(/  if \(attempts[\s\S]*?\n  \}\n/, ""))).toEqual(["deleted-limit-check@2"]);
    const session = lines(
      "export async function load(c) {",
      "  const session = await store.get(sessionId(c))",
      "  if (!session) return c.redirect('/login')",
      "  if (session.expiresAt < Date.now()) {",
      "    await store.delete(session.id)",
      "    return c.redirect('/login')",
      "  }",
      "  return session",
      "}",
    );
    expect(loosened("src/session.ts", session, session.replace(/  if \(session\.expiresAt[\s\S]*?\n  \}\n/, ""))).toEqual(["deleted-expiry-check@3"]);
    expect(loosened("src/session.ts", session, session.replace("  if (!session) return c.redirect('/login')\n", ""))).toEqual(["deleted-guard@2"]);
  });

  it("says what was removed and keeps excerpts short", () => {
    const long = (extra: string): string =>
      lines("export function check(payload: Payload, now: number) {", `  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.nbf > now${extra}) {`, "    throw new JwtTokenInvalid('claims')", "  }", "}");
    const [hit] = loosenedGuards("src/claims.ts", long(" || payload.exp <= now"), long(""));
    expect(hit!.excerpt.length).toBeLessThanOrEqual(140);
    expect(hit!.excerpt).toContain("dropped payload.exp <= now");
  });
});

describe("loosened guards: what must not fire", () => {
  it("a guard moved within its function, or to another function of the file", () => {
    const before = lines("export async function remove(c) {", "  const user = c.get('user')", "  const id = c.req.param('id')", "  if (!isAdmin(user)) {", "    throw new HTTPException(403)", "  }", "  await deletePost(id)", "}", "export const other = () => 1");
    const up = lines("export async function remove(c) {", "  const user = c.get('user')", "  if (!isAdmin(user)) {", "    throw new HTTPException(403)", "  }", "  const id = c.req.param('id')", "  await deletePost(id)", "}", "export const other = () => 1");
    expect(loosened("src/posts.ts", before, up)).toEqual([]);
    const elsewhere = lines("function requireAdmin(user) {", "  if (!isAdmin(user)) {", "    throw new HTTPException(403)", "  }", "}", "export async function remove(c) {", "  const user = c.get('user')", "  const id = c.req.param('id')", "  requireAdmin(user)", "  await deletePost(id)", "}", "export const other = () => 1");
    expect(loosened("src/posts.ts", before, elsewhere)).toEqual([]);
  });

  it("renamed variables, in a guard's condition and around it", () => {
    expect(loosened(BEARER_PATH, BEARER, BEARER.replaceAll("equal", "matches"))).toEqual([]);
    expect(loosened(BEARER_PATH, BEARER, BEARER.replaceAll("headerToken", "presented"))).toEqual([]);
    const check = lines("export function check(user: User) {", "  if (!isAdmin(user) || user.role !== 'admin') throw new HTTPException(403)", "  return user", "}");
    expect(loosened("src/check.ts", check, check.replaceAll("user", "currentUser"))).toEqual([]);
  });

  it("a stricter check: another reason to deny, another condition to allow, a new guard, == made ===, === made constant-time", () => {
    const deny = (cond: string): string => lines("export function check(user: User, token: string, expected: string) {", `  if (${cond}) {`, "    throw new HTTPException(401)", "  }", "  return user", "}");
    expect(loosened("src/check.ts", deny("!token"), deny("!token || !verifyToken(token)"))).toEqual([]);
    expect(loosened("src/check.ts", deny("token != expected"), deny("token !== expected"))).toEqual([]);
    expect(loosened("src/check.ts", deny("token !== expected"), deny("!timingSafeEqual(token, expected)"))).toEqual([]);
    expect(loosened("src/check.ts", deny("!user"), deny("!user || !isAdmin(user)"))).toEqual([]);
    const allow = (cond: string): string => lines("export const admin = async (c, next) => {", `  if (${cond}) return next()`, "  return c.text('Forbidden', 403)", "}");
    expect(loosened("src/admin.ts", allow("c.get('role') === 'admin'"), allow("c.get('role') === 'admin' && c.get('mfa') === true"))).toEqual([]);
    expect(loosened(BEARER_PATH, BEARER, BEARER.replace("    await next()", "    if (!c.get('tenant')) throw new HTTPException(403)\n    await next()"))).toEqual([]);
  });

  it("dead test code deleted: test files are not read", () => {
    const test = lines("test('rejects a bad token', async () => {", "  const res = await app.request('/api', { headers: { Authorization: 'Bearer nope' } })", "  if (res.status !== 401) throw new Error('expected 401')", "  expect(res.status).toBe(401)", "})");
    expect(loosened("src/middleware/bearer-auth/index.test.ts", test, "")).toEqual([]);
    expect(loosened("test/auth.test.ts", test, lines("test('placeholder', () => {})"))).toEqual([]);
  });

  it("reformatting: a call wrapped or joined, quotes, semicolons, indentation and a multi-line condition", () => {
    const joined = BEARER.replace("await throwHTTPException(\n          c,\n          401,\n          `${prefix} error=\"invalid_token\"`,\n          options.invalidTokenMessage || 'Unauthorized'\n        )", 'await throwHTTPException(c, 401, `${prefix} error="invalid_token"`, options.invalidTokenMessage || "Unauthorized");');
    expect(loosened(BEARER_PATH, BEARER, joined)).toEqual([]);
    expect(loosened(BEARER_PATH, BEARER, BEARER.replace(/^ {2}/gm, "    "))).toEqual([]);
    const one = lines("export function check(user: User, token: string) {", "  if (!token || !isAdmin(user)) {", "    throw new HTTPException(401)", "  }", "}");
    const many = lines("export function check(user: User, token: string) {", "  if (", "    !token ||", "    !isAdmin(user)", "  ) {", "    throw new HTTPException(401);", "  }", "}");
    expect(loosened("src/check.ts", one, many)).toEqual([]);
    expect(loosened("src/check.ts", many, one)).toEqual([]);
  });

  it("dead code deleted with its function, a stub implemented, a validation throw moved into a helper", () => {
    const legacy = lines("export function current(user) {", "  return user", "}", "export function legacyAuth(req) {", "  if (!req.user) {", "    throw new HTTPException(401)", "  }", "  return req.user", "}");
    expect(loosened("src/auth/legacy.ts", legacy, lines("export function current(user) {", "  return user", "}"))).toEqual([]);
    const stub = lines("export function parseClaims(token: string): Claims {", "  if (!token) {", "    throw new Error('not implemented')", "  }", "  return {} as Claims", "}");
    expect(loosened("src/claims.ts", stub, lines("export function parseClaims(token: string): Claims {", "  return JSON.parse(atob(token.split('.')[1] ?? ''))", "}"))).toEqual([]);
    const validate = lines("export function commit(opts: Opts) {", "  if (typeof opts.message !== 'string' || !opts.message.trim()) {", "    throw new GitWriteError('invalid_input', 'message is required')", "  }", "  return write(opts)", "}");
    expect(loosened("src/commit.ts", validate, lines("export function commit(opts: Opts) {", "  checkMessage(opts.message)", "  return write(opts)", "}"))).toEqual([]);
  });

  it("a denial reworded in place, a guard split in two, an if/else turned into an early return", () => {
    const check = lines("export function check(user: User) {", "  if (!isAdmin(user)) {", "    throw new HTTPException(403, { message: 'Forbidden' })", "  }", "  return user", "}");
    expect(loosened("src/check.ts", check, check.replace("throw new HTTPException(403, { message: 'Forbidden' })", "throw new ForbiddenError('admins only')"))).toEqual([]);
    const repo = lines("export function repoToken(m: string | undefined, name: string) {", "  if (!m || !name.startsWith(`${m}--`)) throw new HttpError(403, 'forbidden', 'not this repo')", "  return mint(name)", "}");
    const split = lines("export function repoToken(m: string | undefined, name: string) {", "  if (!m) return null", "  if (!name.startsWith(`${m}--`)) throw new HttpError(403, 'forbidden', 'not this repo')", "  return mint(name)", "}");
    expect(loosened("src/repo.ts", repo, split)).toEqual([]);
    const ifElse = lines("export function check(token: string) {", "  if (isValidToken(token)) {", "    return decodeClaims(token)", "  } else {", "    throw new HTTPException(401)", "  }", "}");
    const early = lines("export function check(token: string) {", "  if (!isValidToken(token)) {", "    throw new HTTPException(401)", "  }", "  return decodeClaims(token)", "}");
    expect(loosened("src/check.ts", ifElse, early)).toEqual([]);
  });

  it("a client reading a 401, a log line, a header that is not a guard, and an import-only edit", () => {
    const client = lines("export async function get(url) {", "  const res = await fetch(url)", "  if (res.status === 401) await refreshToken()", "  console.error('Unauthorized request', url)", "  return res", "}");
    expect(loosened("src/client.ts", client, lines("export async function get(url) {", "  const res = await fetch(url)", "  return res", "}"))).toEqual([]);
    const cors = lines("export const cors = (opts) => async (c, next) => {", "  if (opts.origin !== '*' || opts.credentials) {", "    c.header('Vary', 'Origin')", "  }", "  await next()", "}");
    expect(loosened("src/cors.ts", cors, cors.replace("opts.origin !== '*' || opts.credentials", "opts.origin !== '*'"))).toEqual([]);
    const renamed = JWT_MIDDLEWARE.replace("'../../http-exception'", "'../../http-exception.ts'").replace("'../../utils/jwt'", "'../../utils/jwt/index.ts'");
    expect(loosened(JWT_PATH, JWT_MIDDLEWARE, renamed)).toEqual([]);
  });

  it("reads only modified scripts: new, deleted, emptied and non-script files are left alone", () => {
    expect(loosened("README.md", "if (!token) throw new HTTPException(401)\n", "")).toEqual([]);
    expect(loosened(BEARER_PATH, BEARER, "")).toEqual([]);
    expect(loosened(BEARER_PATH, "", BEARER)).toEqual([]);
    const deleted = scanDanger([{ path: BEARER_PATH, before: BEARER, after: null, deleted: true }], null);
    const added = scanDanger([{ path: BEARER_PATH, before: null, after: BEARER }], null);
    expect([...deleted, ...added].filter((h) => h.cls === "loosened-guard")).toEqual([]);
  });

  it("never throws on code it cannot read, and stays fast on a whole-file rewrite", () => {
    const odd = lines("const re = /['\"]/g; if (x.replace(re, '').length > 0 { throw new HTTPException(401)", "}}}) ((( `unterminated", "if (", "export const y = '");
    expect(() => loosenedGuards("src/odd.ts", odd, lines("const z = 1"))).not.toThrow();
    expect(() => loosenedGuards("src/odd.ts", lines("const z = 1"), odd)).not.toThrow();
    const big = Array.from({ length: 6000 }, (_, i) => `function f${i}(user) {\n  if (!isAdmin(user) || user.id !== ${i}) throw new HTTPException(403)\n  return user\n}`).join("\n");
    const t0 = Date.now();
    const hits = loosenedGuards("src/big.ts", big, big.replace(/user\.id !== (\d+)/g, "user.id != $1"));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(6);
  });
});

describe("loosened guards: how they are routed", () => {
  const removed = BEARER.replace(INVALID_TOKEN_BLOCK, "");
  const hitsFor = (source: IntentSource | null, title = "Allow previews without a token") =>
    scanDanger([{ path: BEARER_PATH, before: BEARER, after: removed }], source ? { title, why: "Preview deployments need it: remove the 401 check.", source } : null);

  it("is a danger signal for every kind of intent: never must-human, never asked for, whoever wrote the why", () => {
    for (const source of ["agent", "human", "rule", "certify", null] as const) {
      const hits = hitsFor(source);
      const t = triageDanger(hits);
      expect(t.signals.map((h) => h.pattern), String(source)).toEqual(["loosened-guard:deleted-401-return"]);
      expect(t.mustHuman.filter((h) => h.cls === "loosened-guard")).toEqual([]);
      expect(t.recorded).toEqual([]);
    }
  });

  it("no policy, antibody or antibody file can allow it", () => {
    const allowed = applyAllowances(hitsFor("human"), [
      { cls: "loosened-guard", by: "policy" },
      { cls: "loosened-guard", paths: ["src/**"], by: "antibody ab_1" },
    ]);
    expect(allowed.find((h) => h.cls === "loosened-guard")?.allowedBy).toBeUndefined();
    expect(antibodyAllows({ allows: ["loosened-guard", "auth"] })).toEqual(["auth"]);
  });

  it("labels say what was loosened, for reviewers and the review card", () => {
    expect(dangerLabels(triageDanger(hitsFor("agent")).signals)).toEqual([
      "loosened-guard (deleted-401-return) at src/middleware/bearer-auth/index.ts:13: removed: if (!equal) { await throwHTTPException(c, 401, `${prefix} error=\"invalid_token\"`, options.invalidTokenMessage || 'Unauthorized')",
    ]);
  });

  const CLEAN: ReflexSignals = { needsHuman: 0.05, sensitive: 0.03, offIntent: 0.03, risk: 0.7, antibodies: [] };
  const ALARM: ReflexSignals = { needsHuman: 0.95, sensitive: 0.97, offIntent: 0.1, risk: 2.6, antibodies: [] };
  const APPROVE: SecondOpinion = { verdict: "approve", needsHuman: 0.05, offIntent: false, sensitive: false, confidence: 0.95, reason: "the intent asks for it", model: "@cf/openai/gpt-oss-120b" };
  const base = (): GateInput => {
    const t = triageDanger(hitsFor("human"));
    return {
      innate: { ok: true, failures: [] },
      damage: { sensitivePaths: [], residual: [], capabilities: [] },
      danger: { mustHuman: dangerLabels(t.mustHuman), signals: dangerLabels(t.signals) },
      autonomy: true,
      whyBy: "person",
      alerts: { used: 0, max: 30 },
      detectors: {},
      policy: DEFAULT_POLICY,
    };
  };

  it("needs a second opinion: no human gate up front, and earned autonomy cannot land it on a quiet reflex", () => {
    expect(gate(base())).toMatchObject({ action: "screen", rule: "D4 screen" });
    const quiet = gate({ ...base(), reflex: CLEAN });
    expect(quiet).toMatchObject({ action: "consult", rule: "R4 consult" });
    expect(quiet.reasons[0]).toContain("damage without a detector: danger: loosened-guard (deleted-401-return)");
    expect(gate({ ...base(), reflex: CLEAN, llm: APPROVE })).toMatchObject({ action: "land", rule: "L3 innate+llm", confirmations: ["innate", "llm"] });
  });

  it("with a confident alarm it reaches a person as a security finding of its class", () => {
    const v = gate({ ...base(), reflex: ALARM });
    expect(v).toMatchObject({ action: "escalate", rule: "R1 detector+damage" });
    expect(v.security).toContain("loosened-guard");
  });
});
