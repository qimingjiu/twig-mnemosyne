# Mnemosyne 爱琴海之夜 Dashboard 静态服务（web/app 构建产物 + Caddy 同域反代）
# Zeabur：仓库根上下文引用本文件（deploy-from-specification），构建期完成 vite build。
# 上游 runtime 用环境变量注入：MNEMOSYNE_UPSTREAM=http://mnemosyne.zeabur.internal:8000
# （compose 路线不读本文件——compose 直接用 caddy 挂载 ./web/dist + deploy/compose/Caddyfile。）

FROM node:20-alpine AS build
WORKDIR /build
COPY web/app/package.json web/app/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/app/ ./
# vite outDir=../dist（相对 web/app 根）→ 产物落在 /dist
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /dist /srv/www
COPY deploy/web.Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
