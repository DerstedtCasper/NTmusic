# VMusic 独立播放器骨架（Rust 引擎）
## 目录结构
```
vmusic/
  apps/desktop/         Electron UI
  engine/rust/          Rust 引擎源码
  engine/bin/           Rust 引擎 exe + ffmpeg.exe
  tools/               轮子探针与辅助脚本
  docs/                文档
  AppData/             运行期数据
```

## 启动（占位）
1. 安装 `apps/desktop` 的依赖
2. 构建 `engine/rust/vmusic_engine`
3. 运行 `npm start`（主进程自动启动 Rust 引擎）

## 端口与路径
- `VMUSIC_ENGINE_URL`：覆盖 UI 访问的引擎地址
- `VMUSIC_ENGINE_PORT`：覆盖引擎启动端口（主进程会传入）
- `VMUSIC_ASSET_DIR`：`ffmpeg.exe` 所在目录

## 复用来源
- UI：`D:\AI bot\VCPChat\Musicmodules`
- IPC：`D:\AI bot\VCPChat\modules\ipc\musicHandlers.js`
- 引擎参考：`D:\AI bot\VCPChat\audio_engine`
- Rust 参考：`D:\AI bot\VCPChat\rust_audio_engine`
