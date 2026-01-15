# VMusic 独立播放器骨架
## 目录结构
```
vmusic/
  apps/desktop/         Electron UI
  engine/python/        Python 音频引擎
  engine/rust/          Rust DSP（可选）
  tools/               轮子探针与辅助脚本
  docs/                文档
  AppData/             运行期数据
```

## 启动（占位）
1. 安装 `apps/desktop` 的依赖
2. 运行 `npm start`
3. Python 引擎由主进程自动启动（默认端口 55554）

## 端口与路径
- `VMUSIC_ENGINE_URL`：覆盖 UI 访问的引擎地址
- `VMUSIC_ENGINE_PORT`：覆盖引擎启动端口（主进程会传入）
- `VCP_AUDIO_CACHE_DIR`：覆盖重采样缓存目录

## 复用来源
- UI：`D:\AI bot\VCPChat\Musicmodules`
- IPC：`D:\AI bot\VCPChat\modules\ipc\musicHandlers.js`
- 引擎：`D:\AI bot\VCPChat\audio_engine`
- Rust：`D:\AI bot\VCPChat\rust_audio_engine`
