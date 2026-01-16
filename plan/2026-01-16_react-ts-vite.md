---
mode: auto
cwd: d:\AI bot\NTmusic
task: NTmusic React + TS + Vite Renderer 迁移
complexity: high
created_at: 2026-01-16
source: NTmusic与NT-A协议开发计划.md
---

# 任务
引入 React + TypeScript + Vite，并建立分层目录结构作为新的 Renderer 骨架。

## ✅ 成功判据
- Vite 构建可产出 renderer-dist 产物。
- Electron 能加载 renderer-dist/index.html。
- Renderer 状态仅从 Store 获取，不直连引擎。
- 旧 UI 保留作为 fallback。

## 📦 变更范围
- 新增 `apps/ntmusic-player/vite.config.ts`
- 新增 `apps/ntmusic-player/tsconfig.json`
- 新增 `apps/ntmusic-player/src/renderer/**`
- 修改 `apps/ntmusic-player/src/main.js`
- 修改 `apps/ntmusic-player/src/ipc/musicHandlers.js`
- 修改 `apps/ntmusic-player/package.json`

## 🧭 执行计划
1. 添加 Vite/React/TS 构建链路与脚本。
2. 建立 renderer 目录层次与最小可运行骨架。
3. Main 侧加载 dev server 或 renderer-dist。
4. 保留旧 UI 文件作为 fallback。

## 🔍 验证方式
- `apps/ntmusic-player`: `npm run build:renderer`

## ⚠️ 风险与备选
- 构建链路失效：保留旧 UI 入口。
- 事件未接入：Store 接口作为单一真相源后逐步迁移。

