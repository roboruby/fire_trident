import { SITE } from "./questions.ts";

/**
 * The landing page's table of how FireTrident answers each judging axis (Axes.tsx), the pitch line, and the commands
 * that take a colony's certified work back to the team's forge (TakeBack.tsx). The README carries the same table:
 * axesMarkdown() writes it, word for word, with links to the public site.
 */

/** The pitch, where the landing page pitches: a colony sits beside the team's forge, not in place of it. */
export const PITCH = "A colony sits beside your forge.";

/** What the pitch means, in what exists today: give it a target, it converges and certifies, and the work goes back as a branch. */
export const PITCH_MORE =
  "You don't send it pull requests: you give it a target, and it converges, certifies and tells you why. What it certified goes back to your GitHub as a branch.";

/** How a row is checked: a page of the site (a live replay or an in-browser scene), or a command to run. */
export type AxisCheck = { label: string; href: string } | { label: string; command: string };

/** One judging axis: the mechanism that answers it, in one sentence, and how to check it. */
export interface Axis {
  id: "concurrency" | "coordination" | "context" | "review" | "conflicts";
  axis: string;
  /** One sentence, naming the mechanism first. */
  mechanism: string;
  check: AxisCheck;
}

/** Read a showcase colony's newest lineage note with stock git, no account and no token. */
export const NOTES_COMMAND = `git clone ${SITE}/git/byo-demo.git && cd byo-demo && git fetch origin refs/notes/firetrident:refs/notes/firetrident && git log --notes=firetrident -1`;

/** The five axes, in the order the judging names them. Every sentence holds for what production runs today, flags named. */
export const AXES: readonly Axis[] = [
  {
    id: "concurrency",
    axis: "Concurrency",
    mechanism:
      "Read-set validation: a change lands only if every file it read is still what it read, so up to 200 proposals fold into one trunk cycle with no lock and no rebase.",
    check: { label: "Replay 2,000 agents landing 6,606 changes", href: "/c/scale?replay=1&t=32&speed=4" },
  },
  {
    id: "coordination",
    axis: "Coordination",
    mechanism: "Decaying claims: agents read the claims and needs other agents leave on the code, and each chooses its own work from the goals people set, with no queue and no one assigning it.",
    check: { label: "Replay the Hono run", href: "/c/hono?replay=1" },
  },
  {
    id: "context",
    axis: "Context",
    mechanism:
      "Lineage notes: every landed commit carries a JSON note in git (the intent, the rule and who approved it, the agent and its model, every decision, the files read and written), sealed by its SHA-256 in the commit's FT-Note trailer.",
    check: { label: "Read the newest note with stock git", command: NOTES_COMMAND },
  },
  {
    id: "review",
    axis: "Review",
    mechanism: "Deterministic proof first, then decision models, a second model from another family and a person, each only when the cheaper layer is unsure.",
    check: { label: "See a proof-path landing", href: "/c/hono?path=src/index.ts" },
  },
  {
    id: "conflicts",
    axis: "Conflicts",
    mechanism:
      "Text merge lands edits to different lines of one file; a change that cannot merge goes back naming the landing that beat it and quoting that landing's diff and the contested lines, so the agent repairs it without reading trunk again.",
    check: { label: "Run the text merge in your browser", href: "/#try-merge" },
  },
];

/** A site path as a full URL on the public site (for the README). */
export function siteUrl(href: string): string {
  return href.startsWith("/") ? `${SITE}${href}` : href;
}

/** The README's version of the table, in Markdown, with full links. */
export function axesMarkdown(): string {
  const rows = AXES.map((a) => {
    const check = "href" in a.check ? `[${a.check.label}](${siteUrl(a.check.href)})` : `${a.check.label}: \`${a.check.command}\``;
    return `| ${a.axis} | ${a.mechanism} | ${check} |`;
  });
  return ["| Axis | How FireTrident answers it | Check it |", "| --- | --- | --- |", ...rows].join("\n");
}

/** The colony whose `certified` branch the take-back commands clone (the one the quickstart in RunIt.tsx clones too). */
export const TAKE_BACK_COLONY = "shortlinks";

/**
 * Take the work back: clone what the colony certified with stock git, bring its lineage notes, push both to the
 * team's forge (the commit's trailers travel with it, the notes with their own ref), then open a pull request there.
 */
export const TAKE_BACK_COMMANDS = [
  "# What the colony certified, with stock git and no account",
  `git clone -b certified ${SITE}/git/${TAKE_BACK_COLONY}.git && cd ${TAKE_BACK_COLONY}`,
  "# Its lineage notes (each commit already carries its FT-* trailers)",
  "git fetch origin refs/notes/firetrident:refs/notes/firetrident",
  "# Push both to your forge: certified as a branch, the notes beside it",
  "git push <your-origin> certified:refs/heads/firetrident/certified",
  "git push <your-origin> refs/notes/firetrident",
  "# Then open a pull request from firetrident/certified on GitHub",
].join("\n");
