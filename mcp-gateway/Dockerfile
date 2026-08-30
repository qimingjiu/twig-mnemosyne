# Mnemosyne MCP Gateway — 懒连接聚合器；永不接触 DB/ENCRYPTION_KEY（§5.3 铁律）
# 注意：Zeabur 构建上下文 = 仓库根，COPY 路径须带 mcp-gateway/ 前缀
FROM node:20-alpine AS build
WORKDIR /app
COPY mcp-gateway/package.json mcp-gateway/package-lock.json* ./
RUN npm install --include=dev
COPY mcp-gateway/tsconfig.json ./
COPY mcp-gateway/src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_CONFIG_PATH=/app/config.default.json
RUN addgroup -S gw && adduser -S gw -G gw
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY mcp-gateway/config.default.json ./
USER gw
EXPOSE 3000
CMD ["node", "dist/index.js"]
