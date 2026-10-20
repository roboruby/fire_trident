#!/usr/bin/env ruby
# Assembles the Docker build context for the bench runner image under build/ (gitignored): the monorepo's core and
# bench packages (package.json and src only), a slim root package.json whose one dependency is esbuild (the check's
# parser) pinned to the monorepo lockfile's version plus undici for container/dispatcher.mjs, and SOURCE naming the
# commit the sources came from.
#   ruby prepare.rb
require "fileutils"
require "json"

HERE = __dir__
ROOT = File.expand_path("../../..", HERE)
BUILD = File.join(HERE, "build")

lock = JSON.parse(File.read(File.join(ROOT, "package-lock.json")))
esbuild = lock.dig("packages", "node_modules/esbuild", "version") or abort "esbuild is not in package-lock.json"

FileUtils.rm_rf(BUILD)
%w[core bench].each do |pkg|
  dest = File.join(BUILD, "packages", pkg)
  FileUtils.mkdir_p(dest)
  FileUtils.cp(File.join(ROOT, "packages", pkg, "package.json"), dest)
  FileUtils.cp_r(File.join(ROOT, "packages", pkg, "src"), dest)
end
# undici 7.x matches node 24's bundled copy, so dispatcher.mjs's setGlobalDispatcher reaches the global fetch.
root = { name: "ft-bench-runner-image", private: true, type: "module", workspaces: ["packages/core", "packages/bench"], dependencies: { esbuild: esbuild, undici: "7.30.1" } }
File.write(File.join(BUILD, "package.json"), "#{JSON.pretty_generate(root)}\n")
sha = `git -C #{ROOT} rev-parse --short HEAD`.strip
dirty = `git -C #{ROOT} status --porcelain -- packages/core/src packages/bench/src`.strip.empty? ? "" : " (sources modified)"
File.write(File.join(BUILD, "SOURCE"), "#{sha}#{dirty}\n")
files = Dir.glob("#{BUILD}/**/*").count { |f| File.file?(f) }
puts "build context at #{BUILD}: source #{sha}#{dirty}, esbuild #{esbuild}, #{files} files"
