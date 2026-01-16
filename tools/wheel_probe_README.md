# NTmusic Rust wheel 黑盒探针
## 1. 作用
- 黑盒加载 `rust_audio_resampler` wheel，枚举导出并做最小烟雾测试。
- 用于验证 wheel 与 Python 引擎调用约定是否匹配，发现缺失接口或签名异常。

## 2. 运行方式
默认会在常见目录自动寻找 `rust_audio_resampler-*.whl`：
- `NTmusic/packages/audio-core/python/wheels`
- `NTmusic/packages/audio-core/python`
- `D:\AI bot\VCPChat\audio_engine`

常用命令：
```powershell
python D:\\AI bot\\NTmusic\\tools\wheel_probe.py
```

指定 wheel 路径：
```powershell
python D:\\AI bot\\NTmusic\\tools\wheel_probe.py --wheel "D:\AI bot\VCPChat\audio_engine\rust_audio_resampler-0.1.0-cp313-cp313-win_amd64.whl"
```

输出 JSON 到文件：
```powershell
python D:\\AI bot\\NTmusic\\tools\wheel_probe.py --json "D:\\AI bot\\NTmusic\\tools\wheel_probe_report.json"
```

若环境没有 numpy，默认会跳过烟雾测试：
```powershell
python D:\\AI bot\\NTmusic\\tools\wheel_probe.py --no-tests
```

强制要求 numpy（缺失则报告失败）：
```powershell
python D:\\AI bot\\NTmusic\\tools\wheel_probe.py --require-numpy
```

## 3. 输出说明
JSON 结构包含：
- `exports`: wheel 的导出符号
- `tests`: 每个接口的烟雾测试结果
- `error`: 失败原因（若有）

示例字段：
```json
{
  "wheel": "D:\\\\AI bot\\\\VCPChat\\\\audio_engine\\\\rust_audio_resampler-0.1.0-cp313-cp313-win_amd64.whl",
  "exports": ["resample", "apply_noise_shaping_high_order", "apply_iir_sos", "apply_volume_smoothing", "FFTConvolver"],
  "tests": [
    {"name": "resample", "status": "passed", "details": {"output_len": 220, "expected_len": 220}}
  ]
}
```

## 4. 注意事项
- wheel 内含 `.pyd`，不能直接从 zip 导入，脚本会自动解压到临时目录。
- `FFTConvolver` 与 `apply_iir_sos` 的细节仅做黑盒验证，不做强一致性断言。
- 建议把探针作为独立播放器的 CI 检查之一，避免 wheel 升级导致接口漂移。
