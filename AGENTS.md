# Repository Guidelines

## 项目结构与模块组织

仓库采用前后端分离结构：`ai-ledger-frontend/` 为 Vue 3 + Quasar 前端，`ai-ledger-server/` 为 Express + PostgreSQL 后端。  
前端核心代码在 `ai-ledger-frontend/src`：`components/` 放页面组件，`services/` 放数据与业务逻辑，`assets/` 放样式资源。  
后端核心代码在 `ai-ledger-server/src`：`routes/` 定义接口，`db/` 包含连接池与迁移（`migrations/`），`auth/` 与 `middleware/` 处理认证。  
测试与实现同仓：前后端均使用 `__tests__/` 目录并紧邻被测模块。

## 构建、测试与开发命令

建议在仓库根目录执行（使用 `--prefix` 指定子项目）：

- `npm --prefix ai-ledger-frontend install`：安装前端依赖  
- `npm --prefix ai-ledger-frontend run build`：构建前端产物  
- `npm --prefix ai-ledger-frontend run test`：运行前端 Vitest  
- `npm --prefix ai-ledger-server install`：安装后端依赖  
- `npm --prefix ai-ledger-server run migrate`：执行数据库迁移  
- `npm --prefix ai-ledger-server run test`：运行后端 Vitest  
- `docker compose -f ai-ledger-server/docker-compose.yaml up -d postgres`：启动本地 PostgreSQL

## 编码风格与命名规范

统一使用 ES Module、2 空格缩进、单引号、无分号风格。  
文件命名遵循职责导向：Vue 组件使用 `PascalCase.vue`（如 `AuthPanel.vue`），服务与工具使用 `camelCase.js`（如 `tabSyncPolicy.js`）。  
新增公共函数需补充简体中文 JSDoc；复杂逻辑补充简短中文注释，避免无意义注释。

## 测试规范

测试框架为 Vitest（前后端一致）。测试文件命名为 `*.test.js`，放在对应模块旁的 `__tests__/` 中。  
每次改动至少覆盖：1 个主路径用例 + 1 个边界/异常用例。涉及存储、同步、时间逻辑时，优先使用固定时间戳与可重复夹具。  
提交前必须执行受影响子项目的 `npm run test`，单次测试应控制在 60s 内。

## 提交与 Pull Request 规范

提交信息遵循“简短动词短语 + 明确变更点”，以中文为主，可混合必要英文术语（示例：`新增账号与云同步`、`add server`）。  
单次提交只做一类改动（功能、重构、测试分开）。  
PR 至少包含：变更范围、数据库/环境变量影响、已执行测试命令；若改动前端交互，附截图或录屏并关联 Issue。

## 安全与配置提示

严禁提交密钥、Token、`DATABASE_URL`、`bootstrap-credentials.txt` 等敏感信息。  
非本地环境必须设置 `SESSION_SECRET`，上线前先执行迁移并确认数据库连接策略（如 `DATABASE_USE_SSL`）与目标环境一致。
