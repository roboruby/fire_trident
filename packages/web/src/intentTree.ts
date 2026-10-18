import { regionOf } from "@fire_trident/core";
import type { Id, IntentSource, Rule } from "@fire_trident/core";
import { shortId } from "./format.ts";
import { REPEATED_RETURNS, type ColonyStore, type EscalationView, type IntentView } from "./store.ts";

/**
 * The Intents tab as a tree that stays readable at any colony size. Level one is what asked for the
 * work: each rule (by its title), people and the spec, certification repairs, the colony's own splits,
 * agents' follow-ups. Level two is the region the intent's files are in (core regionOf at the colony's
 * depth). Level three is the intents. Every group and region counts its intents per state and names
 * its most urgent state; both sort most urgent first and show PAGE rows at a time. Pure (no React):
 * live pages, replays, the simulator and the tests build the same tree from the store.
 */

/** Where an intent stands, most urgent first: a report waiting for a person, came back repeatedly, in flight, open, landed, withdrawn. */
export type IntentState = "report" | "returned" | "flight" | "open" | "landed" | "withdrawn";

/** The states in the order a person should look at them. */
export const STATES: readonly IntentState[] = ["report", "returned", "flight", "open", "landed", "withdrawn"];

const RANK: Readonly<Record<IntentState, number>> = { report: 0, returned: 1, flight: 2, open: 3, landed: 4, withdrawn: 5 };

/** How a count of each state reads after its number ("3 in flight"). */
export const STATE_LABEL: Readonly<Record<IntentState, string>> = {
  report: "reported",
  returned: "returned",
  flight: "in flight",
  open: "open",
  landed: "landed",
  withdrawn: "withdrawn",
};

/** Hover text for each state: what it means and what a person can do about it. */
export const STATE_TITLE: Readonly<Record<IntentState, string>> = {
  report: "An agent reported that the intent cannot be done as written. No agent takes it until a person answers the report in the Review tab.",
  returned: `Its changes came back ${REPEATED_RETURNS} or more times. Amending or withdrawing it may help more than another attempt.`,
  flight: "An agent holds it, or its change is on its way through review and its lane.",
  open: "Declared and waiting for an agent to take it.",
  landed: "Its change is on trunk.",
  withdrawn: "Called off before it landed, by a person or with its rule.",
};

/** Rows shown at a time at every level (groups, a group's regions, a region's intents). */
export const PAGE = 50;

// ---------------------------------------------------------------------------
// What asked for the work
// ---------------------------------------------------------------------------

/** What asked for the work: a rule, people and the spec, certification, the colony itself, an agent, or not known. */
export type OriginKind = IntentSource | "unknown";

/** A first-level group: what asked for its intents. */
export interface Origin {
  key: string;
  kind: OriginKind;
  /** The rule's title, or the group's name. */
  label: string;
  ruleId?: Id;
  /** The rule was retracted: its intents that had not landed were withdrawn. */
  retracted?: boolean;
  /** The rule's whole description (hover text). */
  description?: string;
}

const FIXED: Readonly<Record<Exclude<OriginKind, "rule">, Origin>> = {
  human: { key: "human", kind: "human", label: "People and the spec" },
  certify: { key: "certify", kind: "certify", label: "Certification repairs" },
  system: { key: "system", kind: "system", label: "The colony's own splits" },
  agent: { key: "agent", kind: "agent", label: "Agents' follow-ups" },
  external: { key: "external", kind: "external", label: "Imported issues" },
  unknown: { key: "unknown", kind: "unknown", label: "Origin not known" },
};

/** A rule intent whose rule this page cannot name (its record carries no rule id). */
const SOME_RULE: Origin = { key: "rule", kind: "rule", label: "A rule" };

/** Hover text for each kind of group. */
export const ORIGIN_TITLE: Readonly<Record<OriginKind, string>> = {
  rule: "A rule a person approved: it declared one intent for each file that breaks it.",
  human: "Intents people declared: by hand, through the API, or from a project spec.",
  certify: "Repairs that trunk certification declared when the project's own tests failed on trunk.",
  system: "Splits the colony declared itself when a file grew too large too fast.",
  agent: "Intents agents declared while working on another one. Each names its parent.",
  external: "Public GitHub issues a person imported: strangers wrote their text, so review reads them as it reads an agent's request.",
  unknown:
    "The colony's events do not say who declared these intents. A live page learns it from the colony's next snapshot; a replay knows it only for the intents the finished colony still lists.",
};

/** The colony's rules as the tree reads them: one group per rule, and rules by the head of their intents' titles. */
export interface RuleBook {
  readonly origins: Map<Id, Origin>;
  readonly byHead: ReadonlyMap<string, readonly Rule[]>;
}

/** The head of a rule's description as the colony writes it into its intents' titles ("<head> in <path>"). */
export function ruleHead(description: string): string {
  const d = description.trim();
  return d.replace(/[\s.,;:!?…]+$/u, "") || d;
}

/**
 * Index rules for the tree: a group per rule, and rules by title head, oldest first (a rule added again
 * shares its head). Colonies made before titles dropped the description's trailing punctuation titled
 * their rule intents with the whole description, so a rule is found by either.
 */
export function ruleBook(rules: Iterable<Rule>): RuleBook {
  const origins = new Map<Id, Origin>();
  const byHead = new Map<string, Rule[]>();
  const index = (key: string, r: Rule): void => {
    const same = byHead.get(key);
    if (!same) byHead.set(key, [r]);
    else if (!same.includes(r)) same.push(r);
  };
  for (const r of rules) {
    if (!r || typeof r.id !== "string" || !r.id) continue;
    const description = typeof r.description === "string" ? r.description.trim() : "";
    const head = ruleHead(description);
    origins.set(r.id, {
      key: `rule:${r.id}`,
      kind: "rule",
      label: head || `Rule ${shortId(r.id)}`,
      ruleId: r.id,
      ...(typeof r.retractedAt === "number" ? { retracted: true } : {}),
      ...(description ? { description } : {}),
    });
    if (!head) continue;
    index(head, r);
    if (description !== head) index(description, r);
  }
  for (const same of byHead.values()) same.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return { origins, byHead };
}

/** The group of a rule by id (a rule this page does not know yet gets a group named after its id). */
function ruleOrigin(book: RuleBook, ruleId: Id): Origin {
  let o = book.origins.get(ruleId);
  if (!o) {
    o = { key: `rule:${ruleId}`, kind: "rule", label: `Rule ${shortId(ruleId)}`, ruleId };
    book.origins.set(ruleId, o);
  }
  return o;
}

/**
 * The rule whose intent title this is: the colony titles a rule's intent "<rule head> in <path>" with
 * the one violating file as its footprint. Of rules sharing a head, the newest declared by the time
 * the intent was.
 */
function ruleByTitle(book: RuleBook, title: string, footprint: readonly string[], at: number): Rule | null {
  const path = footprint.length === 1 ? footprint[0] : undefined;
  if (!path) return null;
  const suffix = ` in ${path}`;
  if (!title.endsWith(suffix)) return null;
  const same = book.byHead.get(title.slice(0, -suffix.length));
  if (!same || !same.length) return null;
  let pick: Rule | null = null;
  for (const r of same) if ((r.createdAt ?? 0) <= at) pick = r;
  return pick ?? same[same.length - 1] ?? null;
}

/** Titles the colony writes for its own intents, so an intent whose events carry no source can still be placed. */
const REPAIR_TITLE = /^(Make the failing tests pass|Restore the lost tests): /;
const REDO_PREFIX = "Redo after revert: ";

/**
 * What asked for an intent: its recorded source (from a snapshot, or learned since), else what the
 * colony's own titles say (a rule's "<rule> in <path>", a certification repair, a split, a redo after a
 * revert), else not known. Live intent events carry no source, so an intent declared after the page
 * loaded is placed by its title until a snapshot names its origin.
 */
export function originOf(it: IntentView, book: RuleBook): Origin {
  switch (it.source) {
    case "rule": {
      if (it.ruleId) return ruleOrigin(book, it.ruleId);
      const r = ruleByTitle(book, it.title, it.footprint, it.createdAt);
      return r ? ruleOrigin(book, r.id) : SOME_RULE;
    }
    case "human":
    case "certify":
    case "system":
    case "agent":
    case "external":
      return FIXED[it.source];
    default:
      return inferred(it, book);
  }
}

function inferred(it: IntentView, book: RuleBook): Origin {
  const redo = it.title.startsWith(REDO_PREFIX);
  const rule = ruleByTitle(book, redo ? it.title.slice(REDO_PREFIX.length) : it.title, it.footprint, it.createdAt);
  // A redo is its rule's while the rule stands, and a person's otherwise (as the colony declares it).
  if (rule && !(redo && typeof rule.retractedAt === "number")) return ruleOrigin(book, rule.id);
  if (redo) return FIXED.human;
  if (REPAIR_TITLE.test(it.title)) return FIXED.certify;
  const first = it.footprint[0];
  if (first !== undefined && it.title === `Split ${first} into smaller modules`) return FIXED.system;
  return FIXED.unknown;
}

// ---------------------------------------------------------------------------
// Regions and states
// ---------------------------------------------------------------------------

const regionMemo = new WeakMap<readonly string[], { depth: number; region: string }>();

/**
 * The region an intent belongs to: the region (core regionOf at the colony's depth) that holds most of
 * its footprint, the first to appear on a tie (as a proposal's lane is chosen), "." for root files.
 * Memoized per footprint array: the store keeps an intent's array until its footprint changes.
 */
export function intentRegion(footprint: readonly string[], depth = 1): string {
  const hit = regionMemo.get(footprint);
  if (hit && hit.depth === depth) return hit.region;
  let region = ".";
  if (footprint.length === 1) region = regionOf(footprint[0] ?? "", depth);
  else if (footprint.length > 1) {
    const counts = new Map<string, number>();
    for (const p of footprint) {
      const r = regionOf(p, depth);
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    let best = 0;
    for (const [r, n] of counts) {
      if (n > best) {
        best = n;
        region = r;
      }
    }
  }
  regionMemo.set(footprint, { depth, region });
  return region;
}

/**
 * An intent's state in the tree, or null for one the tree leaves out (abandoned: a sealed test change
 * of the vaccination meter). A report a person has not answered outranks everything but the end
 * states; then repeated returns; then the intent's own status.
 */
export function stateOf(it: IntentView, returns: number, report: EscalationView | undefined): IntentState | null {
  if (it.status === "landed") return "landed";
  if (it.status === "withdrawn") return "withdrawn";
  if (it.status === "abandoned") return null;
  if (report && !report.resolved) return "report";
  if (returns >= REPEATED_RETURNS) return "returned";
  return it.status === "open" ? "open" : "flight";
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** Counts per state, what they add up to, and the most urgent state with any intent in it. */
export interface Rollup {
  counts: Record<IntentState, number>;
  total: number;
  top: IntentState | null;
}

/** One intent in the tree. */
export interface TreeItem {
  intent: IntentView;
  state: IntentState;
  /** Returns this page saw. */
  returns: number;
  /** Its report, while one waits for a person. */
  report?: EscalationView;
}

/** A second-level node: the intents of one group whose files are in one region. */
export interface RegionNode extends Rollup {
  key: string;
  region: string;
  groupKey: string;
  /** In the order they were found: itemsOf sorts them when the region is shown. */
  items: TreeItem[];
}

/** A first-level node: what asked for the work, and its regions. */
export interface GroupNode extends Rollup {
  key: string;
  origin: Origin;
  /** Most urgent first. */
  regions: RegionNode[];
}

/** The whole tree, with the colony's roll-up, its rule book and its region depth. */
export interface IntentTree extends Rollup {
  /** Most urgent first. */
  groups: GroupNode[];
  book: RuleBook;
  depth: number;
}

/** What the tree is built from; the store holds all of it (treeInput). */
export interface TreeInput {
  intents: Iterable<IntentView>;
  rules: Iterable<Rule>;
  returns: ReadonlyMap<Id, { n: number }>;
  escalations: ReadonlyMap<Id, EscalationView>;
  regionDepth?: number;
}

/** The tree's input from the store. */
export function treeInput(store: ColonyStore): TreeInput {
  return { intents: store.intents.values(), rules: store.rules.values(), returns: store.returns, escalations: store.escalations, regionDepth: store.colony?.regionDepth ?? 1 };
}

const zero = (): Record<IntentState, number> => ({ report: 0, returned: 0, flight: 0, open: 0, landed: 0, withdrawn: 0 });

function topOf(counts: Record<IntentState, number>): IntentState | null {
  for (const s of STATES) if (counts[s] > 0) return s;
  return null;
}

/** Key of a region within its group (group keys never hold "/"; region names may). */
export function regionKey(groupKey: string, region: string): string {
  return `${groupKey}/${region}`;
}

/** Most urgent first: more intents in the most urgent state, then in the next one, and so on. */
export function byUrgency(a: Rollup, b: Rollup): number {
  for (const s of STATES) {
    const d = b.counts[s] - a.counts[s];
    if (d) return d;
  }
  return 0;
}

/**
 * Build the tree in one pass over the intents: each is placed by what asked for it and its region,
 * and counted in every level's roll-up. Groups and each group's regions are sorted most urgent first;
 * a region's intents are sorted only when it is shown (itemsOf), so a scale colony's tree stays cheap
 * to rebuild while it runs.
 */
export function buildTree(input: TreeInput): IntentTree {
  const book = ruleBook(input.rules);
  const depth = Number.isFinite(input.regionDepth) && (input.regionDepth ?? 0) >= 1 ? Math.floor(input.regionDepth ?? 1) : 1;
  const groups = new Map<string, GroupNode>();
  const regions = new Map<string, RegionNode>();
  const counts = zero();
  let total = 0;
  for (const it of input.intents) {
    if (!it || typeof it.id !== "string") continue;
    const returns = input.returns.get(it.id)?.n ?? 0;
    const esc = input.escalations.get(it.id);
    const report = esc && !esc.resolved ? esc : undefined;
    const state = stateOf(it, returns, report);
    if (!state) continue;
    const origin = originOf(it, book);
    let g = groups.get(origin.key);
    if (!g) {
      g = { key: origin.key, origin, counts: zero(), total: 0, top: null, regions: [] };
      groups.set(origin.key, g);
    }
    const region = intentRegion(Array.isArray(it.footprint) ? it.footprint : [], depth);
    const rk = regionKey(origin.key, region);
    let r = regions.get(rk);
    if (!r) {
      r = { key: rk, region, groupKey: origin.key, counts: zero(), total: 0, top: null, items: [] };
      regions.set(rk, r);
      g.regions.push(r);
    }
    r.items.push(report ? { intent: it, state, returns, report } : { intent: it, state, returns });
    r.counts[state]++;
    r.total++;
    g.counts[state]++;
    g.total++;
    counts[state]++;
    total++;
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.top = topOf(g.counts);
    for (const r of g.regions) r.top = topOf(r.counts);
    g.regions.sort((a, b) => byUrgency(a, b) || cmp(a.region, b.region));
  }
  list.sort((a, b) => byUrgency(a, b) || cmp(a.origin.label, b.origin.label) || cmp(a.key, b.key));
  return { groups: list, counts, total, top: topOf(counts), book, depth };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Within a state, the order a person reads it: the report waiting longest first, the most returns
 * first, the highest priority (then the oldest) open intent first, the latest move first otherwise.
 */
function byItem(a: TreeItem, b: TreeItem): number {
  const d = RANK[a.state] - RANK[b.state];
  if (d) return d;
  const x = a.intent;
  const y = b.intent;
  let k = 0;
  switch (a.state) {
    case "report":
      k = (a.report?.at ?? 0) - (b.report?.at ?? 0);
      break;
    case "returned":
      k = b.returns - a.returns || y.updatedAt - x.updatedAt;
      break;
    case "open":
      k = y.priority - x.priority || x.createdAt - y.createdAt;
      break;
    default:
      k = y.updatedAt - x.updatedAt;
  }
  return k || cmp(x.id, y.id);
}

const sortedMemo = new WeakMap<RegionNode, readonly TreeItem[]>();

/** A region's intents, most urgent first (sorted once per tree, when first asked). */
export function itemsOf(region: RegionNode): readonly TreeItem[] {
  let sorted = sortedMemo.get(region);
  if (!sorted) {
    sorted = [...region.items].sort(byItem);
    sortedMemo.set(region, sorted);
  }
  return sorted;
}

/** Every intent of a group, in no particular order. */
export function* groupItems(g: GroupNode): Generator<TreeItem> {
  for (const r of g.regions) yield* r.items;
}

/** The files of some intents, each once and at most `max` (the map outlines them). */
export function pathsOf(items: Iterable<TreeItem>, max = 2_000): string[] {
  const out = new Set<string>();
  for (const { intent } of items) {
    for (const p of intent.footprint) {
      out.add(p);
      if (out.size >= max) return [...out];
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** The paging key of the groups. */
export const GROUPS_PAGE = "groups";
/** The paging key of a group's regions. */
export const regionsPage = (groupKey: string): string => `regions ${groupKey}`;
/** The paging key of a region's intents. */
export const itemsPage = (regionKey: string): string => `items ${regionKey}`;

/** The rows of a list to show, PAGE at a time: the first `shown` (at least one page), and how many are left. */
export function paged<T>(list: readonly T[], shown: number | undefined): { rows: readonly T[]; more: number } {
  const n = Math.max(PAGE, Math.floor(Number.isFinite(shown) ? (shown as number) : PAGE));
  return list.length <= n ? { rows: list, more: 0 } : { rows: list.slice(0, n), more: list.length - n };
}

/** How many rows to show so that row `index` is on screen: whole pages. */
export function pagesFor(index: number): number {
  return (Math.floor(Math.max(0, index) / PAGE) + 1) * PAGE;
}

// ---------------------------------------------------------------------------
// Focus: where the needs-you strip (or a why link) points the tab
// ---------------------------------------------------------------------------

/** A state's groups, one group, or one intent. */
export type TreeFocus = { state: IntentState } | { group: string } | { intent: Id };

/** The old segments' names, which links and tests may still use. */
const STATE_ALIAS: Readonly<Record<string, IntentState>> = { claimed: "flight", proposed: "flight", escalated: "report", reports: "report" };

/** Read a focus string: "intent:<id>", "group:<key>", or a state ("claimed" and "proposed" mean in flight). */
export function parseFocus(raw: string | null | undefined): TreeFocus | null {
  if (typeof raw !== "string" || !raw) return null;
  if (raw.startsWith("intent:")) return raw.length > 7 ? { intent: raw.slice(7) } : null;
  if (raw.startsWith("group:")) return raw.length > 6 ? { group: raw.slice(6) } : null;
  const state = (STATES as readonly string[]).includes(raw) ? (raw as IntentState) : STATE_ALIAS[raw];
  return state ? { state } : null;
}

/** The key the tab marks a group's row with (data-key), to scroll to it. */
export const groupRow = (key: string): string => `g:${key}`;
/** The key of a region's row. */
export const regionRow = (key: string): string => `r:${key}`;
/** The key of an intent's row. */
export const intentRow = (id: Id): string => `i:${id}`;

/** What a focus opens: groups and regions, the pages that bring the target on screen, and the row to scroll to. */
export interface FocusPlan {
  open: string[];
  shown: Record<string, number>;
  scroll: string | null;
}

/**
 * Plan a focus. A state opens every group holding intents in it and, inside each, every region that
 * does; an intent opens its group and region, with pages enough to show its row; a group opens itself.
 * Null when nothing in the tree matches.
 */
export function planFocus(tree: IntentTree, f: TreeFocus): FocusPlan | null {
  const plan: FocusPlan = { open: [], shown: {}, scroll: null };
  const show = (key: string, index: number): void => {
    plan.shown[key] = Math.max(plan.shown[key] ?? 0, pagesFor(index));
  };
  if ("state" in f) {
    tree.groups.forEach((g, gi) => {
      if (!g.counts[f.state]) return;
      plan.open.push(g.key);
      show(GROUPS_PAGE, gi);
      plan.scroll ??= groupRow(g.key);
      g.regions.forEach((r, ri) => {
        if (!r.counts[f.state]) return;
        plan.open.push(r.key);
        show(regionsPage(g.key), ri);
      });
    });
    return plan.open.length ? plan : null;
  }
  if ("group" in f) {
    const gi = tree.groups.findIndex((g) => g.key === f.group);
    const g = tree.groups[gi];
    if (!g) return null;
    plan.open.push(g.key);
    show(GROUPS_PAGE, gi);
    plan.scroll = groupRow(g.key);
    return plan;
  }
  for (let gi = 0; gi < tree.groups.length; gi++) {
    const g = tree.groups[gi];
    if (!g) continue;
    for (let ri = 0; ri < g.regions.length; ri++) {
      const r = g.regions[ri];
      if (!r || !r.items.some((x) => x.intent.id === f.intent)) continue;
      const ii = itemsOf(r).findIndex((x) => x.intent.id === f.intent);
      plan.open.push(g.key, r.key);
      show(GROUPS_PAGE, gi);
      show(regionsPage(g.key), ri);
      show(itemsPage(r.key), ii);
      plan.scroll = intentRow(f.intent);
      return plan;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The why chain
// ---------------------------------------------------------------------------

/** One step of an intent's why chain: a parent intent (its title when this page knows it), or the rule. */
export type WhyLink = { kind: "parent"; id: Id; title: string | null } | { kind: "rule"; origin: Origin };

/** Parents shown at most. */
const CHAIN_MAX = 4;

/**
 * An intent's why chain: its parent intents, nearest first (at most CHAIN_MAX; it stops at one this
 * page does not know), then the rule that started the chain, when a rule did.
 */
export function whyChain(it: IntentView, intents: ReadonlyMap<Id, IntentView>, book: RuleBook): WhyLink[] {
  const out: WhyLink[] = [];
  const seen = new Set<Id>([it.id]);
  let cur = it;
  while (cur.parentId && !seen.has(cur.parentId) && out.length < CHAIN_MAX) {
    const id = cur.parentId;
    seen.add(id);
    const parent = intents.get(id);
    out.push({ kind: "parent", id, title: parent ? parent.title : null });
    if (!parent) return out;
    cur = parent;
  }
  const origin = originOf(cur, book);
  if (origin.kind === "rule") out.push({ kind: "rule", origin });
  return out;
}
