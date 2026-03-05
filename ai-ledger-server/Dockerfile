# syntax=docker/dockerfile:1.7

# 前端构建层：产出 Vite 静态资源 dist。
FROM node:22-alpine AS frontend-build
WORKDIR /app/ai-ledger-frontend
COPY ai-ledger-frontend/package*.json ./
RUN npm ci
COPY ai-ledger-frontend/ ./

# 云 API 默认仍走同域 `/api`，保持客户端请求路径不变。
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

# 后端依赖层：仅安装后端生产依赖。
FROM node:22-alpine AS server-deps
WORKDIR /app/ai-ledger-server
COPY ai-ledger-server/package*.json ./
RUN npm ci --omit=dev

# 运行层：合并后端源码与前端 dist，形成单镜像部署单元。
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=server-deps /app/ai-ledger-server/node_modules ./node_modules
COPY ai-ledger-server/package*.json ./
COPY ai-ledger-server/src ./src
COPY --from=frontend-build /app/ai-ledger-frontend/dist ./public

EXPOSE 3000
CMD ["node", "src/server.js"]
