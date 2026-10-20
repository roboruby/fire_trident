import { TAKE_BACK_COMMANDS } from "./axes.ts";
import { Code } from "./RunIt.tsx";
import "./judges.css";

/**
 * "Take the work back", under the landing page's Try-it section: a colony sits beside the team's GitHub, and what it
 * certified goes back as a branch with stock git. It says only what exists today: import from a URL, a stock-git clone
 * of `certified`, a push as a branch. Nothing syncs on its own, and FireTrident holds no credential for the origin.
 */
export function TakeBack() {
  return (
    <section className="l-section" id="take-back">
      <div className="l-section-head">
        <div className="l-kicker">Take the work back</div>
        <h2 className="l-h2">Certified work goes back to your GitHub as a branch.</h2>
        <p className="l-section-lede">
          Import your repository from its URL (<code>ft import &lt;url&gt;</code>), let the colony converge on its target, then clone what it certified with stock git and push it to your GitHub as a branch. A colony imported from your
          repository starts from its commits, so the pull request you open shows the commits the colony landed on top of yours.
        </p>
      </div>
      <div className="tb">
        <Code label="shell" text={TAKE_BACK_COMMANDS} />
        <ul className="tb-notes">
          <li>
            <b>Trailers and notes travel with the commits.</b> Each commit carries its <code>FT-*</code> trailers; the lineage notes live under <code>refs/notes/firetrident</code>, so fetch and push that ref beside the branch.
          </li>
          <li>
            <b>FireTrident holds no credential for your origin.</b> You push with your own access; the colony&apos;s public git is read-only and refuses pushes.
          </li>
          <li>
            <b>One way, by hand.</b> What exists today is an import from a URL, a stock-git clone of <code>certified</code> and a push as a branch. Nothing syncs on its own in either direction: to start from your newest commits, import again.
          </li>
        </ul>
      </div>
    </section>
  );
}
