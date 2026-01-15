use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{State, WebSocketUpgrade},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use axum::extract::ws::{Message, WebSocket};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use libloading::Library;
use memmap2::MmapMut;
use ringbuf::{HeapCons, HeapProd, HeapRb};
use ringbuf::traits::{Consumer, Producer, Split};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::CStr,
    fs::{File, OpenOptions},
    io::Read,
    os::raw::{c_char, c_void},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer},
    codecs::DecoderOptions,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};
use tokio::sync::broadcast;
use tracing::{error, info};

#[derive(Clone)]
struct SharedState {
    inner: Arc<Mutex<EngineState>>,
    tx: broadcast::Sender<String>,
    producer: Arc<Mutex<HeapProd<f32>>>,
    consumer: Arc<Mutex<HeapCons<f32>>>,
    output_stream: Arc<Mutex<OutputStreamHolder>>,
    stream_process: Arc<Mutex<Option<Child>>>,
    stream_thread: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
    spectrum_shared: Option<Arc<Mutex<SpectrumShared>>>,
    spectrum_bins: usize,
}

struct OutputStreamHolder(Option<cpal::Stream>);

// cpal::Stream is !Send/Sync on some platforms; we guard access via a mutex.
unsafe impl Send for OutputStreamHolder {}
unsafe impl Sync for OutputStreamHolder {}

struct SpectrumShared {
    mmap: MmapMut,
    bins: usize,
}

const DEFAULT_SPECTRUM_BINS: usize = 48;
const SPECTRUM_FFT_SIZE: usize = 2048;
const SPECTRUM_UPDATE_INTERVAL_MS: u64 = 50;

struct SpectrumAnalyzer {
    fft_size: usize,
    bins: usize,
    window: Vec<f32>,
    input: Vec<Complex<f32>>,
    output: Vec<f32>,
    fft: Arc<dyn Fft<f32>>,
}

impl SpectrumAnalyzer {
    fn new(fft_size: usize, bins: usize) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);
        let mut window = Vec::with_capacity(fft_size);
        for i in 0..fft_size {
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / fft_size as f32).cos();
            window.push(w);
        }
        SpectrumAnalyzer {
            fft_size,
            bins,
            window,
            input: vec![Complex::new(0.0, 0.0); fft_size],
            output: vec![0.0; bins.max(1)],
            fft,
        }
    }

    fn compute(&mut self, samples: &[f32], sample_rate: u32) -> &[f32] {
        let output_len = self.output.len();
        if output_len == 0 {
            return &self.output;
        }
        self.output.fill(0.0);
        if samples.is_empty() || sample_rate == 0 {
            return &self.output;
        }

        let len = samples.len().min(self.fft_size);
        for i in 0..len {
            self.input[i].re = samples[i] * self.window[i];
            self.input[i].im = 0.0;
        }
        if len < self.fft_size {
            for i in len..self.fft_size {
                self.input[i].re = 0.0;
                self.input[i].im = 0.0;
            }
        }

        self.fft.process(&mut self.input);

        let min_freq = 20.0f32;
        let max_freq = (sample_rate as f32) / 2.0;
        if max_freq <= min_freq {
            return &self.output;
        }
        let log_min = min_freq.log10();
        let log_max = max_freq.log10();
        let denom = (log_max - log_min).max(1e-6);
        let mags_len = (self.fft_size / 2).saturating_sub(1);
        if mags_len == 0 {
            return &self.output;
        }
        for i in 0..mags_len {
            let mag = self.input[i + 1].norm();
            let freq = (i as f32 / mags_len as f32) * max_freq;
            let log_pos = ((freq.max(min_freq).log10() - log_min) / denom) * self.bins as f32;
            let idx = log_pos.floor() as usize;
            if idx < self.bins {
                self.output[idx] = self.output[idx].max(mag);
            }
        }
        for v in self.output.iter_mut() {
            let db = 20.0f32 * (*v + 1e-9f32).log10();
            let norm = ((db + 90.0f32) / 90.0f32).clamp(0.0f32, 1.0f32);
            *v = norm;
        }
        &self.output
    }
}

#[derive(Debug, Clone, Serialize)]
struct PlaybackState {
    is_playing: bool,
    is_paused: bool,
    duration: f64,
    current_time: f64,
    file_path: Option<String>,
    volume: f32,
    device_id: Option<usize>,
    exclusive_mode: bool,
    eq_type: String,
    dither_enabled: bool,
    dither_type: String,
    dither_bits: u32,
    replaygain_enabled: bool,
    resampler_mode: String,
    resampler_quality: String,
    soxr_available: bool,
    eq_enabled: bool,
    eq_bands: HashMap<String, f32>,
    target_samplerate: Option<u32>,
    mode: String,
    stream_status: String,
    buffered_ms: f64,
    underruns: u64,
}

#[derive(Debug, Clone)]
struct EngineState {
    is_playing: bool,
    is_paused: bool,
    mode: String,
    file_path: Option<String>,
    data: Vec<f32>,
    channels: usize,
    sample_rate: u32,
    position: usize,
    played_frames: u64,
    duration: f64,
    volume: f32,
    device_id: Option<usize>,
    exclusive_mode: bool,
    eq_enabled: bool,
    eq_type: String,
    eq_bands: HashMap<String, f32>,
    dither_enabled: bool,
    dither_type: String,
    dither_bits: u32,
    replaygain_enabled: bool,
    resampler_mode: String,
    resampler_quality: String,
    soxr_available: bool,
    target_samplerate: Option<u32>,
    stream_url: Option<String>,
    stream_status: String,
    stream_error: Option<String>,
    buffered_frames: usize,
    buffer_target_ms: u32,
    buffer_max_ms: u32,
    underrun_count: u64,
    last_output_chunk: Vec<f32>,
    dither_rng: u64,
}

#[derive(Deserialize)]
struct LoadRequest {
    path: String,
}

#[derive(Deserialize)]
struct StreamRequest {
    url: String,
}

#[derive(Deserialize)]
struct SeekRequest {
    position: f64,
}

#[derive(Deserialize)]
struct VolumeRequest {
    volume: f32,
}

#[derive(Deserialize)]
struct ConfigureOutputRequest {
    device_id: Option<usize>,
    exclusive: Option<bool>,
}

#[derive(Deserialize)]
struct ConfigureUpsamplingRequest {
    target_samplerate: Option<u32>,
}

#[derive(Deserialize)]
struct EqRequest {
    bands: Option<HashMap<String, f32>>,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
struct EqTypeRequest {
    r#type: String,
}

#[derive(Deserialize)]
struct OptimizeRequest {
    dither_enabled: Option<bool>,
    dither_type: Option<String>,
    dither_bits: Option<u32>,
    replaygain_enabled: Option<bool>,
    resampler_mode: Option<String>,
    resampler_quality: Option<String>,
}

#[derive(Deserialize)]
struct CaptureStartRequest {
    device_id: Option<String>,
    samplerate: Option<u32>,
    channels: Option<u16>,
}

fn default_eq_bands() -> HashMap<String, f32> {
    let mut map = HashMap::new();
    for band in ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"] {
        map.insert(band.to_string(), 0.0);
    }
    map
}

fn initial_dither_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x1234_5678_9abc_def0)
}

fn parse_spectrum_bins() -> usize {
    std::env::var("NTMUSIC_SPECTRUM_BINS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_SPECTRUM_BINS)
}

fn init_spectrum_shared(bins: usize) -> Option<Arc<Mutex<SpectrumShared>>> {
    let path = match std::env::var("NTMUSIC_SPECTRUM_SHM") {
        Ok(value) if !value.is_empty() => value,
        _ => return None,
    };
    let byte_len = bins.saturating_mul(std::mem::size_of::<f32>());
    let file = match OpenOptions::new().read(true).write(true).create(true).open(&path) {
        Ok(file) => file,
        Err(err) => {
            error!("spectrum shm open failed: {}", err);
            return None;
        }
    };
    if let Err(err) = file.set_len(byte_len as u64) {
        error!("spectrum shm resize failed: {}", err);
        return None;
    }
    let mmap = unsafe {
        match MmapMut::map_mut(&file) {
            Ok(map) => map,
            Err(err) => {
                error!("spectrum shm map failed: {}", err);
                return None;
            }
        }
    };
    Some(Arc::new(Mutex::new(SpectrumShared { mmap, bins })))
}

fn write_spectrum_shared(shared: &Option<Arc<Mutex<SpectrumShared>>>, spectrum: &[f32]) {
    let Some(shared) = shared else {
        return;
    };
    let mut guard = match shared.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let available_bins = guard.mmap.len() / std::mem::size_of::<f32>();
    let bins = guard.bins.min(available_bins);
    if bins == 0 {
        return;
    }
    let len = bins.min(spectrum.len());
    let dst = unsafe {
        std::slice::from_raw_parts_mut(guard.mmap.as_mut_ptr() as *mut f32, bins)
    };
    if len > 0 {
        dst[..len].copy_from_slice(&spectrum[..len]);
    }
    if len < bins {
        for value in &mut dst[len..] {
            *value = 0.0;
        }
    }
}

type SoxrHandle = *mut c_void;
type SoxrError = *const c_char;
type SoxrCreateFn = unsafe extern "C" fn(
    f64,
    f64,
    u32,
    *mut SoxrError,
    *const c_void,
    *const c_void,
    *const c_void,
) -> SoxrHandle;
type SoxrProcessFn = unsafe extern "C" fn(
    SoxrHandle,
    *const c_void,
    usize,
    *mut usize,
    *mut c_void,
    usize,
    *mut usize,
) -> SoxrError;
type SoxrDeleteFn = unsafe extern "C" fn(SoxrHandle);

struct SoxrLibrary {
    _lib: Library,
    create: SoxrCreateFn,
    process: SoxrProcessFn,
    delete: SoxrDeleteFn,
}

impl SoxrLibrary {
    unsafe fn load(path: &Path) -> Result<Self> {
        let lib = Library::new(path).context("load soxr library")?;
        let create = *lib
            .get::<SoxrCreateFn>(b"soxr_create\0")
            .context("load soxr_create")?;
        let process = *lib
            .get::<SoxrProcessFn>(b"soxr_process\0")
            .context("load soxr_process")?;
        let delete = *lib
            .get::<SoxrDeleteFn>(b"soxr_delete\0")
            .context("load soxr_delete")?;
        Ok(SoxrLibrary {
            _lib: lib,
            create,
            process,
            delete,
        })
    }
}

struct SoxrInstance {
    handle: SoxrHandle,
    lib: Arc<SoxrLibrary>,
}

impl SoxrInstance {
    fn new(lib: Arc<SoxrLibrary>, in_rate: u32, out_rate: u32, channels: usize) -> Result<Self> {
        let mut err: SoxrError = std::ptr::null();
        let handle = unsafe {
            (lib.create)(
                in_rate as f64,
                out_rate as f64,
                channels as u32,
                &mut err,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if !err.is_null() || handle.is_null() {
            let message = if err.is_null() {
                "unknown soxr error".to_string()
            } else {
                unsafe { CStr::from_ptr(err).to_string_lossy().into_owned() }
            };
            return Err(anyhow!("soxr_create failed: {}", message));
        }
        Ok(SoxrInstance { handle, lib })
    }
}

impl Drop for SoxrInstance {
    fn drop(&mut self) {
        unsafe {
            (self.lib.delete)(self.handle);
        }
    }
}

static SOXR_LIB: OnceLock<Option<Arc<SoxrLibrary>>> = OnceLock::new();

fn soxr_candidate_names() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &["soxr.dll", "libsoxr.dll"]
    } else if cfg!(target_os = "macos") {
        &["libsoxr.dylib"]
    } else {
        &["libsoxr.so", "libsoxr.so.0"]
    }
}

fn soxr_library_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("VMUSIC_SOXR_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    if let Ok(dir) = std::env::var("VMUSIC_ASSET_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    for dir in dirs {
        for name in soxr_candidate_names() {
            candidates.push(dir.join(name));
        }
    }
    for name in soxr_candidate_names() {
        candidates.push(PathBuf::from(name));
    }
    candidates
}

fn soxr_library() -> Option<Arc<SoxrLibrary>> {
    SOXR_LIB
        .get_or_init(|| {
            for candidate in soxr_library_candidates() {
                if let Ok(lib) = unsafe { SoxrLibrary::load(&candidate) } {
                    info!("soxr loaded from {}", candidate.display());
                    return Some(Arc::new(lib));
                }
            }
            None
        })
        .clone()
}

fn detect_soxr_available() -> bool {
    soxr_library().is_some()
}

fn initial_state() -> EngineState {
    EngineState {
        is_playing: false,
        is_paused: false,
        mode: "idle".to_string(),
        file_path: None,
        data: Vec::new(),
        channels: 2,
        sample_rate: 48_000,
        position: 0,
        played_frames: 0,
        duration: 0.0,
        volume: 1.0,
        device_id: None,
        exclusive_mode: false,
        eq_enabled: false,
        eq_type: "IIR".to_string(),
        eq_bands: default_eq_bands(),
        dither_enabled: true,
        dither_type: "tpdf".to_string(),
        dither_bits: 24,
        replaygain_enabled: true,
        resampler_mode: "auto".to_string(),
        resampler_quality: "hq".to_string(),
        soxr_available: detect_soxr_available(),
        target_samplerate: None,
        stream_url: None,
        stream_status: "idle".to_string(),
        stream_error: None,
        buffered_frames: 0,
        buffer_target_ms: 300,
        buffer_max_ms: 5000,
        underrun_count: 0,
        last_output_chunk: vec![0.0; SPECTRUM_FFT_SIZE],
        dither_rng: initial_dither_seed(),
    }
}

fn build_state_view(state: &EngineState) -> PlaybackState {
    let buffered_ms = if state.sample_rate > 0 {
        (state.buffered_frames as f64 / state.sample_rate as f64) * 1000.0
    } else {
        0.0
    };
    let current_time = match state.mode.as_str() {
        "file" => {
            if state.sample_rate > 0 {
                state.position as f64 / state.sample_rate as f64
            } else {
                0.0
            }
        }
        _ => {
            if state.sample_rate > 0 {
                state.played_frames as f64 / state.sample_rate as f64
            } else {
                0.0
            }
        }
    };
    PlaybackState {
        is_playing: state.is_playing,
        is_paused: state.is_paused,
        duration: state.duration,
        current_time,
        file_path: state.file_path.clone(),
        volume: state.volume,
        device_id: state.device_id,
        exclusive_mode: state.exclusive_mode,
        eq_type: state.eq_type.clone(),
        dither_enabled: state.dither_enabled,
        dither_type: state.dither_type.clone(),
        dither_bits: state.dither_bits,
        replaygain_enabled: state.replaygain_enabled,
        resampler_mode: state.resampler_mode.clone(),
        resampler_quality: state.resampler_quality.clone(),
        soxr_available: state.soxr_available,
        eq_enabled: state.eq_enabled,
        eq_bands: state.eq_bands.clone(),
        target_samplerate: state.target_samplerate,
        mode: state.mode.clone(),
        stream_status: state.stream_status.clone(),
        buffered_ms,
        underruns: state.underrun_count,
    }
}
fn send_state(shared: &SharedState) {
    let state = shared.inner.lock().unwrap();
    let payload = json!({
        "type": "playback_state",
        "state": build_state_view(&state)
    });
    let _ = shared.tx.send(payload.to_string());
}

fn send_buffer_state(shared: &SharedState) {
    let state = shared.inner.lock().unwrap();
    let payload = json!({
        "type": "buffer_state",
        "buffered_ms": if state.sample_rate > 0 {
            (state.buffered_frames as f64 / state.sample_rate as f64) * 1000.0
        } else {
            0.0
        },
        "underruns": state.underrun_count,
        "mode": state.mode.clone()
    });
    let _ = shared.tx.send(payload.to_string());
}

fn update_stream_status(shared: &SharedState, status: &str, err: Option<String>) {
    {
        let mut state = shared.inner.lock().unwrap();
        state.stream_status = status.to_string();
        state.stream_error = err.clone();
    }
    let payload = json!({
        "type": "stream_state",
        "status": status,
        "error": err
    });
    let _ = shared.tx.send(payload.to_string());
}

fn ffmpeg_path() -> PathBuf {
    if let Ok(dir) = std::env::var("VMUSIC_ASSET_DIR") {
        let candidate = Path::new(&dir).join("ffmpeg.exe");
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("ffmpeg")
}

fn spawn_ffmpeg(input: &str, sample_rate: u32, channels: u16) -> Result<Child> {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-v")
        .arg("error")
        .arg("-i")
        .arg(input)
        .arg("-ac")
        .arg(channels.to_string())
        .arg("-ar")
        .arg(sample_rate.to_string())
        .arg("-acodec")
        .arg("pcm_f32le")
        .arg("-f")
        .arg("f32le")
        .arg("-");

    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ffmpeg")?;
    Ok(child)
}

fn spawn_capture_ffmpeg(sample_rate: u32, channels: u16) -> Result<Child> {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new(ffmpeg_path());
        cmd.arg("-v")
            .arg("error")
            .arg("-f")
            .arg("wasapi")
            .arg("-i")
            .arg("default")
            .arg("-ac")
            .arg(channels.to_string())
            .arg("-ar")
            .arg(sample_rate.to_string())
            .arg("-acodec")
            .arg("pcm_f32le")
            .arg("-f")
            .arg("f32le")
            .arg("-");
        let child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("spawn ffmpeg capture")?;
        return Ok(child);
    }
    Err(anyhow!("capture not supported on this platform"))
}

fn start_stream_reader(shared: SharedState, mut child: Child) {
    let stdout = child.stdout.take();
    if stdout.is_none() {
        update_stream_status(&shared, "error", Some("ffmpeg stdout missing".to_string()));
        return;
    }
    let mut stdout = stdout.unwrap();
    update_stream_status(&shared, "running", None);
    let producer = shared.producer.clone();
    let state = shared.inner.clone();
    let thread = thread::spawn(move || {
        let channels = {
            let guard = state.lock().unwrap();
            guard.channels.max(1)
        };
        let mut sample_count = 0usize;
        let mut buffer = vec![0u8; 8192];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let mut offset = 0;
                    while offset + 4 <= n {
                        let sample = f32::from_le_bytes([
                            buffer[offset],
                            buffer[offset + 1],
                            buffer[offset + 2],
                            buffer[offset + 3],
                        ]);
                        offset += 4;
                        if let Ok(mut prod) = producer.lock() {
                            if prod.try_push(sample).is_ok() {
                                sample_count += 1;
                                if sample_count % channels == 0 {
                                    if let Ok(mut s) = state.lock() {
                                        s.buffered_frames += 1;
                                    }
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    error!("ffmpeg read error: {}", err);
                    break;
                }
            }
        }
    });

    *shared.stream_process.lock().unwrap() = Some(child);
    *shared.stream_thread.lock().unwrap() = Some(thread);
}

fn stop_stream(shared: &SharedState) {
    if let Some(mut child) = shared.stream_process.lock().unwrap().take() {
        let _ = child.kill();
    }
    if let Some(thread) = shared.stream_thread.lock().unwrap().take() {
        let _ = thread.join();
    }
    let mut state = shared.inner.lock().unwrap();
    state.stream_status = "stopped".to_string();
    state.stream_error = None;
    state.stream_url = None;
    state.buffered_frames = 0;
}

fn reset_ring_buffer(shared: &SharedState) {
    let capacity = {
        let state = shared.inner.lock().unwrap();
        let sample_rate = state.sample_rate.max(1);
        let channels = state.channels.max(1);
        let frames = (state.buffer_max_ms as u64 * sample_rate as u64) / 1000;
        (frames as usize) * channels
    };
    let rb = HeapRb::<f32>::new(capacity);
    let (prod, cons) = rb.split();
    *shared.producer.lock().unwrap() = prod;
    *shared.consumer.lock().unwrap() = cons;
}
fn decode_file(path: &str) -> Result<(Vec<f32>, u32, usize, f64)> {
    let file = File::open(path).context("open audio file")?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|v| v.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    )?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("no default track"))?;
    let codec_params = &track.codec_params;
    let sample_rate = codec_params.sample_rate.unwrap_or(48_000);
    let channels = codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2);

    let mut decoder = symphonia::default::get_codecs()
        .make(codec_params, &DecoderOptions::default())?;

    let mut samples: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(_) => break,
        };
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(_) => continue,
        };
        match decoded {
            AudioBufferRef::F32(buf) => {
                let spec = *buf.spec();
                let mut sample_buf = SampleBuffer::<f32>::new(buf.capacity() as u64, spec);
                sample_buf.copy_interleaved_ref(AudioBufferRef::F32(buf));
                samples.extend_from_slice(sample_buf.samples());
            }
            _ => {
                let spec = *decoded.spec();
                let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                sample_buf.copy_interleaved_ref(decoded);
                samples.extend_from_slice(sample_buf.samples());
            }
        }
    }

    let frames = samples.len() / channels.max(1);
    let duration = if sample_rate > 0 {
        frames as f64 / sample_rate as f64
    } else {
        0.0
    };
    Ok((samples, sample_rate, channels, duration))
}

fn normalize_resampler_mode(value: &str) -> String {
    let normalized = value.to_lowercase();
    match normalized.as_str() {
        "auto" | "rubato" | "soxr" => normalized,
        _ => "auto".to_string(),
    }
}

fn normalize_resampler_quality(value: &str) -> String {
    let normalized = value.to_lowercase();
    match normalized.as_str() {
        "low" | "std" | "hq" | "uhq" => normalized,
        _ => "hq".to_string(),
    }
}

fn normalize_dither_bits(bits: u32) -> u32 {
    match bits {
        16 | 24 => bits,
        _ => 24,
    }
}

fn get_sinc_params(quality: &str, ratio: f64) -> SincInterpolationParameters {
    let f_cutoff = if ratio < 1.0 { 0.90 } else { 0.95 };
    match quality {
        "low" => SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 64,
            window: WindowFunction::Hann,
        },
        "std" => SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::Blackman,
        },
        "hq" => SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        },
        _ => SincInterpolationParameters {
            sinc_len: 512,
            f_cutoff,
            interpolation: SincInterpolationType::Cubic,
            oversampling_factor: 512,
            window: WindowFunction::BlackmanHarris2,
        },
    }
}

fn resample_audio(
    data: &[f32],
    channels: usize,
    from_rate: u32,
    to_rate: u32,
    quality: &str,
) -> Result<Vec<f32>> {
    if data.is_empty() || channels == 0 || from_rate == 0 || to_rate == 0 {
        return Ok(data.to_vec());
    }
    if from_rate == to_rate {
        return Ok(data.to_vec());
    }

    let frames = data.len() / channels;
    if frames == 0 {
        return Ok(Vec::new());
    }

    let ratio = to_rate as f64 / from_rate as f64;
    let params = get_sinc_params(quality, ratio);

    let mut waves_in: Vec<Vec<f64>> = vec![Vec::with_capacity(frames); channels];
    for frame in data.chunks_exact(channels) {
        for (ch, &sample) in frame.iter().enumerate() {
            waves_in[ch].push(sample as f64);
        }
    }

    let mut resampler = SincFixedIn::new(ratio, 2.0, params, frames, channels)
        .map_err(|err| anyhow!("resampler init failed: {}", err))?;
    let waves_out = resampler
        .process(&waves_in, None)
        .map_err(|err| anyhow!("resampler process failed: {}", err))?;

    let out_frames = waves_out.get(0).map_or(0, |v| v.len());
    let mut output = vec![0.0f32; out_frames * channels];
    for i in 0..out_frames {
        for (ch, channel_data) in waves_out.iter().enumerate() {
            if let Some(sample) = channel_data.get(i) {
                output[i * channels + ch] = *sample as f32;
            }
        }
    }

    Ok(output)
}

fn resample_audio_soxr(
    data: &[f32],
    channels: usize,
    from_rate: u32,
    to_rate: u32,
) -> Result<Vec<f32>> {
    if data.is_empty() || channels == 0 || from_rate == 0 || to_rate == 0 {
        return Ok(data.to_vec());
    }
    if from_rate == to_rate {
        return Ok(data.to_vec());
    }

    let frames = data.len() / channels;
    if frames == 0 {
        return Ok(Vec::new());
    }

    let lib = soxr_library().ok_or_else(|| anyhow!("soxr library not available"))?;
    let instance = SoxrInstance::new(lib, from_rate, to_rate, channels)?;
    let ratio = to_rate as f64 / from_rate as f64;
    let mut output = Vec::with_capacity(((frames as f64 * ratio).ceil() as usize + 256) * channels);

    let mut offset = 0usize;
    let chunk_frames = 8192usize;
    while offset < frames {
        let frames_in = (frames - offset).min(chunk_frames);
        let in_start = offset * channels;
        let in_end = in_start + frames_in * channels;
        let in_slice = &data[in_start..in_end];

        let out_capacity_frames = ((frames_in as f64 * ratio).ceil() as usize + 64).max(1);
        let mut out_chunk = vec![0.0f32; out_capacity_frames * channels];
        let mut idone = 0usize;
        let mut odone = 0usize;
        let err = unsafe {
            (instance.lib.process)(
                instance.handle,
                in_slice.as_ptr() as *const c_void,
                frames_in,
                &mut idone,
                out_chunk.as_mut_ptr() as *mut c_void,
                out_capacity_frames,
                &mut odone,
            )
        };
        if !err.is_null() {
            let message = unsafe { CStr::from_ptr(err).to_string_lossy().into_owned() };
            return Err(anyhow!("soxr_process failed: {}", message));
        }
        if idone != frames_in {
            return Err(anyhow!(
                "soxr_process consumed {} of {} frames",
                idone,
                frames_in
            ));
        }
        if odone > 0 {
            output.extend_from_slice(&out_chunk[..odone * channels]);
        }
        offset += idone;
    }

    loop {
        let out_capacity_frames = 1024usize;
        let mut out_chunk = vec![0.0f32; out_capacity_frames * channels];
        let mut idone = 0usize;
        let mut odone = 0usize;
        let err = unsafe {
            (instance.lib.process)(
                instance.handle,
                std::ptr::null(),
                0,
                &mut idone,
                out_chunk.as_mut_ptr() as *mut c_void,
                out_capacity_frames,
                &mut odone,
            )
        };
        if !err.is_null() {
            let message = unsafe { CStr::from_ptr(err).to_string_lossy().into_owned() };
            return Err(anyhow!("soxr_process flush failed: {}", message));
        }
        if odone == 0 {
            break;
        }
        output.extend_from_slice(&out_chunk[..odone * channels]);
    }

    Ok(output)
}

fn next_uniform(seed: &mut u64) -> f32 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let value = (*seed >> 32) as u32;
    (value as f32) / (u32::MAX as f32)
}

fn apply_tpdf_dither(samples: &mut [f32], bits: u32, seed: &mut u64) {
    let effective_bits = bits.clamp(8, 32);
    let denom = 1u64 << effective_bits.saturating_sub(1);
    let lsb = 1.0 / denom as f32;
    for sample in samples.iter_mut() {
        let noise = (next_uniform(seed) - next_uniform(seed)) * lsb;
        *sample = (*sample + noise).clamp(-1.0, 1.0);
    }
}

fn apply_dither_if_needed(state: &Arc<Mutex<EngineState>>, data: &mut [f32], target_bits: u32) {
    let (enabled, dither_type, bits, mut seed) = {
        let guard = state.lock().unwrap();
        (
            guard.dither_enabled,
            guard.dither_type.clone(),
            guard.dither_bits,
            guard.dither_rng,
        )
    };
    if !enabled || dither_type != "tpdf" {
        return;
    }
    let effective_bits = normalize_dither_bits(bits).min(target_bits);
    apply_tpdf_dither(data, effective_bits, &mut seed);
    let mut guard = state.lock().unwrap();
    guard.dither_rng = seed;
}
fn ensure_output_stream(shared: &SharedState) -> Result<()> {
    let mut guard = shared.output_stream.lock().unwrap();
    if guard.0.is_some() {
        return Ok(());
    }

    let state_snapshot = shared.inner.lock().unwrap().clone();
    let host = cpal::default_host();
    let device = if let Some(id) = state_snapshot.device_id {
        find_device_by_id(id).unwrap_or_else(|| host.default_output_device().unwrap())
    } else {
        host.default_output_device().ok_or_else(|| anyhow!("no output device"))?
    };

    let default_config = device.default_output_config()?;
    let sample_format = default_config.sample_format();
    let mut config = default_config.config();
    let target_rate = state_snapshot.target_samplerate.unwrap_or(state_snapshot.sample_rate);
    config.sample_rate = cpal::SampleRate(target_rate.max(8000));
    config.channels = state_snapshot.channels as u16;

    let state = shared.inner.clone();
    let consumer = shared.consumer.clone();

    let err_fn = |err| {
        error!("stream error: {}", err);
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config,
            move |data: &mut [f32], _| {
                fill_output_buffer(&state, &consumer, data);
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I16 => device.build_output_stream(
            &config,
            move |data: &mut [i16], _| {
                let mut temp = vec![0.0f32; data.len()];
                fill_output_buffer(&state, &consumer, &mut temp);
                apply_dither_if_needed(&state, &mut temp, 16);
                for (dst, src) in data.iter_mut().zip(temp.iter()) {
                    *dst = cpal::Sample::from_sample(*src);
                }
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::U16 => device.build_output_stream(
            &config,
            move |data: &mut [u16], _| {
                let mut temp = vec![0.0f32; data.len()];
                fill_output_buffer(&state, &consumer, &mut temp);
                apply_dither_if_needed(&state, &mut temp, 16);
                for (dst, src) in data.iter_mut().zip(temp.iter()) {
                    *dst = cpal::Sample::from_sample(*src);
                }
            },
            err_fn,
            None,
        )?,
        _ => return Err(anyhow!("unsupported sample format")),
    };

    stream.play()?;
    guard.0 = Some(stream);
    Ok(())
}

fn fill_output_buffer(state: &Arc<Mutex<EngineState>>, consumer: &Arc<Mutex<HeapCons<f32>>>, data: &mut [f32]) {
    let frames = data.len();
    let mut local = state.lock().unwrap();
    if !local.is_playing || local.is_paused {
        for sample in data.iter_mut() {
            *sample = 0.0;
        }
        return;
    }

    match local.mode.as_str() {
        "file" => {
            let channels = local.channels.max(1);
            let frame_count = frames / channels;
            let start = local.position * channels;
            let end = (start + frame_count * channels).min(local.data.len());
            let available = end.saturating_sub(start);
            data[..available].copy_from_slice(&local.data[start..start + available]);
            if available < data.len() {
                for sample in data[available..].iter_mut() {
                    *sample = 0.0;
                }
                local.is_playing = false;
            }
            local.position += frame_count;
        }
        "stream" | "capture" => {
            let mut consumed = 0usize;
            if let Ok(mut cons) = consumer.lock() {
                for sample in data.iter_mut() {
                    if let Some(v) = cons.try_pop() {
                        *sample = v;
                        consumed += 1;
                    } else {
                        *sample = 0.0;
                    }
                }
            }
            let channels = local.channels.max(1);
            local.buffered_frames = local.buffered_frames.saturating_sub(consumed / channels);
            if consumed < data.len() {
                local.underrun_count += 1;
            }
            local.played_frames += (data.len() / channels) as u64;
        }
        _ => {
            for sample in data.iter_mut() {
                *sample = 0.0;
            }
        }
    }

    for sample in data.iter_mut() {
        *sample *= local.volume;
    }
    if local.last_output_chunk.len() != SPECTRUM_FFT_SIZE {
        local.last_output_chunk.resize(SPECTRUM_FFT_SIZE, 0.0);
    }
    let copy_len = data.len().min(SPECTRUM_FFT_SIZE);
    if copy_len > 0 {
        local.last_output_chunk[..copy_len].copy_from_slice(&data[..copy_len]);
    }
    if copy_len < SPECTRUM_FFT_SIZE {
        for value in &mut local.last_output_chunk[copy_len..] {
            *value = 0.0;
        }
    }
}
fn list_devices() -> Value {
    let mut wasapi = Vec::new();
    let mut other = Vec::new();
    let mut index = 0usize;
    for host_id in cpal::available_hosts() {
        if let Ok(host) = cpal::host_from_id(host_id) {
            if let Ok(devices) = host.output_devices() {
                for device in devices {
                    let name = device.name().unwrap_or_else(|_| "Unknown".to_string());
                    let sample_rate = device
                        .default_output_config()
                        .map(|c| c.sample_rate().0)
                        .unwrap_or(48_000);
                    let info = json!({
                        "id": index,
                        "name": name,
                        "hostapi": format!("{:?}", host_id),
                        "default_samplerate": sample_rate
                    });
                    if host_id == cpal::HostId::Wasapi {
                        wasapi.push(info);
                    } else {
                        other.push(info);
                    }
                    index += 1;
                }
            }
        }
    }
    json!({
        "wasapi": wasapi,
        "other": other
    })
}

fn find_device_by_id(target: usize) -> Option<cpal::Device> {
    let mut index = 0usize;
    for host_id in cpal::available_hosts() {
        if let Ok(host) = cpal::host_from_id(host_id) {
            if let Ok(devices) = host.output_devices() {
                for device in devices {
                    if index == target {
                        return Some(device);
                    }
                    index += 1;
                }
            }
        }
    }
    None
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<SharedState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: SharedState) {
    let mut rx = state.tx.subscribe();
    while let Ok(msg) = rx.recv().await {
        if socket.send(Message::Text(msg.into())).await.is_err() {
            break;
        }
    }
}

async fn get_state_handler(State(state): State<SharedState>) -> impl IntoResponse {
    let state = state.inner.lock().unwrap();
    let payload = json!({
        "status": "success",
        "state": build_state_view(&state)
    });
    Json(payload)
}

async fn list_devices_handler() -> impl IntoResponse {
    let payload = json!({ "status": "success", "devices": list_devices() });
    Json(payload)
}
async fn load_handler(State(shared): State<SharedState>, Json(req): Json<LoadRequest>) -> impl IntoResponse {
    if !Path::new(&req.path).exists() {
        return (StatusCode::BAD_REQUEST, Json(json!({
            "status": "error",
            "message": "File not found"
        })));
    }
    stop_stream(&shared);
    let decode = decode_file(&req.path);
    let (data, sample_rate, channels, _duration) = match decode {
        Ok(result) => result,
        Err(err) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                "status": "error",
                "message": format!("decode failed: {}", err)
            })));
        }
    };

    let soxr_available = detect_soxr_available();
    let (target_samplerate, resampler_mode, resampler_quality) = {
        let mut state = shared.inner.lock().unwrap();
        state.soxr_available = soxr_available;
        (
            state.target_samplerate,
            state.resampler_mode.clone(),
            state.resampler_quality.clone(),
        )
    };

    let mut final_data = data;
    let mut final_sample_rate = sample_rate;
    if let Some(target) = target_samplerate {
        if target > 0 && target != sample_rate {
            let mode = normalize_resampler_mode(&resampler_mode);
            let quality = normalize_resampler_quality(&resampler_quality);
            let prefer_soxr = mode == "soxr" || (mode == "auto" && soxr_available);
            if prefer_soxr {
                match resample_audio_soxr(&final_data, channels, sample_rate, target) {
                    Ok(resampled) => {
                        final_data = resampled;
                        final_sample_rate = target;
                    }
                    Err(err) => {
                        if mode == "auto" {
                            error!("soxr resample failed, falling back to rubato: {}", err);
                            match resample_audio(&final_data, channels, sample_rate, target, &quality) {
                                Ok(resampled) => {
                                    final_data = resampled;
                                    final_sample_rate = target;
                                }
                                Err(err) => {
                                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                                        "status": "error",
                                        "message": format!("resample failed: {}", err)
                                    })));
                                }
                            }
                        } else {
                            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                                "status": "error",
                                "message": format!("soxr resample failed: {}", err)
                            })));
                        }
                    }
                }
            } else {
                match resample_audio(&final_data, channels, sample_rate, target, &quality) {
                    Ok(resampled) => {
                        final_data = resampled;
                        final_sample_rate = target;
                    }
                    Err(err) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                            "status": "error",
                            "message": format!("resample failed: {}", err)
                        })));
                    }
                }
            }
        }
    }
    let duration = if final_sample_rate > 0 && channels > 0 {
        (final_data.len() / channels) as f64 / final_sample_rate as f64
    } else {
        0.0
    };

    {
        let mut state = shared.inner.lock().unwrap();
        state.data = final_data;
        state.sample_rate = final_sample_rate;
        state.channels = channels;
        state.position = 0;
        state.duration = duration;
        state.is_playing = false;
        state.is_paused = false;
        state.file_path = Some(req.path);
        state.mode = "file".to_string();
        state.stream_status = "idle".to_string();
    }

    reset_ring_buffer(&shared);
    let _ = ensure_output_stream(&shared);
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    (StatusCode::OK, Json(json!({ "status": "success", "state": build_state_view(&state) })))
}

async fn play_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    {
        let mut state = shared.inner.lock().unwrap();
        state.is_playing = true;
        state.is_paused = false;
    }
    let _ = ensure_output_stream(&shared);
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn pause_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    {
        let mut state = shared.inner.lock().unwrap();
        state.is_paused = true;
    }
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn stop_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    {
        let mut state = shared.inner.lock().unwrap();
        state.is_playing = false;
        state.is_paused = false;
        state.position = 0;
        state.played_frames = 0;
        state.mode = "idle".to_string();
        state.buffered_frames = 0;
    }
    stop_stream(&shared);
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn seek_handler(State(shared): State<SharedState>, Json(req): Json<SeekRequest>) -> impl IntoResponse {
    let mut state = shared.inner.lock().unwrap();
    if state.mode != "file" {
        return (StatusCode::BAD_REQUEST, Json(json!({
            "status": "error",
            "message": "seek only supported in file mode"
        })));
    }
    if state.sample_rate == 0 {
        return (StatusCode::BAD_REQUEST, Json(json!({
            "status": "error",
            "message": "invalid sample rate"
        })));
    }
    let new_pos = (req.position * state.sample_rate as f64) as usize;
    if new_pos < state.data.len() / state.channels.max(1) {
        state.position = new_pos;
        return (StatusCode::OK, Json(json!({
            "status": "success",
            "state": build_state_view(&state)
        })));
    }
    (StatusCode::BAD_REQUEST, Json(json!({
        "status": "error",
        "message": "seek out of range"
    })))
}

async fn volume_handler(State(shared): State<SharedState>, Json(req): Json<VolumeRequest>) -> impl IntoResponse {
    {
        let mut state = shared.inner.lock().unwrap();
        state.volume = req.volume.clamp(0.0, 1.0);
    }
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn configure_output_handler(State(shared): State<SharedState>, Json(req): Json<ConfigureOutputRequest>) -> impl IntoResponse {
    {
        let mut state = shared.inner.lock().unwrap();
        state.device_id = req.device_id;
        if let Some(exclusive) = req.exclusive {
            state.exclusive_mode = exclusive;
        }
    }
    shared.output_stream.lock().unwrap().0 = None;
    let _ = ensure_output_stream(&shared);
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn configure_upsampling_handler(State(shared): State<SharedState>, Json(req): Json<ConfigureUpsamplingRequest>) -> impl IntoResponse {
    {
        let mut state = shared.inner.lock().unwrap();
        state.target_samplerate = req.target_samplerate;
    }
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn set_eq_handler(State(shared): State<SharedState>, Json(req): Json<EqRequest>) -> impl IntoResponse {
    let mut state = shared.inner.lock().unwrap();
    if let Some(enabled) = req.enabled {
        state.eq_enabled = enabled;
    }
    if let Some(bands) = req.bands {
        for (k, v) in bands {
            if let Some(entry) = state.eq_bands.get_mut(&k) {
                *entry = v;
            }
        }
    }
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn set_eq_type_handler(State(shared): State<SharedState>, Json(req): Json<EqTypeRequest>) -> impl IntoResponse {
    let mut state = shared.inner.lock().unwrap();
    state.eq_type = req.r#type;
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn configure_opt_handler(State(shared): State<SharedState>, Json(req): Json<OptimizeRequest>) -> impl IntoResponse {
    let mut state = shared.inner.lock().unwrap();
    if let Some(value) = req.dither_type {
        let normalized = match value.to_lowercase().as_str() {
            "off" => "off".to_string(),
            "tpdf" => "tpdf".to_string(),
            _ => "tpdf".to_string(),
        };
        state.dither_type = normalized.clone();
        if normalized == "off" {
            state.dither_enabled = false;
        }
    }
    if let Some(bits) = req.dither_bits {
        state.dither_bits = normalize_dither_bits(bits);
    }
    if let Some(val) = req.dither_enabled {
        state.dither_enabled = val;
        if !val {
            state.dither_type = "off".to_string();
        } else if state.dither_type == "off" {
            state.dither_type = "tpdf".to_string();
        }
    }
    if let Some(val) = req.replaygain_enabled {
        state.replaygain_enabled = val;
    }
    if let Some(value) = req.resampler_mode {
        state.resampler_mode = normalize_resampler_mode(&value);
    }
    if let Some(value) = req.resampler_quality {
        state.resampler_quality = normalize_resampler_quality(&value);
    }
    state.soxr_available = detect_soxr_available();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}
async fn load_stream_handler(State(shared): State<SharedState>, Json(req): Json<StreamRequest>) -> impl IntoResponse {
    stop_stream(&shared);
    let (sample_rate, channels) = {
        let mut state = shared.inner.lock().unwrap();
        state.mode = "stream".to_string();
        state.stream_url = Some(req.url.clone());
        state.sample_rate = state.target_samplerate.unwrap_or(48_000);
        state.channels = 2;
        state.data.clear();
        state.position = 0;
        state.played_frames = 0;
        state.duration = 0.0;
        state.buffered_frames = 0;
        state.stream_status = "starting".to_string();
        (state.sample_rate, state.channels as u16)
    };
    reset_ring_buffer(&shared);
    let child = match spawn_ffmpeg(&req.url, sample_rate, channels) {
        Ok(child) => child,
        Err(err) => {
            update_stream_status(&shared, "error", Some(err.to_string()));
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                "status": "error",
                "message": "failed to start ffmpeg"
            })));
        }
    };
    start_stream_reader(shared.clone(), child);
    let _ = ensure_output_stream(&shared);
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    (StatusCode::OK, Json(json!({ "status": "success", "state": build_state_view(&state) })))
}

async fn capture_start_handler(State(shared): State<SharedState>, Json(req): Json<CaptureStartRequest>) -> impl IntoResponse {
    stop_stream(&shared);
    let (sample_rate, channels) = {
        let mut state = shared.inner.lock().unwrap();
        state.mode = "capture".to_string();
        state.sample_rate = req.samplerate.unwrap_or(48_000);
        state.channels = req.channels.unwrap_or(2) as usize;
        state.data.clear();
        state.position = 0;
        state.played_frames = 0;
        state.duration = 0.0;
        state.buffered_frames = 0;
        state.stream_status = "starting".to_string();
        state.stream_url = req.device_id;
        (state.sample_rate, state.channels as u16)
    };
    reset_ring_buffer(&shared);
    let child = match spawn_capture_ffmpeg(sample_rate, channels) {
        Ok(child) => child,
        Err(err) => {
            update_stream_status(&shared, "error", Some(err.to_string()));
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                "status": "error",
                "message": "capture not supported"
            })));
        }
    };
    start_stream_reader(shared.clone(), child);
    let _ = ensure_output_stream(&shared);
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    (StatusCode::OK, Json(json!({ "status": "success", "state": build_state_view(&state) })))
}

async fn capture_stop_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    stop_stream(&shared);
    {
        let mut state = shared.inner.lock().unwrap();
        state.mode = "idle".to_string();
        state.is_playing = false;
        state.is_paused = false;
    }
    send_state(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn capture_devices_handler() -> impl IntoResponse {
    if cfg!(target_os = "windows") {
        Json(json!({
            "status": "success",
            "devices": [{ "id": "default", "name": "default", "backend": "wasapi" }]
        }))
    } else {
        Json(json!({
            "status": "success",
            "devices": []
        }))
    }
}

async fn buffer_state_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    let state = shared.inner.lock().unwrap();
    Json(json!({
        "status": "success",
        "buffered_ms": if state.sample_rate > 0 {
            (state.buffered_frames as f64 / state.sample_rate as f64) * 1000.0
        } else {
            0.0
        },
        "underruns": state.underrun_count,
        "mode": state.mode.clone()
    }))
}

fn start_background_tasks(shared: SharedState) {
    let state_clone = shared.clone();
    tokio::spawn(async move {
        loop {
            send_state(&state_clone);
            send_buffer_state(&state_clone);
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });

    let state_clone = shared.clone();
    let spectrum_bins = state_clone.spectrum_bins;
    let spectrum_shared = state_clone.spectrum_shared.clone();
    tokio::spawn(async move {
        let mut analyzer = SpectrumAnalyzer::new(SPECTRUM_FFT_SIZE, spectrum_bins);
        let mut sample_buffer = vec![0.0f32; SPECTRUM_FFT_SIZE];
        let use_ws = spectrum_shared.is_none();
        loop {
            let sample_rate = {
                let state = state_clone.inner.lock().unwrap();
                let copy_len = state.last_output_chunk.len().min(SPECTRUM_FFT_SIZE);
                if copy_len > 0 {
                    sample_buffer[..copy_len].copy_from_slice(&state.last_output_chunk[..copy_len]);
                }
                if copy_len < SPECTRUM_FFT_SIZE {
                    for value in &mut sample_buffer[copy_len..] {
                        *value = 0.0;
                    }
                }
                state.sample_rate
            };
            let spectrum = analyzer.compute(&sample_buffer, sample_rate);
            write_spectrum_shared(&spectrum_shared, spectrum);
            if use_ws {
                let payload = json!({ "type": "spectrum_data", "data": spectrum });
                let _ = state_clone.tx.send(payload.to_string());
            }
            tokio::time::sleep(Duration::from_millis(SPECTRUM_UPDATE_INTERVAL_MS)).await;
        }
    });
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let port = std::env::var("VMUSIC_ENGINE_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(55_554);

    let rb = HeapRb::<f32>::new(48_000 * 2 * 5);
    let (producer, consumer) = rb.split();
    let (tx, _rx) = broadcast::channel(128);
    let spectrum_bins = parse_spectrum_bins();
    let spectrum_shared = init_spectrum_shared(spectrum_bins);

    let shared = SharedState {
        inner: Arc::new(Mutex::new(initial_state())),
        tx,
        producer: Arc::new(Mutex::new(producer)),
        consumer: Arc::new(Mutex::new(consumer)),
        output_stream: Arc::new(Mutex::new(OutputStreamHolder(None))),
        stream_process: Arc::new(Mutex::new(None)),
        stream_thread: Arc::new(Mutex::new(None)),
        spectrum_shared,
        spectrum_bins,
    };

    start_background_tasks(shared.clone());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/state", get(get_state_handler))
        .route("/devices", get(list_devices_handler))
        .route("/load", post(load_handler))
        .route("/play", post(play_handler))
        .route("/pause", post(pause_handler))
        .route("/stop", post(stop_handler))
        .route("/seek", post(seek_handler))
        .route("/volume", post(volume_handler))
        .route("/configure_output", post(configure_output_handler))
        .route("/configure_upsampling", post(configure_upsampling_handler))
        .route("/set_eq", post(set_eq_handler))
        .route("/set_eq_type", post(set_eq_type_handler))
        .route("/configure_optimizations", post(configure_opt_handler))
        .route("/load_stream", post(load_stream_handler))
        .route("/capture/start", post(capture_start_handler))
        .route("/capture/stop", post(capture_stop_handler))
        .route("/capture/devices", get(capture_devices_handler))
        .route("/buffer/state", get(buffer_state_handler))
        .with_state(shared);

    let addr = format!("127.0.0.1:{}", port);
    info!("VMusic engine listening on {}", addr);
    println!("VMUSIC_ENGINE_READY");
    axum::serve(tokio::net::TcpListener::bind(addr).await?, app).await?;
    Ok(())
}
