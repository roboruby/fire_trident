# The bench runner image: node 24 (TypeScript type-stripping runs the scenario as is), stock git (the scenario reads the
# trunk with it), the monorepo's core and bench packages copied in by prepare.rb (build/), and esbuild (the check's
# parser) pinned to the monorepo's lockfile version. No repository token, no secrets: those arrive as container env.
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY build/package.json ./package.json
COPY build/SOURCE ./SOURCE
COPY build/packages ./packages
RUN npm install --omit=dev --no-audit --no-fund \
 && node -e "import('esbuild').then((e) => console.log('esbuild', e.version))" \
 && node -e "import('undici').then(() => console.log('undici', process.versions.undici, 'bundled'))" \
 && git --version && node --version
COPY container/server.mjs container/dispatcher.mjs ./
RUN mkdir -p /data/results /data/logs
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
