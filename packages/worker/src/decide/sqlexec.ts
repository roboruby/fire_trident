/**
 * SQL statements are not programs. The danger checks' process pattern (decide/danger.ts, capability:process) reads
 * `exec("...")` as running a program, and a SQL statement run on a Durable Object's storage or a database binding
 * (`this.sql.exec("UPDATE ...")`, `env.DB.exec("CREATE TABLE ...")`) has the same shape: on FireTrident's own history it
 * was most of what the checks sent to a person. This module finds those calls so the pattern can leave them out:
 * - a call of `.exec(` (or `?.exec(`) on a receiver named sql, sqlite, db or database, in any case and as the last name
 *   of a chain (`sql`, `this.sql`, `ctx.storage.sql`, `env.DB`), or chained on such a receiver from the line before
 *   (`const rows = this.sql` then `.exec("SELECT ...")`);
 * - whose first argument is a string literal that starts with the first word of a SQL statement (SELECT, INSERT,
 *   UPDATE, DELETE, CREATE, PRAGMA and the like, in any case) not followed by a letter, digit or hyphen, or a template
 *   literal that opens at the end of the line when the next line starts with that word.
 * Everything else keeps firing: a bare `exec("...")` (child_process's, destructured), any other receiver (a sandbox's or
 * a shell library's exec), a literal that starts with anything else, and, in danger.ts, every exec in a file that
 * imports a process module. Only the call's own words are removed, so another call on the same line still counts. Pure.
 */

/** Names a SQL handle goes by: a Durable Object's storage.sql, a D1 or SQLite database. A longer name (mysql, dbx) is not one. */
const HANDLE = String.raw`(?:sql|sqlite|db|database)`;

/** The first word of a SQL statement, as SQLite and D1 run them; a hyphen after it makes a program name (update-ca-certificates). */
const STATEMENT = String.raw`(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|WITH|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ANALYZE|REINDEX|EXPLAIN|VALUES)(?![\w-])`;

/** The call's opening: `exec(`, a quote, then the statement's first word. */
const CALL = String.raw`exec\s*\(\s*['"\`]\s*${STATEMENT}`;

/** The call's opening when its template literal goes on past the line: `exec(` and a backquote, nothing after. */
const OPENS = String.raw`exec\s*\(\s*\`\s*$`;

/** `<handle>.exec("SELECT` anywhere on a line, the handle a whole name. */
const ON_HANDLE = new RegExp(String.raw`(?<![\w$])${HANDLE}\s*\??\.\s*${CALL}`, "gi");

/** `.exec("SELECT` opening a line: a call chained on what the line before ends with. */
const CHAINED = new RegExp(String.raw`^\s*\??\.\s*${CALL}`, "i");

/** `<handle>.exec(\`` ending a line, and the same chained from the line before: the statement is on the next line. */
const ON_HANDLE_OPEN = new RegExp(String.raw`(?<![\w$])${HANDLE}\s*\??\.\s*${OPENS}`, "i");
const CHAINED_OPEN = new RegExp(String.raw`^\s*\??\.\s*${OPENS}`, "i");

/** A line that ends with a SQL handle (`const won = this.sql`): the receiver of a call chained on the next line. */
const ENDS_WITH_HANDLE = new RegExp(String.raw`(?<![\w$])${HANDLE}\s*$`, "i");

/** A line that starts with a statement's first word: the text of a template literal opened on the line before. */
const STARTS_STATEMENT = new RegExp(String.raw`^\s*${STATEMENT}`, "i");

/**
 * The line with each SQL statement call on a SQL handle cut out (its handle, `.exec(`, quote and first word), so a
 * pattern tested on what is left no longer sees it. `prev` and `next` are the nearest lines before and after it that
 * are not blank: a line that opens with `.exec(` is cut only when `prev` ends with a SQL handle, and a template literal
 * that opens at the end of the line only when `next` starts with a statement's first word.
 */
export function withoutSqlStatements(line: string, prev = "", next = ""): string {
  ON_HANDLE.lastIndex = 0;
  const chained = ENDS_WITH_HANDLE.test(prev);
  let cut = line.replace(ON_HANDLE, " ");
  if (chained) cut = cut.replace(CHAINED, " ");
  if (STARTS_STATEMENT.test(next)) {
    cut = cut.replace(ON_HANDLE_OPEN, " ");
    if (chained) cut = cut.replace(CHAINED_OPEN, " ");
  }
  return cut;
}
