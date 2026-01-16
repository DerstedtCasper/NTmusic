# Rust 音频重采样模块

该模块为 VCPChat 的 Python 音频引擎提供高性能的音频重采样功能。

## 构建说明

本项目使用 `maturin` 进行构建。

### 关键编译问题记录

在开发过程中，我们遇到了针对 **Python 3.13** 的编译问题。`PyO3 v0.21.2` 的构建脚本会报错，提示其最高仅支持到 Python 3.12。

**解决方案**是，在编译时设置一个特定的环境变量 `PYO3_USE_ABI3_FORWARD_COMPATIBILITY`，以强制 `PyO3` 使用稳定的 ABI 进行前向兼容构建。

### 最终编译命令 (PowerShell)

在 **PowerShell** 终端中，使用以下命令来构建 wheel 安装包：

```powershell
$env:PYO3_USE_ABI3_FORWARD_COMPATIBILITY="1"; maturin build --release
```

**注意**: 必须使用分号 `;` 将设置环境变量和执行 `maturin` 命令放在同一行，以确保环境变量能够被 `maturin` 进程继承。

构建成功后，wheel 文件会生成在 `target/wheels/` 目录下。

安装指令
pip install target\wheels\rust_audio_resampler-0.1.0-cp313-cp313-win_amd64.whl