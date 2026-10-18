import { describe, expect, it } from "vitest";
import type { Colony, Decision, Id, Intent, IntentSource, Landing, Proposal } from "@fire_trident/core";
import type { Env } from "../../src/env.ts";
import { noteDecisions, type DecisionRow } from "../../src/colony/direction.ts";
import { DecideEngine, type DecideHost, type DecisionInput, type TrunkRpc } from "../../src/decide/engine.ts";
import type { KeepSource } from "../../src/decide/quotes.ts";
import type { ClefAnswer } from "../../src/decide/reflex.ts";
import { VIEW_CHECK, VIEW_RULE } from "../../src/decide/reviewview.ts";
import { sha256Hex } from "../../src/trunk/digest.ts";

/**
 * The review view through the decide pipeline (FT_REVIEW_VIEW with FT_QUOTED_ACCEPTANCE): a colony in memory around the
 * engine, Clef answering clean, and a second opinion that behaves as the reviewers did in the measured contention run: it
 * sends a change back when it is asked keep lines it cannot see in the diff, and it quotes lines from wherever it saw them.
 */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
}

const COLONY: Colony = { id: "c1", name: "c1", trunk: { namespace: "ft-trunk", name: "c1", remote: "" }, trunkSha: "0".repeat(40), createdAt: 0, regionDepth: 1 };
const CLEAN: Record<string, ClefAnswer> = {
  needs_human: { type: "noul", noul: 0.03 },
  touches_sensitive: { type: "noul", noul: 0.02 },
  off_intent: { type: "noul", noul: 0.02 },
  risk: { type: "score", score: 0.4, probabilities: {}, confidence: 0.9 },
};
const APPROVE = { verdict: "approve", needs_human: 0.05, off_intent: false, sensitive: false, confidence: 0.95, reason: "does what the intent asks" };

/** The money module on trunk: an earlier landing (split) added allocate and isZero; format still takes a boolean. */
const MONEY = [
  "export interface Money {",
  "  readonly cents: number;",
  "  readonly currency: string;",
  "}",
  "",
  'export const DEFAULT_CURRENCY = "USD";',
  "",
  "export function money(cents: number, currency: string = DEFAULT_CURRENCY): Money {",
  "  if (!Number.isSafeInteger(cents)) throw new RangeError(`money: ${cents} is not a whole number of cents`);",
  "  return { cents, currency };",
  "}",
  "",
  "export function allocate(m: Money, ratios: readonly number[]): Money[] {",
  '  if (ratios.length === 0) throw new RangeError("allocate: no ratios");',
  "  const total = ratios.reduce((s, r) => s + r, 0);",
  "  return ratios.map((r) => money(Math.floor((m.cents * r) / total), m.currency));",
  "}",
  "",
  "export function isZero(m: Money): boolean {",
  "  return m.cents === 0;",
  "}",
  "",
  "export function add(a: Money, b: Money): Money {",
  "  return money(a.cents + b.cents, a.currency);",
  "}",
  "",
  "export function subtract(a: Money, b: Money): Money {",
  "  return money(a.cents - b.cents, a.currency);",
  "}",
  "",
  "export function format(m: Money, symbol: boolean = true): string {",
  "  return symbol ? `$${m.cents / 100}` : `${m.cents / 100}`;",
  "}",
  "",
].join("\n");

/** The tips intent's change to it: roundUp added at the end, nothing else touched. */
const ROUND_UP = [
  "export function roundUp(m: Money, step: number): Money {",
  '  if (!Number.isSafeInteger(step) || step < 1) throw new RangeError("roundUp: step must be a whole number of at least 1");',
  "  return money(Math.ceil(m.cents / step) * step, m.currency);",
  "}",
  "",
].join("\n");
const TIP = 'import { money, roundUp, type Money } from "./core/money.ts";\n\nexport function roundedTotal(total: Money): Money {\n  return roundUp(money(total.cents), 100);\n}\n';

/** The tips intent's lines: one FireTrident can check, one only a model can. */
const TIPS = ["src/core/money.ts exports roundUp(m: Money, step: number): Money", "amounts stay whole cents: money() throws a RangeError for a fractional amount"];
/** The keep lines of the split landing: one FireTrident can check, one only a model can. */
const SPLIT_KEEP: KeepSource = {
  landingId: "lnd_split",
  intentId: "int_split",
  source: "human",
  acceptance: ["src/core/money.ts exports allocate(m: Money, ratios: readonly number[]): Money[]", "allocate throws a RangeError for an empty list"],
};

/** What the reviewer quotes for each line, by a phrase of the line: lines in regions of money.ts the change did not touch. */
const QUOTES: Array<[string, { path: string; quote: string }]> = [
  ["exports roundUp", { path: "src/core/money.ts", quote: "export function roundUp(m: Money, step: number): Money {" }],
  ["fractional amount", { path: "src/core/money.ts", quote: "if (!Number.isSafeInteger(cents)) throw new RangeError(`money: ${cents} is not a whole number of cents`);" }],
  ["exports allocate", { path: "src/core/money.ts", quote: "export function allocate(m: Money, ratios: readonly number[]): Money[] {" }],
  ["empty list", { path: "src/core/money.ts", quote: 'if (ratios.length === 0) throw new RangeError("allocate: no ratios");' }],
  ["exports splitBill", { path: "src/split.ts", quote: "export function splitBill(invoice: Invoice, people: number): Money[] {" }],
];

/** A fenced section of a prompt. */
function fencedSection(prompt: string, label: string): string | null {
  const m = new RegExp(`${label}[^\\n]*, between (fence-[0-9a-f]{12}) markers:\\n\\1\\n([\\s\\S]*?)\\n\\1(?:\\n|$)`).exec(prompt);
  return m ? m[2]! : null;
}

/** The second opinion as the run's reviewers behaved: keep lines it cannot see send the change back; otherwise it approves, quoting what it knows. */
function reviewer(prompt: string): Record<string, unknown> {
  const diff = fencedSection(prompt, "Diff") ?? "";
  const keep = fencedSection(prompt, "Keep lines") ?? "";
  if (keep !== "" && !diff.includes("export function allocate")) return { ...APPROVE, verdict: "return", reason: "The intent is met, but the keep lines cannot be verified from the diff." };
  const numbered = [...`${fencedSection(prompt, "Acceptance lines") ?? ""}\n${keep}`.matchAll(/^(\d+)\. (.+)$/gm)];
  const acceptance = numbered.map(([, n, text]) => {
    const q = QUOTES.find(([phrase]) => text!.includes(phrase))?.[1];
    return q ? { line: Number(n), verdict: "met", ...q } : { line: Number(n), verdict: "unclear", path: "", quote: "" };
  });
  return { ...APPROVE, ...(acceptance.length > 0 ? { acceptance } : {}) };
}

class FakeAi {
  calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, input });
    if (input.questions) return { answers: Object.fromEntries(Object.keys(input.questions as object).map((id) => [id, CLEAN[id] ?? { type: "noul", noul: 0.02 }])) };
    const prompt = ((input.messages ?? []) as Array<{ content: string }>).map((m) => m.content).join("\n");
    return { response: JSON.stringify(reviewer(prompt)) };
  }
  opinions(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.input.messages).map((c) => c.input);
  }
  prompt(i = 0): string {
    return ((this.opinions()[i]?.messages ?? []) as Array<{ content: string }>).map((m) => m.content).join("\n");
  }
  system(i = 0): string {
    return ((this.opinions()[i]?.messages ?? []) as Array<{ role: string; content: string }>).find((m) => m.role === "system")?.content ?? "";
  }
}

class Colonyish implements DecideHost {
  readonly ai = new FakeAi();
  readonly blobs = new Map<string, string>();
  readonly env: Env;
  readonly sql = sqlStorage();
  readonly proposals = new Map<Id, Proposal>();
  readonly intents = new Map<Id, Intent>();
  readonly decisions: Decision[] = [];
  readonly engine: DecideEngine;
  /** Trunk files the trunk answers for (absent: not on trunk); a value of Error makes the read fail. */
  readonly trunkFiles = new Map<string, string | Error>();
  trunkReads: string[] = [];
  keep: KeepSource | null = null;
  private seq = 0;

  constructor(flags: { quoted?: string; view?: string } = {}) {
    const blobs = this.blobs;
    const artifacts = { get: async () => ({ readBlob: async (sha: string) => (blobs.has(sha) ? new Blob([blobs.get(sha)!]) : null) }) };
    this.env = {
      AI: this.ai,
      ARTIFACTS: artifacts,
      ...(flags.quoted !== undefined ? { FT_QUOTED_ACCEPTANCE: flags.quoted } : {}),
      ...(flags.view !== undefined ? { FT_REVIEW_VIEW: flags.view } : {}),
    } as unknown as Env;
    this.engine = new DecideEngine(this);
  }
  waitUntil(): void {}
  colony(): Colony {
    return COLONY;
  }
  intent(id: Id): Intent | null {
    return this.intents.get(id) ?? null;
  }
  rules() {
    return [];
  }
  agent() {
    return { kind: "external" as const, name: "a", model: "@cf/example/author-model" };
  }
  proposal(id: Id): Proposal | null {
    return this.proposals.get(id) ?? null;
  }
  proposalRegion(): string {
    return "src";
  }
  stuckChecking(): Id[] {
    return [];
  }
  async updateProposals(items: Array<{ id: Id; patch: Partial<Proposal> }>): Promise<void> {
    for (const { id, patch } of items) this.save({ ...this.proposals.get(id)!, ...patch });
  }
  async recordDecision(d: DecisionInput): Promise<Decision> {
    const decision: Decision = { ...d, id: `dec_${++this.seq}`, colonyId: COLONY.id, at: d.at ?? Date.now() + this.seq };
    this.decisions.push(decision);
    return decision;
  }
  decisionsFor(subject: Id): Decision[] {
    return this.decisions.filter((d) => d.subject === subject);
  }
  bump(): void {}
  setMetric(): void {}
  emit(): void {}
  trunk(): TrunkRpc {
    return {
      baseBlobs: async () => [],
      blobsFor: async (paths) => Object.fromEntries(paths.map((p) => [p, null])),
      readFile: async (path) => {
        this.trunkReads.push(path);
        const f = this.trunkFiles.get(path);
        if (f instanceof Error) throw f;
        return f ?? null;
      },
      files: async () => [],
      systemCommit: async () => ({ id: "lnd_ab", colonyId: COLONY.id, trunkSha: "1".repeat(40) }) as unknown as Landing,
    };
  }
  async systemCommitted(): Promise<void> {}
  async vaccineAgent(): Promise<Id> {
    return "agt_vaccine";
  }
  vaccineTargets() {
    return [];
  }
  sealedIntent(): Id {
    return "int_sealed";
  }
  async propose(): Promise<Proposal> {
    throw new Error("not used");
  }
  seal(): void {}
  keepAcceptance(): KeepSource | null {
    return this.keep;
  }

  save(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.sql.exec("INSERT INTO proposals (id, status) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status", p.id, p.status);
  }

  declare(acceptance: string[], over: Partial<Intent> = {}, source: IntentSource = "human"): Intent {
    const intent: Intent = {
      id: `int_${++this.seq}`,
      colonyId: COLONY.id,
      title: "Tips",
      why: "Diners want suggested tips.",
      source,
      footprint: ["src/core/money.ts", "src/tip.ts"],
      priority: 1,
      status: "proposed",
      createdAt: 0,
      createdBy: "t",
      acceptance,
      ...over,
    };
    this.intents.set(intent.id, intent);
    return intent;
  }

  async decide(intent: Intent, files: Array<{ path: string; before?: string; after: string | null }>): Promise<Proposal> {
    const blob = (text: string): string => {
      const id = `${(++this.seq).toString(16).padStart(8, "0")}${"a".repeat(32)}`;
      this.blobs.set(id, text);
      return id;
    };
    const p: Proposal = {
      id: `prp_${++this.seq}`,
      colonyId: COLONY.id,
      intentId: intent.id,
      agentId: "agt_1",
      workspace: { namespace: "ft-trunk", name: "ws", remote: "" },
      baseSha: COLONY.trunkSha,
      headSha: `${this.seq}`.padStart(40, "f"),
      writeSet: files.map((f) => ({ path: f.path, blob: f.after === null ? null : blob(f.after) })),
      readSet: files.filter((f) => f.before !== undefined).map((f) => ({ path: f.path, blob: blob(f.before!) })),
      declared: { footprint: intent.footprint, summary: intent.title },
      evidence: { checks: [], notVerified: "Not verified: no tests were run." },
      status: "checking",
      createdAt: Date.now(),
    };
    this.save(p);
    await this.engine.run(p.id);
    return this.proposals.get(p.id)!;
  }

  llmDecision(id: Id): Decision | undefined {
    return this.decisions.find((d) => d.subject === id && d.layer === "llm");
  }
}

/** The tips change: roundUp appended to money.ts, and the new src/tip.ts. */
const TIPS_CHANGE = [
  { path: "src/core/money.ts", before: MONEY, after: `${MONEY}\n${ROUND_UP}` },
  { path: "src/tip.ts", after: TIP },
];

describe("the measured run's false return: keep lines the reviewer cannot see in the diff", () => {
  it("flag off: the reviewer is asked the keep lines over the hunks alone, cannot find allocate, and sends a correct change back", async () => {
    const c = new Colonyish({ quoted: "on" });
    c.keep = SPLIT_KEEP;
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(p.status).toBe("returned");
    expect(p.reason).toContain("the keep lines cannot be verified from the diff");
    // The export it could not see exists, unchanged, in a region of the file the change did not touch.
    expect(fencedSection(c.ai.prompt(), "Diff")).not.toContain("export function allocate");
    expect(p.evidence.checks.map((k) => k.name)).not.toContain(VIEW_CHECK);
  });

  it("flag on: FireTrident proves the signature lines itself, and the reviewer sees the whole file for the rest", async () => {
    const c = new Colonyish({ quoted: "on", view: "c1" });
    c.keep = SPLIT_KEEP;
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(p.status).toBe("ready");
    // Only the lines no parser can check are asked, numbered afresh.
    const prompt = c.ai.prompt();
    expect(fencedSection(prompt, "Acceptance lines")).toBe("1. amounts stay whole cents: money() throws a RangeError for a fractional amount");
    expect(fencedSection(prompt, "Keep lines")).toBe("2. allocate throws a RangeError for an empty list");
    expect(fencedSection(prompt, "Diff")).toContain(" export function allocate(m: Money, ratios: readonly number[]): Money[] {");
    expect(fencedSection(prompt, "Facts")).toContain('keep line met, checked by FireTrident in the files after the change (not asked again): "src/core/money.ts exports allocate(m: Money, ratios: readonly number[]): Money[]"');
    expect(c.ai.system()).toContain("A keep line you cannot check either way is unclear, and that alone is no reason to return the change.");

    const llm = c.llmDecision(p.id)!;
    expect(llm.answers.rule).toBe("L3 innate+llm");
    expect(llm.answers.acceptance).toEqual([
      { kind: "intent", line: TIPS[0], verdict: "met", basis: "checked", path: "src/core/money.ts", quote: "roundUp(m: Money, step: number): Money" },
      { kind: "intent", line: TIPS[1], verdict: "met", basis: "quote", path: "src/core/money.ts", quote: "if (!Number.isSafeInteger(cents)) throw new RangeError(`money: ${cents} is not a whole number of cents`);" },
      { kind: "keep", line: SPLIT_KEEP.acceptance && (SPLIT_KEEP.acceptance as string[])[0], verdict: "met", basis: "checked", path: "src/core/money.ts", quote: "allocate(m: Money, ratios: readonly number[]): Money[]", landingId: "lnd_split" },
      { kind: "keep", line: (SPLIT_KEEP.acceptance as string[])[1], verdict: "met", basis: "quote", path: "src/core/money.ts", quote: 'if (ratios.length === 0) throw new RangeError("allocate: no ratios");', landingId: "lnd_split" },
    ]);
    expect(llm.answers.reasons).toContain("every acceptance line is met (2 lines): 1 with a quote found in the diff, 1 checked by FireTrident in the files after the change (line 1)");

    // The review card and the note mark the lines FireTrident checked as its own.
    const view = p.evidence.checks.find((k) => k.name === VIEW_CHECK)!;
    expect(view.ok).toBe(true);
    expect(view.detail).toContain("line 1 met: roundUp(m: Money, step: number): Money");
    expect(view.detail).toContain("keep line 1 met: allocate(m: Money, ratios: readonly number[]): Money[]");
    expect(view.detail).toContain("line 2 left to the model layers");
    expect(view.detail).toContain("the second opinion, if asked, sees src/core/money.ts whole");
    expect(p.evidence.checks.find((k) => k.name === "acceptance: quoted")?.detail).toContain("line 1 met: checked by FireTrident: src/core/money.ts roundUp(m: Money, step: number): Money");
    const rows: DecisionRow[] = c.decisions.map((d) => ({ id: d.id, kind: d.kind, subject: d.subject, layer: d.layer, answers: JSON.stringify(d.answers), p: d.p, action: d.action, at: d.at }));
    expect(noteDecisions(rows)[p.id]!.find((d) => d.layer === "llm")!.acceptance).toEqual(llm.answers.acceptance);
  });

  it("flag on: the receipt digests the whole-file view the reviewer was given", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    c.keep = SPLIT_KEEP;
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    const shown = fencedSection(c.ai.prompt(), "Diff")!;
    expect(shown).toContain("export function allocate");
    expect(c.llmDecision(p.id)!.answers.shown).toEqual({ view: "prompt-diff", digest: `sha256:${await sha256Hex(shown)}` });
  });
});

describe("the measured run's escalation: a quote from the file that the diff did not show", () => {
  it("flag off: a line met in an untouched region escalates to a person, its quote not in the diff", async () => {
    const c = new Colonyish({ quoted: "on" });
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(p.status).toBe("escalated");
    expect(p.reason).toContain('acceptance not shown met: line 2 "amounts stay whole cents: money() throws a RangeError for a fractional amount" (its quote is not in the added or unchanged lines of src/core/money.ts it was shown)');
    expect(c.llmDecision(p.id)!.answers.rule).toBe("L7 acceptance unclear");
  });

  it("flag on: the reviewer sees the whole file, and its quote is found there", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(p.status).toBe("ready");
    expect(c.llmDecision(p.id)!.answers.acceptance).toMatchObject([
      { verdict: "met", basis: "checked" },
      { verdict: "met", basis: "quote", path: "src/core/money.ts" },
    ]);
  });

  it("flag on: a file too large to show whole is shown as hunks, and a quote from it still counts when it is in the file after the change", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    // 30 KB of untouched functions between the constructor and the end of the file.
    const padding = Array.from({ length: 300 }, (_, i) => `export function pad${i}(m: Money): Money {\n  return money(m.cents + ${i}, m.currency);\n}\n`).join("\n");
    const big = MONEY.replace("export function allocate", `${padding}\nexport function allocate`);
    const p = await c.decide(c.declare(TIPS), [
      { path: "src/core/money.ts", before: big, after: `${big}\n${ROUND_UP}` },
      { path: "src/tip.ts", after: TIP },
    ]);
    expect(fencedSection(c.ai.prompt(), "Diff")).not.toContain("Number.isSafeInteger(cents)");
    expect(p.evidence.checks.find((k) => k.name === VIEW_CHECK)!.detail).not.toContain("whole");
    expect(p.status).toBe("ready");
    expect(c.llmDecision(p.id)!.answers.acceptance).toMatchObject([{ basis: "checked" }, { verdict: "met", basis: "quote" }]);
    // A quote that is nowhere in the file still does not count.
    QUOTES[1]![1].quote = "if (!Number.isInteger(cents)) throw new RangeError(`money: fractional`);";
    try {
      const fabricated = await c.decide(c.declare(TIPS), [
        { path: "src/core/money.ts", before: big, after: `${big}\n${ROUND_UP}` },
        { path: "src/tip.ts", after: TIP },
      ]);
      expect(fabricated.status).toBe("escalated");
      expect(fabricated.reason).toContain("its quote is not in the added or unchanged lines of src/core/money.ts it was shown");
    } finally {
      QUOTES[1]![1].quote = "if (!Number.isSafeInteger(cents)) throw new RangeError(`money: ${cents} is not a whole number of cents`);";
    }
  });
});

describe("a line FireTrident disproves sends the change back before any model", () => {
  const FORMAT = ["src/core/money.ts exports interface FormatOptions { symbol?: boolean; grouping?: boolean } and format(m: Money, options: FormatOptions = {}): string; the boolean second parameter is gone"];

  it("an intent line: the exact mismatch, rule A1, and no model call", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    const after = MONEY.replace("export function format(m: Money, symbol: boolean = true): string {", "export function format(m: Money, symbol: boolean = true, grouping = false): string {");
    const p = await c.decide(c.declare(FORMAT, { title: "Format options" }), [{ path: "src/core/money.ts", before: MONEY, after }]);
    expect(p.status).toBe("returned");
    expect(p.reason).toBe(
      `deterministic: acceptance not met: line 1 "${FORMAT[0]!.slice(0, 159)}…" (checked by FireTrident: src/core/money.ts does not export FormatOptions; src/core/money.ts has format(m: Money, symbol: boolean = true, grouping = false): string, not format(m: Money, options: FormatOptions = {}): string); change it so it meets that line, or escalate if the intent cannot be met as written`,
    );
    expect(c.ai.calls).toEqual([]);
    expect(p.evidence.checks.find((k) => k.name === VIEW_CHECK)).toMatchObject({ ok: false });
    expect(p.evidence.checks.find((k) => k.name === "gate")?.detail).toContain(`${VIEW_RULE} → return by deterministic`);
  });

  it("a keep line: broken only because it held before this change", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    c.keep = { landingId: "lnd_csv", intentId: "int_csv", source: "human", acceptance: ["src/core/money.ts exports isZero(m: Money): boolean"] };
    const after = `${MONEY.replace(/export function isZero[\s\S]*?\n}\n\n/, "")}\n${ROUND_UP}`;
    const p = await c.decide(c.declare(TIPS), [{ path: "src/core/money.ts", before: MONEY, after }]);
    expect(p.status).toBe("returned");
    expect(p.reason).toContain(
      'it breaks what a recent landing by another intent met: keep line 1 "src/core/money.ts exports isZero(m: Money): boolean" (from landing lnd_csv) (checked by FireTrident: src/core/money.ts does not export isZero, though it held before this change); keep what that landing did',
    );
    expect(c.ai.calls).toEqual([]);
  });

  it("a keep line that did not hold before the change either is unclear, not asked, and holds nothing up", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    c.keep = { landingId: "lnd_refund", intentId: "int_refund", source: "human", acceptance: ["src/core/money.ts exports isNegative(m: Money): boolean"] };
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(p.status).toBe("ready");
    expect(fencedSection(c.ai.prompt(), "Keep lines")).toBeNull();
    expect(c.llmDecision(p.id)!.answers.acceptance).toContainEqual({
      kind: "keep",
      line: "src/core/money.ts exports isNegative(m: Money): boolean",
      verdict: "unclear",
      basis: "checked",
      path: "src/core/money.ts",
      problem: "it did not hold before this change either: src/core/money.ts does not export isNegative",
      landingId: "lnd_refund",
    });
  });
});

describe("trunk files a line names", () => {
  const keep: KeepSource = { landingId: "lnd_split", intentId: "int_split", source: "human", acceptance: ["src/split.ts exports splitBill(invoice: Invoice, people: number): Money[]"] };
  const SPLIT = 'import { allocate, type Money } from "./core/money.ts";\nimport type { Invoice } from "./invoice.ts";\n\nexport function splitBill(invoice: Invoice, people: number): Money[] {\n  return allocate(invoice.total, Array.from({ length: people }, () => 1));\n}\n';

  it("are read from trunk: a keep line about a file the change does not write is proven there", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    c.keep = keep;
    c.trunkFiles.set("src/split.ts", SPLIT);
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(c.trunkReads).toEqual(["src/split.ts"]);
    expect(p.status).toBe("ready");
    expect(c.llmDecision(p.id)!.answers.acceptance).toContainEqual({ kind: "keep", line: keep.acceptance && (keep.acceptance as string[])[0], verdict: "met", basis: "checked", path: "src/split.ts", quote: "splitBill(invoice: Invoice, people: number): Money[]", landingId: "lnd_split" });
  });

  it("a failed read leaves the line to the model, as before", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    c.keep = keep;
    c.trunkFiles.set("src/split.ts", new Error("trunk unavailable"));
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(fencedSection(c.ai.prompt(), "Keep lines")).toBe("2. src/split.ts exports splitBill(invoice: Invoice, people: number): Money[]");
    expect(p.evidence.checks.find((k) => k.name === VIEW_CHECK)!.detail).toContain("keep line 1 left to the model layers");
  });
});

describe("flag off, or nothing to check: exactly as today", () => {
  it("FT_REVIEW_VIEW naming another colony: hunks only, every line asked", async () => {
    const c = new Colonyish({ quoted: "on", view: "c2,c3" });
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(p.status).toBe("escalated");
    expect(fencedSection(c.ai.prompt(), "Acceptance lines")).toBe(`1. ${TIPS[0]}\n2. ${TIPS[1]}`);
    expect(c.ai.system()).not.toContain("FireTrident checked");
    expect(c.trunkReads).toEqual([]);
  });

  it("FT_REVIEW_VIEW on without quoted acceptance: no lines, no view, no check", async () => {
    const c = new Colonyish({ view: "on" });
    const p = await c.decide(c.declare(TIPS), TIPS_CHANGE);
    expect(p.status).toBe("ready");
    expect(fencedSection(c.ai.prompt(), "Diff")).not.toContain("export function allocate");
    expect(c.ai.prompt()).not.toMatch(/acceptance/i);
    expect(p.evidence.checks.map((k) => k.name)).not.toContain(VIEW_CHECK);
  });

  it("an intent without acceptance lines is reviewed as before", async () => {
    const c = new Colonyish({ quoted: "on", view: "on" });
    const p = await c.decide(c.declare([]), TIPS_CHANGE);
    expect(p.status).toBe("ready");
    expect(fencedSection(c.ai.prompt(), "Diff")).not.toContain("export function allocate");
    expect(p.evidence.checks.map((k) => k.name)).not.toContain(VIEW_CHECK);
  });
});
