import { FIELD_COLOR, LAYER_COLOR } from "../theme.ts";

const TILE = "#131b28";
const EDGE = "rgba(150,170,200,0.16)";

/** Sense: files carry decaying marks; an agent walks to a need and around a claim. */
function SenseDiagram() {
  const cols = 8;
  const rows = 4;
  const w = 31;
  const h = 25;
  const gap = 4;
  const x0 = 22;
  const y0 = 14;
  const at = (c: number, r: number) => ({ x: x0 + c * (w + gap), y: y0 + r * (h + gap) });
  const center = (c: number, r: number) => ({ x: at(c, r).x + w / 2, y: at(c, r).y + h / 2 });
  const kind = (c: number, r: number): "need" | "claim" | "trail" | null => {
    const k = `${c},${r}`;
    if (k === "6,1" || k === "5,2" || k === "7,2") return "need";
    if (k === "3,1" || k === "4,2" || k === "4,1") return "claim";
    if (k === "1,0" || k === "2,0" || k === "0,1" || k === "6,3") return "trail";
    return null;
  };
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = at(c, r);
      const k = kind(c, r);
      tiles.push(
        <g key={`${c}-${r}`}>
          <rect x={p.x} y={p.y} width={w} height={h} rx="2" fill={TILE} stroke={EDGE} />
          {k ? (
            <rect x={p.x} y={p.y} width={w} height={h} rx="2" fill={FIELD_COLOR[k]} fillOpacity={k === "trail" ? 0.5 : 0.42} stroke={FIELD_COLOR[k]} strokeOpacity="0.9">
              {k === "need" ? <animate attributeName="fill-opacity" values="0.28;0.6;0.28" dur="2.6s" begin={`${(c + r) * 0.3}s`} repeatCount="indefinite" /> : null}
              {k === "trail" ? <animate attributeName="fill-opacity" values="0.62;0.08;0.62" keyTimes="0;0.9;1" dur="7s" begin={`${c * 0.7}s`} repeatCount="indefinite" /> : null}
            </rect>
          ) : null}
          {k === "claim" ? <rect x={p.x + w / 2 - 2} y={p.y + h / 2 - 2} width="4" height="4" fill="#f4f8ff" /> : null}
        </g>,
      );
    }
  }
  const a = center(0, 3);
  const b = center(2, 3);
  const c = center(3, 2);
  const d = center(5, 1);
  const e = center(6, 1);
  const path = `M${a.x} ${a.y} L${b.x} ${b.y} Q${c.x} ${c.y + 6} ${c.x + 8} ${c.y - 2} T${d.x} ${d.y + 14} L${e.x} ${e.y}`;
  return (
    <svg viewBox="0 0 320 150" role="img" aria-label="Files carry need, claim and trail marks; an agent walks around claimed files to a file that needs work.">
      {tiles}
      <path d={path} fill="none" stroke="#e6eefc" strokeOpacity="0.16" strokeDasharray="2 4" />
      <g>
        <rect x="-3" y="-3" width="6" height="6" fill="#ffffff">
          <animateMotion dur="4.2s" repeatCount="indefinite" path={path} keyPoints="0;1;1" keyTimes="0;0.7;1" calcMode="linear" />
        </rect>
        <circle r="7" fill="none" stroke="#ffffff" strokeOpacity="0.25">
          <animateMotion dur="4.2s" repeatCount="indefinite" path={path} keyPoints="0;1;1" keyTimes="0;0.7;1" calcMode="linear" />
        </circle>
      </g>
      <g className="pd-legend" transform="translate(22 144)">
        <rect width="7" height="7" y="-6.5" fill={FIELD_COLOR.need} />
        <text x="11">need</text>
        <rect x="52" width="7" height="7" y="-6.5" fill={FIELD_COLOR.claim} />
        <text x="63">claim</text>
        <rect x="110" width="7" height="7" y="-6.5" fill={FIELD_COLOR.trail} />
        <text x="121">trail</text>
        <rect x="160" width="5" height="5" y="-5.5" fill="#fff" />
        <text x="169">agent</text>
      </g>
    </svg>
  );
}

/** Decide: decisions flow right until a layer is sure; most stop at the reflex layer. */
function DecideDiagram() {
  const gates = [
    { x: 112, label: "Reflex", cost: "milliseconds", color: LAYER_COLOR.reflex },
    { x: 196, label: "LLM", cost: "seconds", color: LAYER_COLOR.llm },
    { x: 280, label: "Human", cost: "minutes", color: LAYER_COLOR.human },
  ];
  const dots = [
    { y: 50, end: 0, begin: 0 },
    { y: 62, end: 0, begin: 0.45 },
    { y: 74, end: 1, begin: 0.9 },
    { y: 86, end: 0, begin: 1.35 },
    { y: 98, end: 0, begin: 1.8 },
    { y: 70, end: 2, begin: 2.25 },
    { y: 58, end: 0, begin: 2.7 },
    { y: 90, end: 0, begin: 3.15 },
  ];
  return (
    <svg viewBox="0 0 320 150" role="img" aria-label="Decisions pass through reflex models, then an LLM, then a person; each stops at the first layer that is confident.">
      <line x1="16" y1="74" x2="296" y2="74" stroke="#e6eefc" strokeOpacity="0.08" strokeWidth="56" />
      {gates.map((g, i) => (
        <g key={g.label}>
          <rect x={g.x - 9} y={34 + i * 9} width="18" height={80 - i * 18} rx="5" fill={g.color} fillOpacity="0.14" stroke={g.color} strokeOpacity="0.85" />
          <text x={g.x} y="132" textAnchor="middle" className="pd-label" fill={g.color}>
            {g.label}
          </text>
          <text x={g.x} y="145" textAnchor="middle" className="pd-sub">
            {g.cost}
          </text>
        </g>
      ))}
      {dots.map((d, i) => {
        const gate = gates[d.end] ?? gates[0]!;
        const yEnd = d.end === 0 ? d.y : 74 + (d.y - 74) * (d.end === 1 ? 0.5 : 0.2);
        const path = `M14 ${d.y} L${gate.x - 4} ${yEnd}`;
        const dur = 1.6 + d.end * 1.1;
        return (
          <circle key={i} r="3.2" fill={gate.color} opacity="0">
            <animateMotion dur={`${dur}s`} begin={`${d.begin}s`} repeatCount="indefinite" path={path} />
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur={`${dur}s`} begin={`${d.begin}s`} repeatCount="indefinite" />
          </circle>
        );
      })}
    </svg>
  );
}

/** Land: proposals ride lanes into trunk together; a stale one goes back. */
function LandDiagram() {
  const lanes = [42, 74, 106];
  const trunkX = 286;
  return (
    <svg viewBox="0 0 320 150" role="img" aria-label="Three lanes carry proposals into trunk in parallel; a proposal with a stale read is sent back.">
      {lanes.map((y) => (
        <path key={y} d={`M16 ${y} L214 ${y} C246 ${y} 252 74 ${trunkX - 6} 74`} fill="none" stroke="#e6eefc" strokeOpacity="0.14" strokeWidth="1.5" />
      ))}
      <line x1={trunkX} y1="22" x2={trunkX} y2="126" stroke={FIELD_COLOR.need} strokeOpacity="0.22" strokeWidth="1.5" />
      <circle cx={trunkX} cy="74" r="7" fill="none" stroke="#f38020" strokeWidth="2" />
      <circle cx={trunkX} cy="74" r="3.4" fill="#f38020">
        <animate attributeName="r" values="3.4;5.2;3.4" dur="1.6s" repeatCount="indefinite" />
      </circle>
      {lanes.map((y, i) => {
        const path = `M16 ${y} L214 ${y} C246 ${y} 252 74 ${trunkX - 6} 74`;
        return [0, 1].map((k) => (
          <rect key={`${y}-${k}`} x="-9" y="-5" width="18" height="10" rx="3" fill={FIELD_COLOR.trail} fillOpacity="0.85" opacity="0">
            <animateMotion dur="3.2s" begin={`${i * 0.25 + k * 1.6}s`} repeatCount="indefinite" path={path} rotate="auto" />
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.9;1" dur="3.2s" begin={`${i * 0.25 + k * 1.6}s`} repeatCount="indefinite" />
          </rect>
        ));
      })}
      <rect x="-9" y="-5" width="18" height="10" rx="3" fill={FIELD_COLOR.danger} fillOpacity="0.9" opacity="0">
        <animateMotion dur="3.2s" begin="0.8s" repeatCount="indefinite" path="M16 74 L170 74 L60 74" keyPoints="0;0.58;1" keyTimes="0;0.55;1" calcMode="linear" />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.85;1" dur="3.2s" begin="0.8s" repeatCount="indefinite" />
      </rect>
      <text x="16" y="140" className="pd-sub">
        lane per region · stale read returns with its delta
      </text>
    </svg>
  );
}

/** Remember: the newest commit unfolds its lineage note. */
function RememberDiagram() {
  const rows: Array<[string, string]> = [
    ["intent", "relative imports name their file"],
    ["rule", "approved by a person"],
    ["agent", "model and kind"],
    ["decisions", "reflex · collision · p 0.97"],
    ["checks", "✓ rule recheck · not verified: tests"],
  ];
  return (
    <svg viewBox="0 0 320 150" role="img" aria-label="Each commit carries a git note with its intent, rule, agent, decisions and checks.">
      <line x1="20" y1="22" x2="132" y2="22" stroke="#f38020" strokeOpacity="0.35" strokeWidth="1.5" />
      {[30, 62, 94].map((x) => (
        <circle key={x} cx={x} cy="22" r="4.5" fill="#05070b" stroke="#f38020" strokeOpacity="0.6" strokeWidth="1.5" />
      ))}
      <circle cx="126" cy="22" r="7" fill="#f38020" />
      <path d="M126 29 L126 40" stroke="#f38020" strokeOpacity="0.5" />
      <rect x="18" y="40" width="288" height="102" rx="7" fill="#0d131d" stroke="rgba(150,170,200,0.22)" />
      <text x="30" y="56" className="pd-mono pd-accent">
        refs/notes/firetrident
      </text>
      {rows.map(([k, v], i) => (
        <g key={k} opacity="0">
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes={`0;${(0.08 + i * 0.1).toFixed(2)};${(0.14 + i * 0.1).toFixed(2)};0.92;1`} dur="7s" repeatCount="indefinite" />
          <text x="30" y={74 + i * 15} className="pd-mono pd-key">
            {k}
          </text>
          <text x="96" y={74 + i * 15} className="pd-mono">
            {v}
          </text>
        </g>
      ))}
    </svg>
  );
}

interface Prong {
  n: string;
  name: string;
  head: string;
  body: string;
  how: string;
  Diagram: () => React.JSX.Element;
}

const PRONGS: readonly Prong[] = [
  {
    n: "01",
    name: "Sense",
    head: "Agents read the field, not each other.",
    body: "Every file carries decaying marks: a need where work is wanted, a claim where an agent is busy, a trail where a change just landed, failure and danger where something broke. Agents choose work where needs are high and claims are low. Reading the field costs the same for ten agents or ten thousand.",
    how: "Claims fade in 5 minutes, trails in 60. A crashed agent's claims simply evaporate.",
    Diagram: SenseDiagram,
  },
  {
    n: "02",
    name: "Decide",
    head: "Only uncertainty climbs.",
    body: "Every call (does this collide, can it land, is it safe) goes to the cheapest layer that is confident: Clef decision models in milliseconds, then an LLM, then a person. People see only what the models were unsure about, and a rejection becomes an antibody that screens later changes.",
    how: "Calibrated probabilities at each layer; a seeded-change vaccine measures review recall.",
    Diagram: DecideDiagram,
  },
  {
    n: "03",
    name: "Land",
    head: "Parallel lanes instead of a merge queue.",
    body: "Each region of the code has its own lane. Every cycle a lane takes the largest set of proposals that do not conflict and whose reads are still current, and lands them as one commit. A stale proposal goes back to its agent with the exact files that changed. Then the project's own tests run on trunk: the certified branch moves only when they pass, and a failing trunk becomes a repair.",
    how: "Read sets are checked against trunk blob ids; trunk moves by compare-and-swap; tests run in a Dynamic Worker with no network.",
    Diagram: LandDiagram,
  },
  {
    n: "04",
    name: "Remember",
    head: "Every commit carries its why.",
    body: "Each landing writes a git note with the intent, the rule and who approved it, the agent and model, every decision with its probability, the checks that ran, and what was not verified. Any git client can read it, long after the agents are gone.",
    how: "refs/notes/firetrident plus FT-* commit trailers, in Artifacts repos.",
    Diagram: RememberDiagram,
  },
];

/** The four prongs, each with a small live diagram. */
export function Prongs() {
  return (
    <div className="pr-grid">
      {PRONGS.map((p) => (
        <article className="pr" key={p.name}>
          <div className="pr-diagram">
            <p.Diagram />
          </div>
          <div className="pr-k">
            <span className="mono">{p.n}</span>
            {p.name}
          </div>
          <h3 className="pr-head">{p.head}</h3>
          <p className="pr-body">{p.body}</p>
          <p className="pr-how">{p.how}</p>
        </article>
      ))}
    </div>
  );
}
