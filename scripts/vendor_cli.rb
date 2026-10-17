# frozen_string_literal: true
# The published CLI (npm `fire_trident`) ships without @fire_trident/core, which is private: the few core modules it runs
# are copied into packages/cli/src, with their type imports pointed at core (erased by the build) and a first comment line.
# packages/cli/test/package.test.ts fails when a copy differs from core. Run after changing any of these in core:
#   ruby scripts/vendor_cli.rb
ROOT = File.expand_path("..", __dir__)
VENDORED = %w[answerable connect pricing testdelta].freeze

VENDORED.each do |name|
  core = File.read(File.join(ROOT, "packages/core/src/#{name}.ts"))
  head = "// A copy of packages/core/src/#{name}.ts: the published CLI ships without @fire_trident/core " \
         "(scripts/vendor_cli.rb writes it; test/package.test.ts keeps the two the same).\n"
  body = core.gsub(%(from "./types.ts";), %(from "@fire_trident/core";))
  File.write(File.join(ROOT, "packages/cli/src/#{name}.ts"), head + body)
  puts "packages/cli/src/#{name}.ts"
end
