# ---- build: compile CSS + bundle the server with bun -----------------------
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx @tailwindcss/cli -i styles/app.css -o public/app.css --minify \
 && bun build src/server.ts --target=bun --outdir=dist \
 && mkdir -p dist/migrations && cp src/db/migrations/*.sql dist/migrations/

# ---- runtime: Node (to spawn `npx @azure-devops/mcp` children) + Bun --------
FROM node:24.16.0-slim

# Default upstream version baked into the image. The updater can adopt newer
# versions at runtime (requires npm registry access). Override at build time
# with --build-arg ADO_MCP_VERSION=x.y.z for a fully pinned image.
ARG ADO_MCP_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

# Pre-warm the npm cache with the default upstream version so the first child
# spawn works without network. Best-effort; newer adopted versions fetch lazily.
RUN npx -y "@azure-devops/mcp@${ADO_MCP_VERSION}" --help > /dev/null 2>&1 || true

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    ADO_MCP_VERSION=${ADO_MCP_VERSION}
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "dist/server.js"]
