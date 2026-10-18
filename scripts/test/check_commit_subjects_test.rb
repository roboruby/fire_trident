# frozen_string_literal: true

# Tests for scripts/check_commit_subjects.rb, run as a command in small repositories made with stock git (fixed names
# and times, no user or system git configuration).
#
#   ruby scripts/test/check_commit_subjects_test.rb
require "minitest/autorun"
require "fileutils"
require "open3"
require "tmpdir"

ENV["GIT_CONFIG_GLOBAL"] = File::NULL
ENV["GIT_CONFIG_NOSYSTEM"] = "1"

class CheckCommitSubjectsTest < Minitest::Test
  SCRIPT = File.expand_path("../check_commit_subjects.rb", __dir__)
  GIT_ENV = {
    "GIT_AUTHOR_NAME" => "Test", "GIT_AUTHOR_EMAIL" => "test@example.com", "GIT_AUTHOR_DATE" => "2026-10-18T12:00:00Z",
    "GIT_COMMITTER_NAME" => "Test", "GIT_COMMITTER_EMAIL" => "test@example.com", "GIT_COMMITTER_DATE" => "2026-10-18T12:00:00Z",
  }.freeze
  LONG = "Add #{'x' * 69}" # 73 characters

  def setup
    @dir = Dir.mktmpdir("ft-subjects-")
    git("init", "--quiet", "--initial-branch=main")
  end

  def teardown
    FileUtils.rm_rf(@dir)
  end

  def git(*args)
    out, err, status = Open3.capture3(GIT_ENV, "git", "-C", @dir, *args)
    raise "git #{args.join(' ')} failed: #{err}" unless status.success?

    out.strip
  end

  # Commits one file change with `message` (an empty message is allowed); returns the commit's id.
  def commit(message, path: "file.txt", content: nil)
    full = File.join(@dir, path)
    FileUtils.mkdir_p(File.dirname(full))
    File.write(full, content || "#{File.exist?(full) ? File.read(full) : ''}#{message.length}\n")
    git("add", path)
    git("commit", "--quiet", "--allow-empty-message", "-m", message)
    git("rev-parse", "HEAD")
  end

  def run_check(*args)
    out, err, status = Open3.capture3(GIT_ENV, "ruby", SCRIPT, *args, chdir: @dir)
    [out, err, status.exitstatus]
  end

  def test_passes_when_every_subject_is_at_most_72_characters
    base = commit("Start the project")
    commit("Add #{'y' * 68}") # exactly 72
    commit("Fix the parser")
    out, _err, code = run_check("#{base}..HEAD")
    assert_equal 0, code
    assert_equal "Checked 2 commit subjects in #{base}..HEAD: each is at most 72 characters.\n", out
  end

  def test_names_each_subject_over_72_characters_and_each_empty_one
    base = commit("Start the project")
    long = commit(LONG)
    empty = commit("")
    commit("Fix the parser")
    out, _err, code = run_check("#{base}..HEAD")
    assert_equal 1, code
    assert_includes out, "#{empty[0, 12]} \"\": the subject is empty.\n"
    assert_includes out, "#{long[0, 12]} #{LONG.inspect}: the subject is 73 characters, over 72.\n"
    assert_includes out, "2 of 3 commit subjects in #{base}..HEAD break the rule. Reword each"
  end

  def test_counts_characters_not_bytes
    base = commit("Start the project")
    commit("Add #{'é' * 68}") # 72 characters, 140 bytes
    _out, _err, code = run_check("#{base}..HEAD")
    assert_equal 0, code
  end

  def test_a_title_that_runs_onto_a_second_line_is_one_subject_as_git_log_oneline_shows_it
    base = commit("Start the project")
    commit("Add the first half of a title that is long\nand runs onto a second line before its blank line\n\nBody.")
    out, _err, code = run_check("#{base}..HEAD")
    assert_equal 1, code
    assert_includes out, "the subject is 92 characters, over 72."
  end

  def test_never_checks_history_from_before_the_check_but_checks_the_commit_that_adds_it
    root = commit("Start the project")
    commit(LONG)
    landing = commit("Check commit subjects in CI", path: "scripts/check_commit_subjects.rb", content: "# the check\n")
    commit("Fix the parser")
    out, _err, code = run_check("#{root}..HEAD")
    assert_equal 0, code
    assert_equal "Checked 2 commit subjects in #{root}..HEAD: each is at most 72 characters.\n", out

    git("reset", "--quiet", "--hard", "#{landing}^")
    commit("Check commit subjects in CI, a change that grew too long to say in one line", path: "scripts/check_commit_subjects.rb", content: "# the check\n")
    out, _err, code = run_check("#{root}..HEAD")
    assert_equal 1, code
    assert_includes out, "1 of 1 commit subject in #{root}..HEAD breaks the rule."
  end

  def test_a_base_that_is_not_in_the_clone_checks_back_to_the_commit_that_added_the_check
    commit(LONG)
    commit("Check commit subjects in CI", path: "scripts/check_commit_subjects.rb", content: "# the check\n")
    commit("Fix the parser")
    out, _err, code = run_check("#{'0' * 40}..HEAD")
    assert_equal 0, code
    assert_includes out, "is not a commit in this clone, so the check goes back to the commit that added the check.\n"
    assert_includes out, "Checked 2 commit subjects"

    out, _err, code = run_check("#{'ab' * 20}..HEAD")
    assert_equal 0, code
    assert_includes out, "Checked 2 commit subjects"
  end

  def test_a_base_that_is_not_in_the_clone_checks_only_the_head_commit_when_the_check_was_never_committed
    commit(LONG)
    commit("Fix the parser")
    out, _err, code = run_check("..HEAD")
    assert_equal 0, code
    assert_includes out, "The base (none) is not a commit in this clone, so only the head commit is checked.\n"
    assert_includes out, "Checked 1 commit subject in ..HEAD"
  end

  def test_skips_github_merge_commits_and_checks_every_other_merge
    base = commit("Start the project")
    git("checkout", "--quiet", "-b", "a-branch-whose-name-is-long-enough-to-push-the-merge-subject-past-the-limit")
    commit("Add the feature", path: "feature.txt")
    git("checkout", "--quiet", "main")
    commit("Fix the parser", path: "parser.txt")
    git("merge", "--quiet", "--no-ff", "-m", "Merge pull request #12 from owner/a-branch-whose-name-is-long-enough-to-push-the-merge-subject-past-the-limit",
        "a-branch-whose-name-is-long-enough-to-push-the-merge-subject-past-the-limit")
    out, _err, code = run_check("#{base}..HEAD")
    assert_equal 0, code
    assert_equal "Checked 2 commit subjects in #{base}..HEAD (1 of GitHub's merge commits skipped): each is at most 72 characters.\n", out

    git("reset", "--quiet", "--hard", "HEAD^")
    git("merge", "--quiet", "--no-ff", "-m", "Merge the branch whose name is long enough to push this merge subject past the limit",
        "a-branch-whose-name-is-long-enough-to-push-the-merge-subject-past-the-limit")
    out, _err, code = run_check("#{base}..HEAD")
    assert_equal 1, code
    assert_includes out, "1 of 3 commit subjects in #{base}..HEAD breaks the rule."
  end

  def test_refuses_what_is_not_a_range_and_a_head_that_is_not_a_commit
    commit("Start the project")
    _out, err, code = run_check("main...HEAD")
    assert_equal 2, code
    assert_includes err, "\"main...HEAD\" is not a range: give <base>..<head>, for example origin/main..HEAD."

    _out, err, code = run_check("main..nowhere")
    assert_equal 2, code
    assert_includes err, "nowhere is not a commit in this clone: fetch it, or name another head."

    _out, err, code = run_check("--help")
    assert_equal 2, code
    assert_includes err, "Usage: ruby scripts/check_commit_subjects.rb [<base>..<head>]"
  end
end
