# runtime Dockerfile — §12.4 安全清单：非 root 用户
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev || npm install --include=dev
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
# 保留 dev 依赖：容器内可直接跑 vitest 集成套件（红队用例，§12.2）
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S mnemo && adduser -S mnemo -G mnemo
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# 运行期需要：迁移 SQL 与运行配置（compose 另挂 ./config:/app/config:ro，可覆盖）
COPY migrations ./migrations
USER mnemo
EXPOSE 8000
CMD ["node", "dist/src/index.js"]
