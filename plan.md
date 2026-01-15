# NTmusic 总体计划（NT-A 版本）

> 依据：`NTmusic与NT-A协议开发计划.md` + 现有仓库落地现状
> 更新时间：2026-01-15

---

## 0. 任务说明（可复述）
**目标**：在 NTmusic 现有 Rust 引擎 + Electron UI 基础上，升级为面向 NT-A 协议的下一代音频架构，并优先产出“可安装的前端 exe 雏形”。

**非目标**：当前阶段不做完整 DSP 对齐、ASIO/DoP/进程环回全实现，只做架构落地与基础能力可运行。

**边界**：
- 主平台：Windows
- 引擎语言：Rust
- UI：Electron
- 运行时：不依赖 Python

**验收标准（当前阶段）**：
1) 前端 exe 可打包生成并能启动 UI
2) 引擎可启动并返回基础状态接口（/state）
3) UI 与引擎通信链路可跑通（至少状态轮询/基础播放）

**风险与备选**：
- NAPI-RS / SharedArrayBuffer 未落地 → 先保留 HTTP/WS 方案
- ASIO/DSD 支持复杂 → 先 WASAPI Shared/Exclusive
- 频谱共享内存未完成 → 先 WS 推送数据

---

## 1. NT-A 目标架构（宏观）

### 1.1 分层模型
- **Control Plane**：Electron UI + NAPI-RS（指令/状态）
- **Data Plane**：SharedArrayBuffer / RingBuffer（音频/频谱零拷贝）
- **Engine Core**：Rust 音频线程（解码/重采样/DSP/输出）

### 1.2 核心设计原则
- **零拷贝**：避免 JSON/Base64 序列化
- **高精度**：内部 f64 处理链
- **可扩展输出**：WASAPI / ASIO / WaveOut / DirectSound
- **多源输入**：文件 / URL 流 / 进程环回

---

## 2. 当前可执行落地架构（现实路径）
- **UI ↔ 引擎通信**：先采用 HTTP/WS（已存在）
- **频谱**：WS 推送（已存在）
- **重采样**：rubato + 可选 soxr（已存在）
- **输出**：cpal/WASAPI（已存在）

> 备注：NT-A 的 NAPI-RS + SharedArrayBuffer 是下一阶段硬目标。

---

## 3. 关键技术路线（来自 NT-A 计划）

### 3.1 解码与格式
- Symphonia 深度集成（FLAC/WAV/MP3/AAC/OGG/ALAC）
- Gapless 播放
- DSD：Native DSD / DoP（后续）

### 3.2 重采样
- rubato 作为基线
- soxr 动态加载作为高质量档位

### 3.3 DSP
- f64 内部链路
- TPDF dither / 噪声整形 / EQ / FIR（后续）

### 3.4 输出后端
- WASAPI Shared/Exclusive（优先）
- ASIO / WaveOut / DirectSound（后续）

### 3.5 数据层
- 元数据：Lofty
- 媒体库：Redb

---

## 4. 执行计划（Phase）

### Phase 0：前端 exe 雏形（当前优先）
**产出**：Electron exe 可打包、可启动 UI
- 安装 Node 依赖
- electron-builder 打包
- 附带引擎资源（engine/bin）

**DoD**：dist 目录生成 exe + 启动无崩溃

---

### Phase 1：Rust 引擎基线可运行
**产出**：引擎可启动并返回 /state
- cargo build --release
- 引擎启动输出 VMUSIC_ENGINE_READY

**DoD**：/state 返回正常状态 JSON

---

### Phase 2：UI/IPC 独立化
**产出**：UI 与引擎通信稳定
- 主进程启动引擎
- UI 轮询/WS 连接

**DoD**：UI 可获取状态并显示

---

### Phase 3：NT-A 通信改造（NAPI + Shared Memory）
**产出**：零拷贝频谱/指令通道原型

**DoD**：SharedArrayBuffer 读取频谱，无 WS

---

### Phase 4：DSP / 输出 / 进程环回
**产出**：高音质链路与高级输入

---

## 5. 当前阶段的验证方式
- `engine/rust/vmusic_engine`：`cargo build --release`
- `apps/desktop`：`npm install` → `npm run dist`
- 运行 exe 验证启动

---

## 6. 风险与备选
- NAPI-RS 编译复杂 → 先保持 HTTP/WS
- soxr 缺失 → 回退 rubato
- 引擎未就绪 → UI 启动提示

---

## 7. 里程碑说明
- **短期**：exe 雏形 + 引擎可运行
- **中期**：NT-A 协议落地（NAPI + 共享内存）
- **长期**：DSD/ASIO/进程环回 + DSP 对齐
