import argparse
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


def locate_wheel(explicit_path):
    if explicit_path:
        path = Path(explicit_path)
        if path.exists():
            return path
        return None

    env_path = os.environ.get("VMUSIC_WHEEL_PATH")
    if env_path:
        path = Path(env_path)
        if path.exists():
            return path

    script_root = Path(__file__).resolve().parents[1]
    candidates = [
        script_root / "engine" / "python" / "wheels",
        script_root / "engine" / "python",
        script_root / "wheels",
        Path.cwd(),
        script_root.parent / "VCPChat" / "audio_engine",
    ]
    def pick_wheel(matches):
        if not matches:
            return None
        platform = sys.platform
        preferred_tags = []
        if platform.startswith("win"):
            preferred_tags = ["win_amd64", "win32"]
        elif platform == "darwin":
            preferred_tags = ["macosx_11_0_arm64", "macosx_10_9_x86_64", "macosx"]
        else:
            preferred_tags = ["manylinux", "linux"]

        for tag in preferred_tags:
            for match in matches:
                if tag in match.name:
                    return match
        return matches[0]

    for folder in candidates:
        if not folder.exists():
            continue
        matches = list(folder.glob("rust_audio_resampler-*.whl"))
        picked = pick_wheel(matches)
        if picked:
            return picked

    return None


def extract_wheel(wheel_path, extract_dir, keep):
    if extract_dir:
        out_dir = Path(extract_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        target_dir = out_dir
    else:
        target_dir = Path(tempfile.mkdtemp(prefix="vmusic_wheel_"))

    with zipfile.ZipFile(wheel_path, "r") as zf:
        zf.extractall(target_dir)

    return target_dir


def try_import_numpy():
    try:
        import numpy as np  # noqa: F401
    except Exception as exc:
        return None, str(exc)
    return np, None


def collect_exports(module):
    if hasattr(module, "__all__"):
        return list(module.__all__)
    return [name for name in dir(module) if not name.startswith("_")]


def smoke_test_resample(module, np):
    result = {"name": "resample", "status": "skipped"}
    if not hasattr(module, "resample"):
        result["status"] = "missing"
        return result

    frames = 2048
    channels = 2
    original_sr = 48000
    target_sr = 44100
    signal = np.linspace(-1.0, 1.0, frames * channels, dtype=np.float64)

    try:
        out = module.resample(signal, original_sr, target_sr, channels, quality="hq")
        if not hasattr(out, "__len__"):
            result["status"] = "failed"
            result["error"] = "output has no length"
            return result

        out_len = len(out)
        expected_frames = int(round(frames * (target_sr / original_sr)))
        expected_len = expected_frames * channels
        ratio = out_len / expected_len if expected_len else None
        result["status"] = "passed"
        result["details"] = {
            "input_len": int(len(signal)),
            "output_len": int(out_len),
            "expected_len": int(expected_len),
            "channels": channels,
            "ratio": ratio,
        }
        if expected_len and (out_len < expected_len * 0.5 or out_len > expected_len * 1.5):
            result["status"] = "warning"
            result["warning"] = "output length outside expected tolerance"
        return result
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        return result


def smoke_test_volume_smoothing(module, np):
    result = {"name": "apply_volume_smoothing", "status": "skipped"}
    if not hasattr(module, "apply_volume_smoothing"):
        result["status"] = "missing"
        return result

    frames = 64
    channels = 2
    signal = np.ones(frames * channels, dtype=np.float64) * 0.5
    current = 0.0
    target = 1.0

    try:
        out, next_value = module.apply_volume_smoothing(
            signal, current, target, smoothing=0.5, channels=channels
        )
        result["status"] = "passed"
        result["details"] = {
            "output_len": int(len(out)),
            "next_value": float(next_value),
        }
        return result
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        return result


def smoke_test_iir_sos(module, np):
    result = {"name": "apply_iir_sos", "status": "skipped"}
    if not hasattr(module, "apply_iir_sos"):
        result["status"] = "missing"
        return result

    frames = 64
    channels = 2
    signal = np.linspace(-0.5, 0.5, frames * channels, dtype=np.float64)
    sos = np.array([[1.0, 0.0, 0.0, 1.0, 0.0, 0.0]], dtype=np.float64)
    flat_zi = np.zeros(channels * sos.shape[0] * 2, dtype=np.float64)

    try:
        out, next_zi = module.apply_iir_sos(signal, sos.flatten(), flat_zi, channels=channels)
        result["status"] = "passed"
        result["details"] = {
            "output_len": int(len(out)),
            "zi_len": int(len(next_zi)),
        }
        if not np.allclose(out, signal, atol=1e-9):
            result["status"] = "warning"
            result["warning"] = "identity SOS output deviates from input"
        return result
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        return result


def smoke_test_noise_shaping(module, np):
    result = {"name": "apply_noise_shaping_high_order", "status": "skipped"}
    if not hasattr(module, "apply_noise_shaping_high_order"):
        result["status"] = "missing"
        return result

    frames = 64
    channels = 2
    signal = np.zeros(frames * channels, dtype=np.float64)
    state = np.zeros(channels * 5, dtype=np.float64)

    try:
        out, next_state = module.apply_noise_shaping_high_order(
            signal, state, sample_rate=48000, bits=24, channels=channels
        )
        result["status"] = "passed"
        result["details"] = {
            "output_len": int(len(out)),
            "state_len": int(len(next_state)),
        }
        return result
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        return result


def smoke_test_fft_convolver(module, np):
    result = {"name": "FFTConvolver", "status": "skipped"}
    if not hasattr(module, "FFTConvolver"):
        result["status"] = "missing"
        return result

    frames = 128
    channels = 2
    signal = np.linspace(-0.25, 0.25, frames * channels, dtype=np.float64)
    ir = np.array([1.0], dtype=np.float64)
    full_ir = np.tile(ir[:, np.newaxis], (1, channels)).flatten()

    try:
        convolver = module.FFTConvolver(full_ir, channels)
        out = convolver.process(signal)
        result["status"] = "passed"
        result["details"] = {"output_len": int(len(out))}
        return result
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        return result


def run_smoke_tests(module, np):
    return [
        smoke_test_resample(module, np),
        smoke_test_noise_shaping(module, np),
        smoke_test_iir_sos(module, np),
        smoke_test_volume_smoothing(module, np),
        smoke_test_fft_convolver(module, np),
    ]


def parse_args():
    parser = argparse.ArgumentParser(description="VMusic Rust wheel black-box probe")
    parser.add_argument("--wheel", help="wheel path for rust_audio_resampler")
    parser.add_argument("--extract-dir", help="optional extract directory")
    parser.add_argument("--keep", action="store_true", help="keep extracted files")
    parser.add_argument("--no-tests", action="store_true", help="skip smoke tests")
    parser.add_argument(
        "--require-numpy",
        action="store_true",
        help="fail if numpy is unavailable for smoke tests",
    )
    parser.add_argument(
        "--json",
        dest="json_path",
        help="write JSON report to file",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    wheel_path = locate_wheel(args.wheel)
    if not wheel_path:
        print("Wheel not found. Use --wheel or set VMUSIC_WHEEL_PATH.")
        return 2

    extract_dir = None
    if args.extract_dir:
        extract_dir = Path(args.extract_dir)

    work_dir = extract_wheel(wheel_path, extract_dir, args.keep)
    sys.path.insert(0, str(work_dir))

    report = {
        "wheel": str(wheel_path),
        "extract_dir": str(work_dir),
        "exports": [],
        "tests": [],
    }

    try:
        import rust_audio_resampler as module
    except Exception as exc:
        report["error"] = f"import failed: {exc}"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if not args.keep and not args.extract_dir:
            shutil.rmtree(work_dir, ignore_errors=True)
        return 3

    report["exports"] = collect_exports(module)

    if not args.no_tests:
        np, np_err = try_import_numpy()
        if np is None:
            if args.require_numpy:
                report["tests"] = [{"name": "numpy", "status": "failed", "error": np_err}]
            else:
                report["tests"] = [{"name": "numpy", "status": "skipped", "error": np_err}]
        else:
            report["tests"] = run_smoke_tests(module, np)

    output = json.dumps(report, ensure_ascii=False, indent=2)
    print(output)

    if args.json_path:
        Path(args.json_path).write_text(output, encoding="utf-8")

    if not args.keep and not args.extract_dir:
        shutil.rmtree(work_dir, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
