# syntax=docker/dockerfile:1.7

# 运行时基座：统一使用 Node 22 LTS，避免本地与 CI 环境差异。
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# 依赖层：仅安装生产依赖，减小镜像体积。
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev

# 运行层：仅拷贝运行所需文件。
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

EXPOSE 3000
CMD ["node", "src/server.js"]
