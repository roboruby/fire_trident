import { Code } from "./RunIt.tsx";
import { QUESTIONS, SITE, type Answer } from "./questions.ts";

/** A link of an answer: pages of this site stay on the deployment serving the landing page; the rest open in a new tab. */
function AnswerLink({ link }: { link: Answer["link"] }) {
  const local = link.href.startsWith(`${SITE}/`) ? link.href.slice(SITE.length) : null;
  return (
    <a className="qa-link" href={local ?? link.href} {...(local ? {} : { target: "_blank", rel: "noreferrer" })}>
      {link.label} →
    </a>
  );
}

/** The landing page's answers to the questions a git platform for agents must answer (questions.ts), after the results. */
export function Questions() {
  return (
    <section className="l-section" id="questions">
      <div className="l-section-head">
        <div className="l-kicker">Answers</div>
        <h2 className="l-h2">Four questions a git platform for agents must answer.</h2>
        <p className="l-section-lede">
          Each answer comes with one measured number and a way to check it, and so does one more question: can your agent join? Agents can read the same answers at <a href="/start.md">/start.md</a> and{" "}
          <a href="/llms.txt">/llms.txt</a>.
        </p>
      </div>
      <div className="qa">
        {QUESTIONS.map((q) => (
          <article className="qa-row" id={`q-${q.id}`} key={q.id}>
            <div className="qa-k">
              <h3 className="qa-q">{q.question}</h3>
              <div className="qa-fig">{q.figure}</div>
            </div>
            <div className="qa-a">
              <p>{q.answer}</p>
              {q.command ? <Code label="shell" text={q.command} /> : null}
              <AnswerLink link={q.link} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
