# frozen_string_literal: true

# What stock git makes of the rename scene (scripts/scene_rename.rb): the same base, the rename as one commit on main,
# each agent's edit as its own branch from the base, and each branch merged on its own into main after the rename.
# Counted per branch: a merge that conflicts, one that merges clean but leaves a file naming the old identifier (the
# merge succeeds and the code still calls a name that no longer exists), and one that merges clean with the new name.
# Every commit is made with fixed names and times and no user or system git configuration, in a temporary directory
# that is removed afterwards and never named in what it returns.
require "fileutils"
require "tmpdir"
require_relative "stage"

module SceneGit
  # Fixed commit times (seconds), so the comparison is the same on every run.
  T0 = 1_792_573_200

  # What git made of the merges: the branch names in each group, in the order given.
  Result = Struct.new(:conflicts, :stale, :clean, keyword_init: true) do
    def of = conflicts.size + stale.size + clean.size

    # "git: 30 of 30 conflict" with the clean merges after it when there are any.
    def line(from)
      extra = []
      extra << "#{stale.size} merge#{stale.size == 1 ? 's' : ''} clean but still call#{stale.size == 1 ? 's' : ''} #{from}" unless stale.empty?
      extra << "#{clean.size} merge#{clean.size == 1 ? 's' : ''} clean" unless clean.empty?
      "git: #{conflicts.size} of #{of} conflict#{extra.empty? ? '' : " (#{extra.join(', ')})"}"
    end
  end

  # The comparison could not run; the message says why.
  class Error < StandardError; end

  # Merge each branch into main after the rename. `base` and `rename` map paths to texts (`rename` holds only the files
  # the rename rewrote); `branches` is a list of [name, {path => text}]; `from` is the identifier the rename removed.
  def self.compare(base:, rename:, branches:, from:, timeout: 120)
    Dir.mktmpdir("ft-scene-git-") do |dir|
      deadline = Stage.now + timeout
      # One git command; `may_fail` lets a failure through as [false, output] (a merge that conflicts).
      git = lambda do |*args, at: T0, may_fail: false|
        left = deadline - Stage.now
        raise Error, "git did not finish the comparison within #{timeout} s" if left <= 0

        okay, out, err, timed_out = Stage.run(["git", *args], env: env(dir, at), chdir: dir, timeout: left)
        raise Error, "git #{args.first} did not finish within #{timeout} s" if timed_out
        raise Error, "git #{args.first} failed: #{err.strip.lines.last.to_s.strip[0, 200]}" unless okay || may_fail

        [okay, out]
      end
      commit = lambda do |message, at|
        git.call("add", "-A")
        git.call("commit", "-q", "--allow-empty", "-m", message, at: at)
      end
      git.call("init", "-q", "-b", "main", ".")
      write(dir, base)
      commit.call("Seed the shop", T0)
      seed = git.call("rev-parse", "HEAD")[1].strip
      branches.each_with_index do |(name, files), i|
        git.call("checkout", "-q", "-b", name, seed)
        write(dir, files)
        commit.call("#{name}: its edit", T0 + 60 * (i + 1))
      end
      git.call("checkout", "-q", "main")
      write(dir, rename)
      commit.call("Rename #{from}", T0 + 30)
      word = /(?<![\w$])#{Regexp.escape(from)}(?![\w$])/
      out = Result.new(conflicts: [], stale: [], clean: [])
      branches.each do |name, files|
        git.call("checkout", "-q", "-B", "try", "main")
        merged, = git.call("merge", "-q", "--no-edit", "-m", "Merge #{name}", name, at: T0 + 7200, may_fail: true)
        unmerged = git.call("diff", "--name-only", "--diff-filter=U")[1].split("\n").reject(&:empty?)
        if !merged || !unmerged.empty?
          out.conflicts << name
          git.call("merge", "--abort", may_fail: true)
          git.call("reset", "-q", "--hard", "main")
        elsif files.keys.any? { |path| File.read(File.join(dir, path)).match?(word) }
          out.stale << name
        else
          out.clean << name
        end
      end
      out
    end
  end

  # Git's environment: no user or system configuration, no prompts, a fixed author and committer at `at`.
  def self.env(dir, at)
    who = { "GIT_AUTHOR_NAME" => "Scene", "GIT_AUTHOR_EMAIL" => "scene@example.com", "GIT_COMMITTER_NAME" => "Scene", "GIT_COMMITTER_EMAIL" => "scene@example.com" }
    { "GIT_CONFIG_NOSYSTEM" => "1", "GIT_CONFIG_GLOBAL" => File::NULL, "GIT_TERMINAL_PROMPT" => "0", "HOME" => dir, "LC_ALL" => "C",
      "GIT_AUTHOR_DATE" => "@#{at} +0000", "GIT_COMMITTER_DATE" => "@#{at} +0000" }.merge(who)
  end

  def self.write(dir, files)
    files.each do |path, text|
      full = File.join(dir, path)
      FileUtils.mkdir_p(File.dirname(full))
      File.write(full, text)
    end
  end
end
