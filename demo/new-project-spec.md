# shortlinks: a link shortener Worker, grown from a spec

This is FireTrident's "start a new project from a spec" demo. `ft new --spec demo/new-project-spec.md` creates an empty colony, declares five architecture rules, and paints one intent per module into the field. A swarm then builds the modules in parallel against the contracts below. The acceptance suite is the definition of done.

The project is small on purpose: 13 intents, about 22 files, and zero runtime dependencies. It is TypeScript that Node 24 runs directly, so a plain clone of trunk runs its tests with no install and no build step.

## Run it

```sh
ft new --spec demo/new-project-spec.md           # empty trunk, 5 rules, 13 intents
ft swarm shortlinks --agents 6                   # agents self-assign from the field
ft watch shortlinks --only intent,proposal,landing
ft status shortlinks                             # all 13 intents landed, 0 violations

# the payoff, from a plain clone of the trunk repo:
git clone <trunk remote> shortlinks && cd shortlinks && node --test
ft why shortlinks src/routes/create.ts:1
```

Six agents make the colony grow in waves. Priorities put the scaffold and shared types first, the leaf modules next, and the routes, entry point, and acceptance suite last. Each intent also names the files it builds on (`uses`): an agent that takes it waits until those files have landed, then reads them, so every module is written against the code of its dependencies as well as their contracts. Six agents match the widest wave (six intents at priority 4); more agents only wait longer. A swarm can mix models (`ft swarm shortlinks --agents 6 --model default=3,bulk`): the four intents that integrate several modules (the router, the create route, the entry point, and the acceptance suite) ask for the default model (`"model": "default"`), so whichever agent takes one writes it with that model, and bulk agents write the rest.

### Shot list (about 60 seconds)

| Time | On screen |
| --- | --- |
| 0:00 | This file, scrolled past the API table and the rules |
| 0:06 | `ft new --spec ...` prints 5 rules and 13 intents |
| 0:12 | `ft swarm shortlinks --agents 6`; five regions light up with needs |
| 0:15 | Time-lapse: agents fan out by priority, claims and landings spread from `src` to `src/routes` |
| 0:45 | `git clone` and `node --test`: every test passes, nothing installed |
| 0:54 | `ft why` on a route: the intent and its goal, the checks that passed, the agent and model |

## What it is

A Cloudflare Worker that shortens URLs:

- JSON API with one error shape.
- KV storage in production and in-memory storage in tests.
- Time and randomness are injected, so every test is deterministic.

Conventions every module follows:

- Erasable TypeScript only: no `enum`, no `namespace`, no constructor parameter properties. Node strips the types and runs the file.
- Relative imports name the `.ts` file (`import { json } from "./http.ts"`).
- Strict mode. No `any`. Import types with `import type` (Node strips types, so a type imported as a value fails at load time).
- Narrow a result union before reading it: `const r = await readJson(request); if (!r.ok) return r.response;` then use `r.value`.
- Tests use `node:test` and `node:assert/strict`. Test files are `test/*.test.ts`. Expected values use the platform's normal forms: `new URL("https://example.com").href` is `"https://example.com/"`, and `new Request(url, { method: "get" }).method` is `"GET"`. Build boundary inputs (a body of exactly `MAX_BODY_BYTES` bytes) by measuring the encoded bytes, not by counting characters.

## HTTP API

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| POST | `/api/links` | 201 `{ slug, url, shortUrl, createdAt }` | 400 `invalid_json`, `invalid_url`, `invalid_slug`; 409 `slug_taken`; 413 `payload_too_large` |
| GET | `/:slug` | 302 with `Location: <url>` and `cache-control: no-store`; adds one click | 404 `not_found` |
| GET | `/api/links/:slug` | 200 `{ slug, url, clicks, createdAt }` | 404 `not_found` |
| DELETE | `/api/links/:slug` | 204, empty body | 401 `unauthorized` (missing or wrong `Authorization: Bearer <ADMIN_TOKEN>`); 404 `not_found` |
| GET | `/healthz` | 200 `{ ok: true }` | none |

Every error is `{"error":{"code":"<code>","message":"<text>"}}` with `content-type: application/json; charset=utf-8`. Codes and statuses: `invalid_json` 400, `invalid_url` 400, `invalid_slug` 400, `slug_taken` 409, `not_found` 404, `method_not_allowed` 405 (with an `Allow` header), `unauthorized` 401, `payload_too_large` 413, `internal` 500.

`POST /api/links` takes `{ "url": string, "slug"?: string }`. `shortUrl` is the request origin plus `/` plus the slug. Without a custom slug the handler calls `makeSlug(deps.random)` and retries up to 5 times on collision, then answers 500 `internal`.

## Module contracts

Build each module against these contracts, not against whatever other files exist yet. That is what lets every intent be worked at the same time.

### `src/types.ts`

```ts
export interface Link {
  slug: string;
  url: string; // normalized absolute http(s) URL (URL.href)
  createdAt: number; // ms since epoch, from deps.now()
  clicks: number;
}

/** Storage port. MemoryStore (tests, dev) and KvStore (production) implement it. */
export interface Store {
  get(slug: string): Promise<Link | null>;
  /** Insert. Resolves false and changes nothing when the slug exists. */
  create(link: Link): Promise<boolean>;
  /** Add one click. Resolves false when the slug does not exist. */
  hit(slug: string): Promise<boolean>;
  /** Remove. Resolves false when the slug does not exist. */
  delete(slug: string): Promise<boolean>;
}

/** The slice of a KV namespace the app uses. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  LINKS?: KVLike;
  ADMIN_TOKEN?: string;
}

/** Everything a handler needs, injected so tests control time and randomness. */
export interface Deps {
  store: Store;
  random: () => number; // uniform in [0, 1)
  now: () => number;
  adminToken?: string;
}

export type Params = Record<string, string>;
export type Handler = (request: Request, params: Params, deps: Deps) => Promise<Response>;
```

### `src/http.ts`

```ts
export type ErrorCode =
  | "invalid_json" | "invalid_url" | "invalid_slug" | "slug_taken" | "not_found"
  | "method_not_allowed" | "unauthorized" | "payload_too_large" | "internal";
export const MAX_BODY_BYTES = 4096;
/** JSON response, content-type application/json; charset=utf-8. Default status 200. */
export function json(data: unknown, status?: number, headers?: Record<string, string>): Response;
/** Error response with body {"error":{"code","message"}}. */
export function error(status: number, code: ErrorCode, message: string, headers?: Record<string, string>): Response;
/** Read a JSON body: 413 payload_too_large past MAX_BODY_BYTES (measured in bytes), 400 invalid_json if unparsable. */
export function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }>;
```

### `src/slug.ts`

```ts
export const SLUG_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SLUG_LENGTH = 7;
export const RESERVED_SLUGS: readonly string[]; // ["api", "healthz"]
/** Each character is SLUG_ALPHABET[Math.floor(random() * 62)]. With random = () => 0.5 the slug is "VVVVVVV". */
export function makeSlug(random: () => number, length?: number): string;
/** Custom slugs: 3 to 32 of [A-Za-z0-9_-], not reserved (case-insensitive). */
export function isValidSlug(value: unknown): value is string;
```

### `src/validate.ts`

```ts
export const MAX_URL_LENGTH = 2048;
/** Accept absolute http: or https: URLs up to MAX_URL_LENGTH characters with no username or password. Returns URL.href (normalized: "https://example.com" becomes "https://example.com/"). */
export function parseTargetUrl(input: unknown): { ok: true; url: string } | { ok: false; reason: string };
```

### `src/router.ts`

```ts
export interface Route { method: string; pattern: string; handler: Handler }
/**
 * Patterns are literal segments and ":name" params, e.g. "/api/links/:slug".
 * The first route whose pattern and method match wins. A trailing slash is ignored.
 * Params are URI-decoded. If a pattern matches but no method does: 405
 * method_not_allowed with an Allow header (matching methods, sorted, joined by ", ").
 * If no pattern matches: 404 not_found.
 */
export function createRouter(routes: Route[]): (request: Request, deps: Deps) => Promise<Response>;
```

### `src/store/memory.ts` and `src/store/kv.ts`

```ts
export class MemoryStore implements Store {} // Map-backed; get() returns a copy
export class KvStore implements Store {
  constructor(kv: KVLike); // assign to a field: no parameter properties
  // Each Link is stored as JSON under the key "link:<slug>". create() checks before it puts
  // (KV has no compare-and-set; a race is acceptable here). hit() is read, increment, put.
}
```

### Routes

```ts
// src/routes/create.ts
export const createLink: Handler; // POST /api/links
// src/routes/resolve.ts
export const resolveLink: Handler; // GET /:slug
// src/routes/links.ts
export const getLink: Handler; // GET /api/links/:slug
export const deleteLink: Handler; // DELETE /api/links/:slug
```

### `src/index.ts`

```ts
/** In this order: GET /healthz, POST /api/links, GET /api/links/:slug, DELETE /api/links/:slug, GET /:slug. */
export const routes: Route[];
/** Router plus an error boundary: an unexpected throw becomes 500 internal. */
export function createApp(deps: Deps): (request: Request) => Promise<Response>;
/**
 * Worker entry. Store: KvStore(env.LINKS) when bound, else one module-level MemoryStore.
 * random: crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32. now: Date.now. adminToken: env.ADMIN_TOKEN.
 */
declare const worker: { fetch(request: Request, env: Env): Promise<Response> };
export default worker;
```

## Morphology: the rules

FireTrident checks every proposal against these before it lands, and `ft status` counts violations on trunk. An agent whose change breaks a rule gets it back with the hint.

| # | Rule | Kind | Why |
| --- | --- | --- | --- |
| 1 | Relative imports name the `.ts` file | forbid-import | Node runs the files directly and does not guess extensions |
| 2 | Worker code uses web APIs, not Node built-ins | forbid-import | `src/` ships to the Workers runtime |
| 3 | Route handlers depend on the Store interface, not a store | forbid-import | Keeps routes testable with any store; only `src/index.ts` chooses |
| 4 | Responses are built by `src/http.ts` | forbid-pattern | One content type, one error shape |
| 5 | Randomness and time are injected | forbid-pattern | Deterministic tests; only `src/index.ts` touches `Math.random` or `Date.now` sources |

## Acceptance tests

`test/acceptance.test.ts` drives `createApp` with `new MemoryStore()`, `now: () => 1_700_000_000_000`, `adminToken: "test-admin"`, and requests to `https://sho.rt`. Each scenario starts from a fresh app and store. Unless a scenario says otherwise, `random` cycles through `0.1, 0.2, ..., 0.9`.

| # | Scenario | Expect |
| --- | --- | --- |
| A1 | `POST /api/links {"url":"https://example.com/docs?a=1"}` with `random = () => 0.5` | 201; `slug` is `"VVVVVVV"`; `url` is `"https://example.com/docs?a=1"`; `shortUrl` is `"https://sho.rt/VVVVVVV"`; `createdAt` is 1700000000000; JSON content type |
| A2 | `GET /<slug>` twice, then `GET /api/links/<slug>` | 302 with `Location` equal to the URL, both times; then 200 with `clicks: 2` |
| A3 | `POST` with url `"ftp://example.com"`, `"not a url"`, a missing url, `"https://user:pw@example.com"`; a body of `{`; a 5,000-byte body | 400 `invalid_url` four times; 400 `invalid_json`; 413 `payload_too_large` |
| A4 | `POST {"url":"https://example.com","slug":"docs"}` twice; then slugs `"a b"` and `"api"` | 201 with slug `docs`; 409 `slug_taken`; 400 `invalid_slug` twice |
| A5 | `GET /nope123`; `PUT /api/links`; `GET /healthz`; after creating slug `docs`, `GET /api/links/docs/` | 404 `not_found`; 405 `method_not_allowed` with `Allow: POST`; 200 `{ ok: true }`; 200 (trailing slash ignored) |
| A6 | After creating slug `docs`: `DELETE /api/links/docs` with no auth, with `Bearer wrong`, with `Bearer test-admin`; then `GET /docs` | 401, 401, 204 with an empty body; then 404 |
| A7 | Every error response above | Body is exactly `{ error: { code, message } }` with a non-empty message |

Done means `node --test` passes from a clean clone (module tests plus A1 to A7) and the colony reports 0 violations of rules 1 to 5.

How FireTrident should verify, so parallel work does not trip over itself: a module intent's proposal runs the morphology check and its own test file only (`node --test test/<module>.test.ts`). The full suite, including the acceptance tests, gates the colony goal. The acceptance suite has the lowest priority, so it lands after the modules it drives.

## Machine-readable spec

`ft new` reads this block. Rules are created before intents, so the morphology check is live before any code lands. Intents are declared in dependency order: the intent that creates a file another intent `uses` becomes that intent's parent. Every intent carries the sections named in `context` (contracts, conventions, rules, and acceptance scenarios) as its spec context, so its agent builds against the same target shape as every other agent.

```json firetrident
{
  "firetrident": "spec/v1",
  "name": "shortlinks",
  "regionDepth": 2,
  "context": ["What it is", "HTTP API", "Module contracts", "Morphology: the rules", "Acceptance tests"],
  "goal": {
    "title": "shortlinks: a link shortener Worker built from demo/new-project-spec.md",
    "why": "Show a colony growing a project from a spec: contracts, rules, and acceptance tests instead of a task list."
  },
  "rules": [
    {
      "kind": "forbid-import",
      "description": "Relative imports name the .ts file",
      "spec": {
        "from": ["src/**", "test/**"],
        "module": "^\\.\\.?/(?!.*\\.ts$)",
        "hint": "Write relative imports with the .ts extension, e.g. import { json } from \"./http.ts\". Node runs these files directly and does not guess extensions."
      }
    },
    {
      "kind": "forbid-import",
      "description": "Worker code uses web APIs, not Node built-ins",
      "spec": {
        "from": ["src/**"],
        "module": "^(node:|(fs|path|os|crypto|http|https|net|child_process|buffer|stream|util|events)(/|$))",
        "hint": "Use fetch, Request, Response, URL, TextEncoder, and crypto.getRandomValues. Only tests may import node:test and node:assert."
      }
    },
    {
      "kind": "forbid-import",
      "description": "Route handlers depend on the Store interface, not a store",
      "spec": {
        "from": ["src/routes/**"],
        "module": "(^|/)store/",
        "hint": "Use deps.store and import only the Store type from ../types.ts. src/index.ts chooses KvStore or MemoryStore."
      }
    },
    {
      "kind": "forbid-pattern",
      "description": "Responses are built by src/http.ts",
      "spec": {
        "pattern": "new Response\\(\\s*JSON\\.stringify|Response\\.json\\(",
        "include": ["src/**"],
        "exclude": ["src/http.ts"],
        "hint": "Return json(data, status) or error(status, code, message) from src/http.ts so every response shares one content type and one error shape."
      }
    },
    {
      "kind": "forbid-pattern",
      "description": "Randomness and time are injected",
      "spec": {
        "pattern": "Math\\.random\\(|Date\\.now\\(",
        "include": ["src/**"],
        "exclude": ["src/index.ts"],
        "hint": "Use deps.random and deps.now. Only src/index.ts wires the real sources, so tests stay deterministic."
      }
    }
  ],
  "intents": [
    {
      "title": "Scaffold the Worker project",
      "why": "Every module needs the package, compiler, and Worker settings first.",
      "footprint": ["package.json", "tsconfig.json", "wrangler.jsonc", "README.md", ".gitignore"],
      "acceptance": [
        "package.json: name shortlinks, private, type module, no dependencies; scripts test = \"node --test\", typecheck = \"tsc --noEmit\"; the only devDependencies are typescript and @types/node (typecheck only: node --test needs no install)",
        "tsconfig.json: strict, target ES2022, module ESNext, moduleResolution Bundler, allowImportingTsExtensions, noEmit, verbatimModuleSyntax, erasableSyntaxOnly, lib ES2022 and DOM, types [\"node\"], include src and test",
        "wrangler.jsonc: name shortlinks, main src/index.ts, compatibility_date 2026-10-01, one kv_namespaces binding named LINKS",
        "README.md: one paragraph, the HTTP API table from the spec, and how to test (node --test) and deploy (npx wrangler deploy)",
        ".gitignore: node_modules, .wrangler"
      ],
      "priority": 5
    },
    {
      "title": "Shared types: Link, Store, KVLike, Env, Deps, Handler",
      "why": "Every module codes against these contracts, which lets the swarm build modules in parallel.",
      "footprint": ["src/types.ts"],
      "acceptance": ["Exports exactly the types in the src/types.ts contract, with the same doc comments", "Types only: no runtime code"],
      "priority": 5
    },
    {
      "title": "HTTP helpers: json, error, readJson",
      "why": "One place builds responses, so every route shares one content type and one error shape.",
      "footprint": ["src/http.ts", "test/http.test.ts"],
      "acceptance": [
        "Matches the src/http.ts contract",
        "error() bodies are {\"error\":{\"code\",\"message\"}} with the given status",
        "readJson: 413 payload_too_large past 4096 bytes, 400 invalid_json for unparsable bodies",
        "node --test test/http.test.ts passes"
      ],
      "priority": 4
    },
    {
      "title": "Slug generation and validation",
      "why": "Short, deterministic-in-tests slugs and safe custom slugs.",
      "footprint": ["src/slug.ts", "test/slug.test.ts"],
      "acceptance": [
        "makeSlug(() => 0.5) returns \"VVVVVVV\"; makeSlug(() => 0, 4) returns \"0000\"",
        "isValidSlug accepts 3 to 32 of [A-Za-z0-9_-] and rejects \"api\", \"healthz\", \"a b\", \"ab\", and non-strings",
        "node --test test/slug.test.ts passes"
      ],
      "priority": 4
    },
    {
      "title": "Target URL validation",
      "why": "Only absolute http(s) URLs without credentials may be shortened.",
      "footprint": ["src/validate.ts", "test/validate.test.ts"],
      "acceptance": [
        "Accepts https://example.com/docs?a=1 and returns URL.href",
        "Rejects ftp: URLs, relative or unparsable strings, non-strings, URLs with a username or password, and URLs over 2048 characters",
        "node --test test/validate.test.ts passes"
      ],
      "priority": 4
    },
    {
      "title": "Router with params, 404, and 405",
      "why": "A tiny dependency-free router keeps the Worker small and its behavior exact.",
      "footprint": ["src/router.ts", "test/router.test.ts"],
      "uses": ["src/types.ts", "src/http.ts"],
      "model": "default",
      "acceptance": [
        "Matches the src/router.ts contract: first match wins, trailing slash ignored, params URI-decoded",
        "405 method_not_allowed with Allow listing matching methods sorted and joined by \", \"; 404 not_found otherwise",
        "node --test test/router.test.ts passes"
      ],
      "priority": 4
    },
    {
      "title": "In-memory store",
      "why": "Tests and local development need a Store with no bindings.",
      "footprint": ["src/store/memory.ts", "test/store.memory.test.ts"],
      "uses": ["src/types.ts"],
      "acceptance": [
        "Implements Store exactly: create returns false on an existing slug, hit and delete return false on a missing slug",
        "get returns a copy, so callers cannot mutate stored links",
        "node --test test/store.memory.test.ts passes"
      ],
      "priority": 4
    },
    {
      "title": "KV store",
      "why": "Production storage on Workers KV behind the same Store interface.",
      "footprint": ["src/store/kv.ts", "test/store.kv.test.ts"],
      "uses": ["src/types.ts"],
      "acceptance": [
        "Stores each Link as JSON under link:<slug>",
        "Same Store semantics as MemoryStore, tested against an in-memory KVLike fake",
        "node --test test/store.kv.test.ts passes"
      ],
      "priority": 4
    },
    {
      "title": "Route: POST /api/links creates a short link",
      "why": "The core feature: turn a URL into a slug.",
      "footprint": ["src/routes/create.ts"],
      "uses": ["src/types.ts", "src/http.ts", "src/slug.ts", "src/validate.ts"],
      "model": "default",
      "acceptance": ["Behaves as the API table and acceptance scenarios A1, A3, and A4 describe", "Up to 5 attempts on a generated-slug collision, then 500 internal"],
      "priority": 3
    },
    {
      "title": "Route: GET /:slug redirects and counts",
      "why": "Following a short link is the hot path.",
      "footprint": ["src/routes/resolve.ts"],
      "uses": ["src/types.ts", "src/http.ts"],
      "acceptance": ["302 with Location and cache-control: no-store, and one click added (scenario A2)", "404 not_found for unknown slugs"],
      "priority": 3
    },
    {
      "title": "Routes: GET and DELETE /api/links/:slug",
      "why": "Owners need stats, and admins need to remove links.",
      "footprint": ["src/routes/links.ts"],
      "uses": ["src/types.ts", "src/http.ts"],
      "acceptance": ["GET returns { slug, url, clicks, createdAt } or 404", "DELETE needs Authorization: Bearer <adminToken>; 401 without it, 204 on success, 404 when missing (scenario A6)"],
      "priority": 3
    },
    {
      "title": "Worker entry: routes, error boundary, store selection",
      "why": "Wires the modules into a deployable Worker.",
      "footprint": ["src/index.ts"],
      "uses": ["src/types.ts", "src/http.ts", "src/router.ts", "src/store/memory.ts", "src/store/kv.ts", "src/routes/create.ts", "src/routes/resolve.ts", "src/routes/links.ts"],
      "model": "default",
      "acceptance": [
        "Exports routes in the contract order, createApp, and a default export with fetch(request, env)",
        "An unexpected throw becomes 500 internal; KvStore when env.LINKS is bound, else one module-level MemoryStore",
        "random comes from crypto.getRandomValues, now from Date.now"
      ],
      "priority": 2
    },
    {
      "title": "Acceptance suite A1 to A7",
      "why": "The definition of done for the whole spec.",
      "footprint": ["test/acceptance.test.ts"],
      "uses": ["src/types.ts", "src/store/memory.ts", "src/index.ts"],
      "model": "default",
      "acceptance": ["Encodes scenarios A1 to A7 from the spec with node:test, through createApp and MemoryStore", "node --test passes from a clean clone with nothing installed"],
      "priority": 1
    }
  ]
}
```
