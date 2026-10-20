import { Code } from "./RunIt.tsx";
import { QUESTIONS, SITE, type Answer } from "./questions.ts";

/** A link of an answer: pages of this site stay on the deployment serving the landing page; the rest open in a new tab. */
function AnswerLink({ link }: { link: Answer["link"] }) {
  const local = link.href.startsWith(`${SITE}/`) ? link.href.slice(SITE.length) : link.href.startsWith("/") ? link.href : null;
  return (
    <a className="qa-link" href={local ?? link.href} {...(local ? {} : { target: "_blank", rel: "noreferrer" })}>
      {link.label} →
    </a>
  );
}

/**
 * The landing page's answers to the questions a git platform for agents must answer (questions.ts): each question, the
 * answer in one line, the sentence that explains it, the measured number in context, and the pages or scenes that let a
 * visitor check it (the judging axes' checks among them).
 */
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
              <p className="qa-short">{q.short}</p>
            </div>
            <div className="qa-a">
              <p>{q.answer}</p>
              {q.command ? <Code label="shell" text={q.command} /> : null}
              <div className="qa-evidence">
                <span className="qa-ev-k">{q.evidence}</span>
                <div className="qa-fig">{q.figure}</div>
              </div>
              <div className="qa-links">
                <AnswerLink link={q.link} />
                {(q.more ?? []).map((m) => (
                  <AnswerLink link={m} key={m.href} />
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
