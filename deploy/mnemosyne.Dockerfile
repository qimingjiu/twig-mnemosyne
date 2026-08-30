# Zeabur 用：repo 根上下文构建（deploy-from-specification 引用本文件）
# 与 runtime/Dockerfile 的差异：context 是仓库根，需显式拷 runtime/ 子路径，并把 config/ 烤入镜像
# （Zeabur 无 compose 的 :ro 挂载）
FROM node:20-alpine AS build
WORKDIR /build
COPY runtime/package.json runtime/package-lock.json* ./
RUN npm ci --include=dev || npm install --include=dev
COPY runtime/tsconfig.json runtime/vitest.config.ts ./
COPY runtime/src ./src
COPY runtime/scripts ./scripts
COPY runtime/test ./test
# 保留 dev 依赖：容器内可直接跑 vitest 集成套件（红队用例，§12.2）
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S mnemo && adduser -S mnemo -G mnemo
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/package.json ./package.json
COPY runtime/migrations ./migrations
COPY config ./config
# 红队集成套件在容器内可跑（vitest 直接消费 TS 源码）
COPY runtime/tsconfig.json runtime/vitest.config.ts ./
COPY runtime/src ./src
COPY runtime/test ./test
USER mnemo
EXPOSE 8000
CMD ["node", "dist/src/index.js"]
