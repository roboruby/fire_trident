import type {
  AgentKind,
  AgentState,
  CheckResult,
  Colony,
  ColonyEvent,
  ColonySnapshot,
  Decision,
  DecisionKind,
  DecisionLayer,
  EscalationKind,
  FieldReading,
  FileVersion,
  Id,
  Intent,
  IntentSource,
  Landing,
  LineageNote,
  MarkKind,
  NoteProvenance,
  Proposal,
  Rule,
} from "@fire_trident/core";
import type { Backend, EscalationDecision, IntentAmend, ReviewDecision, WhyEntry } from "./api.ts";
import { basename, regionOf } from "./format.ts";
import type { ColonyStore } from "./store.ts";
import { TAU_MS } from "./theme.ts";

/**
 * A built-in colony simulator for `?mock=1`: a synthetic repository, rules with
 * violations, and agents that self-assign intents, claim paths, propose, pass or
 * fail checks, wait in region lanes, and land in batches. It streams the same
 * ColonyEvent shapes the Worker sends, and answers why/review/decide.
 *
 * URL knobs: files=<n> (default: a curated ~350-file repo), agents=<n> (64),
 * speed=<x> (1), seed=<n> (7), stress=<events per second> (0: extra field churn,
 * agent moves, and decisions, for load testing the UI).
 */

export interface MockOptions {
  files: number;
  agents: number;
  speed: number;
  seed: number;
  /** Extra synthetic events per second (load testing). */
  stress?: number;
}

/** Read mock options from the page's query string. */
export function mockOptionsFrom(params: URLSearchParams): MockOptions {
  const num = (key: string, fallback: number, lo: number, hi: number): number => {
    const raw = params.get(key);
    const v = raw === null || raw === "" ? NaN : Number(raw);
    return Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : fallback;
  };
  return {
    files: Math.round(num("files", 0, 30, 20_000)),
    agents: Math.round(num("agents", 64, 1, 50_000)),
    speed: num("speed", 1, 0.1, 20),
    seed: Math.round(num("seed", 7, 1, 2 ** 31)),
    stress: Math.round(num("stress", 0, 0, 100_000)),
  };
}

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function hexFrom(rng: Rng, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[(rng() * 16) | 0];
  return s;
}

const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;

/** A simulated change's provenance as the trunk writer records it: an in-platform agent's model observed with its counts, any other declared. */
function simProvenance(kind: AgentKind, model: string, seed: string): NoteProvenance {
  if (kind !== "internal") return { author: kind === "external" ? "external" : "synthetic", ...(kind === "external" ? { auth: "mcp" as const } : {}), model: { evidence: "declared", name: model } };
  const h = hashString(seed);
  const calls = 1 + (h % 3);
  return { author: "platform", auth: "platform", model: { evidence: "observed", name: model, observed: [{ model, calls, inputTokens: 1_800 * calls + (h % 900), outputTokens: 240 * calls + (h % 300) }] } };
}

// ---------------------------------------------------------------------------
// The synthetic repository
// ---------------------------------------------------------------------------

interface RepoFile {
  path: string;
  size: number;
}

const CURATED: ReadonlyArray<[dir: string, ext: string, names: string, mu: number]> = [
  ["api/routes", ".ts", "orders products carts users sessions inventory webhooks health search reviews coupons shipping returns wishlists payments admin", 8.5],
  ["api/middleware", ".ts", "auth rateLimit cors errors logging tenant idempotency compress", 7.7],
  ["api", ".ts", "server router context schema openapi", 8.3],
  ["auth", ".ts", "session tokens passwords oauth mfa roles policies audit magicLink sso crypto index", 8.1],
  ["billing", ".ts", "invoices subscriptions taxes refunds ledger money proration dunning plans receipts webhooks currency totals discounts credits statements usage meter index", 8.3],
  ["billing/payments", ".ts", "intents methods capture disputes payouts", 8.2],
  ["catalog", ".ts", "products variants pricing images categories collections attributes inventory bundles feeds imports search sync slugs media options seo index", 8.1],
  ["checkout", ".ts", "cart steps address shipping payment review confirm giftCards promo tax totals validation session guest index", 8.4],
  ["core", ".ts", "config log errors events ids clock cache queue retry flags metrics env result types http index", 7.8],
  [
    "db/migrations",
    ".sql",
    "0001_init 0002_users 0003_products 0004_orders 0005_carts 0006_payments 0007_inventory 0008_reviews 0009_coupons 0010_shipments 0011_returns 0012_wishlists 0013_sessions 0014_audit 0015_tenants 0016_search 0017_invoices 0018_ledger 0019_feeds 0020_flags 0021_outbox 0022_gift_cards",
    6.6,
  ],
  ["db/models", ".ts", "user order product variant cart payment invoice address review coupon session shipment", 7.9],
  ["db", ".ts", "client pool repo tx seed schema", 8.2],
  ["events", ".ts", "bus handlers orderPlaced paymentCaptured inventoryLow userCreated outbox replay schemas index", 7.7],
  ["search", ".ts", "indexer query ranking synonyms facets suggest tokenize analyzers boost index", 8.0],
  [
    "ui/components",
    ".tsx",
    "Button Modal Drawer CartDrawer ProductCard ProductGrid PriceTag Rating Header Footer Nav SearchBar Toast Tabs Select Input Checkbox Badge Avatar Skeleton Pagination Breadcrumbs QuantityPicker AddressForm PaymentForm OrderSummary EmptyState ErrorBoundary Carousel Accordion Tooltip Spinner Menu Dialog Gallery Filters Sort Stepper",
    7.9,
  ],
  ["ui/pages", ".tsx", "Home Product Category Cart Checkout Account Orders Order Search Login Signup Wishlist Returns NotFound Admin Settings", 8.6],
  ["ui/hooks", ".ts", "useCart useAuth useProducts useSearch useCheckout useToast useDebounce useMedia useOrders useFlags", 7.3],
  ["ui", ".tsx", "App routes theme store", 7.9],
  ["utils", ".ts", "http money dates strings arrays objects validate format slug hash retry sleep url env assert index", 7.4],
  ["workers", ".ts", "emails exports imageResize reindex reconcile cleanup digests webhooksOut scheduler index", 7.9],
  ["scripts", ".ts", "seed migrate release bench lintRules genTypes", 7.5],
  ["docs", ".md", "README ARCHITECTURE API CONTRIBUTING RUNBOOK SECURITY CHANGELOG STYLE ONBOARDING", 7.9],
];

const BIG_FILES: Readonly<Record<string, number>> = {
  "api/routes/orders.ts": 26_400,
  "ui/pages/Checkout.tsx": 33_800,
  "checkout/steps.ts": 21_300,
  "billing/ledger.ts": 19_700,
  "db/schema.ts": 29_100,
  "ui/pages/Product.tsx": 18_200,
  "search/ranking.ts": 16_900,
};

const TESTED: ReadonlyArray<[dir: string, names: string]> = [
  ["api", "orders products carts users sessions webhooks payments returns"],
  ["billing", "invoices refunds ledger money proration totals"],
  ["checkout", "cart steps payment promo tax totals"],
  ["catalog", "products pricing variants feeds search"],
  ["auth", "session tokens oauth roles"],
  ["search", "query ranking suggest"],
  ["utils", "http money dates validate"],
];

function lognormal(rng: Rng, mu: number, sigma: number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.round(Math.exp(mu + sigma * z));
}

function curatedRepo(rng: Rng): RepoFile[] {
  const out: RepoFile[] = [];
  for (const [dir, ext, names, mu] of CURATED) {
    for (const name of names.split(" ")) {
      const path = `${dir}/${name}${ext}`;
      out.push({ path, size: BIG_FILES[path] ?? Math.max(240, lognormal(rng, mu, 0.62)) });
    }
  }
  for (const [dir, names] of TESTED) {
    for (const name of names.split(" ")) out.push({ path: `test/${dir}/${name}.test.ts`, size: Math.max(400, lognormal(rng, 8.1, 0.5)) });
  }
  return out;
}

const SCALE_TOPS = "api auth billing catalog checkout core db events search ui utils workers admin analytics integrations mobile notifications platform reporting test".split(" ");
const SCALE_SUBS = "handlers models services adapters jobs views components hooks schemas routes clients fixtures commands queries policies stores widgets pipelines".split(" ");
const SCALE_NOUNS =
  "order cart user product price invoice payment session token search index report event queue cache ledger refund coupon review shipment address tenant flag metric export import feed media image note audit role policy plan quota usage webhook batch stream sync".split(
    " ",
  );
const SCALE_SUFFIX = "Service Store Handler Client Model Schema View Job Adapter Policy Query Mapper Router Worker Utils Types Config Factory Builder Parser".split(" ");

function scaledRepo(rng: Rng, n: number): RepoFile[] {
  const weights = SCALE_TOPS.map(() => 0.45 + rng());
  const totalW = weights.reduce((a, b) => a + b, 0);
  const out: RepoFile[] = [];
  const seen = new Set<string>();
  SCALE_TOPS.forEach((top, ti) => {
    const count = Math.max(6, Math.round((n * (weights[ti] ?? 1)) / totalW));
    const nSubs = Math.max(2, Math.round(Math.sqrt(count) / 2.4));
    const subs: string[] = [];
    for (let s = 0; s < nSubs; s++) {
      const name = SCALE_SUBS[(ti * 7 + s * 3) % SCALE_SUBS.length] ?? "lib";
      const dir = s >= SCALE_SUBS.length ? `${name}${s}` : name;
      subs.push(dir);
      if (count > 160 && rng() < 0.35) subs.push(`${dir}/${SCALE_SUBS[(s * 5 + ti) % SCALE_SUBS.length] ?? "impl"}`);
    }
    for (let k = 0; k < count; k++) {
      const dir = `${top}/${subs[k % subs.length] ?? "lib"}`;
      const base = `${SCALE_NOUNS[(rng() * SCALE_NOUNS.length) | 0] ?? "item"}${SCALE_SUFFIX[(rng() * SCALE_SUFFIX.length) | 0] ?? "Utils"}`;
      const ext = top === "ui" || top === "mobile" ? ".tsx" : top === "test" ? ".test.ts" : ".ts";
      let path = `${dir}/${base}${ext}`;
      if (seen.has(path)) path = `${dir}/${base}${k}${ext}`;
      seen.add(path);
      out.push({ path, size: Math.max(200, lognormal(rng, 8.0, 0.75)) });
    }
  });
  return out.slice(0, n);
}

// ---------------------------------------------------------------------------
// Rules, features, and the words agents use
// ---------------------------------------------------------------------------

interface RuleSpec {
  id: Id;
  kind: "forbid-pattern" | "forbid-import";
  description: string;
  hint: string;
  match: (path: string) => boolean;
  rate: number;
  per: [number, number];
  title: (path: string) => string;
  companion: string;
  spec: Record<string, unknown>;
}

const notTest = (p: string): boolean => !p.startsWith("test/") && !p.includes(".test.");

const INITIAL_RULES: readonly RuleSpec[] = [
  {
    id: "rule-console",
    kind: "forbid-pattern",
    description: "No console.log in server code",
    hint: "Log through core/log so output is structured and redacted.",
    match: (p) => /^(api|workers|events|auth|core)\//.test(p) && p !== "core/log.ts" && notTest(p),
    rate: 0.55,
    per: [2, 14],
    title: (p) => `Replace console.log with core/log in ${p}`,
    companion: "core/log.ts",
    spec: { pattern: "console\\.log\\(", include: ["api/**", "workers/**", "events/**", "auth/**", "core/**"], exclude: ["core/log.ts", "test/**"] },
  },
  {
    id: "rule-ui-db",
    kind: "forbid-import",
    description: "UI must not import the database layer",
    hint: "Read data through ui/hooks; the UI never imports db/.",
    match: (p) => p.startsWith("ui/") && notTest(p),
    rate: 0.4,
    per: [1, 5],
    title: (p) => `Route ${basename(p)} through ui/hooks instead of db/`,
    companion: "ui/hooks/useProducts.ts",
    spec: { from: ["ui/**"], module: "^(\\.\\./)*db(/|$)" },
  },
  {
    id: "rule-any",
    kind: "forbid-pattern",
    description: "No `any` on money paths",
    hint: "Type amounts as Money and payloads with their schemas.",
    match: (p) => /^(billing|checkout)\//.test(p) && notTest(p),
    rate: 0.66,
    per: [3, 19],
    title: (p) => `Type the \`any\`s out of ${p}`,
    companion: "utils/money.ts",
    spec: { pattern: ":\\s*any\\b", include: ["billing/**", "checkout/**"], exclude: ["test/**"] },
  },
];

/** Extra rule for generated repositories, so work reaches every region. */
const SCALE_RULE: RuleSpec = {
  id: "rule-todo-owner",
  kind: "forbid-pattern",
  description: "Every TODO names an owner",
  hint: "Unowned TODOs never get done. Write TODO(owner): what and why.",
  match: notTest,
  rate: 0.3,
  per: [1, 6],
  title: (p) => `Give every TODO in ${p} an owner`,
  companion: "core/config.ts",
  spec: { pattern: "TODO(?!\\()", include: ["**"], exclude: ["test/**"] },
};

const WAVE_RULES: readonly RuleSpec[] = [
  {
    id: "rule-fetch",
    kind: "forbid-import",
    description: "Network calls go through utils/http",
    hint: "utils/http adds retries, timeouts, and tracing. Raw fetch skips all three.",
    match: (p) => /^(catalog|search|workers|api|events|integrations)\//.test(p) && notTest(p),
    rate: 0.5,
    per: [1, 8],
    title: (p) => `Move ${p} onto utils/http`,
    companion: "utils/http.ts",
    spec: { from: ["catalog/**", "search/**", "workers/**", "api/**", "events/**"], module: "^(node-fetch|undici)$" },
  },
  {
    id: "rule-dates",
    kind: "forbid-pattern",
    description: "Date math goes through utils/dates",
    hint: "Hand-rolled date math broke month-end invoices twice this year.",
    match: (p) => /^(billing|checkout|events|ui\/pages|reporting)\//.test(p) && notTest(p),
    rate: 0.55,
    per: [1, 9],
    title: (p) => `Use utils/dates in ${p}`,
    companion: "utils/dates.ts",
    spec: { pattern: "new Date\\(|\\.getTime\\(\\)", include: ["billing/**", "checkout/**", "events/**", "ui/pages/**"], exclude: ["test/**"] },
  },
  {
    id: "rule-cart-v1",
    kind: "forbid-import",
    description: "Remove the deprecated cart v1 API",
    hint: "Cart v1 is read-only after the migration; v2 handles saved carts.",
    match: (p) => /^(ui|checkout|api\/routes|mobile)\//.test(p) && notTest(p),
    rate: 0.34,
    per: [1, 6],
    title: (p) => `Drop cart v1 calls from ${p}`,
    companion: "checkout/cart.ts",
    spec: { from: ["ui/**", "checkout/**", "api/routes/**"], module: "cart/v1" },
  },
];

const FEATURES: ReadonlyArray<[title: string, why: string, dirs: string[]]> = [
  ["Add gift cards to checkout", "Gift cards are the most requested feature in support tickets this quarter.", ["checkout", "billing", "ui"]],
  ["Show delivery estimates on product pages", "Shoppers leave when they can't tell when an order will arrive.", ["catalog", "ui", "api"]],
  ["Support partial refunds", "Support issues full refunds today because partial ones need an engineer.", ["billing", "api", "events"]],
  ["Suggest searches while typing", "Half of all searches get retyped at least once.", ["search", "ui", "api"]],
  ["Rate-limit the public API per tenant", "One tenant's import job slowed checkout for everyone last week.", ["api", "core", "auth"]],
  ["Keep carts across devices", "Signed-in shoppers lose their cart when they switch to mobile.", ["checkout", "db", "ui"]],
  ["Send receipts in the shopper's language", "Receipts go out in English to every market.", ["workers", "billing", "events"]],
  ["Audit log for admin role changes", "The security review asked for a trail of every privilege change.", ["auth", "db", "events"]],
];

const HISTORY_TITLES: readonly string[] = [
  "Initial import of the storefront",
  "Extract structured logging into core/log",
  "Split checkout into explicit steps",
  "Index products by variant for faster search",
  "Move money math into utils/money",
  "Add idempotency keys to payment capture",
  "Introduce the outbox for order events",
  "Replace session cookies with signed tokens",
];

const NOT_VERIFIED: readonly string[] = [
  "Behavior under production traffic volumes.",
  "Visual rendering in older mobile browsers.",
  "Interaction with the nightly export job.",
  "Latency of the search indexer after the change.",
  "Currency rounding for JPY and KWD.",
  "Email rendering in desktop mail clients.",
];

const FAIL_DETAILS: readonly string[] = [
  "typecheck: TS2322 Type 'string' is not assignable to type 'Money'",
  "unit: expected 3 line items, received 2",
  "rules: write set re-introduces console.log",
  "typecheck: TS2345 Argument of type 'Cart' is not assignable to 'CartV2'",
  "unit: refund total off by one cent",
];

const REVIEWERS: readonly string[] = ["dana (reviewer)", "sam (on call)", "priya (owner)"];

/** What a simulated agent reports when it finds an intent cannot be done as written ({file} is the intent's first file). */
const REPORTS: ReadonlyArray<[kind: EscalationKind, report: string]> = [
  ["broken-test", "test/{base}.test.ts expects the old rounding (0.335 rounds to 0.33), but the rule asks for utils/money, which rounds half up. The test fails either way; it needs a person to say which behavior is right."],
  ["contradictory-spec", "The intent says to keep the v1 cart response shape for mobile, and the rule forbids importing cart/v1 from {file}. I can't satisfy both from this file."],
  ["impossible", "{file} has no caller left after the v2 migration. There is nothing to change here; deleting the file is outside the footprint."],
  ["other", "The footprint names {file}, but the logic moved to core/http.ts two landings ago. Should the intent follow it?"],
];

/** How a simulated reviewer answers a report nobody answered. */
const ANSWERS: ReadonlyArray<[decision: "amend" | "withdraw" | "dismiss", note: string]> = [
  ["dismiss", "The test is right: keep half-even rounding and fix the call site instead."],
  ["dismiss", "Both hold: keep the shape with a v2 adapter in this file."],
  ["amend", "Point the intent at the file the logic moved to."],
  ["withdraw", "Not needed after the migration."],
];

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

type DecisionLite = Pick<Decision, "kind" | "layer" | "p" | "action">;

interface SimIntent {
  intent: Intent;
  violations: number;
  needs: Array<[path: string, weight: number]>;
  region: string;
  openIdx: number;
  openedT: number;
  decisions: DecisionLite[];
  /** Contest mode: the agents building it at once. */
  holders: Set<SimAgent>;
}

interface SimAgent {
  id: Id;
  kind: AgentKind;
  model: string;
  state: AgentState;
  intent: SimIntent | null;
  proposal: SimProposal | null;
  next: number;
  n: number;
}

interface SimProposal {
  p: Proposal;
  region: string;
  stage: "pending" | "checking" | "ready" | "escalated" | "done";
  next: number;
  baseT: number;
  escalatedAt: number;
  agent: SimAgent;
  intent: SimIntent;
  decisions: DecisionLite[];
  fail: string | null;
  residual: string | null;
  /** Assumption revalidation: files that changed after it read them, and the names that still held. */
  revalidated?: Array<{ path: string; read: string | null; landedOn: string | null; names: string[] }>;
}

interface Lane {
  region: string;
  queue: SimProposal[];
  next: number;
}

interface Spike {
  region: string;
  startT: number;
  peakT: number;
  endT: number;
  peak: number;
  danger: string[];
}

/** The colony simulator behind MockBackend (exported for tests). */
export class ColonySim {
  private readonly rng: Rng;
  private readonly colony: Colony;
  private readonly files: RepoFile[];
  private readonly fileSet: Set<string>;
  private readonly byRegion = new Map<string, string[]>();
  private readonly regions: string[];
  private readonly intents = new Map<Id, SimIntent>();
  private readonly open: SimIntent[] = [];
  private readonly agents: SimAgent[] = [];
  private readonly inflight = new Set<SimProposal>();
  private readonly lanes = new Map<string, Lane>();
  private readonly need = new Map<string, number>();
  private readonly claims = new Map<string, number>();
  private readonly regionClaims = new Map<string, number>();
  private readonly landedAt = new Map<string, number>();
  private readonly failures = new Set<string>();
  private readonly sigma = new Map<string, { value: number; sent: number; sentT: number }>();
  private readonly closed = new Set<string>();
  private readonly history: WhyEntry[] = [];
  private readonly byRule: Record<Id, number> = {};
  private readonly rules: Rule[] = [];
  private readonly funnel: Record<DecisionLayer, number> = { reflex: 18_442, llm: 611, human: 23 };
  private readonly scheduled: Array<{ t: number; fn: () => void }> = [];
  private pending: ColonyEvent[] = [];
  private violations = 0;
  private trunkSha: string;
  private t = 0;
  private now = Date.now();
  private lastReal = Date.now();
  private counter = 0;
  private spawned = 0;
  private spawnMs: number;
  private batchMax: number;
  private laneBase: number;
  private nextSigmaT = 1500;
  private nextSpikeT = 26_000;
  private nextFeatureT = 14_000;
  private nextBurstT = 20_000;
  private spike: Spike | null = null;
  private cleanSince = 0;
  private waveNo = 0;
  private nextVaccineT = 4000;
  private nextReportT = 30_000;
  private readonly vaccine = { seeded: 38, caught: 37, antibodies: 4, hits: 11 };

  constructor(
    readonly colonyId: string,
    private readonly opts: MockOptions,
  ) {
    this.rng = mulberry32(opts.seed);
    this.files = opts.files > 0 ? scaledRepo(this.rng, opts.files) : curatedRepo(this.rng);
    this.fileSet = new Set(this.files.map((f) => f.path));
    for (const f of this.files) {
      const r = regionOf(f.path);
      const list = this.byRegion.get(r) ?? [];
      list.push(f.path);
      this.byRegion.set(r, list);
    }
    this.regions = [...this.byRegion.keys()];
    for (const r of this.regions) {
      this.sigma.set(r, { value: 0.3 + this.rng() * 0.25, sent: -1, sentT: -1e9 });
      this.lanes.set(r, { region: r, queue: [], next: 2000 + this.rng() * 2500 });
    }
    const a = opts.agents;
    this.spawnMs = Math.min(9000, 2200 + a * 0.7);
    this.batchMax = Math.min(40, Math.max(6, Math.round(a / 40)));
    this.laneBase = 4200 / Math.min(5, Math.max(1, Math.sqrt(a / 64)));
    this.trunkSha = this.hex(40);
    const created = Date.now() - 3 * 86_400_000;
    this.colony = {
      id: colonyId,
      name: opts.files > 0 ? `copperleaf/platform` : "copperleaf/storefront",
      trunk: { namespace: "ft-trunk", name: `${colonyId}--trunk`, remote: `https://artifacts.example/ft-trunk/${colonyId}--trunk.git` },
      trunkSha: this.trunkSha,
      greenSha: this.hex(40),
      source: { url: "https://git.example.com/copperleaf/storefront", branch: "main" },
      createdAt: created,
      regionDepth: 1,
    };
    this.seedHistory();
    for (const rule of INITIAL_RULES) this.addRule(rule, false);
    if (opts.files > 0) this.addRule(SCALE_RULE, false);
  }

  // -- randomness ------------------------------------------------------------

  private r(): number {
    return this.rng();
  }
  private range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.rng();
  }
  private int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }
  private pick<T>(arr: readonly T[]): T {
    return arr[(this.rng() * arr.length) | 0] as T;
  }
  private hex(n: number): string {
    return hexFrom(this.rng, n);
  }
  private id(prefix: string): Id {
    return `${prefix}_${(this.counter++).toString(36).padStart(4, "0")}${this.hex(3)}`;
  }

  // -- emission --------------------------------------------------------------

  private emit(ev: ColonyEvent): void {
    this.pending.push(ev);
  }

  private mark(path: string, kind: MarkKind, value: number): void {
    this.emit({ t: "mark", at: this.now, region: regionOf(path), path, kind, value: round(Math.max(0, value), 2) });
  }

  private agentEvent(a: SimAgent, state: AgentState, paths?: string[]): void {
    a.state = state;
    this.emit({ t: "agent", at: this.now, agentId: a.id, kind: a.kind, state, intentId: a.intent?.intent.id, paths });
  }

  private decide(kind: DecisionKind, layer: DecisionLayer, p: number, action: string, subject: Id, into?: DecisionLite[]): void {
    const d: DecisionLite = { kind, layer, p: round(p), action };
    this.funnel[layer]++;
    into?.push(d);
    this.emit({ t: "decision", at: this.now, decisionId: this.id("dec"), kind, layer, p: d.p, action, subject });
  }

  private proposalEvent(sp: SimProposal, reason?: string): void {
    this.emit({ t: "proposal", at: this.now, proposalId: sp.p.id, intentId: sp.intent.intent.id, agentId: sp.agent.id, status: sp.p.status, reason });
  }

  private intentEvent(si: SimIntent): void {
    const i = si.intent;
    const ev: ColonyEvent = { t: "intent", at: this.now, intentId: i.id, status: i.status, title: i.title, footprint: i.footprint };
    // Contest intents say so on their events too (the UI also reads it from the snapshot and the contest event).
    // Each event also names where its intent came from, which the colony leaves to its snapshot (the store reads both).
    const origin = { source: i.source, priority: i.priority, ...(i.ruleId ? { ruleId: i.ruleId } : {}), ...(i.parentId ? { parentId: i.parentId } : {}) };
    this.emit({ ...ev, ...origin, ...(i.contest ? { contest: i.contest } : {}) } as ColonyEvent);
  }

  /** The rules declared so far (a rule declared while the simulator runs reaches the page through MockBackend). */
  ruleList(): Rule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  /** How many rules are declared. */
  get ruleCount(): number {
    return this.rules.length;
  }

  private violationsEvent(): void {
    this.emit({ t: "violations", at: this.now, total: this.violations, byRule: { ...this.byRule } });
  }

  // -- intents ---------------------------------------------------------------

  private addIntent(
    title: string,
    why: string,
    source: IntentSource,
    footprint: string[],
    priority: number,
    violations: number,
    needs: Array<[string, number]>,
    extra: { ruleId?: Id; parentId?: Id } = {},
  ): SimIntent {
    const intent: Intent = {
      id: this.id("int"),
      colonyId: this.colonyId,
      title,
      why,
      source,
      ruleId: extra.ruleId,
      parentId: extra.parentId,
      footprint,
      priority,
      status: "open",
      createdAt: this.now,
      createdBy: source === "rule" ? "morphology" : source === "human" ? "maya@copperleaf" : "colony",
    };
    const si: SimIntent = { intent, violations, needs, region: regionOf(footprint[0] ?? ""), openIdx: -1, openedT: this.t, decisions: [], holders: new Set() };
    this.intents.set(intent.id, si);
    this.pushOpen(si);
    return si;
  }

  private pushOpen(si: SimIntent): void {
    si.openIdx = this.open.length;
    si.openedT = this.t;
    this.open.push(si);
  }

  private removeOpen(si: SimIntent): void {
    const i = si.openIdx;
    if (i < 0) return;
    const last = this.open.pop();
    if (last && last !== si) {
      this.open[i] = last;
      last.openIdx = i;
    }
    si.openIdx = -1;
  }

  private addNeeds(si: SimIntent, live: boolean): void {
    for (const [path, w] of si.needs) {
      const v = (this.need.get(path) ?? 0) + w;
      this.need.set(path, v);
      if (live) this.mark(path, "need", v);
    }
  }

  private releaseNeeds(si: SimIntent): void {
    for (const [path, w] of si.needs) {
      const v = Math.max(0, (this.need.get(path) ?? 0) - w);
      if (v > 0) this.need.set(path, v);
      else this.need.delete(path);
      this.mark(path, "need", v);
    }
  }

  /** Turn a rule into violations and intents (chunks of a few violations per intent). */
  private addRule(rule: RuleSpec, live: boolean): void {
    const created: SimIntent[] = [];
    let total = 0;
    this.rules.push({ id: rule.id, colonyId: this.colonyId, kind: rule.kind, spec: { ...rule.spec, hint: rule.hint }, description: rule.description, approvedBy: "maya@copperleaf", createdAt: this.now });
    const why = `${rule.description}. ${rule.hint}`;
    for (const f of this.files) {
      if (!rule.match(f.path) || this.r() > rule.rate) continue;
      const v = this.int(rule.per[0], rule.per[1]);
      total += v;
      const parts = Math.min(3, Math.ceil(v / 5));
      for (let part = 1; part <= parts; part++) {
        const share = Math.floor(v / parts) + (part <= v % parts ? 1 : 0);
        const footprint = [f.path];
        if (this.fileSet.has(rule.companion) && this.r() < 0.16) footprint.push(rule.companion);
        const test = `test/${f.path.replace(/\.(tsx?|sql|md)$/, ".test.ts")}`;
        if (this.fileSet.has(test) && this.r() < 0.4) footprint.push(test);
        const title = parts > 1 ? `${rule.title(f.path)} (${part}/${parts})` : rule.title(f.path);
        created.push(this.addIntent(title, why, "rule", footprint, 1 + this.r() * 0.8, share, [[f.path, share]], { ruleId: rule.id }));
      }
    }
    if (!live) {
      this.byRule[rule.id] = (this.byRule[rule.id] ?? 0) + total;
      this.violations += total;
      for (const si of created) this.addNeeds(si, false);
      return;
    }
    // A live rule spreads across the map as a wave: needs pop in, the count climbs.
    // Each intent becomes claimable only when it is revealed.
    for (const si of created) this.removeOpen(si);
    const order = created.map((si) => ({ si, t: this.t + this.range(0, 2800) })).sort((a, b) => a.t - b.t);
    for (const { si, t } of order) {
      this.schedule(t, () => {
        this.pushOpen(si);
        this.addNeeds(si, true);
        this.intentEvent(si);
        this.violations += si.violations;
        this.byRule[rule.id] = (this.byRule[rule.id] ?? 0) + si.violations;
        this.violationsEvent();
      });
    }
  }

  private addFeature(): void {
    const [title, why, dirs] = this.pick(FEATURES);
    const footprint: string[] = [];
    for (const d of dirs) {
      const list = this.byRegion.get(d);
      if (!list?.length) continue;
      const n = this.int(1, 2);
      for (let i = 0; i < n; i++) {
        const p = this.pick(list);
        if (!footprint.includes(p)) footprint.push(p);
      }
    }
    if (!footprint.length) return;
    const si = this.addIntent(
      title,
      why,
      "human",
      footprint,
      3,
      0,
      footprint.map((p): [string, number] => [p, 1]),
    );
    // Contest mode: half of the features are built by two (now and then three) agents at once.
    if (this.r() < 0.5) si.intent.contest = this.r() < 0.8 ? 2 : 3;
    this.addNeeds(si, true);
    this.intentEvent(si);
  }

  // -- agents ----------------------------------------------------------------

  private spawnAgent(): void {
    const n = ++this.spawned;
    const roll = this.r();
    const kind: AgentKind = roll < 0.7 ? "internal" : roll < 0.92 ? "external" : "synthetic";
    const num = String(n).padStart(this.opts.agents >= 1000 ? 5 : 3, "0");
    const id = kind === "internal" ? `forager-${num}` : kind === "external" ? `visitor-${num}` : `drone-${num}`;
    const model = kind === "internal" ? (this.r() < 0.6 ? "workers-ai/code-large" : "workers-ai/code-flash") : kind === "external" ? "external/mcp-client" : "bench/scripted";
    const a: SimAgent = { id, kind, model, state: "idle", intent: null, proposal: null, next: this.t + this.range(200, 1600), n };
    this.agents.push(a);
    // An agent's first event names its model, so agents that join after the page opened show one on the map.
    this.emit({ t: "agent", at: this.now, agentId: a.id, kind: a.kind, state: "idle", model } as ColonyEvent);
  }

  private repulsion(footprint: readonly string[]): number {
    let r = 0;
    for (const p of footprint) r += this.claims.get(p) ?? 0;
    return r;
  }

  private pickIntent(): SimIntent | null {
    const n = this.open.length;
    if (!n) return null;
    let best: SimIntent | null = null;
    let bestScore = -Infinity;
    for (let s = 0; s < Math.min(n, 7); s++) {
      const si = this.open[(this.r() * n) | 0];
      if (!si) continue;
      const ageMin = (this.t - si.openedT) / 60_000;
      const score = si.intent.priority * (1 + ageMin / 10) - 1.4 * this.repulsion(si.intent.footprint) + this.r() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = si;
      }
    }
    return best;
  }

  private tryTake(a: SimAgent): void {
    const si = this.pickIntent();
    if (!si) {
      if (a.state !== "waiting") this.agentEvent(a, "waiting");
      a.next = this.t + this.range(2000, 5000);
      return;
    }
    if (this.closed.has(si.region) && this.r() < 0.75) {
      if (this.r() < 0.35) this.decide("admission", "reflex", this.range(0.9, 0.99), "wait", si.intent.id);
      if (a.state !== "waiting") this.agentEvent(a, "waiting");
      a.next = this.t + this.range(2500, 5000);
      return;
    }
    const rep = this.repulsion(si.intent.footprint);
    if (rep > 0) {
      if (this.r() < 0.72) {
        this.decide("collision", "reflex", this.range(0.86, 0.995), "defer", si.intent.id);
        a.next = this.t + this.range(250, 800);
        return;
      }
      if (this.r() < 0.12) this.decide("collision", "llm", this.range(0.58, 0.82), "share", si.intent.id, si.decisions);
      else this.decide("collision", "reflex", this.range(0.8, 0.95), "share", si.intent.id, si.decisions);
    } else if (this.r() < 0.45) {
      this.decide("admission", "reflex", this.range(0.92, 0.995), "take", si.intent.id, si.decisions);
    }
    this.claim(a, si);
  }

  private claim(a: SimAgent, si: SimIntent): void {
    // A contest intent stays open until it has as many holders as its contest allows.
    si.holders.add(a);
    if (!si.intent.contest || si.holders.size >= si.intent.contest) this.removeOpen(si);
    si.intent.status = "claimed";
    si.intent.assignedTo = a.id;
    a.intent = si;
    this.intentEvent(si);
    this.agentEvent(a, "working", si.intent.footprint);
    for (const p of si.intent.footprint) {
      const c = (this.claims.get(p) ?? 0) + 1;
      this.claims.set(p, c);
      this.mark(p, "claim", c);
    }
    this.regionClaims.set(si.region, (this.regionClaims.get(si.region) ?? 0) + 1);
    // What the agent says it is doing now (some agents relay a note as they start).
    if (this.r() < 0.35) this.emit({ t: "status", at: this.now, agentId: a.id, intentId: si.intent.id, note: `reading ${si.intent.footprint.slice(0, 2).join(", ")} for "${si.intent.title}"` });
    // The first wave lands quickly so the opening shot has motion; later work takes longer.
    const work = this.t < 25_000 ? this.range(4500, 15_000) : this.range(14_000, 40_000);
    a.next = this.t + work * (si.intent.source === "human" ? 1.6 : 1);
  }

  private releaseClaims(si: SimIntent): void {
    for (const p of si.intent.footprint) {
      const c = Math.max(0, (this.claims.get(p) ?? 0) - 1);
      if (c) this.claims.set(p, c);
      else this.claims.delete(p);
      this.mark(p, "claim", c);
    }
    this.regionClaims.set(si.region, Math.max(0, (this.regionClaims.get(si.region) ?? 0) - 1));
  }

  private submit(a: SimAgent): void {
    const si = a.intent;
    if (!si) {
      a.state = "idle";
      a.next = this.t + 500;
      return;
    }
    const writeSet: FileVersion[] = si.intent.footprint.map((path) => ({ path, blob: this.hex(40) }));
    let residual: string | null = null;
    if (this.r() < 0.065) {
      const pool = this.byRegion.get(this.pick(this.regions)) ?? [];
      const candidate = pool.length ? this.pick(pool) : null;
      if (candidate && !si.intent.footprint.includes(candidate)) {
        residual = candidate;
        writeSet.push({ path: candidate, blob: this.hex(40) });
      }
    }
    const neighbors = this.byRegion.get(si.region) ?? [];
    const reads = new Set(si.intent.footprint);
    for (let i = 0; i < this.int(1, 3) && neighbors.length; i++) reads.add(this.pick(neighbors));
    const p: Proposal = {
      id: this.id("prp"),
      colonyId: this.colonyId,
      intentId: si.intent.id,
      agentId: a.id,
      workspace: { namespace: `ft-ws-${a.n % 4}`, name: `${this.colonyId}--ws-${a.n}`, remote: `https://artifacts.example/ft-ws-${a.n % 4}/${this.colonyId}--ws-${a.n}.git` },
      baseSha: this.trunkSha,
      headSha: this.hex(40),
      writeSet,
      readSet: [...reads].map((path) => ({ path, blob: this.hex(40) })),
      declared: { footprint: [...si.intent.footprint], summary: si.intent.title },
      evidence: { checks: [], residual: residual ? [residual] : [], notVerified: this.pick(NOT_VERIFIED) },
      status: "pending",
      createdAt: this.now,
    };
    const fail = this.r() < 0.07 ? this.pick(FAIL_DETAILS) : null;
    const sp: SimProposal = { p, region: si.region, stage: "pending", next: this.t + this.range(300, 800), baseT: this.t, escalatedAt: 0, agent: a, intent: si, decisions: [...si.decisions], fail, residual };
    a.proposal = sp;
    this.inflight.add(sp);
    si.intent.status = "proposed";
    this.proposalEvent(sp);
    this.agentEvent(a, "proposing");
    if (this.r() < 0.2) this.emit({ t: "status", at: this.now, agentId: a.id, intentId: si.intent.id, note: `proposing ${writeSet.length} ${writeSet.length === 1 ? "file" : "files"} for "${si.intent.title}"` });
  }

  private advance(sp: SimProposal): void {
    const a = sp.agent;
    if (sp.stage === "pending") {
      sp.stage = "checking";
      sp.p.status = "checking";
      sp.next = this.t + this.range(900, 2400);
      this.proposalEvent(sp);
      return;
    }
    if (sp.stage !== "checking") return;
    const checks: CheckResult[] = [
      { name: "typecheck", ok: true, ms: this.int(600, 2400) },
      { name: "unit", ok: true, ms: this.int(1200, 6400) },
      { name: "rules", ok: true, ms: this.int(80, 420), detail: "morphology re-checked on the write set" },
    ];
    if (sp.fail) {
      const name = sp.fail.split(":")[0] ?? "unit";
      const c = checks.find((x) => x.name === name);
      if (c) {
        c.ok = false;
        c.detail = sp.fail;
      }
      sp.p.evidence.checks = checks;
      this.finish(sp, "returned", `Checks failed: ${sp.fail}`);
      this.decide("triage", "reflex", this.range(0.9, 0.99), "retry", sp.p.id, sp.intent.decisions);
      const target = sp.intent.intent.footprint[0];
      if (target) {
        this.mark(target, "failure", 1);
        this.failures.add(target);
      }
      a.proposal = null;
      sp.intent.intent.status = "claimed";
      this.agentEvent(a, "working", sp.intent.intent.footprint);
      a.next = this.t + this.range(4000, 10_000);
      return;
    }
    sp.p.evidence.checks = checks;
    if (sp.residual) {
      const p = this.range(0.52, 0.9);
      if (p < 0.7) {
        this.decide("overlap", "llm", p, "escalate", sp.p.id, sp.decisions);
        sp.stage = "escalated";
        sp.escalatedAt = this.t;
        sp.p.status = "escalated";
        sp.p.reason = `Residual: wrote ${sp.residual}, outside the declared footprint. The overlap model was unsure (p ${p.toFixed(2)}).`;
        this.proposalEvent(sp, sp.p.reason);
        this.agentEvent(a, "waiting");
        return;
      }
      this.decide("overlap", "llm", p, "accept", sp.p.id, sp.decisions);
    }
    this.toLane(sp);
  }

  private toLane(sp: SimProposal): void {
    sp.stage = "ready";
    sp.p.status = "ready";
    this.proposalEvent(sp);
    this.agentEvent(sp.agent, "waiting");
    this.lanes.get(sp.region)?.queue.push(sp);
  }

  private finish(sp: SimProposal, status: "returned" | "rejected", reason: string): void {
    sp.stage = "done";
    sp.p.status = status;
    sp.p.reason = reason;
    this.inflight.delete(sp);
    this.proposalEvent(sp, reason);
  }

  private returnStale(sp: SimProposal, path: string): void {
    this.finish(sp, "returned", `Stale read: ${path} changed in ${this.trunkSha.slice(0, 7)} after base ${sp.p.baseSha.slice(0, 7)}. Rebase and retry.`);
    const llm = this.r() < 0.18;
    this.decide("conflict", llm ? "llm" : "reflex", llm ? this.range(0.6, 0.86) : this.range(0.88, 0.99), "rebase", sp.p.id, sp.intent.decisions);
    this.mark(path, "failure", 0.7);
    this.failures.add(path);
    const a = sp.agent;
    a.proposal = null;
    sp.intent.intent.status = "claimed";
    this.agentEvent(a, "working", sp.intent.intent.footprint);
    a.next = this.t + this.range(2500, 6000);
  }

  // -- lanes and landing -----------------------------------------------------

  private laneInterval(region: string): number {
    const inhibition = this.closed.has(region) ? 2.2 : 1;
    return this.laneBase * this.range(0.7, 1.35) * inhibition;
  }

  private tickLane(lane: Lane): void {
    const batch: SimProposal[] = [];
    const used = new Set<string>();
    const keep: SimProposal[] = [];
    for (const sp of lane.queue) {
      if (sp.stage !== "ready") continue;
      if (batch.length >= this.batchMax) {
        keep.push(sp);
        continue;
      }
      const stale = sp.p.writeSet.find((w) => (this.landedAt.get(w.path) ?? -1) > sp.baseT);
      if (stale && this.r() < 0.6) {
        this.returnStale(sp, stale.path);
        continue;
      }
      const staleRead = stale || sp.revalidated ? undefined : sp.p.readSet.find((r) => !sp.p.writeSet.some((w) => w.path === r.path) && (this.landedAt.get(r.path) ?? -1) > sp.baseT);
      if (staleRead) {
        if (this.r() < 0.45) {
          this.returnStale(sp, staleRead.path);
          continue;
        }
        // Assumption revalidation: only a file it read changed, and every name it imports from that file is still exported.
        const names = this.namesOf(staleRead.path);
        sp.revalidated = [{ path: staleRead.path, read: staleRead.blob, landedOn: this.hex(40), names }];
        this.emit({ t: "revalidated", at: this.now, proposalId: sp.p.id, intentId: sp.intent.intent.id, paths: [staleRead.path], names });
      }
      if (sp.p.writeSet.some((w) => used.has(w.path))) {
        keep.push(sp);
        continue;
      }
      for (const w of sp.p.writeSet) used.add(w.path);
      batch.push(sp);
    }
    lane.queue = keep;
    if (batch.length) this.land(batch);
    lane.next = this.t + this.laneInterval(lane.region);
  }

  private land(batch: SimProposal[]): void {
    const parent = this.trunkSha;
    this.trunkSha = this.hex(40);
    const paths = [...new Set(batch.flatMap((sp) => sp.p.writeSet.map((w) => w.path)))];
    const landing: Landing = {
      id: this.id("lnd"),
      colonyId: this.colonyId,
      trunkSha: this.trunkSha,
      parentSha: parent,
      proposalIds: batch.map((sp) => sp.p.id),
      intentIds: batch.map((sp) => sp.intent.intent.id),
      paths,
      regions: [...new Set(paths.map((p) => regionOf(p)))],
      at: this.now,
    };
    this.emit({ t: "landing", at: this.now, landingId: landing.id, trunkSha: landing.trunkSha, proposalIds: landing.proposalIds, paths });
    // Contest mode: the other holders' attempts lose to the one landing now.
    const rivals = new Map<SimProposal, SimAgent[]>();
    for (const sp of batch) if (sp.intent.intent.contest) rivals.set(sp, [...sp.intent.holders].filter((h) => h !== sp.agent));
    const alternatives = (sp: SimProposal) =>
      (rivals.get(sp) ?? [])
        .filter((h) => h.proposal)
        .map((h) => ({ proposalId: h.proposal?.p.id ?? "", agentId: h.id, model: h.model, reason: h.proposal?.stage === "ready" ? "Still waiting in its lane when this attempt landed." : "Still being checked when this attempt landed." }));
    const note: LineageNote = {
      schema: "firetrident.lineage/v1",
      landingId: landing.id,
      colonyId: this.colonyId,
      proposals: batch.map((sp) => {
        const alt = alternatives(sp);
        return {
          id: sp.p.id,
          agentId: sp.agent.id,
          agentKind: sp.agent.kind,
          model: sp.agent.model,
          intent: { id: sp.intent.intent.id, title: sp.intent.intent.title, why: sp.intent.intent.why, ruleId: sp.intent.intent.ruleId, parentId: sp.intent.intent.parentId },
          writeSet: sp.p.writeSet,
          readSet: sp.p.readSet,
          decisions: sp.decisions,
          evidence: sp.p.evidence,
          ...(alt.length ? { alternatives: alt } : {}),
          ...(sp.revalidated?.length ? { revalidated: sp.revalidated } : {}),
          provenance: simProvenance(sp.agent.kind, sp.agent.model, sp.p.id),
        };
      }),
    };
    this.history.push({ landing, note });
    if (this.history.length > 900) this.history.splice(0, 300);
    let fixed = false;
    for (const sp of batch) {
      sp.stage = "done";
      sp.p.status = "landed";
      sp.p.landingId = landing.id;
      this.inflight.delete(sp);
      this.proposalEvent(sp);
      const si = sp.intent;
      si.intent.status = "landed";
      this.intentEvent(si);
      this.releaseNeeds(si);
      this.releaseClaims(si);
      if (si.violations > 0 && si.intent.ruleId) {
        this.violations = Math.max(0, this.violations - si.violations);
        this.byRule[si.intent.ruleId] = Math.max(0, (this.byRule[si.intent.ruleId] ?? 0) - si.violations);
        fixed = true;
      }
      const a = sp.agent;
      a.intent = null;
      a.proposal = null;
      this.agentEvent(a, "idle");
      a.next = this.t + this.range(400, 2400);
      const lost = this.settleContest(sp, rivals.get(sp) ?? [], alternatives(sp));
      si.holders.clear();
      if (lost) this.emit({ t: "contest", at: this.now, intentId: si.intent.id, title: si.intent.title, winner: sp.p.id, losers: lost, reason: "It passed its checks and reached its lane first." });
      if (this.r() < 0.05) this.followUp(si);
    }
    for (const path of paths) {
      this.landedAt.set(path, this.t);
      this.mark(path, "trail", 1);
      if (this.failures.delete(path)) this.mark(path, "failure", 0);
    }
    if (fixed) this.violationsEvent();
    this.notify(landing, batch);
  }

  /** The other holders of a contest intent stop: proposals in flight go back as superseded. Returns their ids, or null when none had proposed. */
  private settleContest(winner: SimProposal, rivals: readonly SimAgent[], alternatives: ReadonlyArray<{ proposalId: string }>): Id[] | null {
    for (const h of rivals) {
      if (h.intent !== winner.intent) continue;
      const own = h.proposal;
      if (own) {
        const lane = this.lanes.get(own.region);
        const at = lane ? lane.queue.indexOf(own) : -1;
        if (lane && at >= 0) lane.queue.splice(at, 1);
        this.finish(own, "returned", `superseded by ${winner.p.id}: another attempt at this intent landed first`);
      }
      this.releaseClaims(winner.intent);
      h.intent = null;
      h.proposal = null;
      this.agentEvent(h, "idle");
      h.next = this.t + this.range(600, 2000);
    }
    const ids = alternatives.map((x) => x.proposalId).filter(Boolean);
    return ids.length ? ids : null;
  }

  /**
   * Landing notices: agents working in the regions a landing touched hear which files changed under
   * them (directive events of kind "landing"), a few agents for some landings.
   */
  private notify(landing: Landing, batch: readonly SimProposal[]): void {
    if (this.r() > 0.25) return;
    const landed = new Set(batch.map((sp) => sp.agent));
    const regions = new Set(landing.regions);
    const told = this.agents.filter((a) => a.intent && !landed.has(a) && (a.state === "working" || a.state === "proposing") && regions.has(a.intent.region)).slice(0, this.int(1, 4));
    const title = batch[0]?.intent.intent.title ?? "a landing";
    for (const a of told) {
      const path = landing.paths.find((p) => regionOf(p) === a.intent?.region) ?? landing.paths[0] ?? "";
      this.emit({ t: "directive", at: this.now, directiveId: this.id("dir"), agentId: a.id, intentId: a.intent?.intent.id, message: `${path} changed on trunk (${landing.trunkSha.slice(0, 7)}): ${title}`, by: "colony", via: "push", kind: "landing" });
    }
  }

  /** Names a change might import from a file, made from its file name (`cart.ts` gives Cart, createCart, ...). */
  private namesOf(path: string): string[] {
    const base = basename(path)
      .replace(/\.[a-z]+$/i, "")
      .replace(/[^a-zA-Z0-9]+(.)/g, (_m, c: string) => c.toUpperCase());
    const cap = base.charAt(0).toUpperCase() + base.slice(1);
    return [cap, `create${cap}`, `${base}Schema`].slice(0, this.int(1, 3));
  }

  private followUp(parent: SimIntent): void {
    const file = parent.intent.footprint[0];
    if (!file) return;
    const test = `test/${file.replace(/\.(tsx?|sql|md)$/, ".test.ts")}`;
    const target = this.fileSet.has(test) ? test : file;
    const si = this.addIntent(
      `Add a regression test for ${basename(file)}`,
      `Spawned after ${parent.intent.title.toLowerCase()} landed: the change has no test pinning the new behavior.`,
      "agent",
      [target],
      1.4,
      0,
      [[target, 0.6]],
      { parentId: parent.intent.id },
    );
    this.addNeeds(si, true);
    this.intentEvent(si);
  }

  // -- criticality governor --------------------------------------------------

  private updateSigma(): void {
    this.nextSigmaT = this.t + 1200;
    if (!this.spike && this.t >= this.nextSpikeT) this.startSpike();
    const perRegion = Math.max(2, (this.agents.length / Math.max(1, this.regions.length)) * 0.9);
    for (const region of this.regions) {
      const s = this.sigma.get(region);
      if (!s) continue;
      const busy = this.regionClaims.get(region) ?? 0;
      let target = 0.24 + 0.5 * Math.min(1, busy / perRegion) + (this.r() - 0.5) * 0.08;
      const sp = this.spike;
      if (sp && sp.region === region) {
        const u = Math.min(1, (this.t - sp.startT) / Math.max(1, sp.peakT - sp.startT));
        target = this.t < sp.endT ? 0.85 + (sp.peak - 0.85) * u : 0.6;
      }
      s.value += (target - s.value) * 0.45;
      if (Math.abs(s.value - s.sent) > 0.03 || this.t - s.sentT > 8000) {
        s.sent = s.value;
        s.sentT = this.t;
        this.emit({ t: "sigma", at: this.now, region, sigma: round(s.value) });
      }
    }
    if (this.spike && this.t >= this.spike.endT) this.endSpike();
  }

  private startSpike(): void {
    const ranked = [...this.regions].sort((a, b) => (this.regionClaims.get(b) ?? 0) - (this.regionClaims.get(a) ?? 0));
    const region = this.pick(ranked.slice(0, 3));
    const list = this.byRegion.get(region) ?? [];
    const danger: string[] = [];
    for (let i = 0; i < Math.min(list.length, this.int(3, 6)); i++) {
      const p = this.pick(list);
      if (!danger.includes(p)) danger.push(p);
    }
    this.spike = { region, startT: this.t, peakT: this.t + 2600, endT: this.t + this.range(9000, 13_000), peak: this.range(1.18, 1.62), danger };
    for (const p of danger) this.mark(p, "danger", this.range(1.0, 1.8));
    this.closed.add(region);
    this.decide("admission", "reflex", this.range(0.95, 0.99), "close region", region);
    // A rebase storm: a few queued proposals in the region go stale at once.
    const lane = this.lanes.get(region);
    if (lane) {
      let n = this.int(1, 3);
      for (const sp of [...lane.queue]) {
        if (n-- <= 0 || sp.stage !== "ready") break;
        const path = sp.p.writeSet[0]?.path ?? danger[0] ?? region;
        lane.queue.splice(lane.queue.indexOf(sp), 1);
        this.returnStale(sp, path);
      }
    }
  }

  private endSpike(): void {
    const sp = this.spike;
    if (!sp) return;
    this.spike = null;
    this.closed.delete(sp.region);
    this.decide("admission", "reflex", this.range(0.93, 0.99), "open region", sp.region);
    for (const p of sp.danger) this.mark(p, "danger", 0.3);
    this.schedule(this.t + 3500, () => {
      for (const p of sp.danger) this.mark(p, "danger", 0);
    });
    this.nextSpikeT = this.t + this.range(38_000, 64_000);
  }

  // -- review ----------------------------------------------------------------

  /** Apply a human review decision to an escalated proposal. */
  humanDecision(proposalId: Id, decision: ReviewDecision, reason: string, by?: string): void {
    const sp = [...this.inflight].find((x) => x.p.id === proposalId && x.stage === "escalated");
    if (!sp) throw new Error("This proposal is no longer waiting for review.");
    this.now = Date.now();
    this.decide("triage", "human", 1, decision, sp.p.id, sp.decisions);
    const who = by ?? "you";
    const a = sp.agent;
    if (decision === "approve") {
      sp.p.evidence.notVerified = `${sp.p.evidence.notVerified ?? ""} Residual approved by ${who}${reason ? `: ${reason}` : "."}`.trim();
      this.toLane(sp);
      const lane = this.lanes.get(sp.region);
      if (lane) lane.next = Math.min(lane.next, this.t + 700);
      return;
    }
    if (decision === "return") {
      this.finish(sp, "returned", `Returned by ${who}: ${reason || "split the residual change into its own intent."}`);
      a.proposal = null;
      sp.intent.intent.status = "claimed";
      this.agentEvent(a, "working", sp.intent.intent.footprint);
      a.next = this.t + this.range(4000, 9000);
      return;
    }
    this.finish(sp, "rejected", `Rejected by ${who}: ${reason || "the residual change is out of scope."}`);
    this.decide("antibody", "reflex", 0.99, "learn antibody", sp.p.id);
    this.vaccine.antibodies++;
    this.emit({ t: "metric", at: this.now, name: "antibodies", value: this.vaccine.antibodies });
    const si = sp.intent;
    this.releaseClaims(si);
    si.holders.delete(a);
    si.intent.status = "open";
    si.intent.assignedTo = undefined;
    if (si.openIdx < 0) this.pushOpen(si);
    this.intentEvent(si);
    a.intent = null;
    a.proposal = null;
    this.agentEvent(a, "idle");
    a.next = this.t + this.range(800, 2400);
  }

  // -- agents' reports (escalations) -----------------------------------------

  /** A working agent finds its intent cannot be done as written: it reports it, lets go, and no one takes it until a person answers. */
  private report(): void {
    this.nextReportT = this.t + this.range(45_000, 80_000);
    const working = this.agents.filter((a) => a.state === "working" && a.intent && !a.proposal && !a.intent.intent.contest && !a.intent.intent.escalation);
    const a = working.length ? this.pick(working) : null;
    const si = a?.intent;
    if (!a || !si) return;
    const [kind, template] = this.pick(REPORTS);
    const file = si.intent.footprint[0] ?? "";
    const report = template.replaceAll("{file}", file).replaceAll("{base}", basename(file).replace(/\.[a-z]+$/i, ""));
    si.intent.escalation = { kind, report, by: a.id, at: this.now };
    this.releaseClaims(si);
    si.holders.delete(a);
    si.intent.status = "open";
    si.intent.assignedTo = undefined;
    this.intentEvent(si);
    this.emit({ t: "escalation", at: this.now, intentId: si.intent.id, agentId: a.id, kind, report, title: si.intent.title });
    this.emit({ t: "status", at: this.now, agentId: a.id, intentId: si.intent.id, note: `reported ${si.intent.title}: ${kind}` });
    a.intent = null;
    this.agentEvent(a, "idle");
    a.next = this.t + this.range(1500, 4000);
    // Nobody answered for a while: a simulated reviewer does.
    this.schedule(this.t + this.range(70_000, 110_000), () => {
      if (!si.intent.escalation || si.intent.escalation.resolved) return;
      const [decision, note] = this.pick(ANSWERS);
      const target = decision === "amend" ? this.amendTarget(si) : undefined;
      this.resolveEscalation(si.intent.id, target || decision !== "amend" ? decision : "dismiss", note, this.pick(REVIEWERS), target ? { footprint: [target] } : undefined);
    });
  }

  /** A file in the same region an amended intent could point at instead. */
  private amendTarget(si: SimIntent): string | undefined {
    const list = (this.byRegion.get(si.region) ?? []).filter((p) => !si.intent.footprint.includes(p));
    return list.length ? this.pick(list) : undefined;
  }

  /** A person's answer to an agent's report: amend the intent, withdraw it, or dismiss the report. */
  resolveEscalation(intentId: Id, decision: "amend" | "withdraw" | "dismiss", note: string, by: string, amend?: { title?: string; why?: string; footprint?: string[] }): void {
    const si = this.intents.get(intentId);
    const esc = si?.intent.escalation;
    if (!si || !esc || esc.resolved) throw new Error("This report was already answered.");
    if (!note.trim()) throw new Error("A note is required.");
    this.now = Date.now();
    esc.resolved = { by, at: this.now, decision, note };
    this.emit({ t: "escalation", at: this.now, intentId, agentId: esc.by, kind: esc.kind, report: esc.report, title: si.intent.title, resolved: esc.resolved });
    if (decision === "withdraw") {
      si.intent.status = "withdrawn";
      si.intent.withdrawnReason = note;
      this.releaseNeeds(si);
      this.emit({ t: "withdrawn", at: this.now, intentId, reason: note, by, title: si.intent.title, returned: 0 });
      // The simulator counts a withdrawn rule intent's violations as waived, so the colony still converges.
      if (si.violations > 0 && si.intent.ruleId) {
        this.violations = Math.max(0, this.violations - si.violations);
        this.byRule[si.intent.ruleId] = Math.max(0, (this.byRule[si.intent.ruleId] ?? 0) - si.violations);
        si.violations = 0;
        this.violationsEvent();
      }
      return;
    }
    if (decision === "amend" && amend) {
      const changed: Array<"title" | "why" | "footprint"> = [];
      if (amend.title && amend.title !== si.intent.title) {
        si.intent.title = amend.title;
        changed.push("title");
      }
      if (amend.why && amend.why !== si.intent.why) {
        si.intent.why = amend.why;
        changed.push("why");
      }
      if (amend.footprint?.length) {
        si.intent.footprint = amend.footprint.filter((p) => this.fileSet.has(p));
        if (!si.intent.footprint.length) si.intent.footprint = [...amend.footprint];
        si.region = regionOf(si.intent.footprint[0] ?? "");
        changed.push("footprint");
      }
      if (changed.length) {
        si.intent.revision = (si.intent.revision ?? 1) + 1;
        this.emit({ t: "amended", at: this.now, intentId, revision: si.intent.revision, changed, reason: note, by, title: si.intent.title, returned: 0 });
      }
    }
    if (si.openIdx < 0) this.pushOpen(si);
    this.intentEvent(si);
  }

  /** Proposals waiting for a human, oldest first. */
  reviewQueue(): Proposal[] {
    return [...this.inflight]
      .filter((sp) => sp.stage === "escalated")
      .sort((a, b) => a.escalatedAt - b.escalatedAt)
      .map((sp) => structuredClone(sp.p));
  }

  // -- lineage ---------------------------------------------------------------

  /** Landings that touched `path`, newest first, with their lineage notes. */
  why(path: string): WhyEntry[] {
    const out: WhyEntry[] = [];
    for (let i = this.history.length - 1; i >= 0 && out.length < 8; i--) {
      const h = this.history[i];
      if (h && h.landing.paths.includes(path)) out.push(h);
    }
    if (out.length < 2) out.push(...this.ancientHistory(path, 2 - out.length));
    return structuredClone(out);
  }

  private ancientHistory(path: string, n: number): WhyEntry[] {
    const rng = mulberry32(hashString(path));
    const out: WhyEntry[] = [];
    for (let i = 0; i < n; i++) {
      const at = Date.now() - (i + 1) * (2 + rng() * 9) * 86_400_000;
      const title = i === n - 1 ? (HISTORY_TITLES[0] ?? "Initial import") : (HISTORY_TITLES[1 + ((rng() * (HISTORY_TITLES.length - 1)) | 0)] ?? "Refactor");
      out.push(this.entry(rng, [path], title, at, "Kept as history from before the colony was formed."));
    }
    return out;
  }

  private entry(rng: Rng, paths: string[], title: string, at: number, why: string): WhyEntry {
    const pid = `prp_${hexFrom(rng, 8)}`;
    const iid = `int_${hexFrom(rng, 8)}`;
    const agentNo = String(1 + ((rng() * 60) | 0)).padStart(3, "0");
    const landing: Landing = {
      id: `lnd_${hexFrom(rng, 8)}`,
      colonyId: this.colonyId,
      trunkSha: hexFrom(rng, 40),
      parentSha: hexFrom(rng, 40),
      proposalIds: [pid],
      intentIds: [iid],
      paths,
      regions: [...new Set(paths.map((p) => regionOf(p)))],
      at,
    };
    const note: LineageNote = {
      schema: "firetrident.lineage/v1",
      landingId: landing.id,
      colonyId: this.colonyId,
      proposals: [
        {
          id: pid,
          agentId: `forager-${agentNo}`,
          agentKind: "internal",
          model: "workers-ai/code-large",
          intent: { id: iid, title, why },
          writeSet: paths.map((p) => ({ path: p, blob: hexFrom(rng, 40) })),
          readSet: paths.map((p) => ({ path: p, blob: hexFrom(rng, 40) })),
          decisions: [{ kind: "admission", layer: "reflex", p: round(0.93 + rng() * 0.06), action: "take" }],
          evidence: {
            checks: [
              { name: "typecheck", ok: true, ms: 800 + ((rng() * 1600) | 0) },
              { name: "unit", ok: true, ms: 1500 + ((rng() * 4000) | 0) },
            ],
            residual: [],
            notVerified: NOT_VERIFIED[(rng() * NOT_VERIFIED.length) | 0],
          },
          provenance: simProvenance("internal", "workers-ai/code-large", pid),
        },
      ],
    };
    return { landing, note };
  }

  private seedHistory(): void {
    const now = Date.now();
    for (let i = 14; i >= 1; i--) {
      const region = this.pick(this.regions);
      const list = this.byRegion.get(region) ?? [];
      const paths = new Set<string>();
      for (let k = 0; k < this.int(1, 5) && list.length; k++) paths.add(this.pick(list));
      const at = now - i * this.range(2.4, 3.6) * 60_000;
      const title = this.pick(HISTORY_TITLES.slice(1));
      this.history.push(this.entry(this.rng, [...paths], title, at, "Earlier colony work, landed before this session."));
    }
  }

  // -- snapshot --------------------------------------------------------------

  snapshot(): ColonySnapshot {
    this.now = Date.now();
    return {
      colony: { ...this.colony, trunkSha: this.trunkSha },
      files: this.files.map((f) => ({ path: f.path, size: f.size })),
      intents: [...this.intents.values()].map((si) => ({ ...si.intent, footprint: [...si.intent.footprint] })),
      rules: this.rules.map((r) => ({ ...r })),
      agents: this.agents.map((a) => ({
        id: a.id,
        colonyId: this.colonyId,
        kind: a.kind,
        name: a.id,
        model: a.model,
        thresholds: {},
        state: a.state,
        intentId: a.intent?.intent.id,
        lastSeen: this.now,
      })),
      recentLandings: this.history.slice(-12).map((h) => h.landing),
      violations: { total: this.violations, byRule: { ...this.byRule } },
      funnel: { ...this.funnel },
      metrics: { "vaccine.seeded": this.vaccine.seeded, "vaccine.caught": this.vaccine.caught, antibodies: this.vaccine.antibodies, "antibodies.hits": this.vaccine.hits },
    };
  }

  /** Field readings per region: open needs, plus trails left by recent history. */
  fieldReadings(): FieldReading[] {
    const now = Date.now();
    const byRegion = new Map<string, FieldReading>();
    const reading = (region: string): FieldReading => {
      let r = byRegion.get(region);
      if (!r) {
        r = {
          region,
          at: now,
          totals: { claim: 0, need: 0, trail: 0, failure: 0, danger: 0 },
          byPath: {},
          agents: [],
          sigma: this.sigma.get(region)?.value ?? 0.4,
          admission: { open: true, landingsPerMin: 0, activeAgents: 0 },
        };
        byRegion.set(region, r);
      }
      return r;
    };
    for (const [path, v] of this.need) {
      const r = reading(regionOf(path));
      r.byPath[path] = { ...r.byPath[path], need: v };
      r.totals.need += v;
    }
    const tau = TAU_MS.trail ?? 3_600_000;
    for (const h of this.history) {
      const v = Math.exp(-(now - h.landing.at) / tau);
      if (v < 0.05) continue;
      for (const path of h.landing.paths) {
        const r = reading(regionOf(path));
        const cur = r.byPath[path]?.trail ?? 0;
        r.byPath[path] = { ...r.byPath[path], trail: round(Math.max(cur, v), 3) };
      }
    }
    return [...byRegion.values()];
  }

  // -- vaccination -----------------------------------------------------------

  /** Seed a sealed bad change into review; review catches most of them, and antibodies catch repeats. */
  private vaccinate(): void {
    this.nextVaccineT = this.t + this.range(5000, 9000);
    const v = this.vaccine;
    v.seeded++;
    if (this.r() < 0.95) {
      v.caught++;
      this.decide("triage", this.r() < 0.8 ? "reflex" : "llm", this.range(0.86, 0.99), "caught seeded change", `vaccine-${v.seeded}`);
    }
    if (this.r() < 0.5) {
      v.hits++;
      this.decide("antibody", "reflex", this.range(0.9, 0.99), "screened by antibody", `vaccine-${v.seeded}`);
    }
    this.emit({ t: "metric", at: this.now, name: "vaccine.seeded", value: v.seeded });
    this.emit({ t: "metric", at: this.now, name: "vaccine.caught", value: v.caught });
    this.emit({ t: "metric", at: this.now, name: "antibodies.hits", value: v.hits });
  }

  /** `n` synthetic events for load tests: marks on random files, agents moving, decisions. */
  noise(n: number): ColonyEvent[] {
    const out: ColonyEvent[] = [];
    const now = Date.now();
    const kinds: MarkKind[] = ["claim", "need", "trail", "failure"];
    const layers: DecisionLayer[] = ["reflex", "reflex", "reflex", "llm", "human"];
    for (let i = 0; i < n; i++) {
      const roll = this.r();
      const f = this.files[(this.r() * this.files.length) | 0];
      if (!f) break;
      if (roll < 0.6) {
        out.push({ t: "mark", at: now, region: regionOf(f.path), path: f.path, kind: this.pick(kinds), value: round(this.r() * 2, 2) });
      } else if (roll < 0.9 && this.agents.length) {
        const a = this.agents[(this.r() * this.agents.length) | 0];
        if (a) out.push({ t: "agent", at: now, agentId: a.id, kind: a.kind, state: "working", paths: [f.path] });
      } else {
        out.push({ t: "decision", at: now, decisionId: `noise_${i}`, kind: "collision", layer: this.pick(layers), p: round(this.range(0.6, 0.99)), action: "defer", subject: f.path });
      }
    }
    return out;
  }

  // -- the clock -------------------------------------------------------------

  private schedule(t: number, fn: () => void): void {
    // Binary insertion keeps the list ordered: a live rule schedules thousands of reveals at once.
    const list = this.scheduled;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid]?.t ?? 0) <= t) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, { t, fn });
  }

  /** Advance the simulation to real time `realNow`; returns the events produced. */
  step(realNow: number): ColonyEvent[] {
    const dt = Math.min(250, Math.max(0, realNow - this.lastReal));
    this.lastReal = realNow;
    this.now = realNow;
    this.t += dt * this.opts.speed;
    const t = this.t;

    let due = 0;
    while (due < this.scheduled.length && (this.scheduled[due]?.t ?? Infinity) <= t) due++;
    if (due) for (const job of this.scheduled.splice(0, due)) job.fn();

    if (this.spawned < this.opts.agents) {
      const due = Math.min(this.opts.agents, Math.ceil((this.opts.agents * t) / this.spawnMs));
      while (this.spawned < due) this.spawnAgent();
    }

    for (const a of this.agents) {
      if (t < a.next) continue;
      if (a.state === "idle" || (a.state === "waiting" && !a.proposal)) this.tryTake(a);
      else if (a.state === "working") this.submit(a);
      else a.next = t + 1000;
    }
    for (const sp of this.inflight) {
      if (sp.stage === "pending" || sp.stage === "checking") {
        if (t >= sp.next) this.advance(sp);
      } else if (sp.stage === "escalated" && t - sp.escalatedAt > 45_000) {
        const roll = this.r();
        this.humanDecision(sp.p.id, roll < 0.75 ? "approve" : roll < 0.9 ? "return" : "reject", "", this.pick(REVIEWERS));
      }
    }
    if (t >= this.nextBurstT) {
      // Every so often the lanes line up and land together: a burst.
      for (const lane of this.lanes.values()) lane.next = Math.min(lane.next, t + this.range(0, 450));
      this.nextBurstT = t + this.range(16_000, 26_000);
    }
    for (const lane of this.lanes.values()) if (lane.queue.length && t >= lane.next) this.tickLane(lane);
    if (t >= this.nextSigmaT) this.updateSigma();
    if (t >= this.nextVaccineT) this.vaccinate();
    if (t >= this.nextReportT) this.report();
    if (t >= this.nextFeatureT) {
      this.addFeature();
      this.nextFeatureT = t + this.range(22_000, 40_000);
    }

    // When the rules are satisfied, hold a beat, then declare the next rule.
    if (this.violations === 0 && !this.scheduled.length) {
      if (!this.cleanSince) this.cleanSince = t;
      else if (t - this.cleanSince > 12_000) {
        this.cleanSince = 0;
        const rule = WAVE_RULES[this.waveNo % WAVE_RULES.length];
        const pass = Math.floor(this.waveNo / WAVE_RULES.length);
        this.waveNo++;
        if (rule) this.addRule(pass ? { ...rule, id: `${rule.id}-${pass + 1}` } : rule, true);
      }
    } else {
      this.cleanSince = 0;
    }

    const out = this.pending;
    this.pending = [];
    return out;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Backend for `?mock=1`: runs the simulator in the page and streams its events into the store. */
export class MockBackend implements Backend {
  readonly mode = "mock" as const;
  private readonly sim: ColonySim;
  private timer = 0;
  private paused = false;
  private readonly stress: number;
  private debt = 0;
  private rulesSent = 0;

  constructor(colonyId: string, opts: MockOptions) {
    this.sim = new ColonySim(colonyId, opts);
    this.stress = opts.stress ?? 0;
  }

  start(store: ColonyStore): void {
    store.applySnapshot(this.sim.snapshot());
    store.applyField(this.sim.fieldReadings());
    store.setConn("mock", null);
    this.rulesSent = this.sim.ruleCount;
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (this.paused) return;
      const evs = this.sim.step(Date.now());
      if (this.stress > 0) {
        this.debt += this.stress / 20;
        const n = Math.floor(this.debt);
        this.debt -= n;
        if (n) evs.push(...this.sim.noise(n));
      }
      // A rule the simulator declares while it runs: no event carries a rule, so the page learns it here.
      if (this.sim.ruleCount !== this.rulesSent) {
        this.rulesSent = this.sim.ruleCount;
        store.learnRules(this.sim.ruleList());
      }
      if (evs.length) store.applyEvents(evs);
    }, 50);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  /** Freeze the simulated clock (director mode, space). */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  async why(path: string): Promise<WhyEntry[]> {
    await sleep(140);
    return this.sim.why(path);
  }

  async review(): Promise<Proposal[]> {
    await sleep(90);
    return this.sim.reviewQueue();
  }

  async decide(proposalId: string, decision: ReviewDecision, reason: string): Promise<void> {
    await sleep(220);
    this.sim.humanDecision(proposalId, decision, reason);
  }

  async resolveEscalation(intentId: string, decision: EscalationDecision, note: string, by?: string, amend?: IntentAmend): Promise<void> {
    await sleep(220);
    this.sim.resolveEscalation(intentId, decision, note, by || "you", amend);
  }
}
