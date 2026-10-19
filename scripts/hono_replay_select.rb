#!/usr/bin/env ruby
# frozen_string_literal: true

# The Hono replay's workload: a base commit B of honojs/hono and the pull requests merged into main after it that a
# colony is asked to redo (scripts/hono_replay.rb runs them; demo/hono-replay/workload.json is this script's output).
#
#   1. Read main's first-parent history from B to --until in a local clone (Hono squash-merges, so each commit is one
#      pull request, its number at the end of the subject). Keep a pull request that changes source under src/ (not
#      only tests or docs) and adds or changes a test file (src/**/*.test.ts) whose tests run on Node: none touches
#      JSX (.tsx or src/jsx/) or a Bun, Deno or Cloudflare Workers adapter, and no test file uses Bun, Deno, workerd or
#      Fastly APIs. No file it changes under src/ may be longer, right before it or right after it, than an in-platform
#      agent can write back in one reply (the worker's MAX_REWRITE_CHARS, read from packages/worker/src/agents/prompt.ts,
#      86,016 characters as JavaScript counts them): no agent could write such a file, so its intent could never land.
#   2. Overlap: two pull requests overlap when they change the same source file (not a test file). Only pull requests
#      that overlap another are candidates.
#   3. Validity, with real vitest in a scratch worktree of the clone (Hono's main vitest project, B's node_modules):
#      each candidate's own test files pass at its own merge commit.
#   4. Selection: whole groups of overlapping pull requests, hub files first (src/hono-base.ts, src/context.ts,
#      src/request.ts, src/router/**, src/helper/**, src/utils/**), up to --max; every pull request selected overlaps
#      another selected.
#   5. Together: the selected pull requests laid on B in merge order as `git cherry-pick` lays them (stock `git
#      merge-tree`, each against its own parent; the end of the chain is the target). A pull request's hidden tests
#      are its test files as the chain leaves them right after it: B's tests, the earlier selected pull requests'
#      tests in the same files, and its own. They must FAIL at B and right before it, PASS right after it and on the
#      final target; its target tests are the ones that fail right before it and pass right after it (its own, never
#      an earlier one's). A pull request that does not lay on the chain, or whose checks do not hold, is dropped and
#      the chain is laid again, until it holds. A shared case file (src/router/common.case.test.ts) runs through the
#      router tests that import it.
#   6. Intents: one per pull request, titled from its title and with its why from its description (read with `gh api`,
#      GET only, cached), treated as untrusted text: HTML, images, links, mentions, the template's checklist and any line
#      that speaks to an agent are removed and the length capped. Footprint: the files it changed under src/. No
#      acceptance lines: they would come from the hidden tests.
#
# Every vitest API, matcher, hook and package import the hidden tests and their visible versions at B use is listed,
# so a test runner's coverage can be matched against them. No GitHub username is written. The output names no path on
# this machine.
#
# Usage:
#   ruby scripts/hono_replay_select.rb --clone <hono clone> --modules <node_modules> --base <B> [--until <commit>]
#     [--min 12] [--max 16] [--cache DIR] [--out demo/hono-replay/workload.json] [--no-github] [--quiet]
#
# --modules is a node_modules installed in a Hono checkout at or near B (npm install --ignore-scripts); it is linked
# into the scratch worktree (--worktree, default <clone>/../hono-replay-verify). Exit codes: 0 written, 1 fewer than
# --min pull requests held, 2 a setting is missing.
require "digest"
require "json"
require "optparse"
require "set"
require "time"
require_relative "stage"
require_relative "hono_tree"

module HonoReplaySelect
  ROOT = File.expand_path("..", __dir__)
  OUT = File.join(ROOT, "demo", "hono-replay", "workload.json")
  SCHEMA = "firetrident.hono-replay/v1"
  REPOSITORY = "honojs/hono"
  # Source files most of Hono imports: a change to one is felt widely, so pull requests on them are preferred.
  HUB = [%r{\Asrc/hono-base\.ts\z}, %r{\Asrc/context\.ts\z}, %r{\Asrc/request\.ts\z}, %r{\Asrc/router/}, %r{\Asrc/helper/}, %r{\Asrc/utils/}].freeze
  # Adapters whose code needs another runtime.
  OTHER_RUNTIME = %r{\Asrc/adapter/(bun|deno|cloudflare-workers|cloudflare-pages)/}
  # What the seed leaves out of B's tree, and why (scripts/hono_replay.rb lands the rest).
  SEED_EXCLUDE = [
    ["runtime-tests/", "tests for Bun, Deno, workerd and other runtimes, with their own configurations"],
    ["benchmarks/", "benchmark projects with their own dependencies"],
    ["perf-measures/", "bundle-size and type-check measurement projects"],
    ["docs/images/", "binary images"]
  ].freeze
  # Where the worker sets an in-platform agent's whole-file output cap, and the cap when that file cannot be read as
  # expected: (MAX_REWRITE_TOKENS 32,768 - REWRITE_HEADROOM_TOKENS 4,096) * CHARS_PER_OUTPUT_TOKEN 3.
  PROMPT_TS = File.join(ROOT, "packages", "worker", "src", "agents", "prompt.ts")
  REWRITE_CAP_FALLBACK = 86_016
  # A why longer than this is cut at a line.
  WHY_CHARS = 1_200
  # Lines of a description that speak to an agent (or a model) rather than describe the change.
  TO_AGENT = /\b(?:ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)|disregard|you\s+are\s+(?:an?|the)\b|as\s+an\s+ai|ai\s+agents?|language\s+models?|system\s+prompt|prompt\s+injection|assistant|claude|chatgpt|gpt-\d|copilot|cursor|codex|gemini|llms?|instructions?\s+(?:to|for)\s+(?:the\s+)?(?:agents?|models?|ai)|note\s+to\s+(?:the\s+)?(?:agents?|models?|ai|bots?))\b|\bagents?\s*[:,]/i
  # The pull request template's checklist and its heading.
  TEMPLATE = /\A\s*(#+\s*the author should do the following|[-*]\s*\[[ xX]\]\s)/i

  module_function

  # --- pure parts ---------------------------------------------------------------------------------------------------

  # The pull request number of a squash commit's subject: the last "(#N)" at its end, or nil.
  def pr_number(subject)
    m = subject.to_s.match(/\(#(\d+)\)\s*\z/)
    m && m[1].to_i
  end

  def hub?(path) = HUB.any? { |re| re.match?(path) }

  def test_file?(path) = path.match?(/\.test\.tsx?\z/)

  # One commit of main as a candidate, or the reason it is not one. `commit`: { sha:, date:, subject:, changed:
  # [[status, path]] }; `texts`: test path => its text after the commit (for the runtime check); `sizes`: path => the
  # characters of a file it changes under src/ (the longer of right before and right after it), checked against `cap`.
  def classify(commit, texts = {}, sizes: {}, cap: nil)
    pr = pr_number(commit[:subject])
    return { sha: commit[:sha], skip: "no pull request number in the subject" } unless pr

    paths = commit[:changed].map(&:last)
    src = paths.select { |p| p.start_with?("src/") && !test_file?(p) }
    tests = commit[:changed].reject { |st, _| st == "D" }.map(&:last).select { |p| HonoTree::TEST_FILE.match?(p) }
    base = { number: pr, sha: commit[:sha], date: commit[:date], subject: commit[:subject] }
    reason = if src.empty? then "changes no source under src/ (tests, docs or tooling only)"
             elsif tests.empty? then "adds or changes no test file under src/"
             elsif paths.any? { |p| p.start_with?("src/") && (p.end_with?(".tsx") || p.start_with?("src/jsx/")) } then "touches JSX (.tsx or src/jsx/)"
             elsif (o = src.find { |p| OTHER_RUNTIME.match?(p) }) then "changes an adapter for another runtime (#{o})"
             elsif (t = tests.find { |p| !HonoTree::Api.not_node(texts[p]).empty? }) then "#{t} uses #{HonoTree::Api.not_node(texts[t]).join(', ')} APIs"
             elsif (big = too_large(sizes, cap)) then too_large_reason(*big, cap)
             end
    return base.merge(skip: reason) if reason

    base.merge(src: src.sort, tests: tests.sort, footprint: paths.select { |p| p.start_with?("src/") }.sort, hub: src.count { |p| hub?(p) })
  end

  # The first file (by path) longer than `cap` characters, as [path, characters], or nil (also when there is no cap).
  def too_large(sizes, cap)
    return nil unless cap

    sizes.to_h.compact.select { |_, n| n > cap }.min_by { |p, _| p }
  end

  # Why a pull request is skipped when one of its files is longer than the cap.
  def too_large_reason(path, n, cap)
    "#{path} is #{group(n)} characters, more than the #{group(cap)} an in-platform agent can write back in one reply, so no agent can write it"
  end

  # A count with thousands separators.
  def group(n) = n.to_i.to_s.reverse.scan(/\d{1,3}/).join(",").reverse

  # The length of a file's bytes as JavaScript counts a string (UTF-16 code units), the unit of the worker's cap; bytes
  # that are not UTF-8 count one each.
  def chars(bytes)
    text = bytes.to_s.dup.force_encoding(Encoding::UTF_8)
    text.valid_encoding? ? text.encode(Encoding::UTF_16LE).bytesize / 2 : bytes.to_s.bytesize
  end

  # The agents' whole-file output cap from the text of the worker's agents/prompt.ts: { chars:, source: }. The cap is
  # MAX_REWRITE_CHARS = (MAX_REWRITE_TOKENS - REWRITE_HEADROOM_TOKENS) * CHARS_PER_OUTPUT_TOKEN; when the text does not
  # define it that way with numeric constants, the cap is REWRITE_CAP_FALLBACK and `source` says why.
  def rewrite_cap(text)
    num = ->(name) { text.to_s[/^export const #{name} = ([\d_]+);$/, 1]&.delete("_")&.to_i }
    tokens, headroom, per = num.call("MAX_REWRITE_TOKENS"), num.call("REWRITE_HEADROOM_TOKENS"), num.call("CHARS_PER_OUTPUT_TOKEN")
    formula = text.to_s.match?(/^export const MAX_REWRITE_CHARS = \(MAX_REWRITE_TOKENS - REWRITE_HEADROOM_TOKENS\) \* CHARS_PER_OUTPUT_TOKEN;$/)
    if tokens && headroom && per && formula && tokens > headroom && per.positive?
      { chars: (tokens - headroom) * per, source: "packages/worker/src/agents/prompt.ts MAX_REWRITE_CHARS" }
    else
      { chars: REWRITE_CAP_FALLBACK, source: "#{group(REWRITE_CAP_FALLBACK)} characters, the value when this was written: packages/worker/src/agents/prompt.ts no longer defines MAX_REWRITE_CHARS as this script reads it" }
    end
  end

  # The cap as the worker in this checkout sets it (rewrite_cap), or the fallback when its file is missing.
  def output_cap(path = PROMPT_TS)
    rewrite_cap(File.file?(path) ? File.read(path, encoding: "UTF-8") : "")
  end

  # Source files shared between pull requests: { edges: [[a, b, [files]]], by_file: { file => [numbers] } }, over
  # source files only (test files are listed apart, as :tests_by_file).
  def overlap(cands)
    by_file = Hash.new { |h, k| h[k] = [] }
    tests_by_file = Hash.new { |h, k| h[k] = [] }
    cands.each do |c|
      c[:src].each { |f| by_file[f] << c[:number] }
      c[:tests].each { |f| tests_by_file[f] << c[:number] }
    end
    edges = []
    cands.combination(2) do |a, b|
      shared = a[:src] & b[:src]
      edges << [a[:number], b[:number], shared] unless shared.empty?
    end
    { edges: edges, by_file: by_file.select { |_, v| v.size > 1 }.sort.to_h, tests_by_file: tests_by_file.select { |_, v| v.size > 1 }.sort.to_h }
  end

  # Groups of pull requests connected by shared source files (each with at least two), in merge order inside.
  def groups(cands)
    order = cands.each_with_index.to_h { |c, i| [c[:number], i] }
    adj = Hash.new { |h, k| h[k] = Set.new }
    overlap(cands)[:edges].each do |a, b, _|
      adj[a] << b
      adj[b] << a
    end
    seen = Set.new
    out = []
    cands.each do |c|
      n = c[:number]
      next if seen.include?(n) || adj[n].empty?

      group = []
      stack = [n]
      until stack.empty?
        x = stack.pop
        next if seen.include?(x)

        seen << x
        group << x
        stack.concat(adj[x].to_a)
      end
      out << group.sort_by { |x| order[x] }
    end
    out
  end

  # The selection: whole groups, hub files first (the group's share of hub source files, then its size, then the
  # earliest merge), up to `max`; a group too large for the room left gives its most shared file's pull requests.
  # Every pull request chosen shares a source file with another chosen. Returns numbers in merge order.
  def select(cands, max:)
    by = cands.to_h { |c| [c[:number], c] }
    order = cands.each_with_index.to_h { |c, i| [c[:number], i] }
    ranked = groups(cands).sort_by do |g|
      files = g.flat_map { |n| by[n][:src] }
      [-(files.count { |f| hub?(f) }.to_f / files.size), -g.size, order[g.first]]
    end
    chosen = []
    ranked.each do |g|
      room = max - chosen.size
      break if room < 2

      if g.size <= room
        chosen.concat(g)
      else
        counts = g.flat_map { |n| by[n][:src] }.tally
        file = counts.max_by { |f, k| [k, hub?(f) ? 1 : 0, f] }.first
        part = g.select { |n| by[n][:src].include?(file) }.first(room)
        chosen.concat(part) if part.size >= 2
      end
    end
    chosen.sort_by { |n| order[n] }
  end

  # A pull request description as an intent's why: untrusted text, so HTML, images, links (their text kept), bare
  # URLs, mentions, the template's checklist and any line speaking to an agent are removed; code spans and fences are
  # kept as text; the result is capped at `limit` characters at a line. Empty when nothing is left.
  def clean_why(body, limit: WHY_CHARS)
    text = body.to_s.gsub("\r\n", "\n").gsub(/<!--.*?-->/m, "")
    out = []
    fence = false
    template = false
    text.each_line do |raw|
      line = raw.chomp
      if line.strip.start_with?("```")
        fence = !fence
        out << line.strip[0, 3] + line.strip[3..].to_s.gsub(/[^\w-]/, "")
        next
      end
      if fence
        out << line
        next
      end
      template = true if line.match?(/\A\s*#+\s*the author should do the following/i)
      next if template && (line.strip.empty? || TEMPLATE.match?(line))
      template = false

      next if TEMPLATE.match?(line) || TO_AGENT.match?(line)

      text = prose(line)
      # A reference whose link was its only content ("Fixes <url>") says nothing once the link is gone.
      next if text.strip.match?(/\A(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|related(?: to)?|see|ref(?:s|erence)?)\s*:?\s*[.,]?\z/i)

      out << text
    end
    out << "```" if fence
    joined = out.join("\n").gsub(/\n{3,}/, "\n\n").strip
    return joined if joined.length <= limit

    cut = joined[0, limit]
    cut = cut[0, cut.rindex("\n")] if cut.include?("\n") && cut.rindex("\n") > limit / 2
    open = cut.scan(/^```/).size.odd?
    "#{cut.rstrip}\n…#{open ? "\n```" : ''}"
  end

  # One line of prose outside code: HTML, images, links, URLs and mentions removed; inline code spans kept as they are.
  def prose(line)
    line.split(/(`[^`]*`)/).map do |part|
      next part if part.start_with?("`") && part.end_with?("`") && part.length > 1

      part.gsub(%r{https?://github\.com/#{Regexp.escape(REPOSITORY)}/(?:issues|pull)/(\d+)[^\s)\]]*}, '#\1')
          .gsub(/!\[[^\]]*\]\([^)]*\)/, "").gsub(/<img\b[^>]*>/i, "").gsub(%r{</?[A-Za-z][^>]*>}, "")
          .gsub(/\[([^\]]*)\]\([^)]*\)/, '\1').gsub(%r{\b(?:https?|ftp)://\S+}, "").gsub(%r{\bwww\.\S+}, "")
          .gsub(%r{(^|[^\w`@./-])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:/[A-Za-z0-9_-]+)?(?![\w@/-])}, '\1')
          .gsub(/[ \t]{2,}/, " ")
    end.join.rstrip
  end

  # An intent's title from the pull request's title (one line, at most 200 characters).
  def title(text) = prose(text.to_s.gsub(/\s+/, " ").strip)[0, 200]

  # The test files vitest runs for a pull request's test files: each runnable one, and for a shared case file the
  # runnable test files that import it (`texts`: path => text of the tree's test files).
  def run_targets(tests, texts)
    runnable = tests.select { |p| HonoTree.runnable?(p) }
    cases = tests.select { |p| HonoTree::CASE_FILE.match?(p) }
    importers = cases.flat_map do |c|
      stem = File.basename(c, ".ts")
      texts.select { |p, t| HonoTree.runnable?(p) && t.to_s.match?(/['"][^'"]*#{Regexp.escape(stem)}(\.ts)?['"]/) }.keys
    end
    (runnable + importers).uniq.sort
  end

  # --- the clone ----------------------------------------------------------------------------------------------------

  # The characters of each of `paths` right before the commit and right after it, the longer of the two (nil when the
  # file is at neither): what an agent redoing the pull request reads and must write back whole.
  def footprint_chars(repo, sha, paths)
    paths.to_h do |p|
      sizes = [repo.show("#{sha}^", p), repo.show(sha, p)].compact.map { |b| chars(b) }
      [p, sizes.max]
    end
  end

  # main's first-parent commits after `base` up to `upto`, oldest first: { sha:, date:, subject:, changed: }.
  def history(repo, base, upto)
    log = repo.git("log", "--first-parent", "--reverse", "--format=%H%x1f%cI%x1f%s", "#{base}..#{upto}")
    log.lines.map do |l|
      sha, date, subject = l.chomp.split("\x1f", 3)
      { sha: sha, date: date, subject: subject, changed: repo.changed(sha) }
    end
  end

  # Real vitest runs for the selection, each cached by what it ran (commit, files, files written over it).
  class Verifier
    def initialize(repo, worktree, base, cache:, log:)
      @repo = repo
      @wt = worktree
      @base = base
      @cache = cache
      @log = log
      @texts = {}
    end

    # The test files the tree at `rev` holds, path => text, for finding a case file's importers.
    def test_texts(rev)
      @texts[rev] ||= @repo.tree(rev).keys.select { |p| HonoTree::TEST_FILE.match?(p) }.to_h { |p| [p, @repo.show(rev, p)] }
    end

    # The vitest targets of pull request `c` in the tree at `rev`.
    def targets(c, rev) = HonoReplaySelect.run_targets(c[:tests], c[:tests].any? { |p| HonoTree::CASE_FILE.match?(p) } ? test_texts(rev) : {})

    # Vitest on `files` at `commit`, with `extra` (path => bytes) written over it first; cached.
    def run(commit, files, extra = {}, all: false)
      key = Digest::SHA1.hexdigest([commit, *files.sort, *extra.sort.map { |p, t| "#{p}\0#{Digest::SHA1.hexdigest(t.to_s)}" }, all.to_s].join("\n"))
      path = File.join(@cache, "vitest-#{key[0, 20]}.json")
      return JSON.parse(File.read(path), symbolize_names: true).then { |r| r.merge(files: r[:files].transform_keys(&:to_s)) } if File.file?(path)

      @wt.checkout(commit)
      @wt.write(extra)
      result = @wt.vitest(files, all: all)
      FileUtils.mkdir_p(@cache)
      File.write(path, JSON.generate(result)) unless result[:error]
      result
    end

    # Its own test files at its own merge commit (the upstream tree, B's node_modules): they must pass.
    def at_merge(c)
      files = targets(c, c[:sha]).select { |p| @repo.show(c[:sha], p) }
      return { error: "none of its test files is at its merge commit", counts: {}, files: {}, success: false } if files.empty?

      @log.call("  ##{c[:number]}: vitest at its merge commit on #{files.join(', ')}")
      run(c[:sha], files)
    end

    # The checks of pull request `c` laid at `step` ({ before:, after: }) of the chain whose head is `final`: its hidden
    # tests (its test files as the chain leaves them right after it) fail before it and at B, pass right after it and
    # at the final target; its target tests are the ones that fail before it and pass after it.
    def check(c, step, final)
      hidden = c[:tests].to_h { |p| [p, @repo.show(step[:after], p)] }.compact
      targets = targets(c, step[:after])
      return { valid: false, reason: "no test file vitest's main project runs", hidden: hidden, targets: [] } if targets.empty?

      @log.call("  ##{c[:number]}: vitest before and after it, at B and at the target on #{targets.join(', ')}")
      before = run(step[:before], targets, hidden)
      after = run(step[:after], targets)
      at_base = run(@base, targets, hidden)
      at_final = run(final, targets, hidden)
      passing_after = HonoReplaySelect.passing(after)
      target = HonoTree::Vitest.failing(before).select { |n| passing_after.include?(n) || (n.include?(": did not load") && after[:success]) }
      reason = if [before, after, at_base, at_final].any? { |r| r[:error] } then "vitest did not run: #{[before, after, at_base, at_final].filter_map { |r| r[:error] }.first}"
               elsif !after[:success] then "its hidden tests do not pass right after it: #{HonoTree::Vitest.failing(after).first(3).join('; ')}"
               elsif target.empty? then "none of its hidden tests fails right before it: they cannot tell its change from none"
               elsif at_base[:success] then "its hidden tests already pass at B"
               elsif !at_final[:success] then "its hidden tests fail on the final target (a later pull request changed what they expect): #{HonoTree::Vitest.failing(at_final).first(3).join('; ')}"
               end
      { valid: reason.nil?, reason: reason, hidden: hidden, targets: targets, target_tests: target,
        before: summary(before), after: summary(after), at_base: summary(at_base), on_target: summary(at_final) }
    end

    def summary(r) = r[:counts].to_h.merge(success: r[:success], seconds: r[:seconds], error: r[:error], failing: HonoTree::Vitest.failing(r).first(40)).compact
  end

  # The names of the passing tests of a parsed vitest run, "file: describe > it".
  def passing(result)
    result[:files].flat_map { |path, f| f[:tests].select { |t| t[:status] == "passed" }.map { |t| "#{path}: #{t[:name]}" } }.to_set
  end

  # --- GitHub (GET only, cached) ------------------------------------------------------------------------------------

  # The pull request as `gh api repos/honojs/hono/pulls/<n>` answers it (a GET), from the cache when it holds it.
  def pull(number, cache)
    path = File.join(cache, "pulls", "#{number}.json")
    return JSON.parse(File.read(path)) if File.file?(path)

    ok, out, err, timed_out = Stage.run(["gh", "api", "--method", "GET", "repos/#{REPOSITORY}/pulls/#{number}"], timeout: 60)
    raise HonoTree::Error, "gh api for pull request ##{number} #{timed_out ? 'did not answer' : "failed: #{err.strip.lines.last.to_s.strip[0, 200]}"}" unless ok

    data = JSON.parse(out).slice("number", "title", "body", "merged_at", "merge_commit_sha", "state")
    data["base"] = JSON.parse(out).dig("base", "ref")
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, JSON.pretty_generate(data))
    data
  end

  # --- the whole selection ------------------------------------------------------------------------------------------

  def parse(argv)
    opts = { clone: nil, modules: nil, base: nil, until: "main", min: 12, max: 16, cache: nil, out: OUT, github: true, quiet: false, worktree: nil }
    OptionParser.new do |o|
      o.banner = "Usage: ruby scripts/hono_replay_select.rb --clone DIR --modules DIR --base SHA [options]"
      o.on("--clone DIR", "A local clone of honojs/hono") { |v| opts[:clone] = File.expand_path(v) }
      o.on("--modules DIR", "node_modules installed in a Hono checkout at or near B") { |v| opts[:modules] = File.expand_path(v) }
      o.on("--base SHA", "B: the commit the colony starts from") { |v| opts[:base] = v }
      o.on("--until REV", "The last commit of main read (default main)") { |v| opts[:until] = v }
      o.on("--min N", Integer, "Fewest pull requests to write a workload (default 12)") { |v| opts[:min] = v }
      o.on("--max N", Integer, "Most pull requests selected (default 16)") { |v| opts[:max] = v }
      o.on("--cache DIR", "Cache for verification results and GitHub answers (default <clone>/../hono-replay-cache)") { |v| opts[:cache] = File.expand_path(v) }
      o.on("--worktree DIR", "Scratch worktree for vitest (default <clone>/../hono-replay-verify)") { |v| opts[:worktree] = File.expand_path(v) }
      o.on("--out FILE", "The workload (default demo/hono-replay/workload.json)") { |v| opts[:out] = File.expand_path(v) }
      o.on("--no-github", "Do not read pull request descriptions (whys are left empty)") { opts[:github] = false }
      o.on("--quiet", "Print only the summary") { opts[:quiet] = true }
    end.parse!(argv)
    %i[clone modules base].each { |k| raise Stage::ConfigError, "pass --#{k}" unless opts[k] }
    opts[:cache] ||= File.join(File.dirname(opts[:clone]), "hono-replay-cache")
    opts[:worktree] ||= File.join(File.dirname(opts[:clone]), "hono-replay-verify")
    opts
  end

  def main(argv)
    original = argv.dup
    opts = parse(argv)
    log = ->(line) { puts(line) unless opts[:quiet] }
    repo = HonoTree::Repo.new(opts[:clone])
    base = repo.commit(opts[:base]) or raise Stage::ConfigError, "the clone has no commit #{opts[:base]}"
    upto = repo.commit(opts[:until]) or raise Stage::ConfigError, "the clone has no commit #{opts[:until]}"
    wt = HonoTree::Worktree.new(repo, opts[:worktree], node_modules: opts[:modules])
    verifier = Verifier.new(repo, wt, base, cache: opts[:cache], log: log)

    cap = output_cap
    log.call("an agent writes at most #{group(cap[:chars])} characters of a file back in one reply (#{cap[:source]}): a pull request changing a longer file is skipped")
    commits = history(repo, base, upto)
    classified = commits.map do |c|
      texts = c[:changed].map(&:last).select { |p| HonoTree::TEST_FILE.match?(p) }.to_h { |p| [p, repo.show(c[:sha], p)] }
      first = classify(c, texts)
      # Sizes are read only for what passes every other check (two reads per file).
      first[:skip] ? first : classify(c, texts, sizes: footprint_chars(repo, c[:sha], first[:footprint]), cap: cap[:chars])
    end
    cands = classified.reject { |c| c[:skip] }
    big = classified.select { |c| c[:skip].to_s.include?("an in-platform agent can write back") }
    log.call("read #{commits.size} commits of main after #{base[0, 8]}; #{cands.size} pull requests change source and tests that run on Node#{big.empty? ? '' : " (#{big.size} more change a file too long for an agent to write: #{big.map { |c| "##{c[:number]}" }.join(', ')})"}")
    linked = groups(cands).flatten.to_set
    pool = cands.select { |c| linked.include?(c[:number]) }
    log.call("#{pool.size} of them share a source file with another; their test files at their own merge commits:")
    dropped = []
    merges = pool.to_h { |c| [c[:number], verifier.at_merge(c)] }
    valid = pool.select do |c|
      r = merges[c[:number]]
      dropped << { number: c[:number], reason: "its test files do not pass at its own merge commit: #{(r[:error] ? [r[:error]] : HonoTree::Vitest.failing(r)).first(3).join('; ')}" } unless r[:success]
      r[:success]
    end

    # Select, lay the selection on B in merge order, check each pull request where it lands, and drop what does not
    # hold, until it holds.
    result = nil
    loop do
      chosen = select(valid, max: opts[:max])
      sel = valid.select { |c| chosen.include?(c[:number]) }
      chain = repo.replay(base, sel.map { |c| c[:sha] }, label: ->(sha) { "##{sel.find { |c| c[:sha] == sha }[:number]}" })
      unless chain[:conflicts].empty?
        chain[:conflicts].each do |sha, paths|
          c = sel.find { |x| x[:sha] == sha }
          dropped << { number: c[:number], reason: "does not lay on B with the pull requests selected before it (conflicts in #{paths.join(', ')}): it builds on one not selected" }
          valid.delete(c)
        end
        next
      end
      log.call("chain: #{sel.size} pull requests laid on B in merge order (#{sel.map { |c| "##{c[:number]}" }.join(' ')}), target #{chain[:head][0, 8]}")
      checks = sel.each_with_index.to_h { |c, i| [c[:number], verifier.check(c, chain[:steps][i], chain[:head])] }
      bad = sel.reject { |c| checks[c[:number]][:valid] }
      if bad.empty?
        result = { sel: sel, chain: chain, checks: checks }
        break
      end
      # A pull request whose own tests do not hold goes; of those that fail only on the final target, the latest goes
      # first (an earlier one may fail only through what a later one changed).
      own, late = bad.partition { |c| !checks[c[:number]][:reason].to_s.start_with?("its hidden tests fail on the final target") }
      gone = own.empty? ? [late.max_by { |c| sel.index(c) }] : own
      gone.each do |c|
        dropped << { number: c[:number], reason: checks[c[:number]][:reason] }
        valid.delete(c)
      end
    end
    sel = result[:sel]
    if sel.size < opts[:min]
      warn("hono_replay_select: only #{sel.size} pull requests hold (fewer than --min #{opts[:min]}): widen --until or move --base")
      return Stage::EXIT_FAIL
    end

    log.call("visible tests at B: vitest's main project, every test file")
    suite = verifier.run(base, [], all: true)
    log.call("the target's own test files")
    own = verifier.run(result[:chain][:head], sel.flat_map { |c| verifier.targets(c, result[:chain][:head]) }.uniq.sort)
    workload = build(repo, base, upto, result, merges, verifier, dropped, cands, classified, suite, own, opts, original, log, cap: cap)
    FileUtils.mkdir_p(File.dirname(opts[:out]))
    File.write(opts[:out], "#{JSON.pretty_generate(workload)}\n")
    report(workload).each { |l| puts l }
    puts "wrote #{opts[:out].delete_prefix("#{ROOT}/")}"
    Stage::EXIT_PASS
  rescue Stage::ConfigError, OptionParser::ParseError => e
    warn("hono_replay_select: #{e.message}")
    Stage::EXIT_USAGE
  rescue HonoTree::Error => e
    warn("hono_replay_select: #{e.message}")
    Stage::EXIT_FAIL
  end

  def summary_of(r) = r[:counts].to_h.merge(success: r[:success], failing: HonoTree::Vitest.failing(r).first(40)).compact

  # The workload written to demo/hono-replay/workload.json.
  def build(repo, base, upto, result, merges, verifier, dropped, cands, classified, suite, own, opts, argv, log, cap: output_cap)
    head = repo.git("log", "-1", "--format=%cI%x1f%s", base).strip.split("\x1f", 2)
    chain = result[:chain]
    prs = result[:sel].each_with_index.map do |c, i|
      pr = opts[:github] ? pull(c[:number], opts[:cache]) : {}
      log.call("  ##{c[:number]}: merge commit on main #{pr['merge_commit_sha'].to_s[0, 8]} (local #{c[:sha][0, 8]})") if pr["merge_commit_sha"] && pr["merge_commit_sha"] != c[:sha]
      chk = result[:checks][c[:number]]
      hidden = chk[:hidden]
      visible = c[:tests].to_h { |p| [p, repo.show(base, p)] }
      {
        number: c[:number], title: title(pr["title"] || c[:subject].sub(/\s*\(#\d+\)\s*\z/, "")), merged_at: pr["merged_at"] || c[:date],
        commit: c[:sha], why: clean_why(pr["body"]), acceptance: [], footprint: c[:footprint], src: c[:src], tests: c[:tests],
        laid: { before: chain[:steps][i][:before], after: chain[:steps][i][:after] },
        hidden: hidden.map { |p, t| { path: p, blob: git_blob(t), new: visible[p].nil?, bytes: t.bytesize } },
        run: chk[:targets], target_tests: chk[:target_tests],
        checks: { at_merge: summary_of(merges[c[:number]]), before: chk[:before], after: chk[:after], at_base: chk[:at_base], on_target: chk[:on_target] },
        apis: hidden.transform_values { |t| HonoTree::Api.scan(t) },
        visible_apis: visible.compact.transform_values { |t| HonoTree::Api.scan(t) }
      }
    end
    ov = overlap(result[:sel])
    suite_files = repo.tree(base).keys.select { |p| HonoTree.runnable?(p) }
    hidden_scan = prs.each_with_object({}) { |p, h| h.merge!(p[:apis]) }
    visible_scan = prs.each_with_object({}) { |p, h| h.merge!(p[:visible_apis]) }
    {
      schema: SCHEMA, label: "MEASURED", repository: REPOSITORY,
      command: (["ruby scripts/hono_replay_select.rb"] + redact_paths(argv)).join(" "),
      base: { commit: base, date: head[0], subject: head[1] }, until: upto,
      target: { commit: chain[:head], note: "B with every selected pull request laid on it in merge order (stock git merge-tree, a fixed identity and fixed dates, so the ids are the same in any clone), in the clone's object store only", own_tests: summary_of(own) },
      seed: { exclude: SEED_EXCLUDE.map { |p, why| { prefix: p, why: why } }, note: "B's tree but these, symlinks, binary files and files over the inline limit (scripts/hono_replay.rb)" },
      visible_suite_at_base: { files: suite_files.size, vitest: summary_of(suite) },
      prs: prs,
      overlap: { edges: ov[:edges].map { |a, b, f| { a: a, b: b, files: f } }, by_file: ov[:by_file], tests_by_file: ov[:tests_by_file] },
      # Over distinct files: a test file several pull requests changed counts once, as the last one left it.
      apis: { hidden_files: hidden_scan.keys.sort, hidden: HonoTree::Api.merge(hidden_scan.values),
              visible_files: visible_scan.keys.sort, visible: HonoTree::Api.merge(visible_scan.values),
              suite_files: suite_files.size, suite: HonoTree::Api.merge(suite_files.map { |p| HonoTree::Api.scan(repo.show(base, p)) }) },
      considered: { commits: classified.size, candidates: cands.size, output_cap: cap,
                    skipped: classified.select { |c| c[:skip] }.map { |c| { number: c[:number], sha: c[:sha][0, 12], why: c[:skip] }.compact },
                    dropped: dropped }
    }
  end

  # The git blob id of bytes as stored (no encoding change).
  def git_blob(bytes) = Digest::SHA1.hexdigest("blob #{bytes.bytesize}\0".b + bytes.b)

  # Arguments with local paths replaced by what they stand for.
  def redact_paths(argv)
    out = []
    argv.each_with_index do |a, i|
      prev = argv[i - 1] if i.positive?
      out << (%w[--clone --modules --cache --worktree --out].include?(prev) ? "<#{prev.delete_prefix('--')}>" : a)
    end
    out
  end

  # The summary printed at the end: the pull requests, the overlap graph and the vitest surface.
  def report(w)
    lines = ["", "B #{w[:base][:commit][0, 12]} (#{w[:base][:date]}): #{w[:base][:subject]}", "#{w[:prs].size} pull requests, target #{w[:target][:commit][0, 12]}:"]
    w[:prs].each do |p|
      lines << format("  #%-5d %s  %s", p[:number], p[:merged_at].to_s[0, 10], p[:title][0, 90])
      lines << "         src: #{p[:src].join(' ')}  | hidden: #{p[:hidden].map { |h| "#{h[:path]}#{h[:new] ? ' (new)' : ''}" }.join(' ')}  | target tests #{p[:target_tests].size}"
    end
    lines << "overlap (shared source files):"
    w[:overlap][:by_file].each { |f, ns| lines << "  #{f}: #{ns.map { |n| "##{n}" }.join(' ')}" }
    lines << "overlap (shared test files): #{w[:overlap][:tests_by_file].map { |f, ns| "#{f} (#{ns.map { |n| "##{n}" }.join(' ')})" }.join('; ')}"
    h = w[:apis][:hidden]
    lines << "hidden test files (#{w[:apis][:hidden_files].size} distinct) use: matchers #{h[:matchers].map { |k, v| "#{k}×#{v}" }.join(', ')}; .not×#{h[:negated]}, resolves×#{h[:resolves]}, rejects×#{h[:rejects]}"
    lines << "  asymmetric #{h[:asymmetric].inspect}; vi #{h[:vi].inspect}; hooks #{h[:hooks].inspect}; modifiers #{h[:modifiers].inspect}; type tests #{h[:type_tests].inspect}; snapshots #{h[:snapshots].inspect}"
    lines << "  imports: vitest #{h[:vitest_imports].inspect}, globals #{h[:globals].inspect}, packages #{h[:packages].inspect}, node #{h[:node_builtins].inspect}"
    big = w[:considered][:skipped].select { |c| c[:why].to_s.include?("an in-platform agent can write back") }
    lines << "skipped as too long for an agent to write (cap #{group(w.dig(:considered, :output_cap, :chars))} characters): #{big.map { |c| "##{c[:number]} (#{c[:why][/\A\S+ is [\d,]+ characters/]})" }.join('; ')}" unless big.empty?
    lines << "dropped: #{w[:considered][:dropped].map { |d| "##{d[:number]} (#{d[:reason][0, 90]})" }.join('; ')}"
    lines
  end
end

exit(HonoReplaySelect.main(ARGV)) if $PROGRAM_NAME == __FILE__
