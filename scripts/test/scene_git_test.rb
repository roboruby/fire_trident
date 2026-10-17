# frozen_string_literal: true

# Tests for scripts/scene_git.rb (what stock git makes of a rename and edits built before it) on a small fixture, and
# for the scene data's generator (scripts/scene_data.ts): the same JSON from two processes.
#
#   ruby scripts/test/scene_git_test.rb
require "minitest/autorun"
require "json"
require_relative "../scene_git"
require_relative "../scene"

ENV["GIT_CONFIG_GLOBAL"] = File::NULL
ENV["GIT_CONFIG_NOSYSTEM"] = "1"

class SceneGitTest < Minitest::Test
  PRICE = "export function formatPrice(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n"
  CART = "import { formatPrice } from \"./price\";\n\nexport function cartTotal(cents: number): string {\n  return formatPrice(cents);\n}\n\n" \
         "/** The cart's note. */\nexport const cartNote = \"Thanks\";\n"
  DATES = "export function formatDay(at: Date): string {\n  return at.toISOString().slice(0, 10);\n}\n"
  BASE = { "src/price.ts" => PRICE, "src/cart.ts" => CART, "src/dates.ts" => DATES }.freeze
  RENAME = BASE.slice("src/price.ts", "src/cart.ts").transform_values { |t| t.gsub("formatPrice", "formatAmount") }.freeze

  def compare(branches) = SceneGit.compare(base: BASE, rename: RENAME, branches: branches, from: "formatPrice")

  def test_counts_a_conflict_a_clean_merge_that_still_names_the_old_identifier_and_a_clean_merge
    result = compare([
      # Changes the line the rename changed: git cannot merge it.
      ["edits-the-call", { "src/cart.ts" => CART.sub("return formatPrice(cents);", "return formatPrice(Math.max(0, cents));") }],
      # Adds a call far from every line the rename changed: git merges it, and the merged file calls a name that is gone.
      ["adds-a-call", { "src/cart.ts" => "#{CART}\nexport const free = formatPrice(0);\n" }],
      # Touches a file the rename did not: git merges it, and nothing names the old identifier.
      ["edits-dates", { "src/dates.ts" => DATES.sub("10)", "10) /* day */") }],
    ])
    assert_equal ["edits-the-call"], result.conflicts
    assert_equal ["adds-a-call"], result.stale
    assert_equal ["edits-dates"], result.clean
    assert_equal 3, result.of
    assert_equal "git: 1 of 3 conflict (1 merges clean but still calls formatPrice, 1 merges clean)", result.line("formatPrice")
  end

  def test_says_every_branch_conflicts_when_each_edits_a_renamed_line
    result = compare([["a", { "src/cart.ts" => CART.sub("formatPrice(cents)", "formatPrice(cents + 1)") }], ["b", { "src/price.ts" => PRICE.sub("cents: number", "cents: number, _currency = \"USD\"") }]])
    assert_equal "git: 2 of 2 conflict", result.line("formatPrice")
  end

  def test_the_scene_data_is_the_same_from_two_processes
    a = Stage.run([Stage::NODE, File.expand_path("../scene_data.ts", __dir__)], timeout: 120)
    b = Stage.run([Stage::NODE, File.expand_path("../scene_data.ts", __dir__)], timeout: 120)
    assert a[0], a[2]
    assert_equal a[1], b[1]
    data = JSON.parse(a[1])
    assert_equal [300, 212, 212, 30, 40], [data["files"].size, data["users"].size, data["renamed"].size, data["edits"].size, data["edits"].sum { |e| e["files"].size }]
    assert_equal 892, data["users"].sum { |p| Scene.naming(data["files"][p], "formatPrice") }
    assert_equal 1, data.dig("smuggle", "text").lines.count { |l| l.include?("fetch(") }
  end
end
