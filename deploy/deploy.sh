#!/usr/bin/env bash
set -euo pipefail

# 自动定位仓库根目录，便于在任意路径调用。
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 允许通过环境变量覆盖编排文件和环境文件路径。
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/deploy/docker-compose.prod.yml}"
COMPOSE_DEV_FILE="${COMPOSE_DEV_FILE:-${PROJECT_DIR}/deploy/docker-compose.dev.yml}"
ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/deploy/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[错误] 未找到环境变量文件: ${ENV_FILE}"
  echo "[提示] 请先执行: cp deploy/.env.example deploy/.env"
  exit 1
fi

# pro
echo "[步骤] 使用编排文件: ${COMPOSE_FILE}"

echo "[步骤] 拉取最新镜像"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" pull

echo "[步骤] 使用新镜像重建容器"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --remove-orphans

echo "[步骤] 当前容器状态"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps


# dev
echo "[dev步骤] 卸载"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_DEV_FILE}" down

echo "[dev步骤] 部署"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_DEV_FILE}" up

echo "[dev步骤] 当前容器状态"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_DEV_FILE}" ps
