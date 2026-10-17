import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { intentSpendDetail, intentSpendLine } from "@fire_trident/core";
import { KIND_LABEL } from "../eventText.ts";
import { fmtInt, shortId, timeAgo } from "../format.ts";
import {
  GROUPS_PAGE,
  ORIGIN_TITLE,
  PAGE,
  STATES,
  STATE_LABEL,
  STATE_TITLE,
  buildTree,
  groupItems,
  groupRow,
  intentRow,
  itemsOf,
  itemsPage,
  paged,
  parseFocus,
  pathsOf,
  planFocus,
  regionRow,
  regionsPage,
  treeInput,
  whyChain,
  type GroupNode,
  type RegionNode,
  type Rollup,
  type RuleBook,
  type TreeFocus,
  type TreeItem,
  type WhyLink,
} from "../intentTree.ts";
import { REPEATED_RETURNS, type ColonyStore } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";
import { MovedBadge } from "./MovedBy.tsx";
import { closureBadge } from "../closure.ts";
import { IntentLifecycleToggle } from "./Lifecycle.tsx";

/** Groups that start open: the most urgent few, decided once when each first appears (a person's clicks win after that). */
const OPEN_AT_FIRST = 3;
/** How long the row a focus pointed at stays lit. */
const LIT_MS = 2_400;
const EMPTY = "No intents yet. Rules, people, certification and agents declare them, and they show here by what asked for them.";

/** What a person opened and paged on a colony's tree: kept per store, so it survives switching tabs. */
interface TreeUi {
  toggled: ReadonlyMap<string, boolean>;
  shown: Readonly<Record<string, number>>;
  firstOpen: Map<string, boolean>;
}
const kept = new WeakMap<ColonyStore, TreeUi>();

/**
 * Intents as a tree: what asked for the work (each rule by its title, people and the spec,
 * certification repairs, the colony's own splits, agents' follow-ups), then the region of its files,
 * then the intents. Every group and region shows its counts per state with its most urgent state
 * marked, and sorts most urgent first, 50 rows at a time. An intent shows its why chain (its parents,
 * then the rule that started it). `focus` (from the needs-you strip) opens the groups and regions that
 * hold what needs a person, or one intent's, and lights the row.
 */
export function IntentsTab({ store, onPick, focus = null }: { store: ColonyStore; onPick: (path: string | null) => void; focus?: { segment: string; at: number } | null }) {
  useThrottledVersion(store, 400);
  const depth = store.colony?.regionDepth ?? 1;
  const version = store.intentsVersion;
  // The store mutates in place; intentsVersion is the change signal (intents, reports, repeated returns, rules).
  const tree = useMemo(() => buildTree(treeInput(store)), [store, version, depth]);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => kept.get(store)?.toggled ?? new Map());
  const [shown, setShown] = useState<Readonly<Record<string, number>>>(() => kept.get(store)?.shown ?? {});
  const [lit, setLit] = useState<{ row: string; at: number } | null>(null);
  const firstOpen = useRef(kept.get(store)?.firstOpen ?? new Map<string, boolean>());
  useEffect(() => {
    kept.set(store, { toggled, shown, firstOpen: firstOpen.current });
  }, [store, toggled, shown]);
  const latest = useRef(tree);
  latest.current = tree;
  const litEl = useRef<HTMLElement | null>(null);
  const setLitEl = useCallback((el: HTMLElement | null) => {
    litEl.current = el;
  }, []);

  // Open what a focus points at, with pages enough to show it, and light its row.
  const go = useCallback((f: TreeFocus) => {
    const plan = planFocus(latest.current, f);
    if (!plan) return;
    setToggled((m) => {
      const next = new Map(m);
      for (const k of plan.open) next.set(k, true);
      return next;
    });
    setShown((s) => {
      const next = { ...s };
      for (const [k, n] of Object.entries(plan.shown)) next[k] = Math.max(next[k] ?? PAGE, n);
      return next;
    });
    if (plan.scroll) setLit({ row: plan.scroll, at: Date.now() });
  }, []);

  const focusAt = focus?.at ?? 0;
  const focusTo = focus?.segment ?? "";
  useEffect(() => {
    const f = focusAt ? parseFocus(focusTo) : null;
    if (f) go(f);
  }, [focusAt, focusTo, go]);

  useEffect(() => {
    if (!lit) return;
    litEl.current?.scrollIntoView?.({ block: "center" });
    const timer = window.setTimeout(() => setLit(null), LIT_MS);
    return () => window.clearTimeout(timer);
  }, [lit]);

  const groupOpen = (g: GroupNode, index: number): boolean => {
    const t = toggled.get(g.key);
    if (t !== undefined) return t;
    let first = firstOpen.current.get(g.key);
    if (first === undefined) {
      first = index < OPEN_AT_FIRST;
      firstOpen.current.set(g.key, first);
    }
    return first;
  };
  const flip = (key: string, open: boolean) => setToggled((m) => new Map(m).set(key, !open));
  const more = (key: string) => setShown((s) => ({ ...s, [key]: Math.max(PAGE, s[key] ?? PAGE) + PAGE }));
  const outline = (items: Iterable<TreeItem>) => store.setHighlight(pathsOf(items));
  const follow = (l: WhyLink) => go(l.kind === "rule" ? { group: l.origin.key } : { intent: l.id });
  const litRow = lit?.row ?? null;
  const now = store.now();
  const groups = paged(tree.groups, shown[GROUPS_PAGE]);

  const regionRowOf = (g: GroupNode, r: RegionNode) => {
    const open = toggled.get(r.key) ?? g.regions.length === 1;
    const row = regionRow(r.key);
    const items = open ? paged(itemsOf(r), shown[itemsPage(r.key)]) : null;
    return (
      <li key={r.key} className={`ir is-${r.top ?? "empty"}`}>
        <button
          type="button"
          ref={litRow === row ? setLitEl : undefined}
          data-key={row}
          className={`ir-head${litRow === row ? " is-lit" : ""}`}
          aria-expanded={open}
          onClick={() => flip(r.key, open)}
          onMouseEnter={() => outline(r.items)}
          onFocus={() => outline(r.items)}
          onBlur={() => store.setHighlight([])}
          title={`${r.region === "." ? "Files at the top of the repository" : `Files under ${r.region}/`}: ${plural(r.total)}, most urgent state: ${STATE_LABEL[r.top ?? "landed"]}.`}
        >
          <span className="itree-caret" aria-hidden="true" />
          <span className="ir-name mono">{r.region === "." ? "(root)" : r.region}</span>
          <Counts r={r} />
        </button>
        {items ? (
          <ul className="ii-list">
            {items.rows.map((item) => (
              <IntentRow key={item.intent.id} item={item} store={store} book={tree.book} now={now} lit={litRow === intentRow(item.intent.id)} setLitEl={setLitEl} onPick={onPick} onFollow={follow} />
            ))}
            {items.more > 0 ? <MoreRow more={items.more} what="intents" onMore={() => more(itemsPage(r.key))} /> : null}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="intents">
      <div className="itree-sum">
        <span className="itree-total">{plural(tree.total)}</span>
        <Counts r={tree} />
      </div>
      <ul className="itree" aria-label="Intents by what asked for them, then by region" onMouseLeave={() => store.setHighlight([])}>
        {groups.rows.map((g, gi) => {
          const open = groupOpen(g, gi);
          const row = groupRow(g.key);
          const regions = open ? paged(g.regions, shown[regionsPage(g.key)]) : null;
          return (
            <li key={g.key} className={`ig is-${g.top ?? "empty"}`}>
              <button
                type="button"
                ref={litRow === row ? setLitEl : undefined}
                data-key={row}
                className={`ig-head${litRow === row ? " is-lit" : ""}`}
                aria-expanded={open}
                onClick={() => flip(g.key, open)}
                onMouseEnter={() => outline(groupItems(g))}
                onFocus={() => outline(groupItems(g))}
                onBlur={() => store.setHighlight([])}
                title={groupTitle(g)}
              >
                <span className="ig-line">
                  <span className="itree-caret" aria-hidden="true" />
                  {g.origin.kind === "rule" ? <span className="src src-rule">rule</span> : null}
                  <span className="ig-label">{g.origin.label}</span>
                  {g.origin.retracted ? <span className="ibadge ibadge-retracted">retracted</span> : null}
                </span>
                <Counts r={g} />
              </button>
              {regions ? (
                <ul className="ir-list">
                  {regions.rows.map((r) => regionRowOf(g, r))}
                  {regions.more > 0 ? <MoreRow more={regions.more} what="regions" onMore={() => more(regionsPage(g.key))} /> : null}
                </ul>
              ) : null}
            </li>
          );
        })}
        {groups.more > 0 ? <MoreRow more={groups.more} what="groups" onMore={() => more(GROUPS_PAGE)} /> : null}
        {!tree.groups.length ? <li className="empty">{EMPTY}</li> : null}
      </ul>
    </div>
  );
}

const plural = (n: number): string => `${fmtInt(n)} ${n === 1 ? "intent" : "intents"}`;

/** A group's hover text: what kind of group it is, a rule's whole description, and its most urgent state. */
function groupTitle(g: GroupNode): string {
  const parts = [ORIGIN_TITLE[g.origin.kind]];
  if (g.origin.description) parts.push(`Rule: ${g.origin.description}`);
  if (g.origin.retracted) parts.push("Retracted: it is no longer checked, and its intents that had not landed were withdrawn.");
  parts.push(`${plural(g.total)}, most urgent state: ${STATE_LABEL[g.top ?? "landed"]}.`);
  return parts.join("\n");
}

/** Counts per state in the order a person should look at them; the most urgent one is marked. */
function Counts({ r }: { r: Rollup }) {
  return (
    <span className="sc-row">
      {STATES.map((s) =>
        r.counts[s] > 0 ? (
          <span key={s} className={`sc sc-${s}${s === r.top ? " is-top" : ""}`} title={STATE_TITLE[s]}>
            <b>{fmtInt(r.counts[s])}</b> {STATE_LABEL[s]}
          </span>
        ) : null,
      )}
    </span>
  );
}

function MoreRow({ more, what, onMore }: { more: number; what: string; onMore: () => void }) {
  return (
    <li className="itree-more-row">
      <button type="button" className="itree-more" onClick={onMore}>
        Show {fmtInt(Math.min(PAGE, more))} more {what} <span className="itree-left">({fmtInt(more)} left)</span>
      </button>
    </li>
  );
}

interface RowProps {
  item: TreeItem;
  store: ColonyStore;
  book: RuleBook;
  now: number;
  lit: boolean;
  setLitEl: (el: HTMLElement | null) => void;
  onPick: (path: string | null) => void;
  onFollow: (l: WhyLink) => void;
}

/** One intent: its title (and revision), its badges, its first file, who holds it and since when, and its why chain. */
function IntentRow({ item, store, book, now, lit, setLitEl, onPick, onFollow }: RowProps) {
  const it = item.intent;
  const report = item.report;
  const chain = whyChain(it, store.intents, book);
  const fresh = item.state === "open";
  // What beat its latest change, while the intent is still to do (the colony's movedBy).
  const moved = it.status !== "landed" && it.status !== "withdrawn" ? (store.returns.get(it.id)?.movedBy ?? null) : null;
  // What its model calls cost, where the colony counts per intent (FT_INTENT_SPEND); nothing when nothing was counted.
  const spent = store.intentSpend.get(it.id) ?? null;
  const spentLine = intentSpendLine(spent);
  // Why it last closed or reopened while an agent held it (the closure ledger); the report and returns badges say their own.
  const repeated = item.returns >= REPEATED_RETURNS && it.status !== "landed" && it.status !== "withdrawn";
  const closed = report || (repeated && it.closure?.cause === "returned") ? null : closureBadge(it.closure, (id) => store.agentName(id), now);
  return (
    <li
      ref={lit ? setLitEl : undefined}
      data-key={intentRow(it.id)}
      className={`intent intent-${it.status}${report ? " has-report" : ""}${lit ? " is-lit" : ""}`}
      tabIndex={0}
      onMouseEnter={() => store.setHighlight(it.footprint)}
      onFocus={() => store.setHighlight(it.footprint)}
      onBlur={() => store.setHighlight([])}
      onClick={() => onPick(it.footprint[0] ?? null)}
      onKeyDown={(e) => {
        // The row's own key (not a why link's): a replay's space-to-pause does not see it.
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        e.stopPropagation();
        onPick(it.footprint[0] ?? null);
      }}
      title={it.withdrawnReason ? `Withdrawn: ${it.withdrawnReason}` : undefined}
    >
      <div className="intent-title">
        {it.revision > 1 ? (
          <span className="rev-badge" title={`Amended ${it.revision - 1} time${it.revision === 2 ? "" : "s"}: uncommitted changes built on older revisions are stopped; one already committed is reported with its landing`}>
            r{it.revision}
          </span>
        ) : null}
        {it.title}
      </div>
      <div className="intent-meta">
        {report ? (
          <span className="ibadge ibadge-report" title={`${store.agentName(report.agentId)} reported: ${report.report}`}>
            report · {KIND_LABEL[report.kind] ?? report.kind}
          </span>
        ) : null}
        {it.contest && it.contest >= 2 ? (
          <span className="ibadge ibadge-contest" title={`Contest: up to ${it.contest} agents build it at once, and the colony lands one of their changes`}>
            contest ×{it.contest}
          </span>
        ) : null}
        {item.returns >= REPEATED_RETURNS && it.status !== "landed" && it.status !== "withdrawn" ? (
          <span className="ibadge ibadge-returned" title={store.returns.get(it.id)?.reason ?? "Returned to its agent"}>
            returned {fmtInt(item.returns)}×
          </span>
        ) : null}
        {moved ? <MovedBadge moved={moved} agentName={(id) => store.agentName(id)} /> : null}
        {closed ? (
          <span className={`ibadge ibadge-closure ibadge-closure-${it.closure?.cause ?? "none"}`} title={closed.title}>
            {closed.label}
          </span>
        ) : null}
        <span className="mono intent-path">{it.status === "withdrawn" && it.withdrawnReason ? it.withdrawnReason : (it.footprint[0] ?? "—")}</span>
        {it.status !== "withdrawn" && it.footprint.length > 1 ? <span className="intent-more">+{it.footprint.length - 1}</span> : null}
        {spentLine ? (
          <span className="intent-spend" title={intentSpendDetail(spent, store.spend?.priceDate)}>
            {spentLine}
          </span>
        ) : null}
        <span className="intent-when">
          {it.assignedTo && !fresh ? `${store.agentName(it.assignedTo)} · ` : ""}
          {timeAgo(fresh ? it.createdAt : it.updatedAt, now)}
        </span>
      </div>
      {chain.length ? <WhyChain links={chain} onFollow={onFollow} /> : null}
      {/* Its lifecycle strip, read from the colony when a person opens it (Lifecycle.tsx). */}
      <IntentLifecycleToggle store={store} intentId={it.id} now={now} />
    </li>
  );
}

/** An intent's why chain: the intents it was declared from, nearest first, then the rule that started it. */
function WhyChain({ links, onFollow }: { links: WhyLink[]; onFollow: (l: WhyLink) => void }) {
  return (
    <div className="intent-why">
      <span className="intent-why-k">why</span>
      {links.map((l, i) => (
        <Fragment key={l.kind === "rule" ? l.origin.key : `p:${l.id}`}>
          {i > 0 ? (
            <span className="intent-why-sep" aria-hidden="true">
              ←
            </span>
          ) : null}
          {l.kind === "rule" ? (
            <button
              type="button"
              className="why-link why-rule"
              title={`Declared by the rule “${l.origin.label}”${l.origin.retracted ? " (retracted)" : ""}. Show the rule's intents.`}
              onClick={(e) => {
                e.stopPropagation();
                onFollow(l);
              }}
            >
              rule: {l.origin.label}
            </button>
          ) : l.title !== null ? (
            <button
              type="button"
              className="why-link"
              title={`Declared from “${l.title}”. Show it.`}
              onClick={(e) => {
                e.stopPropagation();
                onFollow(l);
              }}
            >
              after: {l.title}
            </button>
          ) : (
            <span className="why-link is-unknown" title={`Declared from intent ${l.id}, which this page has not seen.`}>
              after: {shortId(l.id)}
            </span>
          )}
        </Fragment>
      ))}
    </div>
  );
}
