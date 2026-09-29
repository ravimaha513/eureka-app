# Eureka API / worker / migrate image (ARM64, Fargate). One image, three commands:
#   node dist/main.js         API (default)
#   node dist/worker.js       background worker
#   node dist/db/migrate.js   migrations + role passwords (run once per deploy)

ARG NODE_VERSION=22.20.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# ---------- build ----------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @eureka/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @eureka/shared build && pnpm --filter @eureka/api build

# ---------- production dependencies only ----------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter @eureka/api...

# ---------- RDS CA bundle (verify-full TLS to Postgres) ----------
FROM base AS certs
RUN mkdir /certs && node -e "fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem').then(async r=>{if(!r.ok)throw new Error(r.status);const t=await r.text();if(!t.includes('BEGIN CERTIFICATE'))throw new Error('bad bundle');require('fs').writeFileSync('/certs/rds-global-bundle.pem',t,{mode:0o444})})"

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--conditions=eureka-dist \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem
WORKDIR /app
RUN groupadd --system --gid 10001 eureka && useradd --system --uid 10001 --gid eureka --no-create-home eureka
COPY --from=deps  /app/node_modules                 node_modules
COPY --from=deps  /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=deps  /app/apps/api/node_modules        apps/api/node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist         packages/shared/dist
COPY --from=build /app/apps/api/package.json        apps/api/package.json
COPY --from=build /app/apps/api/dist                apps/api/dist
COPY --from=certs /certs                            certs
COPY db/migrations                                  db/migrations
USER 10001
WORKDIR /app/apps/api
EXPOSE 3000
# ECS task definitions set their own health check; this one covers local runs.
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
