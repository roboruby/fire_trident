import { ReviewChange } from "../components/ReviewChange.tsx";
import type { ReviewView } from "../review.ts";
import { FIELD_COLOR } from "../theme.ts";

/**
 * What reaches a person: the review card (the change itself, danger lines first), the questions
 * agents see before they write, and the repair loop on trunk. The card is drawn by the same
 * component as the Review tab, from an example change, and says so.
 */

const AUTH = 'if (c.req.header("Authorization") !== `Bearer ${c.env.ADMIN_TOKEN}`) return c.text("unauthorized", 401);';

/** An example change of the kind that waits for a person: a route that checks a bearer token, and a file outside its footprint. */
const EXAMPLE: ReviewView = {
  files: [
    {
      path: "src/routes/links.ts",
      status: "modified",
      added: 4,
      removed: 0,
      hunks: ["@@ -2,3 +2,7 @@", " const app = new Router();", ' app.get("/:code", get);', '+app.delete("/:code", async (c) => {', `+  ${AUTH}`, "+  return c.body(null, 204);", "+});", " export default app;"].join("\n"),
      truncated: false,
    },
    {
      path: "src/env.ts",
      status: "modified",
      added: 1,
      removed: 0,
      hunks: ["@@ -1,3 +1,4 @@", " export interface Env {", "   LINKS: KVNamespace;", "+  ADMIN_TOKEN: string;", " }"].join("\n"),
      truncated: false,
    },
  ],
  filesChanged: 2,
  danger: [{ path: "src/routes/links.ts", line: 5, cls: "auth", pattern: "auth:authorization-header", label: `auth (authorization-header) at src/routes/links.ts:5: ${AUTH}` }],
  residual: ["src/env.ts"],
};
const DECLARED: readonly string[] = ["src/routes/links.ts"];

/** Trunk commits, their own tests, and where certified points: it moves only to a commit whose tests passed. */
function RepairDiagram() {
  const commits = [
    { x: 40, ok: true },
    { x: 150, ok: false },
    { x: 270, ok: true },
  ];
  const green = FIELD_COLOR.trail;
  const red = FIELD_COLOR.danger;
  return (
    <svg viewBox="0 0 320 132" role="img" aria-label="A commit's tests fail on trunk, so the colony declares a repair; certified stays on the last green commit and moves only when the repair's tests pass.">
      <line x1="16" y1="70" x2="304" y2="70" stroke="#f38020" strokeOpacity="0.35" strokeWidth="1.5" />
      <path d="M150 84 C 160 118, 260 118, 268 86" fill="none" stroke="#e6eefc" strokeOpacity="0.28" strokeDasharray="3 4" />
      <text x="210" y="124" textAnchor="middle" className="pd-sub">
        repair intent
      </text>
      {commits.map((c) => (
        <g key={c.x}>
          <circle cx={c.x} cy="70" r="11" fill="#05070b" stroke={c.ok ? green : red} strokeWidth="2" />
          <text x={c.x} y="74.5" textAnchor="middle" className="pd-label" fill={c.ok ? green : red}>
            {c.ok ? "✓" : "✗"}
          </text>
        </g>
      ))}
      <text x="150" y="46" textAnchor="middle" className="pd-sub">
        tests fail
      </text>
      <g>
        <animateTransform attributeName="transform" type="translate" values="0 0; 0 0; 230 0; 230 0" keyTimes="0; 0.45; 0.6; 1" dur="7s" repeatCount="indefinite" />
        <rect x="8" y="14" width="64" height="18" rx="9" fill="rgba(31,224,142,0.14)" stroke={green} strokeOpacity="0.7" />
        <text x="40" y="27" textAnchor="middle" className="pd-mono" fill={green}>
          certified
        </text>
        <path d="M40 32 L40 52" stroke={green} strokeOpacity="0.6" />
      </g>
    </svg>
  );
}

/** The "when a person is needed" section of the landing page. */
export function Exceptions() {
  return (
    <section className="l-section" id="people">
      <div className="l-section-head">
        <div className="l-kicker">When a person is needed</div>
        <h2 className="l-h2">Nobody watches agents. People see exceptions.</h2>
        <p className="l-section-lede">
          The colony map counts only what needs a person: changes the checks could not settle, a red trunk, intents that keep coming back. Each one arrives with the evidence to decide it.
        </p>
      </div>
      <div className="ex-grid">
        <figure className="ex-card ex-review">
          <div className="ex-k">The review card</div>
          <h3 className="ex-head">The change itself, danger lines first.</h3>
          <p className="ex-body">
            A change the checks could not settle reaches the Review tab with its diff. The lines the danger patterns flagged and the files changed outside the declared footprint come first, and the whole change is one click away.
            Approve, return or reject it: a rejection becomes an antibody.
          </p>
          <div className="ex-demo">
            <div className="card ex-frame">
              <div className="card-head">
                <span className="pill pill-escalated">Escalated</span>
                <span className="card-when">example</span>
              </div>
              <div className="card-title">Delete a short link</div>
              <ReviewChange view={EXAMPLE} declared={DECLARED} />
            </div>
          </div>
          <figcaption className="ex-cap">An example card, drawn by the same code as the Review tab.</figcaption>
        </figure>
        <div className="ex-side">
          <article className="ex-card">
            <div className="ex-k">Before an agent writes</div>
            <h3 className="ex-head">Agents see what review will ask.</h3>
            <p className="ex-body">
              Every antibody is a question review asks of later changes to the same files. An agent that takes work on those files gets the questions with its task, so it can avoid what a person rejected before.
            </p>
            <div className="ex-prompt" aria-label="An example of what an agent reads when it takes work">
              <span className="ex-prompt-k">An agent's task, example</span>
              <p>A person rejected changes like this before. Review will ask these questions of your change; write it so that every answer is no:</p>
              <p className="mono">· Does the route change data without checking the caller's token?</p>
            </div>
          </article>
          <article className="ex-card">
            <div className="ex-k">After a change lands</div>
            <h3 className="ex-head">A repair counts only when its tests pass.</h3>
            <p className="ex-body">
              The project's own tests run on trunk after landings. <span className="mono">certified</span> moves only to a commit whose tests all passed. A failing trunk becomes a repair intent, and the repair counts only when the tests it
              was declared for run and pass: a run that lost tests never moves <span className="mono">certified</span>.
            </p>
            <div className="ex-diagram">
              <RepairDiagram />
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
