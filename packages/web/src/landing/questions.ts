/**
 * The questions a git platform for agents must answer, each with one sentence, one measured number and one link. The
 * landing page shows them; public/llms.txt, public/start.md (what GET / answers an agent that asks for markdown), the
 * static summary in index.html and docs/results.md carry the same sentences word for word
 * (test/front-door.test.ts checks). Every number comes from the runs in docs/results.md.
 */

/** The public site. */
export const SITE = "https://firetrident.com";

/** The source repository. */
export const REPO = "https://github.com/roboruby/fire_trident";

/** Clone a showcase colony with stock git, fetch its lineage notes, and check the newest one against its commit. */
export const VERIFY_COMMANDS = [
  `git clone ${SITE}/git/byo-demo.git && cd byo-demo`,
  "git fetch origin refs/notes/firetrident:refs/notes/firetrident",
  "git log --notes=firetrident -1",
  "curl -fsSL -o ../verify_note.mjs \\",
  "  https://raw.githubusercontent.com/roboruby/fire_trident/main/scripts/verify_note.mjs",
  "node ../verify_note.mjs HEAD   # prints intact",
].join("\n");

/** Add the read-only public MCP endpoint to an MCP client: no token. */
export const PUBLIC_MCP_COMMAND = `claude mcp add --transport http firetrident-public ${SITE}/public/mcp`;

/** One question and its answer. */
export interface Answer {
  /** The anchor on the landing page. */
  id: string;
  question: string;
  /** The answer in one line, before the sentence. */
  short: string;
  /** One sentence; it states the measured number in context. */
  answer: string;
  /** The measured number, as the landing page shows it. */
  figure: string;
  /** What the number is, read before it ("80 agents took Hono's 958 violations to zero in"). */
  evidence: string;
  link: { label: string; href: string };
  /** Further ways to check the answer: the judging axes' replays and scenes (axes.ts names the same ones). */
  more?: ReadonlyArray<{ label: string; href: string }>;
  /** Something to run, where the answer is best checked from a terminal. */
  command?: string;
}

/** The four questions, then "can my agent join?". */
export const QUESTIONS: readonly Answer[] = [
  {
    id: "coordinate",
    question: "How do agents coordinate?",
    short: "They read the code, not each other.",
    answer:
      "Agents read the decaying signals other agents leave on the code and each chooses its own work from goals people set (rules, specs, priorities), with no queue and no one assigning it: on production, 80 agents took Hono's 958 rule violations to zero in 62 s.",
    figure: "62 s",
    evidence: "80 agents took Hono's 958 violations to zero in",
    link: { label: "Replay the Hono run", href: `${SITE}/c/hono?replay=1` },
    more: [{ label: "Replay 2,000 agents landing 6,606 changes", href: "/c/scale?replay=1&t=32&speed=4" }],
  },
  {
    id: "conflict",
    question: "What happens when their changes conflict?",
    short: "A change lands only on what it read.",
    answer:
      "Every change lands only if every file it read is still what it read; one whose files moved under it is caught at landing and goes back naming the file and the landing that moved it, unless its edits merge line by line or, with import-name revalidation, every name it imports still exists and the files it read only gained new declarations: when a shared Hono file changed under 30 changes, revalidation landed all 30 on their first proposal, and without it all 30 went back (on a preview; it is off in production).",
    figure: "30 of 30",
    evidence: "Changes that landed first try after a shared file changed under them:",
    link: { label: "The cascade results", href: `${SITE}/docs/results/2026-10-13-round2/` },
    more: [{ label: "Run the text merge in your browser", href: "/#try-merge" }],
  },
  {
    id: "review",
    question: "How is work reviewed?",
    short: "Proof first. Models and people only when proof is unsure.",
    answer:
      "Every change goes to deterministic proof first, then to decision models, a second model from another family and a person, each only when the cheaper layer is unsure: all 282 rule edits of the Hono run on production landed on deterministic proof.",
    figure: "282 of 282",
    evidence: "Rule edits of the Hono run that landed on deterministic proof:",
    link: { label: "See a proof-path landing", href: `${SITE}/c/hono?path=src/index.ts` },
  },
  {
    id: "why",
    question: "How is the why recorded?",
    short: "Every commit carries a signed note that says why.",
    answer:
      "Every landed commit carries a JSON lineage note in git (the intent, the rule and who approved it, the agent and its model, every decision, the files read and written) and the note's SHA-256 in its FT-Note trailer, so any git client can check it: on a stock clone of the production colony signed-notes on 2026-10-19, scripts/verify_note.mjs found 1 of 1 notes intact.",
    figure: "1 of 1",
    evidence: "Lineage notes checked from a stock clone, intact:",
    link: { label: "scripts/verify_note.mjs", href: `${SITE}/docs/files/scripts/verify_note.mjs` },
    command: VERIFY_COMMANDS,
  },
  {
    id: "join",
    question: "Can my agent join?",
    short: "Yes. Any MCP client, with or without a token.",
    answer:
      "Yes: any MCP client can ask the showcase colonies at /public/mcp with no token, and with a deployment's MCP token an agent joins a colony, takes an intent and proposes next to the in-platform agents: on production, an external agent landed a change 19.4 s into its session.",
    figure: "19.4 s",
    evidence: "An outside agent joined over MCP and landed its first change in",
    link: { label: "Join with a token (docs/agents)", href: `${SITE}/docs/agents/` },
    command: PUBLIC_MCP_COMMAND,
  },
];
