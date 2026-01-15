# Development Notes

## Soxr resampler integration
- Uses `libloading` to load libsoxr at runtime.
- Auto mode prefers Soxr when available and falls back to Rubato if missing or Soxr fails.
- The engine publishes `soxr_available` in state; the UI shows availability and disables the Soxr option when missing.
- Soxr uses the library default quality today; `resampler_quality` currently affects Rubato only.

## Enabling Soxr
1. Place `soxr.dll` (and optional `soxr.lib`, `soxr.h`) in one of:
   - `vmusic/engine/bin`
   - `vmusic/AppData/deps/soxr`
2. Ensure `VMUSIC_SOXR_DIR` or `VMUSIC_ASSET_DIR` points to that folder.
3. Restart the app to reload the engine.

## Build checks
From `vmusic/engine/rust/vmusic_engine`:
- `cargo check`
- `cargo build`
