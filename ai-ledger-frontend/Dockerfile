# syntax=docker/dockerfile:1.7

# 构建层：编译前端静态资源。
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# 云 API 默认走同域 `/api`，可在构建时覆盖。
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

# 运行层：使用 Nginx 托管静态资源并转发 `/api`。
FROM nginx:1.27-alpine AS runtime
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
