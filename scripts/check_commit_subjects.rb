#!/usr/bin/env ruby
# frozen_string_literal: true

# Checks commit subjects: every commit in a range has a subject (its first line, as `git log --oneline` shows it) of 1
# to 72 characters. Prints each commit that breaks the rule and exits 1 when there is one. CI runs it on the commits a
# push or a pull request adds.
#
#   ruby scripts/check_commit_subjects.rb                  the commits of HEAD that origin/main does not have
#   ruby scripts/check_commit_subjects.rb <base>..<head>   the commits of head that base does not have
#
# History from before the check is never checked: the range stops at the commit that added this script (that commit is
# checked, its ancestors are not). A base that is empty, all zeros (the first push of a branch) or not in this clone
# (after a force push) checks back to that commit, or only the head commit when the script was never committed.
# GitHub's own merge commits ("Merge pull request #12 from owner/branch") are skipped: GitHub writes their subject from
# the branch name.
require "open3"

module CommitSubjects
  MAX = 72
  DEFAULT_RANGE = "origin/main..HEAD"
  # The path whose first commit starts the checked history.
  SELF = "scripts/check_commit_subjects.rb"
  GITHUB_MERGE = /\AMerge pull request #\d+ from \S+\z/

  # The range could not be read; the message says why.
  class Error < StandardError; end

  # One commit and its subject.
  Commit = Struct.new(:sha, :parents, :subject, keyword_init: true) do
    def merge? = parents.size > 1

    # What is wrong with the subject, or nil when nothing is.
    def problem
      return "the subject is empty" if subject.strip.empty?
      return "the subject is #{subject.length} characters, over #{MAX}" if subject.length > MAX

      nil
    end
  end

  # What a check found: the commits it read, those skipped as GitHub's merge commits, and those that break the rule.
  Result = Struct.new(:checked, :skipped, :offenders, :note, keyword_init: true)

  module_function

  # Runs git in `dir`; returns its output, or nil when it fails.
  def git(dir, *args)
    out, _err, status = Open3.capture3("git", "-C", dir, *args)
    status.success? ? out : nil
  end

  # Is `rev` a commit in this clone? Empty and all-zero names are not.
  def commit?(dir, rev)
    return false if rev.nil? || rev.empty? || rev.match?(/\A0+\z/)

    !git(dir, "rev-parse", "--verify", "--quiet", "#{rev}^{commit}").nil?
  end

  # Splits "<base>..<head>" into its two names; an empty head is HEAD.
  def parse(range)
    raise Error, "#{range.inspect} is not a range: give <base>..<head>, for example origin/main..HEAD." if range.include?("...") || !range.include?("..")

    base, head = range.split("..", 2)
    [base, head.to_s.empty? ? "HEAD" : head]
  end

  # The commit that first added this script in head's history, or nil.
  def floor(dir, head)
    out = git(dir, "log", "--format=%H", "--no-renames", "--diff-filter=A", head, "--", SELF)
    out&.split("\n")&.last
  end

  # Checks the commits of `range` in the repository at `dir`.
  def check(range, dir: Dir.pwd)
    base, head = parse(range)
    raise Error, "#{head} is not a commit in this clone: fetch it, or name another head." unless commit?(dir, head)

    start = floor(dir, head)
    stops = start ? git(dir, "rev-parse", "#{start}^@").to_s.split : []
    note = nil
    args = [head, *stops.map { |s| "^#{s}" }]
    if commit?(dir, base)
      args << "^#{base}"
    elsif start
      note = "The base #{base.empty? ? '(none)' : base} is not a commit in this clone, so the check goes back to the commit that added the check."
    else
      note = "The base #{base.empty? ? '(none)' : base} is not a commit in this clone, so only the head commit is checked."
      args = ["--max-count=1", head]
    end
    out = git(dir, "log", "--format=%H%x1f%P%x1f%s", *args) or raise Error, "git log could not read #{range}."
    commits = out.split("\n").map do |line|
      sha, parents, subject = line.split("\x1f", 3)
      Commit.new(sha: sha, parents: parents.to_s.split, subject: subject.to_s.dup.force_encoding("UTF-8").scrub)
    end
    skipped, rest = commits.partition { |c| c.merge? && c.subject.match?(GITHUB_MERGE) }
    Result.new(checked: rest, skipped: skipped, offenders: rest.select(&:problem), note: note)
  end

  # Parses the command line, checks and prints; returns the exit code.
  def main(argv, out: $stdout, err: $stderr, dir: Dir.pwd)
    if argv.size > 1 || argv.first&.start_with?("-")
      err.puts "Usage: ruby scripts/check_commit_subjects.rb [<base>..<head>] (default #{DEFAULT_RANGE})"
      return 2
    end
    range = argv.first || DEFAULT_RANGE
    result = check(range, dir: dir)
    out.puts result.note if result.note
    if result.offenders.empty?
      skipped = result.skipped.empty? ? "" : " (#{result.skipped.size} of GitHub's merge commits skipped)"
      out.puts "Checked #{result.checked.size} commit subject#{result.checked.size == 1 ? '' : 's'} in #{range}#{skipped}: each is at most #{MAX} characters."
      return 0
    end
    result.offenders.each { |c| out.puts "#{c.sha[0, 12]} #{c.subject.inspect}: #{c.problem}." }
    n = result.offenders.size
    out.puts "#{n} of #{result.checked.size} commit subject#{result.checked.size == 1 ? '' : 's'} in #{range} " \
             "#{n == 1 ? 'breaks' : 'break'} the rule. Reword each to an imperative summary of at most #{MAX} characters, " \
             "with the details in the body (git rebase -i, then reword), and push again."
    1
  rescue Error => e
    err.puts e.message
    2
  end
end

exit(CommitSubjects.main(ARGV)) if $PROGRAM_NAME == __FILE__
