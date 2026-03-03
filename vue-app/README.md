# AI 记账前端（vue-app）

## 项目简介

当前项目是一个基于 Vue 3 + Vite 的前端应用，聚焦 AI 服务配置管理：

- 支持 OpenAI 兼容与 Anthropic 两类 Provider
- 支持模型列表获取、手动添加、当前模型切换
- 支持配置本地持久化与接口连通性测试

## 当前技术栈

### 核心框架与构建

- Vue `3.5.29`
- Vite `7.3.1`
- `@vitejs/plugin-vue` `6.0.4`
- `vite-plugin-vue-devtools` `8.0.6`

### 语言与工程配置

- JavaScript（ES Module）
- Node.js 版本要求：`^20.19.0 || >=22.12.0`
- 路径别名：`@ -> src`（`vite.config.js` + `jsconfig.json`）

### 运行时能力

- 原生 `fetch` + `AbortController`（10s 超时控制）
- `localStorage` 配置持久化
- Vue Composition API（`ref` / `reactive` / `computed` / `watch`）
- CSS 响应式布局（含 `@media (max-width: 768px)`）

## 当前功能清单

1. AI Provider 切换（OpenAI 兼容 / Anthropic）
2. Base URL、Token 配置与本地保存
3. 模型列表拉取、分组展示、批量增删、手动维护
4. 当前模型设置与配置校验
5. 连通性测试（成功/失败信息 + 耗时）

## 项目结构（核心）

```text
vue-app
├── src
│   ├── components
│   │   └── AIConfigPanel.vue
│   ├── services
│   │   ├── aiProviders.js
│   │   └── storage.js
│   ├── App.vue
│   └── main.js
├── index.html
├── vite.config.js
└── package.json
```

## 本地开发

```bash
npm install
npm run dev
```

## 构建产物

```bash
npm run build
npm run preview
```

