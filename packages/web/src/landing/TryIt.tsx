import { useState, type ReactNode } from "react";
import {
  GOAL_INTENTS,
  GOAL_LANDING,
  GOAL_PATH,
  GOAL_VERSIONS,
  MERGE_PATH,
  MERGE_PRESETS,
  READ_NAMES,
  READ_PATH,
  READ_SEEN,
  READ_TRUNK,
  READ_WRITES,
  TWIN_FIRST,
  TWIN_SECOND,
  goalScene,
  mergeScene,
  readScene,
  twinScene,
  type MergeInputs,
} from "./tryit.ts";

/**
 * The landing page's "try the rules" panel: four scenes, each a small editable example that the core's own check
 * decides in the visitor's browser (tryit.ts), with the result worded as the colony words it. No fetch, no token.
 */

/** A labeled editable text of a scene. */
function Text({ label, value, rows = 8, onChange }: { label: string; value: string; rows?: number; onChange: (value: string) => void }) {
  return (
    <label className="tr-field">
      <span className="tr-k">{label}</span>
      <textarea className="mono" rows={rows} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** A labeled one-line input (mono for paths). */
function Line({ label, value, mono = false, onChange }: { label: string; value: string; mono?: boolean; onChange: (value: string) => void }) {
  return (
    <label className="tr-field">
      <span className="tr-k">{label}</span>
      <input type="text" className={mono ? "mono" : undefined} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The outcome sentence, marked by what happens to the change: it lands or goes on (green), or it is held or goes back (amber). */
function Result({ kind, who, children }: { kind: string; who?: string; children: ReactNode }) {
  const held = kind === "back" || kind === "waits" || kind === "caught";
  return (
    <p className={`tr-result ${held ? "is-held" : "is-clear"}`}>
      {who ? <span className="tr-who">{who}</span> : null}
      {who ? " " : null}
      {children}
    </p>
  );
}

/** One scene: its number, title, the one-line caption naming the core module that decides it, and its inputs and result. */
function Scene({ id, n, title, caption, children }: { id: string; n: number; title: string; caption: ReactNode; children: ReactNode }) {
  return (
    <article className="tr-scene" id={`try-${id}`}>
      <div className="tr-head">
        <span className="tr-n">{n}</span>
        <div>
          <h3 className="tr-name">{title}</h3>
          <p className="tr-cap">{caption}</p>
        </div>
      </div>
      {children}
    </article>
  );
}

/** Scene 1: text merge and the insertion rule, as the trunk writer runs them on the second of two changes from one trunk. */
function MergeScene() {
  const [inputs, setInputs] = useState<MergeInputs>(MERGE_PRESETS[0]!.inputs);
  const out = mergeScene(inputs);
  const set = (key: keyof MergeInputs) => (value: string) => setInputs((cur) => ({ ...cur, [key]: value }));
  return (
    <Scene
      id="merge"
      n={1}
      title="Two agents edit one file from the same trunk"
      caption={
        <>
          Decided by <code>core/textmerge.ts</code> and <code>core/insertions.ts</code>, called as the trunk writer calls them once <code>core/occ.ts</code> finds the second change stale: <code>mergeText(base, trunk, change, undefined, {"{ insertions: true }"})</code>.
        </>
      }
    >
      <div className="tr-presets">
        <span className="tr-presets-k">Try</span>
        {MERGE_PRESETS.map((p) => (
          <button key={p.id} type="button" className="tr-preset" onClick={() => setInputs(p.inputs)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="tr-inputs">
        <Text label={`${MERGE_PATH} as both agents read it`} value={inputs.base} onChange={set("base")} />
        <Text label="What the first agent landed (trunk now)" value={inputs.trunk} onChange={set("trunk")} />
        <Text label="What the second agent proposes" value={inputs.change} onChange={set("change")} />
      </div>
      <Result kind={out.kind}>{out.sentence}</Result>
      {out.kind === "merged" ? (
        <div className="tr-out">
          <span className="tr-k">What lands</span>
          <pre className="mono">{out.text}</pre>
        </div>
      ) : null}
    </Scene>
  );
}

/** Scene 2: read-set validation on a change that read a file trunk has since changed, and the pre-check of import-name revalidation. */
function ReadScene() {
  const [seen, setSeen] = useState(READ_SEEN);
  const [trunk, setTrunk] = useState(READ_TRUNK);
  const [deleted, setDeleted] = useState(false);
  const out = readScene({ seen, trunk, deleted });
  return (
    <Scene
      id="read"
      n={2}
      title="A change read a file that moved"
      caption={
        <>
          Decided by <code>core/occ.ts</code>: <code>validateProposal</code>, then <code>revalidationCandidate</code> for a stale change, as the trunk writer calls them. The change writes <code>{READ_WRITES}</code> and imports <code>{READ_NAMES.join(", ")}</code> from <code>{READ_PATH}</code>, which it read.
        </>
      }
    >
      <div className="tr-inputs tr-cols-2">
        <Text label={`${READ_PATH} as the change read it`} rows={4} value={seen} onChange={setSeen} />
        <div className="tr-col">
          <Text label={`${READ_PATH} on trunk now`} rows={4} value={trunk} onChange={setTrunk} />
          <label className="tr-check">
            <input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} />
            Trunk deleted the file instead
          </label>
        </div>
      </div>
      <Result kind={out.kind}>{out.sentence}</Result>
      {out.lane ? <p className="tr-lane">{out.lane}</p> : null}
    </Scene>
  );
}

/** Scene 3: the goal-conflict check on two changes that each move a backend away from the language a landing just gave it. */
function GoalScene() {
  const [landed, setLanded] = useState(GOAL_VERSIONS.int_rust);
  const [go, setGo] = useState(GOAL_VERSIONS.int_go);
  const [ts, setTs] = useState(GOAL_VERSIONS.int_ts);
  const goOut = goalScene(landed, go, "int_go");
  const tsOut = goalScene(landed, ts, "int_ts");
  return (
    <Scene
      id="goals"
      n={3}
      title="Two changes would undo what just landed for another goal"
      caption={
        <>
          Decided by <code>core/goalconflict.ts</code> (<code>removedLines</code>, <code>LineTrace</code>, <code>findGoalConflict</code>) as the decide stage calls them over the trunk writer's trace of who wrote each line. Landing <code>{GOAL_LANDING}</code> created <code>{GOAL_PATH}</code> three minutes ago for "{GOAL_INTENTS.int_rust.title}"; the changes below, for "{GOAL_INTENTS.int_go.title}" and "{GOAL_INTENTS.int_ts.title}", each propose their own version over it.
        </>
      }
    >
      <div className="tr-inputs">
        <Text label="Landed for the Rust intent" rows={9} value={landed} onChange={setLanded} />
        <Text label="Proposed for the Go intent" rows={9} value={go} onChange={setGo} />
        <Text label="Proposed for the TypeScript intent" rows={9} value={ts} onChange={setTs} />
      </div>
      <Result kind={goOut.kind} who="The Go change:">
        {goOut.sentence}
      </Result>
      <Result kind={tsOut.kind} who="The TypeScript change:">
        {tsOut.sentence}
      </Result>
    </Scene>
  );
}

/** Scene 4: the twin check on a declare whose title and footprint look like an intent the colony has. */
function TwinScene() {
  const [firstTitle, setFirstTitle] = useState<string>(TWIN_FIRST.title);
  const [firstFootprint, setFirstFootprint] = useState<string>(TWIN_FIRST.footprint);
  const [title, setTitle] = useState<string>(TWIN_SECOND.title);
  const [footprint, setFootprint] = useState<string>(TWIN_SECOND.footprint);
  const out = twinScene({ firstTitle, firstFootprint, title, footprint });
  return (
    <Scene
      id="twins"
      n={4}
      title="The same need declared twice in different words"
      caption={
        <>
          Decided by <code>core/twins.ts</code> (<code>findTwins</code>, with <code>titleScore</code> and <code>footprintsOverlap</code> saying why) as the colony calls it on every declare, with production's thresholds: a title score of at least 0.8 and footprints that overlap.
        </>
      }
    >
      <div className="tr-inputs tr-cols-2">
        <div className="tr-col">
          <Line label={`The colony has (${TWIN_FIRST.id}, open): title`} value={firstTitle} onChange={setFirstTitle} />
          <Line label="Its footprint" mono value={firstFootprint} onChange={setFirstFootprint} />
        </div>
        <div className="tr-col">
          <Line label="Being declared: title" value={title} onChange={setTitle} />
          <Line label="Its footprint" mono value={footprint} onChange={setFootprint} />
        </div>
      </div>
      <Result kind={out.kind}>{out.sentence}</Result>
    </Scene>
  );
}

/** The "try the rules" section of the landing page, right after the with-and-without panel. */
export function TryIt() {
  return (
    <section className="l-section" id="try">
      <div className="l-section-head">
        <div className="l-kicker">In your browser</div>
        <h2 className="l-h2">Try the rules.</h2>
        <p className="l-section-lede">
          The checks that decide what lands are pure functions in the core package the server runs. Each scene runs one of them here, on the text you edit, with the options production passes; nothing is sent anywhere and no token is needed. The result changes as you type.
        </p>
      </div>
      <div className="tr">
        <MergeScene />
        <ReadScene />
        <GoalScene />
        <TwinScene />
      </div>
    </section>
  );
}
