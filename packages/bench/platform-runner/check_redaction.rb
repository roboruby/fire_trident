#!/usr/bin/env ruby
# Scans result files for the staging secrets before they are committed: the admin token and the Cloudflare Access
# service-token pair, read from the environment (run it under the stage env wrapper). Prints only file names and
# counts, never a value. Exits 1 when any secret appears.
#   <env with FT_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET> ruby check_redaction.rb <dir or files...>
secrets = %w[FT_TOKEN FT_ADMIN_TOKEN CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET FT_MCP_TOKEN].filter_map { |k| v = ENV[k].to_s.strip; [k, v] if v.length >= 8 }
abort "no secrets in the environment to scan for" if secrets.empty?
files = ARGV.flat_map { |a| File.directory?(a) ? Dir.glob(File.join(a, "**", "*")).select { |f| File.file?(f) } : [a] }
abort "no files" if files.empty?
found = 0
files.each do |f|
  text = File.binread(f)
  hits = secrets.filter_map { |k, v| n = text.scan(v).size; "#{k} x#{n}" if n > 0 }
  if hits.empty?
    puts "clean  #{f} (#{text.bytesize} bytes)"
  else
    found += 1
    puts "FOUND  #{f}: #{hits.join(", ")}"
  end
end
puts(found.zero? ? "no secret appears in #{files.size} files" : "#{found} files hold a secret")
exit(found.zero? ? 0 : 1)
