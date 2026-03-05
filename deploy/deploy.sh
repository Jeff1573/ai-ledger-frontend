#!/usr/bin/env bash
set -euo pipefail

# 自动定位仓库根目录，便于在任意路径调用。
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 允许通过环境变量覆盖编排文件和环境文件路径。
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/deploy/docker-compose.prod.yml}"
COMPOSE_DEV_FILE="${COMPOSE_DEV_FILE:-${PROJECT_DIR}/deploy/docker-compose.dev.yml}"
ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/deploy/.env}"
# 为 prod/dev 指定独立项目名，避免互相识别为 orphan 容器。
PROD_PROJECT_NAME="${PROD_PROJECT_NAME:-ai-ledger-prod}"
DEV_PROJECT_NAME="${DEV_PROJECT_NAME:-ai-ledger-dev}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[错误] 未找到环境变量文件: ${ENV_FILE}"
  echo "[提示] 请先执行: cp deploy/.env.example deploy/.env"
  exit 1
fi

#
# 函数作用：提取 compose 文件中显式声明的 container_name 列表。
# 参数：
#   $1 - compose 文件路径
#   $2 - compose 项目名（用于解析配置）
# 返回：
#   标准输出每行一个容器名
#
get_compose_container_names() {
  local compose_file="$1"
  local project_name="$2"
  docker compose -p "${project_name}" --env-file "${ENV_FILE}" -f "${compose_file}" config \
    | awk '$1=="container_name:" {print $2}'
}

#
# 函数作用：删除与当前部署冲突的同名容器，避免 up 阶段因名称冲突失败。
# 参数：
#   $1 - compose 文件路径
#   $2 - compose 项目名
# 返回：
#   无返回值；冲突容器会被强制删除
#
remove_conflicting_containers() {
  local compose_file="$1"
  local project_name="$2"
  local container_name
  local existing_project

  while IFS= read -r container_name; do
    [[ -z "${container_name}" ]] && continue

    if ! docker container inspect "${container_name}" >/dev/null 2>&1; then
      continue
    fi

    existing_project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "${container_name}" 2>/dev/null || true)"
    if [[ "${existing_project}" == "${project_name}" ]]; then
      continue
    fi

    echo "[步骤] 检测到容器名冲突: ${container_name} (现属项目: ${existing_project:-unknown})"
    echo "[步骤] 停止并删除冲突容器，避免部署失败"
    docker rm -f "${container_name}" >/dev/null
  done < <(get_compose_container_names "${compose_file}" "${project_name}")
}

# pro
echo "[步骤] 使用编排文件: ${COMPOSE_FILE}"

echo "[步骤] 拉取最新镜像"
docker compose -p "${PROD_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" pull

echo "[步骤] 使用新镜像重建容器"
remove_conflicting_containers "${COMPOSE_FILE}" "${PROD_PROJECT_NAME}"
docker compose -p "${PROD_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --remove-orphans

echo "[步骤] 当前容器状态"
docker compose -p "${PROD_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps


# dev
echo "[dev步骤] 部署"
remove_conflicting_containers "${COMPOSE_DEV_FILE}" "${DEV_PROJECT_NAME}"
docker compose -p "${DEV_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_DEV_FILE}" up -d

echo "[dev步骤] 当前容器状态"
docker compose -p "${DEV_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_DEV_FILE}" ps
