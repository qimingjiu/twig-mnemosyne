# Mnemosyne MCP Gateway — 懒连接聚合器；永不接触 DB/ENCRYPTION_KEY（§5.3 铁律）
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_CONFIG_PATH=/app/config.default.json
RUN addgroup -S gw && adduser -S gw -G gw
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config.default.json ./
USER gw
EXPOSE 3000
CMD ["node", "dist/index.js"]
