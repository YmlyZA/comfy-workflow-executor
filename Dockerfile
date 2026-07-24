FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# --config.minimum-release-age=0 scopes pnpm 11's 1-day supply-chain cooldown
# override to this Docker build stage only (CI/dev machines keep the default
# protection — see pnpm-workspace.yaml). Neither .npmrc nor npm_config_ env
# vars are honored by pnpm 11.7 for this setting (verified empirically), so
# the CLI flag must be repeated on every pnpm invocation in this stage: each
# one re-runs pnpm's lockfile supply-chain check.
RUN pnpm install --frozen-lockfile --config.minimum-release-age=0
COPY . .
RUN pnpm --config.minimum-release-age=0 --filter @cwe/web build && pnpm --config.minimum-release-age=0 --filter @cwe/server build
# pnpm v10+ deploy 需要 --legacy（shared 已被 tsup 打进 server dist，无需 workspace 链接）
RUN pnpm --config.minimum-release-age=0 --filter @cwe/server deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /app
COPY --from=build /out .
COPY --from=build /repo/apps/web/dist ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
VOLUME /data
CMD ["node", "dist/index.js"]
