# NTmusic

NTmusic 是一个基于 Rust 引擎的独立音频播放器项目，源自 VCPChat 的设计启发进行的开发。利用纯Rust引擎和配套的自有音频解码协议获得极低的音频延迟,在音质上做到最接近原生采样的效果。

## 设计目标
- **Rust-only 引擎**：运行时不依赖 Python，提升稳定性与性能上限。
- **前后端解耦**：统一 HTTP/WS 协议，UI 与引擎独立演进。
- **音质优先**：重采样与 DSP 可持续补齐与升级（EQ/噪声整形等）。
- **多输入模式**：本地文件为主，预留流媒体与系统捕获扩展。
- **Windows 优先**：先保障 Windows 体验，再推进跨平台。

## 项目概览
- **apps/desktop**：Electron UI（播放器界面与交互）。
- **engine/rust/vmusic_engine**：Rust 音频引擎（HTTP + WS）。
- **engine/bin**：运行时依赖（如 `ffmpeg.exe`、`soxr` 等）。
- **AppData**：播放列表、封面、歌词等运行数据（不入库）。

## 下载与运行
- **便携版**：到 GitHub Releases 下载 `NTmusic-0.1.0-win.zip`，解压后直接运行根目录 `NTmusic.exe`。
- **安装版**：到 GitHub Releases 下载 `NTmusic Setup 0.1.0.exe`，安装后从开始菜单启动。
- **注意**：仓库页面的 “Code → Download ZIP” 是源码包，不包含可执行程序。

## 开发定位
这个仓库是“播放器骨架 + 高性能引擎”的独立形态，不追求与旧版 100% 功能一致；优先保证结构清晰、可扩展和工程可维护。
