---
mode: auto
cwd: d:\AI bot\NTmusic
task: NTmusic Engine Gateway + Store 迁移
complexity: medium
created_at: 2026-01-16
source: NTmusic与NT-A协议开发计划.md
---

# 任务
建立 Main 侧网关与事件 schema，Renderer 改为单一 Store 消费状态并去掉直连 WS。

## ✅ 成功判据
- Renderer 不再直接连接引擎 WS。
- Main 侧统一接收 WS 事件并转发到 Renderer。
- 事件 schema 有运行时校验（zod）。
- Renderer UI 状态只从 Store 读取。
- 断线自动重连且有状态事件。

## 📦 变更范围
- 新增 `apps/ntmusic-player/src/main/engineGateway.js`
- 新增 `apps/ntmusic-player/src/main/ipc.js`
- 新增 `apps/ntmusic-player/src/shared/events.js`
- 新增 `apps/ntmusic-player/src/ui/store.js`
- 修改 `apps/ntmusic-player/src/main.js`
- 修改 `apps/ntmusic-player/src/preload.js`
- 修改 `apps/ntmusic-player/src/ui/music.js`
- 修改 `apps/ntmusic-player/src/ui/music.html`
- 修改 `apps/ntmusic-player/package.json`

## 🧭 执行计划
1. Main 建立 EngineGateway（WS 连接 + 事件转发 + 重连节流）。
2. 定义事件 schema 并在 Main 解析/规范化。
3. Renderer 添加 Store 并订阅 Engine 事件。
4. Renderer 去除直连 WS，改走 IPC 网关。
5. 统一命令入口（engineCmd）接入网关。

## 🔍 验证方式
- `apps/ntmusic-player`: `npm run pack`

## ⚠️ 风险与备选
- WS 事件频率过高导致 UI 抖动：Main 侧节流。
- Engine 不可用：自动重连 + fallback 事件。

