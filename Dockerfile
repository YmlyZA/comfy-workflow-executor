FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @cwe/web build && pnpm --filter @cwe/server build
# pnpm v10+ deploy 需要 --legacy（shared 已被 tsup 打进 server dist，无需 workspace 链接）
RUN pnpm --filter @cwe/server deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /app
COPY --from=build /out .
COPY --from=build /repo/apps/web/dist ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
VOLUME /data
CMD ["node", "dist/index.js"]
