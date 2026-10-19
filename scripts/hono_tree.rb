# frozen_string_literal: true

# What the Hono replay's selection (scripts/hono_replay_select.rb) and its harness (scripts/hono_replay.rb) share, on a
# local clone of honojs/hono kept outside this repository: files and trees at a commit; a pull request's squash commit
# laid on another commit the way `git cherry-pick` lays it (stock `git merge-tree` with the commit's parent as the merge
# base); a scratch worktree checked out at a commit, with an installed node_modules linked beside it; real vitest runs
# there with their JSON report read back; and the vitest APIs, matchers and imports a test file uses. Hono's code only
# ever runs through its own vitest, inside that scratch worktree.
require "fileutils"
require "json"
require "open3"
require "set"
require "tmpdir"
require_relative "stage"

module HonoTree
  # Something in the clone or a run is not as it must be; the message says what.
  class Error < StandardError; end

  # Git without the user's or the system's configuration, never prompting, with a fixed identity and fixed dates: the
  # commits made here (a base with pull requests laid on it, in the clone's own object store only) get the same ids on
  # every machine.
  GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM" => "1", "GIT_CONFIG_GLOBAL" => File::NULL, "GIT_TERMINAL_PROMPT" => "0",
    "GIT_AUTHOR_NAME" => "hono replay", "GIT_AUTHOR_EMAIL" => "replay@hono-replay.invalid", "GIT_AUTHOR_DATE" => "2026-01-01T00:00:00Z",
    "GIT_COMMITTER_NAME" => "hono replay", "GIT_COMMITTER_EMAIL" => "replay@hono-replay.invalid", "GIT_COMMITTER_DATE" => "2026-01-01T00:00:00Z"
  }.freeze
  # A test file vitest's main project runs (Hono's vitest.config.ts: src/**/*.test.ts, never *.case.test.*), and a
  # shared case file that router tests import.
  TEST_FILE = %r{\Asrc/.+\.test\.ts\z}
  CASE_FILE = %r{\Asrc/.+\.case\.test\.ts\z}

  # A test runnable on Node by vitest's main project: a .test.ts file under src/ that is not a shared case file.
  def self.runnable?(path) = TEST_FILE.match?(path) && !CASE_FILE.match?(path)

  # One local clone of honojs/hono.
  class Repo
    attr_reader :dir

    def initialize(dir)
      @dir = File.expand_path(dir)
      raise Error, "#{@dir} is not a git clone" unless File.directory?(File.join(@dir, ".git")) || File.file?(File.join(@dir, ".git"))
    end

    # Run git in the clone; its stdout, or an Error with its last line of stderr. `ok` lists exit codes that are not failures.
    def git(*args, ok: [0], input: nil, timeout: 300)
      out = +""
      err = +""
      status = nil
      Open3.popen3(GIT_ENV, "git", "-C", @dir, *args) do |stdin, stdout, stderr, wait|
        stdin.binmode
        stdin.write(input) if input
        stdin.close
        readers = [Thread.new { out << stdout.read.to_s }, Thread.new { err << stderr.read.to_s }]
        if wait.join(timeout).nil?
          Process.kill("KILL", wait.pid)
          raise Error, "git #{args.first} did not finish within #{timeout} s"
        end
        readers.each(&:join)
        status = wait.value
      end
      raise Error, "git #{args.first(3).join(' ')} failed: #{err.strip.lines.last.to_s.strip[0, 300]}" unless ok.include?(status.exitstatus)

      @last_status = status.exitstatus
      out
    end

    def last_status = @last_status

    # The full id of a commit, or nil when the clone has none by that name.
    def commit(rev)
      out = git("rev-parse", "--verify", "--quiet", "#{rev}^{commit}", ok: [0, 1]).strip
      out.empty? ? nil : out
    end

    def parent(sha) = git("rev-parse", "#{sha}^").strip

    # [status, path] for each file a commit changed against its first parent, renames as a deletion and an addition.
    def changed(sha)
      git("diff-tree", "--no-commit-id", "-r", "--no-renames", "--name-status", "#{sha}^", sha).lines.map { |l| l.chomp.split("\t", 2) }
    end

    # Every file of a commit: path => { mode:, blob:, size: }.
    def tree(rev)
      git("ls-tree", "-r", "-l", "-z", rev).split("\0").to_h do |entry|
        meta, path = entry.split("\t", 2)
        mode, _type, blob, size = meta.split(/\s+/)
        [path, { mode: mode, blob: blob, size: size.to_i }]
      end
    end

    # A file's bytes at a commit (or tree), or nil when it has none at that path.
    def show(rev, path)
      id = git("rev-parse", "--verify", "--quiet", "#{rev}:#{path}", ok: [0, 1, 128]).strip
      id.empty? || last_status != 0 ? nil : blob(id)
    end

    # A blob's bytes, or nil when the clone does not hold it.
    def blob(id)
      return nil unless git("cat-file", "-e", id, ok: [0, 1, 128]) && last_status.zero?

      git("cat-file", "blob", id).b
    end

    # The tree of `onto` with commit `sha` laid on it as `git cherry-pick` lays it: a three-way merge of the commit
    # against its parent. Returns [tree id, conflicted paths]; the paths are empty when it lays cleanly.
    def lay(onto, sha)
      out = git("merge-tree", "--write-tree", "--name-only", "--no-messages", "--merge-base=#{sha}^", onto, sha, ok: [0, 1])
      clean = last_status.zero?
      lines = out.lines.map(&:chomp)
      [lines.first, clean ? [] : lines[1..].reject(&:empty?).uniq]
    end

    # A commit of `tree` on `parent` (fixed identity and dates, so its id is the same on every machine).
    def commit_tree(tree, parent, message) = git("commit-tree", tree, "-p", parent, "-m", message).strip

    # `base` with `commits` laid on it in order, each as a commit of its own ("replay <label>": the label is part of
    # the commit's id, so whoever lays the same chain again passes the same labels). Returns { head:, laid: [sha],
    # steps: [{ sha:, before:, after: }], conflicts: { sha => [paths] } }: a commit that does not lay cleanly is left
    # out and the rest go on. `before` is the commit it was laid on and `after` the commit it made.
    def replay(base, commits, label: ->(sha) { sha[0, 8] })
      head = base
      laid = []
      steps = []
      conflicts = {}
      commits.each do |sha|
        tree, bad = lay(head, sha)
        if bad.empty?
          after = commit_tree(tree, head, "replay #{label.call(sha)}")
          steps << { sha: sha, before: head, after: after }
          head = after
          laid << sha
        else
          conflicts[sha] = bad
        end
      end
      { head: head, laid: laid, steps: steps, conflicts: conflicts }
    end
  end

  # A scratch worktree of the clone with an installed node_modules linked in, checked out at one commit at a time.
  class Worktree
    attr_reader :dir

    # `node_modules`: an installed node_modules directory (from `npm install` in a Hono checkout near the base); without
    # one the worktree only holds files (vitest cannot run in it).
    def initialize(repo, dir, node_modules: nil)
      @repo = repo
      @dir = File.expand_path(dir)
      @modules = node_modules && File.expand_path(node_modules)
      raise Error, "#{@modules} has no vitest: install Hono's dependencies there first (npm install --ignore-scripts)" if @modules && !File.file?(File.join(@modules, "vitest", "vitest.mjs"))
    end

    # Check out `commit` (detached), drop every untracked file but the linked node_modules, and link it.
    def checkout(commit)
      if File.exist?(File.join(@dir, ".git"))
        git("checkout", "-q", "-f", "--detach", commit)
        git("clean", "-fdq", "-e", "node_modules")
      else
        FileUtils.mkdir_p(File.dirname(@dir))
        @repo.git("worktree", "add", "-q", "-f", "--detach", @dir, commit)
      end
      link = File.join(@dir, "node_modules")
      File.symlink(@modules, link) if @modules && !File.exist?(link) && !File.symlink?(link)
      self
    end

    # Write files (path => bytes; nil deletes it) into the checkout.
    def write(files)
      files.each do |path, text|
        full = File.join(@dir, path)
        raise Error, "refusing to write outside the worktree: #{path}" unless File.expand_path(full).start_with?("#{@dir}/")

        if text.nil?
          FileUtils.rm_f(full)
        else
          FileUtils.mkdir_p(File.dirname(full))
          File.binwrite(full, text)
        end
      end
      self
    end

    # Real vitest on `files` (paths in the checkout), its main project, no coverage. Returns Vitest.parse's result.
    # An empty list runs every test file, so it must be asked for (`all: true`).
    def vitest(files, timeout: 600, all: false)
      raise Error, "no node_modules with vitest is linked into #{@dir}" unless @modules
      raise Error, "no test files to run" if files.empty? && !all
      raise Error, "test files must be paths in the checkout: #{files.find { |f| f.start_with?("-") }}" if files.any? { |f| f.start_with?("-") }

      Vitest.run(@dir, files, timeout: timeout)
    end

    private

    def git(*args)
      ok, _out, err, = Stage.run(["git", "-C", @dir, *args], env: GIT_ENV, timeout: 300)
      raise Error, "git #{args.first} in #{@dir} failed: #{err.strip.lines.last.to_s.strip[0, 300]}" unless ok
    end
  end

  # Real vitest in a Hono checkout, and its JSON report.
  module Vitest
    module_function

    # Run vitest's main project on `files` in `dir` with the JSON reporter. Returns parse's result plus :exit and
    # :seconds; a run that wrote no report (vitest itself failed) comes back with :error.
    def run(dir, files, timeout: 600, project: "main")
      Dir.mktmpdir("hono-vitest-") do |tmp|
        out = File.join(tmp, "report.json")
        cmd = [Stage::NODE, File.join("node_modules", "vitest", "vitest.mjs"), "run", "--project", project, "--coverage.enabled=false",
               "--reporter=json", "--outputFile=#{out}", *files]
        t = Stage.now
        ok, stdout, stderr, timed_out = Stage.run(cmd, chdir: dir, timeout: timeout)
        secs = (Stage.now - t).round(1)
        if timed_out
          return { error: "vitest did not finish within #{timeout} s", exit: nil, seconds: secs, files: {}, counts: {}, success: false }
        end
        unless File.file?(out)
          last = (stderr.to_s + stdout.to_s).strip.lines.reject { |l| l.strip.empty? }.last(3).join(" ").strip
          return { error: "vitest wrote no report: #{last[0, 400]}", exit: ok ? 0 : 1, seconds: secs, files: {}, counts: {}, success: false }
        end
        parse(File.read(out), dir).merge(exit: ok ? 0 : 1, seconds: secs)
      end
    end

    # Vitest's JSON report (--reporter=json): per test file (relative to `root`) its status, a load error's message, and
    # each test with its name ("describe > it"), status and first failure line; counts over all of them. A file that
    # failed to load (no tests, status failed) counts as one failed test, so a run passes only when every file loaded
    # and every test passed.
    def parse(json, root)
      data = json.is_a?(String) ? JSON.parse(json) : json
      prefix = "#{File.expand_path(root)}/"
      files = Array(data["testResults"]).to_h do |f|
        name = f["name"].to_s
        rel = name.start_with?(prefix) ? name.delete_prefix(prefix) : name.sub(%r{\A.*?/(src/)}, '\1')
        tests = Array(f["assertionResults"]).map do |a|
          { name: [*Array(a["ancestorTitles"]), a["title"]].compact.join(" > "), status: a["status"],
            failure: Array(a["failureMessages"]).first.to_s.lines.first.to_s.strip[0, 300] }
        end
        message = f["message"].to_s.strip
        [rel, { status: f["status"], message: message.empty? ? nil : message.lines.first.strip[0, 300], tests: tests }]
      end
      tests = files.values.flat_map { |f| f[:tests] }
      load_failures = files.count { |_, f| f[:status] == "failed" && f[:tests].none? { |t| t[:status] == "failed" } }
      counts = {
        files: files.size, tests: tests.size, passed: tests.count { |t| t[:status] == "passed" },
        failed: tests.count { |t| t[:status] == "failed" } + load_failures, skipped: tests.count { |t| %w[skipped pending todo].include?(t[:status]) },
        load_failures: load_failures
      }
      { files: files, counts: counts, success: counts[:failed].zero? && counts[:files].positive? }
    end

    # The names of the failing tests of a parsed run, "file: describe > it" (a file that did not load: "file: did not load").
    def failing(result)
      result[:files].flat_map do |path, f|
        names = f[:tests].select { |t| t[:status] == "failed" }.map { |t| "#{path}: #{t[:name]}" }
        names.empty? && f[:status] == "failed" ? ["#{path}: did not load#{f[:message] ? " (#{f[:message][0, 120]})" : ''}"] : names
      end
    end
  end

  # The vitest surface a test file uses: matchers, modifiers, async assertions, asymmetric matchers, vi helpers, hooks,
  # parameterized forms, type-level tests, snapshots, and what it imports. A plain text scan (no TypeScript parse), so
  # it lists what appears in the file; it is for matching a test runner's coverage against these files, not a proof.
  module Api
    module_function

    MATCHER = /\.(to[A-Z][A-Za-z]*)\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\(/
    # Methods of JavaScript's own objects that look like matchers (`.toString()`), never counted as one.
    NOT_MATCHERS = %w[toString toISOString toUTCString toDateString toTimeString toLocaleString toLocaleDateString toLocaleTimeString
                      toLocaleUpperCase toLocaleLowerCase toUpperCase toLowerCase toFixed toPrecision toExponential toJSON toSorted
                      toReversed toSpliced toWellFormed toArray toBase64 toHex toTemporalInstant toZonedDateTime toPlainDate].freeze
    ASYMMETRIC = /\bexpect\s*\.\s*(not\s*\.\s*)?(any|anything|objectContaining|arrayContaining|stringContaining|stringMatching|closeTo|assertions|hasAssertions|extend|soft|poll|unreachable|addSnapshotSerializer|addEqualityTesters|getState|setState)\b/
    VI = /\bvi\s*\.\s*(\w+)/
    HOOK = /\b(beforeAll|afterAll|beforeEach|afterEach|onTestFinished|onTestFailed)\s*\(/
    MODIFIER = /\b(describe|it|test|suite|bench)\s*\.\s*(each|for|skip|only|todo|concurrent|sequential|skipIf|runIf|fails|extend)\b/
    EACH_TEMPLATE = /\b(?:describe|it|test)\s*\.\s*each\s*`/
    TYPE_TESTS = /\b(expectTypeOf|assertType)\b/
    SNAPSHOT = /\b(toMatchSnapshot|toMatchInlineSnapshot|toThrowErrorMatchingSnapshot|toThrowErrorMatchingInlineSnapshot|toMatchFileSnapshot)\b/
    IMPORT = /(?:^|[\s;])(?:import\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?|export\s+[\w*{}\s,$]+?\s+from\s+)['"]([^'"]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/
    VITEST_NAMES = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]vitest['"]/m
    GLOBALS = /(?:^|[^.\w$])(describe|it|test|expect|vi|beforeAll|afterAll|beforeEach|afterEach)\s*[.(]/
    ENVIRONMENT = /@vitest-environment\s+([\w-]+)/
    # What a test file needs that Node with vitest does not give it.
    NOT_NODE = [
      [/\bBun\s*\.|from\s+['"]bun(?::\w+)?['"]|['"]bun:test['"]/, "Bun"],
      [/\bDeno\s*\./, "Deno"],
      [/['"]cloudflare:[\w-]+['"]|['"]@cloudflare\/vitest-pool-workers|\bworkerd\b/, "workerd"],
      [/['"]fastly:[\w-]+['"]/, "Fastly Compute"]
    ].freeze

    # Counts of each thing a test file's text uses, and its imports.
    def scan(text)
      body = text.to_s.dup.force_encoding(Encoding::UTF_8).scrub
      code = body.gsub(%r{/\*.*?\*/}m, "").gsub(%r{(?<!:)//[^\n]*}, "")
      imports = code.scan(IMPORT).map { |a, b| a || b }.compact
      vitest_names = code.scan(VITEST_NAMES).flatten.flat_map { |l| l.split(",").map { |n| n.strip.sub(/\Atype\s+/, "").split(/\s+as\s+/).first }.reject { |n| n.nil? || n.empty? } }.uniq.sort
      used_globals = code.scan(GLOBALS).flatten.uniq
      {
        matchers: code.scan(MATCHER).flatten.reject { |m| SNAPSHOT.match?(m) || NOT_MATCHERS.include?(m) }.tally.sort.to_h,
        negated: code.scan(/\.not\s*\.\s*to[A-Z]/).size,
        resolves: code.scan(/\.resolves\s*\./).size,
        rejects: code.scan(/\.rejects\s*\./).size,
        asymmetric: code.scan(ASYMMETRIC).map { |n, m| n ? "not.#{m}" : m }.tally.sort.to_h,
        vi: code.scan(VI).flatten.tally.sort.to_h,
        hooks: code.scan(HOOK).flatten.tally.sort.to_h,
        modifiers: code.scan(MODIFIER).map { |a, b| "#{a}.#{b}" }.tally.sort.to_h,
        each_template: code.scan(EACH_TEMPLATE).size,
        type_tests: code.scan(TYPE_TESTS).flatten.tally.sort.to_h,
        snapshots: code.scan(SNAPSHOT).flatten.tally.sort.to_h,
        vitest_imports: vitest_names,
        globals: (used_globals - vitest_names).sort,
        environment: body[ENVIRONMENT, 1],
        packages: imports.reject { |i| i.start_with?(".", "/") || i.start_with?("node:") || i == "vitest" }.map { |i| i.start_with?("@") ? i.split("/").first(2).join("/") : i.split("/").first }.uniq.sort,
        node_builtins: imports.select { |i| i.start_with?("node:") }.uniq.sort,
        relative_imports: imports.count { |i| i.start_with?(".") },
        not_node: not_node(body)
      }
    end

    # Why a test file cannot run on Node with vitest (Bun, Deno, workerd or Fastly APIs), or empty.
    def not_node(text) = NOT_NODE.filter_map { |re, why| why if re.match?(text.to_s) }

    # Several scans summed: counts added, lists joined.
    def merge(scans)
      out = {}
      scans.each do |s|
        s.each do |k, v|
          case v
          when Hash then out[k] = (out[k] || {}).merge(v) { |_, a, b| a + b }.sort.to_h
          when Array then out[k] = ((out[k] || []) | v).sort
          when Integer then out[k] = out[k].to_i + v
          else (out[:environments] ||= []) << v if k == :environment && v && !Array(out[:environments]).include?(v)
          end
        end
      end
      out
    end
  end
end
