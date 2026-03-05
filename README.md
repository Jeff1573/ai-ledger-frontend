# AI 记账 - 服务端部署与账号查看

本文档用于快速完成服务端部署，并在部署后查看默认账号与账号列表。

## 1. 部署方式（生产环境，Docker Compose）

### 1.1 前置条件

- 服务器已安装 Docker 与 Docker Compose
- 可访问镜像仓库（默认 `ghcr.io`）
- 已获取本仓库代码

### 1.2 配置环境变量

在仓库根目录执行：

```bash
cp deploy/.env.example deploy/.env
```

然后编辑 `deploy/.env`，至少确认以下字段：

- `IMAGE_NAMESPACE`：你的 GitHub 用户名或组织名（小写）
- `IMAGE_TAG`：镜像标签（如 `latest` 或版本号）
- `POSTGRES_PASSWORD`：数据库强密码
- `SESSION_SECRET`：服务端会话密钥（长随机字符串）
- `HTTP_PORT`：对外端口（默认 `80`）

### 1.3 一键部署

在仓库根目录执行：

```bash
bash deploy/deploy.sh
```

该脚本会依次执行：

1. 拉取最新镜像
2. 重建并启动容器
3. 输出容器状态

### 1.4 健康检查

```bash
curl -f http://127.0.0.1:${HTTP_PORT:-80}/api/health
```

返回 `200` 表示服务可用。

## 2. 查看默认账号（首次空库启动）

首次启动且数据库中无用户时，服务会自动生成默认账号，并写入：

`/app/data/bootstrap-credentials.txt`

查看命令：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml exec ai-ledger-server sh -lc 'cat /app/data/bootstrap-credentials.txt'
```

文件中包含：

- `username=...`
- `password=...`

说明：

- 该文件使用“已存在不覆盖”策略，避免后续重启覆盖首次凭据
- 如果文件不存在，通常表示库中已有账号，未触发“首次空库初始化”

## 3. 查看当前有哪些账号

执行以下命令查询 `app_users` 表：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select id, username, created_at, updated_at from public.app_users order by created_at desc;"'
```

## 4. 操作流程（ASCII）

```text
[准备 deploy/.env]
        |
        v
[执行 deploy/deploy.sh]
        |
        v
[服务启动 + 健康检查]
        |
        v
[查看默认账号文件]
        |
        v
[SQL 查询全部账号]
```
