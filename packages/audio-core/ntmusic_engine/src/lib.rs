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
    hash::{Hash, Hasher},
    io::Read,
    os::raw::{c_char, c_void},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer},
    codecs::{CodecParameters, DecoderOptions},
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::{MetadataOptions, StandardTagKey, StandardVisualKey},
    probe::Hint,
    sample::SampleFormat,
};
use tokio::sync::broadcast;
use tracing::{error, info};
use walkdir::WalkDir;

#[cfg(target_os = "windows")]
use windows::core::PCSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
#[cfg(target_os = "windows")]
use windows::Win32::Media::Audio::{
    IAudioClient, IAudioRenderClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    eConsole, eRender, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
};
#[cfg(target_os = "windows")]
use windows::Win32::Media::KernelStreaming::{
    SPEAKER_BACK_LEFT, SPEAKER_BACK_RIGHT, SPEAKER_FRONT_CENTER, SPEAKER_FRONT_LEFT,
    SPEAKER_FRONT_RIGHT, SPEAKER_LOW_FREQUENCY, SPEAKER_SIDE_LEFT, SPEAKER_SIDE_RIGHT,
};
#[cfg(target_os = "windows")]
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{CreateEventA, WaitForSingleObject};

#[derive(Clone)]
pub struct SharedState {
    inner: Arc<Mutex<EngineState>>,
    tx: broadcast::Sender<String>,
    producer: Arc<Mutex<HeapProd<f32>>>,
    consumer: Arc<Mutex<HeapCons<f32>>>,
    output_stream: Arc<Mutex<OutputStreamHolder>>,
    exclusive_stream: Arc<Mutex<Option<ExclusiveStreamHandle>>>,
    output_scratch: Arc<Mutex<Vec<f32>>>,
    stream_process: Arc<Mutex<Option<Child>>>,
    stream_thread: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
    spectrum_shared: Option<Arc<Mutex<SpectrumShared>>>,
    spectrum_bins: usize,
    control_shared: Option<Arc<Mutex<ControlShared>>>,
}

struct OutputStreamHolder(Option<cpal::Stream>);

// cpal::Stream is !Send/Sync on some platforms; we guard access via a mutex.
unsafe impl Send for OutputStreamHolder {}
unsafe impl Sync for OutputStreamHolder {}

struct ExclusiveStreamHandle {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ExclusiveStreamHandle {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct SpectrumShared {
    mmap: MmapMut,
    bins: usize,
}

struct ControlShared {
    mmap: MmapMut,
    capacity: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub id: usize,
    pub name: String,
    pub hostapi: String,
    pub default_samplerate: u32,
}

#[derive(Debug, Clone)]
pub struct TrackInfo {
    pub path: Option<String>,
    pub title: Option<String>,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_depth: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryTrack {
    pub path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: f64,
}

#[derive(Debug, Clone)]
pub struct PositionInfo {
    pub current: f64,
    pub duration: f64,
    pub percent: f64,
}

pub struct EngineHandle {
    shared: SharedState,
    server_thread: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}

impl EngineHandle {
    pub fn new() -> Result<Self> {
        let shared = create_shared_state();
        Ok(Self {
            shared,
            server_thread: Arc::new(Mutex::new(None)),
        })
    }

    pub fn start_http_server(&self, port: u16) -> Result<()> {
        let mut guard = self.server_thread.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        let shared = self.shared.clone();
        let handle = thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(err) => {
                    error!("failed to build runtime: {}", err);
                    return;
                }
            };
            if let Err(err) = runtime.block_on(run_http_server(Some(shared), Some(port))) {
                error!("ntmusic engine http server stopped: {}", err);
            }
        });
        *guard = Some(handle);
        Ok(())
    }

    pub fn load(&self, path: String) -> Result<()> {
        load_file_impl(&self.shared, path)
    }

    pub fn play(&self) -> Result<()> {
        play_impl(&self.shared)
    }

    pub fn pause(&self) -> Result<()> {
        pause_impl(&self.shared)
    }

    pub fn stop(&self) -> Result<()> {
        stop_impl(&self.shared)
    }

    pub fn set_device(&self, device_id: Option<usize>, exclusive: Option<bool>) -> Result<()> {
        configure_output_impl(&self.shared, device_id, exclusive)
    }

    pub fn get_devices(&self) -> Vec<DeviceInfo> {
        enumerate_devices()
    }

    pub fn current_track(&self) -> TrackInfo {
        track_from_state(&self.shared)
    }

    pub fn current_position(&self) -> PositionInfo {
        position_from_state(&self.shared)
    }

    pub fn scan_library(&self, path: String) -> Result<Vec<LibraryTrack>> {
        let tracks = scan_library_impl(&path)?;
        {
            let mut state = self.shared.inner.lock().unwrap();
            state.library = tracks.clone();
        }
        Ok(tracks)
    }

    pub fn queue_add(&self, tracks: Vec<LibraryTrack>, replace: bool) -> Result<usize> {
        Ok(queue_add_impl(&self.shared, tracks, replace))
    }

    pub fn queue_next(&self) -> Result<Option<LibraryTrack>> {
        queue_next_impl(&self.shared)
    }

    pub fn capture_start(
        &self,
        device_id: Option<String>,
        samplerate: Option<u32>,
        channels: Option<u16>,
    ) -> Result<()> {
        start_capture_impl(&self.shared, device_id, samplerate, channels)
    }

    pub fn capture_stop(&self) -> Result<()> {
        stop_capture_impl(&self.shared)
    }
}

const DEFAULT_SPECTRUM_BINS: usize = 48;
const SPECTRUM_FFT_SIZE: usize = 2048;
const SPECTRUM_UPDATE_INTERVAL_MS: u64 = 50;
const SPECTRUM_HEADER_BYTES: usize = std::mem::size_of::<u32>();
const CONTROL_HEADER_BYTES: usize = 16;
const CONTROL_CMD_BYTES: usize = 16;
const MAX_DITHER_CHANNELS: usize = 8;
const DITHER_SHAPER_ORDER1_COEFF: f32 = 1.0;
const DITHER_SHAPER_ORDER2_COEFF1: f32 = 2.0;
const DITHER_SHAPER_ORDER2_COEFF2: f32 = -1.0;

const CONTROL_CMD_PLAY: u32 = 1;
const CONTROL_CMD_PAUSE: u32 = 2;
const CONTROL_CMD_STOP: u32 = 3;
const CONTROL_CMD_SEEK: u32 = 4;
const CONTROL_CMD_VOLUME: u32 = 5;

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
    sample_rate: u32,
    channels: u32,
    source_sample_rate: u32,
    source_channels: u32,
    source_bit_depth: Option<u32>,
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
    limiter_enabled: bool,
    limiter_threshold: f32,
    eq_enabled: bool,
    eq_bands: HashMap<String, f32>,
    target_samplerate: Option<u32>,
    mode: String,
    stream_status: String,
    buffered_ms: f64,
    underruns: u64,
    spectrum_ws_enabled: bool,
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
    source_channels: usize,
    source_sample_rate: u32,
    source_bit_depth: Option<u32>,
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
    limiter_enabled: bool,
    limiter_threshold: f32,
    target_samplerate: Option<u32>,
    stream_url: Option<String>,
    stream_status: String,
    stream_error: Option<String>,
    buffered_frames: usize,
    buffer_max_ms: u32,
    underrun_count: u64,
    library: Vec<LibraryTrack>,
    queue: Vec<LibraryTrack>,
    queue_index: Option<usize>,
    last_output_chunk: Vec<f32>,
    dither_rng: u64,
    dither_shape_err1: [f32; MAX_DITHER_CHANNELS],
    dither_shape_err2: [f32; MAX_DITHER_CHANNELS],
    spectrum_ws_enabled: bool,
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
struct LibraryScanRequest {
    path: String,
}

#[derive(Deserialize)]
struct QueueAddRequest {
    tracks: Vec<LibraryTrack>,
    replace: Option<bool>,
}

#[derive(Deserialize)]
struct CommandRequest {
    text: Option<String>,
    action: Option<String>,
    query: Option<String>,
}

#[derive(Deserialize)]
struct CoverRequest {
    path: String,
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
struct SpectrumWsRequest {
    enabled: bool,
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
    limiter_enabled: Option<bool>,
    limiter_threshold: Option<f32>,
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

fn parse_control_capacity() -> usize {
    std::env::var("NTMUSIC_CONTROL_CAPACITY")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(64)
}

fn init_spectrum_shared(bins: usize) -> Option<Arc<Mutex<SpectrumShared>>> {
    let path = match std::env::var("NTMUSIC_SPECTRUM_SHM") {
        Ok(value) if !value.is_empty() => value,
        _ => return None,
    };
    let data_len = bins.saturating_mul(std::mem::size_of::<f32>());
    let byte_len = SPECTRUM_HEADER_BYTES.saturating_add(data_len);
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

fn init_control_shared(capacity: usize) -> Option<Arc<Mutex<ControlShared>>> {
    let path = match std::env::var("NTMUSIC_CONTROL_SHM") {
        Ok(value) if !value.is_empty() => value,
        _ => return None,
    };
    let byte_len = CONTROL_HEADER_BYTES.saturating_add(capacity.saturating_mul(CONTROL_CMD_BYTES));
    let file = match OpenOptions::new().read(true).write(true).create(true).open(&path) {
        Ok(file) => file,
        Err(err) => {
            error!("control shm open failed: {}", err);
            return None;
        }
    };
    if let Err(err) = file.set_len(byte_len as u64) {
        error!("control shm resize failed: {}", err);
        return None;
    }
    let mut mmap = unsafe {
        match MmapMut::map_mut(&file) {
            Ok(map) => map,
            Err(err) => {
                error!("control shm map failed: {}", err);
                return None;
            }
        }
    };
    let header_ptr = mmap.as_mut_ptr();
    let write_idx = unsafe { &*(header_ptr as *const AtomicU32) };
    let read_idx = unsafe { &*(header_ptr.add(4) as *const AtomicU32) };
    write_idx.store(0, Ordering::Release);
    read_idx.store(0, Ordering::Release);
    unsafe {
        *(header_ptr.add(8) as *mut u32) = capacity as u32;
        *(header_ptr.add(12) as *mut u32) = 0;
    }
    Some(Arc::new(Mutex::new(ControlShared { mmap, capacity })))
}

fn create_shared_state() -> SharedState {
    let rb = HeapRb::<f32>::new(48_000 * 2 * 5);
    let (producer, consumer) = rb.split();
    let (tx, _rx) = broadcast::channel(128);
    let spectrum_bins = parse_spectrum_bins();
    let spectrum_shared = init_spectrum_shared(spectrum_bins);
    let control_capacity = parse_control_capacity();
    let control_shared = init_control_shared(control_capacity);

    SharedState {
        inner: Arc::new(Mutex::new(initial_state())),
        tx,
        producer: Arc::new(Mutex::new(producer)),
        consumer: Arc::new(Mutex::new(consumer)),
        output_stream: Arc::new(Mutex::new(OutputStreamHolder(None))),
        exclusive_stream: Arc::new(Mutex::new(None)),
        output_scratch: Arc::new(Mutex::new(Vec::new())),
        stream_process: Arc::new(Mutex::new(None)),
        stream_thread: Arc::new(Mutex::new(None)),
        spectrum_shared,
        spectrum_bins,
        control_shared,
    }
}

fn drain_control_commands(state: &mut EngineState, control: &ControlShared) {
    let header_ptr = control.mmap.as_ptr() as *const u8;
    let write_idx = unsafe { &*(header_ptr as *const AtomicU32) };
    let read_idx = unsafe { &*(header_ptr.add(4) as *const AtomicU32) };
    let capacity = control.capacity.max(1) as u32;

    let mut read = read_idx.load(Ordering::Acquire);
    let write = write_idx.load(Ordering::Acquire);
    if read == write {
        return;
    }
    let mut processed = 0u32;
    while read != write && processed < capacity {
        let cmd_offset = CONTROL_HEADER_BYTES + (read as usize * CONTROL_CMD_BYTES);
        let cmd_ptr = unsafe { header_ptr.add(cmd_offset) };
        let cmd = unsafe { *(cmd_ptr as *const u32) };
        let value = unsafe { *(cmd_ptr.add(4) as *const f32) };
        match cmd {
            CONTROL_CMD_PLAY => {
                state.is_playing = true;
                state.is_paused = false;
            }
            CONTROL_CMD_PAUSE => {
                state.is_paused = true;
            }
            CONTROL_CMD_STOP => {
                state.is_playing = false;
                state.is_paused = false;
                if state.mode == "file" {
                    state.position = 0;
                }
            }
            CONTROL_CMD_SEEK => {
                if state.mode == "file" && state.sample_rate > 0 {
                    let new_pos = (value.max(0.0) * state.sample_rate as f32) as usize;
                    let max_pos = state.data.len() / state.channels.max(1);
                    state.position = new_pos.min(max_pos);
                }
            }
            CONTROL_CMD_VOLUME => {
                state.volume = value.clamp(0.0, 1.0);
            }
            _ => {}
        }
        read = (read + 1) % capacity;
        processed += 1;
    }
    read_idx.store(read, Ordering::Release);
}

fn write_spectrum_shared(shared: &Option<Arc<Mutex<SpectrumShared>>>, spectrum: &[f32]) {
    let Some(shared) = shared else {
        return;
    };
    let mut guard = match shared.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let data_len = guard.mmap.len().saturating_sub(SPECTRUM_HEADER_BYTES);
    let available_bins = data_len / std::mem::size_of::<f32>();
    let bins = guard.bins.min(available_bins);
    if bins == 0 {
        return;
    }
    let len = bins.min(spectrum.len());
    let seq = unsafe { &*(guard.mmap.as_ptr() as *const AtomicU32) };
    let data_ptr = unsafe { guard.mmap.as_mut_ptr().add(SPECTRUM_HEADER_BYTES) as *mut f32 };
    let dst = unsafe { std::slice::from_raw_parts_mut(data_ptr, bins) };
    let start_seq = seq.load(Ordering::Relaxed).wrapping_add(1);
    seq.store(start_seq, Ordering::Release);
    if len > 0 {
        dst[..len].copy_from_slice(&spectrum[..len]);
    }
    if len < bins {
        for value in &mut dst[len..] {
            *value = 0.0;
        }
    }
    seq.store(start_seq.wrapping_add(1), Ordering::Release);
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
        source_channels: 2,
        source_sample_rate: 48_000,
        source_bit_depth: None,
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
        limiter_enabled: false,
        limiter_threshold: 0.98,
        target_samplerate: None,
        stream_url: None,
        stream_status: "idle".to_string(),
        stream_error: None,
        buffered_frames: 0,
        buffer_max_ms: 5000,
        underrun_count: 0,
        library: Vec::new(),
        queue: Vec::new(),
        queue_index: None,
        last_output_chunk: vec![0.0; SPECTRUM_FFT_SIZE],
        dither_rng: initial_dither_seed(),
        dither_shape_err1: [0.0; MAX_DITHER_CHANNELS],
        dither_shape_err2: [0.0; MAX_DITHER_CHANNELS],
        spectrum_ws_enabled: true,
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
        sample_rate: state.sample_rate,
        channels: state.channels as u32,
        source_sample_rate: state.source_sample_rate,
        source_channels: state.source_channels as u32,
        source_bit_depth: state.source_bit_depth,
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
        limiter_enabled: state.limiter_enabled,
        limiter_threshold: state.limiter_threshold,
        eq_enabled: state.eq_enabled,
        eq_bands: state.eq_bands.clone(),
        target_samplerate: state.target_samplerate,
        mode: state.mode.clone(),
        stream_status: state.stream_status.clone(),
        buffered_ms,
        underruns: state.underrun_count,
        spectrum_ws_enabled: state.spectrum_ws_enabled,
    }
}

fn track_from_state(shared: &SharedState) -> TrackInfo {
    let state = shared.inner.lock().unwrap();
    let title = state
        .file_path
        .as_ref()
        .and_then(|path| Path::new(path).file_stem())
        .map(|s| s.to_string_lossy().to_string());
    TrackInfo {
        path: state.file_path.clone(),
        title,
        duration: state.duration,
        sample_rate: state.source_sample_rate,
        channels: state.source_channels as u32,
        bit_depth: state.source_bit_depth,
    }
}

fn position_from_state(shared: &SharedState) -> PositionInfo {
    let state = shared.inner.lock().unwrap();
    let current = if state.sample_rate > 0 {
        state.position as f64 / state.sample_rate as f64
    } else {
        0.0
    };
    let duration = state.duration;
    let percent = if duration > 0.0 {
        (current / duration).clamp(0.0, 1.0)
    } else {
        0.0
    };
    PositionInfo {
        current,
        duration,
        percent,
    }
}

fn is_supported_audio_path(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mp3" | "flac" | "wav" | "ogg" | "m4a" | "aac" | "aiff" | "alac"
    )
}

fn track_title_from_path(path: &Path) -> Option<String> {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
}

fn tag_value_to_string(tag: &symphonia::core::meta::Tag) -> Option<String> {
    let value = tag.value.to_string();
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn read_library_track(path: &Path) -> Result<LibraryTrack> {
    let file = File::open(path).with_context(|| format!("open {:?}", path))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .with_context(|| format!("probe {:?}", path))?;
    let mut format = probed.format;

    let mut title = None;
    let mut artist = None;
    let mut album = None;
    if let Some(rev) = format.metadata().current() {
        for tag in rev.tags() {
            if title.is_none() && matches!(tag.std_key, Some(StandardTagKey::TrackTitle)) {
                title = tag_value_to_string(tag);
            }
            if artist.is_none() && matches!(tag.std_key, Some(StandardTagKey::Artist)) {
                artist = tag_value_to_string(tag);
            }
            if album.is_none() && matches!(tag.std_key, Some(StandardTagKey::Album)) {
                album = tag_value_to_string(tag);
            }
        }
    }

    let duration = format
        .default_track()
        .and_then(|track| {
            let params = &track.codec_params;
            let frames = params.n_frames?;
            let sample_rate = params.sample_rate?;
            if sample_rate == 0 {
                None
            } else {
                Some(frames as f64 / sample_rate as f64)
            }
        })
        .unwrap_or(0.0);

    Ok(LibraryTrack {
        path: path.to_string_lossy().to_string(),
        title: title.or_else(|| track_title_from_path(path)),
        artist,
        album,
        duration,
    })
}

fn scan_library_impl(path: &str) -> Result<Vec<LibraryTrack>> {
    let root = Path::new(path);
    if !root.exists() {
        return Err(anyhow!("scan path not found"));
    }
    let mut tracks = Vec::new();
    for entry in WalkDir::new(root).follow_links(true).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let file_path = entry.path();
        if !is_supported_audio_path(file_path) {
            continue;
        }
        let track = match read_library_track(file_path) {
            Ok(track) => track,
            Err(_) => LibraryTrack {
                path: file_path.to_string_lossy().to_string(),
                title: track_title_from_path(file_path),
                artist: None,
                album: None,
                duration: 0.0,
            },
        };
        tracks.push(track);
    }
    Ok(tracks)
}

fn queue_add_impl(shared: &SharedState, tracks: Vec<LibraryTrack>, replace: bool) -> usize {
    let mut state = shared.inner.lock().unwrap();
    if replace {
        state.queue = tracks;
        state.queue_index = None;
    } else {
        state.queue.extend(tracks);
    }
    if let Some(path) = state.file_path.as_ref() {
        state.queue_index = state.queue.iter().position(|track| &track.path == path);
    } else {
        state.queue_index = None;
    }
    state.queue.len()
}

fn queue_next_impl(shared: &SharedState) -> Result<Option<LibraryTrack>> {
    let next = {
        let mut state = shared.inner.lock().unwrap();
        if state.queue.is_empty() {
            return Ok(None);
        }
        let next_index = match state.queue_index {
            Some(idx) => idx.saturating_add(1),
            None => 0,
        };
        if next_index >= state.queue.len() {
            return Ok(None);
        }
        state.queue_index = Some(next_index);
        state.queue[next_index].clone()
    };

    load_file_impl(shared, next.path.clone())?;
    play_impl(shared)?;
    Ok(Some(next))
}

#[derive(Debug, Clone)]
struct ParsedCommand {
    action: String,
    query: Option<String>,
    raw: String,
}

#[derive(Debug, Clone)]
struct CommandResult {
    action: String,
    matches: usize,
    track: Option<LibraryTrack>,
}

fn normalize_command_text(text: &str) -> String {
    text.trim().to_lowercase()
}

fn extract_query(raw: &str, key: &str) -> Option<String> {
    if let Some(pos) = raw.find(key) {
        let tail = raw[(pos + key.len())..].trim();
        if tail.is_empty() {
            None
        } else {
            Some(tail.to_string())
        }
    } else {
        None
    }
}

fn parse_command_text(text: &str) -> Option<ParsedCommand> {
    let raw = text.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let normalized = normalize_command_text(&raw);
    let action = if normalized.contains("暂停") || normalized.contains("pause") {
        "pause"
    } else if normalized.contains("停止") || normalized.contains("stop") {
        "stop"
    } else if normalized.contains("下一曲") || normalized.contains("next") {
        "next"
    } else if normalized.contains("上一曲") || normalized.contains("previous") {
        "prev"
    } else if normalized.contains("继续") || normalized.contains("resume") {
        "play"
    } else if normalized.contains("播放") || normalized.contains("play") {
        "play"
    } else {
        "unknown"
    };

    let mut query = None;
    if action == "play" {
        query = extract_query(&raw, "播放")
            .or_else(|| extract_query(&normalized, "play "))
            .or_else(|| extract_query(&normalized, "play"));
    }
    Some(ParsedCommand {
        action: action.to_string(),
        query,
        raw,
    })
}

fn track_matches_query(track: &LibraryTrack, query: &str) -> bool {
    let q = query.to_lowercase();
    let mut haystacks = Vec::new();
    if let Some(title) = &track.title {
        haystacks.push(title.as_str());
    }
    if let Some(artist) = &track.artist {
        haystacks.push(artist.as_str());
    }
    if let Some(album) = &track.album {
        haystacks.push(album.as_str());
    }
    haystacks.push(track.path.as_str());
    for item in haystacks {
        if item.to_lowercase().contains(&q) {
            return true;
        }
    }
    false
}

fn cover_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("NTMUSIC_COVER_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::temp_dir().join("ntmusic_covers")
}

fn cover_extension(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

fn cover_hash_key(path: &Path) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    hasher.finish()
}

fn write_cover_file(path: &Path, data: &[u8], media_type: &str) -> Result<PathBuf> {
    let dir = cover_dir();
    std::fs::create_dir_all(&dir).context("create cover dir")?;
    let hash = cover_hash_key(path);
    let ext = cover_extension(media_type);
    let filename = format!("cover_{}.{}", hash, ext);
    let cover_path = dir.join(filename);
    if cover_path.exists() {
        return Ok(cover_path);
    }
    std::fs::write(&cover_path, data).context("write cover file")?;
    Ok(cover_path)
}

fn extract_cover_art(path: &Path) -> Result<Option<(Vec<u8>, String)>> {
    let file = File::open(path).with_context(|| format!("open {:?}", path))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .with_context(|| format!("probe {:?}", path))?;
    let mut format = probed.format;
    let visuals = format
        .metadata()
        .current()
        .map(|rev| rev.visuals().to_vec())
        .unwrap_or_default();
    if visuals.is_empty() {
        return Ok(None);
    }
    let preferred = visuals.iter().find(|visual| {
        matches!(visual.usage, Some(StandardVisualKey::CoverFront))
    });
    let visual = preferred.unwrap_or_else(|| &visuals[0]);
    let data = visual.data.to_vec();
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some((data, visual.media_type.clone())))
}

fn handle_command_impl(shared: &SharedState, cmd: ParsedCommand) -> Result<CommandResult> {
    match cmd.action.as_str() {
        "pause" => {
            pause_impl(shared)?;
            Ok(CommandResult {
                action: cmd.action,
                matches: 0,
                track: None,
            })
        }
        "stop" => {
            stop_impl(shared)?;
            Ok(CommandResult {
                action: cmd.action,
                matches: 0,
                track: None,
            })
        }
        "next" => match queue_next_impl(shared)? {
            Some(track) => Ok(CommandResult {
                action: cmd.action,
                matches: 1,
                track: Some(track),
            }),
            None => Err(anyhow!("queue empty")),
        },
        "play" => {
            if let Some(query) = cmd.query.clone().filter(|q| !q.is_empty()) {
                let library = {
                    let state = shared.inner.lock().unwrap();
                    state.library.clone()
                };
                if library.is_empty() {
                    return Err(anyhow!("library empty, scan first"));
                }
                let matches: Vec<LibraryTrack> = library
                    .into_iter()
                    .filter(|track| track_matches_query(track, &query))
                    .collect();
                if matches.is_empty() {
                    return Err(anyhow!("no matches for query"));
                }
                let count = matches.len();
                queue_add_impl(shared, matches, true);
                let next = queue_next_impl(shared)?;
                Ok(CommandResult {
                    action: cmd.action,
                    matches: count,
                    track: next,
                })
            } else {
                let has_file = {
                    let state = shared.inner.lock().unwrap();
                    state.file_path.is_some()
                };
                if has_file {
                    play_impl(shared)?;
                    return Ok(CommandResult {
                        action: cmd.action,
                        matches: 0,
                        track: None,
                    });
                }
                match queue_next_impl(shared)? {
                    Some(track) => Ok(CommandResult {
                        action: cmd.action,
                        matches: 1,
                        track: Some(track),
                    }),
                    None => Err(anyhow!("no track loaded")),
                }
            }
        }
        "prev" => Err(anyhow!("previous track not implemented")),
        _ => Err(anyhow!("unknown command")),
    }
}

fn start_capture_impl(
    shared: &SharedState,
    device_id: Option<String>,
    samplerate: Option<u32>,
    channels: Option<u16>,
) -> Result<()> {
    stop_stream(shared);
    let (sample_rate, channels) = {
        let mut state = shared.inner.lock().unwrap();
        state.mode = "capture".to_string();
        state.sample_rate = samplerate.unwrap_or(48_000);
        state.channels = channels.unwrap_or(2) as usize;
        state.source_sample_rate = state.sample_rate;
        state.source_channels = state.channels;
        state.source_bit_depth = None;
        state.data.clear();
        state.position = 0;
        state.played_frames = 0;
        state.duration = 0.0;
        state.buffered_frames = 0;
        state.stream_status = "starting".to_string();
        state.stream_url = device_id;
        (state.sample_rate, state.channels as u16)
    };
    reset_ring_buffer(shared);
    let child = match spawn_capture_ffmpeg(sample_rate, channels) {
        Ok(child) => child,
        Err(err) => {
            update_stream_status(shared, "error", Some(err.to_string()));
            return Err(err);
        }
    };
    start_stream_reader(shared.clone(), child);
    let _ = ensure_output_stream(shared);
    send_state(shared);
    Ok(())
}

fn stop_capture_impl(shared: &SharedState) -> Result<()> {
    stop_stream(shared);
    {
        let mut state = shared.inner.lock().unwrap();
        state.mode = "idle".to_string();
        state.is_playing = false;
        state.is_paused = false;
    }
    send_state(shared);
    Ok(())
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

struct DecodedAudio {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: usize,
    duration: f64,
    bit_depth: Option<u32>,
}

fn bit_depth_from_codec(codec_params: &CodecParameters) -> Option<u32> {
    if let Some(bits) = codec_params
        .bits_per_sample
        .or(codec_params.bits_per_coded_sample)
    {
        return Some(bits);
    }
    codec_params.sample_format.and_then(|format| match format {
        SampleFormat::U8 | SampleFormat::S8 => Some(8),
        SampleFormat::U16 | SampleFormat::S16 => Some(16),
        SampleFormat::U24 | SampleFormat::S24 => Some(24),
        SampleFormat::U32 | SampleFormat::S32 | SampleFormat::F32 => Some(32),
        SampleFormat::F64 => Some(64),
        _ => None,
    })
}

fn apply_gapless_trim(samples: Vec<f32>, channels: usize, delay: usize, padding: usize) -> Vec<f32> {
    if samples.is_empty() {
        return samples;
    }
    let channels = channels.max(1);
    let frame_count = samples.len() / channels;
    if delay == 0 && padding == 0 {
        return samples;
    }
    let start_frame = delay.min(frame_count);
    let end_frame = frame_count.saturating_sub(padding);
    if end_frame <= start_frame {
        return Vec::new();
    }
    let start = start_frame * channels;
    let end = (end_frame * channels).min(samples.len());
    samples[start..end].to_vec()
}

fn decode_file(path: &str) -> Result<DecodedAudio> {
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
        .unwrap_or(2)
        .max(1);
    let bit_depth = bit_depth_from_codec(codec_params);
    let gapless_delay = codec_params.delay.unwrap_or(0) as usize;
    let gapless_padding = codec_params.padding.unwrap_or(0) as usize;

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

    if gapless_delay > 0 || gapless_padding > 0 {
        samples = apply_gapless_trim(samples, channels, gapless_delay, gapless_padding);
    }

    let frames = samples.len() / channels.max(1);
    let duration = if sample_rate > 0 {
        frames as f64 / sample_rate as f64
    } else {
        0.0
    };
    Ok(DecodedAudio {
        samples,
        sample_rate,
        channels,
        duration,
        bit_depth,
    })
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

fn should_prefer_soxr(resampler_mode: &str, quality: &str, soxr_available: bool) -> bool {
    if resampler_mode == "soxr" {
        return true;
    }
    if resampler_mode == "rubato" {
        return false;
    }
    if !soxr_available {
        return false;
    }
    !matches!(quality, "low" | "std")
}

fn normalize_dither_bits(bits: u32) -> u32 {
    match bits {
        16 | 24 => bits,
        _ => 24,
    }
}

fn normalize_limiter_threshold(value: f32) -> f32 {
    value.clamp(0.7, 1.0)
}

#[cfg(test)]
mod gapless_tests {
    use super::apply_gapless_trim;

    #[test]
    fn gapless_trim_noop() {
        let samples = vec![0.1_f32, -0.2, 0.3, -0.4];
        let trimmed = apply_gapless_trim(samples.clone(), 2, 0, 0);
        assert_eq!(trimmed, samples);
    }

    #[test]
    fn gapless_trim_with_padding() {
        // 2 channels, 4 frames => 8 samples.
        let samples = (0..8).map(|v| v as f32).collect::<Vec<f32>>();
        // Trim 1 leading frame and 1 trailing frame => keep frames 1..3 (2 frames).
        let trimmed = apply_gapless_trim(samples, 2, 1, 1);
        assert_eq!(trimmed, vec![2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn gapless_trim_all() {
        let samples = vec![0.0_f32; 6];
        let trimmed = apply_gapless_trim(samples, 2, 2, 2);
        assert!(trimmed.is_empty());
    }
}

#[cfg(test)]
mod queue_tests {
    use super::{create_shared_state, queue_add_impl, LibraryTrack};

    fn track(path: &str) -> LibraryTrack {
        LibraryTrack {
            path: path.to_string(),
            title: None,
            artist: None,
            album: None,
            duration: 0.0,
        }
    }

    #[test]
    fn queue_add_sets_index_for_current_path() {
        let shared = create_shared_state();
        {
            let mut state = shared.inner.lock().unwrap();
            state.file_path = Some("b.flac".to_string());
        }
        let count = queue_add_impl(&shared, vec![track("a.flac"), track("b.flac")], true);
        assert_eq!(count, 2);
        let state = shared.inner.lock().unwrap();
        assert_eq!(state.queue_index, Some(1));
    }

    #[test]
    fn queue_add_clears_index_when_missing() {
        let shared = create_shared_state();
        {
            let mut state = shared.inner.lock().unwrap();
            state.file_path = Some("missing.flac".to_string());
        }
        let count = queue_add_impl(&shared, vec![track("a.flac")], true);
        assert_eq!(count, 1);
        let state = shared.inner.lock().unwrap();
        assert_eq!(state.queue_index, None);
    }
}

fn normalize_dither_type(value: &str) -> String {
    match value.to_lowercase().as_str() {
        "off" => "off".to_string(),
        "tpdf" => "tpdf".to_string(),
        "tpdf_ns1" => "tpdf_ns1".to_string(),
        "tpdf_ns2" => "tpdf_ns2".to_string(),
        _ => "tpdf".to_string(),
    }
}

fn reset_dither_shape_state(state: &mut EngineState) {
    state.dither_shape_err1.fill(0.0);
    state.dither_shape_err2.fill(0.0);
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

fn resample_for_output(shared: &SharedState, target_rate: u32) -> Result<()> {
    let (mode, channels, sample_rate, resampler_mode, resampler_quality, soxr_available, data, position) = {
        let mut state = shared.inner.lock().unwrap();
        if state.mode != "file" || state.data.is_empty() {
            return Ok(());
        }
        if state.sample_rate == target_rate || target_rate == 0 {
            return Ok(());
        }
        (
            state.mode.clone(),
            state.channels,
            state.sample_rate,
            state.resampler_mode.clone(),
            state.resampler_quality.clone(),
            state.soxr_available,
            std::mem::take(&mut state.data),
            state.position,
        )
    };

    if mode != "file" {
        return Ok(());
    }

    let quality = normalize_resampler_quality(&resampler_quality);
    let prefer_soxr = should_prefer_soxr(&resampler_mode, &quality, soxr_available);
    let resampled = if prefer_soxr {
        match resample_audio_soxr(&data, channels, sample_rate, target_rate) {
            Ok(out) => out,
            Err(err) => {
                if resampler_mode == "auto" {
                    error!("soxr resample failed, falling back to rubato: {}", err);
                    resample_audio(&data, channels, sample_rate, target_rate, &quality)?
                } else {
                    return Err(err);
                }
            }
        }
    } else {
        resample_audio(&data, channels, sample_rate, target_rate, &quality)?
    };

    let duration = if target_rate > 0 && channels > 0 {
        (resampled.len() / channels) as f64 / target_rate as f64
    } else {
        0.0
    };
    let scaled_pos = if sample_rate > 0 {
        ((position as f64) * target_rate as f64 / sample_rate as f64) as usize
    } else {
        0
    };

    let mut state = shared.inner.lock().unwrap();
    state.data = resampled;
    state.sample_rate = target_rate;
    state.duration = duration;
    state.position = scaled_pos.min(state.data.len() / state.channels.max(1));
    Ok(())
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

fn quantize_to_step(value: f32, step: f32) -> f32 {
    if step <= 0.0 {
        return value;
    }
    let scaled = (value / step).round();
    (scaled * step).clamp(-1.0, 1.0)
}

fn soft_limit_sample(sample: f32, threshold: f32) -> f32 {
    let limit = normalize_limiter_threshold(threshold);
    let abs = sample.abs();
    if abs <= limit {
        return sample;
    }
    let t = ((abs - limit) / (1.0 - limit)).min(1.0);
    let shaped = limit + (1.0 - limit) * (t + t * t - t * t * t);
    sample.signum() * shaped
}

fn apply_tpdf_dither_shaped(
    samples: &mut [f32],
    bits: u32,
    channels: usize,
    seed: &mut u64,
    err1: &mut [f32; MAX_DITHER_CHANNELS],
    err2: &mut [f32; MAX_DITHER_CHANNELS],
    order: u8,
) {
    let effective_bits = bits.clamp(8, 32);
    let denom = 1u64 << effective_bits.saturating_sub(1);
    let lsb = 1.0 / denom as f32;
    let channel_count = channels.max(1);
    if channel_count > MAX_DITHER_CHANNELS || order == 0 {
        apply_tpdf_dither(samples, effective_bits, seed);
        return;
    }
    for (idx, sample) in samples.iter_mut().enumerate() {
        let ch = idx % channel_count;
        let feedback = if order == 1 {
            DITHER_SHAPER_ORDER1_COEFF * err1[ch]
        } else {
            DITHER_SHAPER_ORDER2_COEFF1 * err1[ch] + DITHER_SHAPER_ORDER2_COEFF2 * err2[ch]
        };
        let shaped = *sample + feedback;
        let noise = (next_uniform(seed) - next_uniform(seed)) * lsb;
        let dithered = (shaped + noise).clamp(-1.0, 1.0);
        let quantized = quantize_to_step(dithered, lsb);
        let error = dithered - quantized;
        err2[ch] = err1[ch];
        err1[ch] = error;
        *sample = quantized;
    }
}

fn apply_dither_if_needed(state: &Arc<Mutex<EngineState>>, data: &mut [f32], target_bits: u32) {
    let (enabled, dither_type, bits, mut seed, channels, mut err1, mut err2) = {
        let guard = state.lock().unwrap();
        (
            guard.dither_enabled,
            guard.dither_type.clone(),
            guard.dither_bits,
            guard.dither_rng,
            guard.channels,
            guard.dither_shape_err1,
            guard.dither_shape_err2,
        )
    };
    if !enabled || dither_type == "off" {
        return;
    }
    let effective_bits = normalize_dither_bits(bits).min(target_bits);
    match dither_type.as_str() {
        "tpdf_ns1" => {
            apply_tpdf_dither_shaped(
                data,
                effective_bits,
                channels,
                &mut seed,
                &mut err1,
                &mut err2,
                1,
            );
        }
        "tpdf_ns2" => {
            apply_tpdf_dither_shaped(
                data,
                effective_bits,
                channels,
                &mut seed,
                &mut err1,
                &mut err2,
                2,
            );
        }
        _ => {
            apply_tpdf_dither(data, effective_bits, &mut seed);
        }
    }
    let mut guard = state.lock().unwrap();
    guard.dither_rng = seed;
    if dither_type == "tpdf_ns1" || dither_type == "tpdf_ns2" {
        guard.dither_shape_err1 = err1;
        guard.dither_shape_err2 = err2;
    }
}
fn ensure_output_stream(shared: &SharedState) -> Result<()> {
    let state_snapshot = shared.inner.lock().unwrap().clone();
    if state_snapshot.exclusive_mode {
        let hostapi = state_snapshot
            .device_id
            .and_then(device_hostapi_by_id)
            .unwrap_or_else(|| format!("{:?}", cpal::default_host().id()));
        if hostapi == "Wasapi" && cfg!(target_os = "windows") {
            if shared.exclusive_stream.lock().unwrap().is_some() {
                return Ok(());
            }
            shared.output_stream.lock().unwrap().0 = None;
            let ordinal = state_snapshot
                .device_id
                .and_then(wasapi_device_ordinal_by_id);
            match start_wasapi_exclusive_stream(shared, ordinal) {
                Ok(handle) => {
                    *shared.exclusive_stream.lock().unwrap() = Some(handle);
                    return Ok(());
                }
                Err(err) => {
                    error!("wasapi exclusive start failed: {}", err);
                    let mut state = shared.inner.lock().unwrap();
                    state.exclusive_mode = false;
                }
            }
        }
    } else if shared.exclusive_stream.lock().unwrap().is_some() {
        stop_exclusive_stream(shared);
    }

    let mut guard = shared.output_stream.lock().unwrap();
    if guard.0.is_some() {
        return Ok(());
    }

    let host = cpal::default_host();
    let device = if let Some(id) = state_snapshot.device_id {
        find_device_by_id(id).unwrap_or_else(|| host.default_output_device().unwrap())
    } else {
        host.default_output_device().ok_or_else(|| anyhow!("no output device"))?
    };

    let default_config = device.default_output_config()?;
    let mut sample_format = default_config.sample_format();
    let mut config = default_config.config();
    let target_rate = state_snapshot
        .target_samplerate
        .unwrap_or(state_snapshot.sample_rate)
        .max(8000);
    let target_channels = state_snapshot.channels.max(1) as u16;
    config.channels = target_channels;

    let mut matched = None;
    if let Ok(supported) = device.supported_output_configs() {
        for range in supported {
            if range.channels() != target_channels {
                continue;
            }
            let min_rate = range.min_sample_rate().0;
            let max_rate = range.max_sample_rate().0;
            if target_rate >= min_rate && target_rate <= max_rate {
                matched = Some(range.with_sample_rate(cpal::SampleRate(target_rate)));
                break;
            }
        }
    }

    if let Some(cfg) = matched {
        sample_format = cfg.sample_format();
        config = cfg.config();
    } else {
        let fallback_rate = default_config.sample_rate().0.max(8000);
        if fallback_rate != target_rate {
            if let Err(err) = resample_for_output(shared, fallback_rate) {
                error!("resample for output failed: {}", err);
            }
        }
        config.sample_rate = cpal::SampleRate(fallback_rate);
    }

    let state = shared.inner.clone();
    let consumer = shared.consumer.clone();
    let control_shared = shared.control_shared.clone();
    let output_scratch = shared.output_scratch.clone();

    let err_fn = |err| {
        error!("stream error: {}", err);
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config,
            move |data: &mut [f32], _| {
                fill_output_buffer(&state, &consumer, &control_shared, data);
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I16 => device.build_output_stream(
            &config,
            move |data: &mut [i16], _| {
                let mut scratch = output_scratch.lock().unwrap();
                if scratch.len() != data.len() {
                    scratch.resize(data.len(), 0.0);
                }
                fill_output_buffer(&state, &consumer, &control_shared, &mut scratch);
                apply_dither_if_needed(&state, &mut scratch, 16);
                for (dst, src) in data.iter_mut().zip(scratch.iter()) {
                    *dst = cpal::Sample::from_sample(*src);
                }
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::U16 => device.build_output_stream(
            &config,
            move |data: &mut [u16], _| {
                let mut scratch = output_scratch.lock().unwrap();
                if scratch.len() != data.len() {
                    scratch.resize(data.len(), 0.0);
                }
                fill_output_buffer(&state, &consumer, &control_shared, &mut scratch);
                apply_dither_if_needed(&state, &mut scratch, 16);
                for (dst, src) in data.iter_mut().zip(scratch.iter()) {
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

fn fill_output_buffer(
    state: &Arc<Mutex<EngineState>>,
    consumer: &Arc<Mutex<HeapCons<f32>>>,
    control_shared: &Option<Arc<Mutex<ControlShared>>>,
    data: &mut [f32],
) {
    let frames = data.len();
    let mut local = state.lock().unwrap();
    if let Some(control) = control_shared {
        if let Ok(guard) = control.try_lock() {
            drain_control_commands(&mut local, &guard);
        }
    }
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
    if local.limiter_enabled {
        let threshold = local.limiter_threshold;
        for sample in data.iter_mut() {
            *sample = soft_limit_sample(*sample, threshold);
        }
    }
    if local.last_output_chunk.len() != SPECTRUM_FFT_SIZE {
        local.last_output_chunk.resize(SPECTRUM_FFT_SIZE, 0.0);
    }
    let channels = local.channels.max(1) as usize;
    let frames = data.len() / channels;
    let copy_len = frames.min(SPECTRUM_FFT_SIZE);
    if copy_len > 0 {
        if channels == 1 {
            local.last_output_chunk[..copy_len].copy_from_slice(&data[..copy_len]);
        } else {
            for frame in 0..copy_len {
                let mut sum = 0.0f32;
                let base = frame * channels;
                for ch in 0..channels {
                    sum += data[base + ch];
                }
                local.last_output_chunk[frame] = sum / channels as f32;
            }
        }
    }
    if copy_len < SPECTRUM_FFT_SIZE {
        for value in &mut local.last_output_chunk[copy_len..] {
            *value = 0.0;
        }
    }
}
fn enumerate_devices() -> Vec<DeviceInfo> {
    let mut devices = Vec::new();
    let mut index = 0usize;
    for host_id in cpal::available_hosts() {
        if let Ok(host) = cpal::host_from_id(host_id) {
            if let Ok(outputs) = host.output_devices() {
                for device in outputs {
                    let name = device.name().unwrap_or_else(|_| "Unknown".to_string());
                    let sample_rate = device
                        .default_output_config()
                        .map(|c| c.sample_rate().0)
                        .unwrap_or(48_000);
                    devices.push(DeviceInfo {
                        id: index,
                        name,
                        hostapi: format!("{:?}", host_id),
                        default_samplerate: sample_rate,
                    });
                    index += 1;
                }
            }
        }
    }
    devices
}

fn list_devices() -> Value {
    let mut wasapi = Vec::new();
    let mut asio = Vec::new();
    let mut other = Vec::new();
    for info in enumerate_devices() {
        match info.hostapi.as_str() {
            "Wasapi" => wasapi.push(info),
            "Asio" => asio.push(info),
            _ => other.push(info),
        }
    }
    json!({
        "wasapi": wasapi,
        "asio": asio,
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

fn device_hostapi_by_id(target: usize) -> Option<String> {
    let mut index = 0usize;
    for host_id in cpal::available_hosts() {
        if let Ok(host) = cpal::host_from_id(host_id) {
            if let Ok(devices) = host.output_devices() {
                for _device in devices {
                    if index == target {
                        return Some(format!("{:?}", host_id));
                    }
                    index += 1;
                }
            }
        }
    }
    None
}

fn wasapi_device_ordinal_by_id(target: usize) -> Option<u32> {
    let mut index = 0usize;
    let mut ordinal = 0u32;
    for host_id in cpal::available_hosts() {
        if let Ok(host) = cpal::host_from_id(host_id) {
            if let Ok(devices) = host.output_devices() {
                for _device in devices {
                    if index == target {
                        if format!("{:?}", host_id) == "Wasapi" {
                            return Some(ordinal);
                        }
                        return None;
                    }
                    if format!("{:?}", host_id) == "Wasapi" {
                        ordinal += 1;
                    }
                    index += 1;
                }
            }
        }
    }
    None
}

fn resolve_exclusive_mode(device_id: Option<usize>, requested: bool) -> bool {
    if !requested {
        return false;
    }
    if let Some(id) = device_id {
        if let Some(hostapi) = device_hostapi_by_id(id) {
            if hostapi == "Asio" {
                return true;
            }
            if hostapi == "Wasapi" {
                return cfg!(target_os = "windows");
            }
            return false;
        }
    }
    if cfg!(target_os = "windows") {
        let hostapi = format!("{:?}", cpal::default_host().id());
        return hostapi == "Asio" || hostapi == "Wasapi";
    }
    false
}

fn stop_exclusive_stream(shared: &SharedState) {
    let mut guard = shared.exclusive_stream.lock().unwrap();
    if let Some(mut handle) = guard.take() {
        handle.stop();
    }
}

#[cfg(target_os = "windows")]
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = 0xFFFE;

#[cfg(target_os = "windows")]
fn channel_mask_for(channels: u16) -> u32 {
    match channels {
        1 => SPEAKER_FRONT_CENTER,
        2 => SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT,
        6 => {
            SPEAKER_FRONT_LEFT
                | SPEAKER_FRONT_RIGHT
                | SPEAKER_FRONT_CENTER
                | SPEAKER_LOW_FREQUENCY
                | SPEAKER_BACK_LEFT
                | SPEAKER_BACK_RIGHT
        }
        8 => {
            SPEAKER_FRONT_LEFT
                | SPEAKER_FRONT_RIGHT
                | SPEAKER_FRONT_CENTER
                | SPEAKER_LOW_FREQUENCY
                | SPEAKER_BACK_LEFT
                | SPEAKER_BACK_RIGHT
                | SPEAKER_SIDE_LEFT
                | SPEAKER_SIDE_RIGHT
        }
        _ => 0,
    }
}

#[cfg(target_os = "windows")]
struct ComInit;

#[cfg(target_os = "windows")]
impl ComInit {
    fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|err| anyhow!("CoInitializeEx failed: {}", err))?;
        }
        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for ComInit {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

#[cfg(target_os = "windows")]
fn build_wave_format(channels: u16, sample_rate: u32) -> WAVEFORMATEXTENSIBLE {
    let mut format = WAVEFORMATEXTENSIBLE::default();
    format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE_TAG;
    format.Format.nChannels = channels;
    format.Format.nSamplesPerSec = sample_rate;
    format.Format.wBitsPerSample = 32;
    format.Format.nBlockAlign = channels.saturating_mul(4);
    format.Format.nAvgBytesPerSec = sample_rate.saturating_mul(format.Format.nBlockAlign as u32);
    format.Format.cbSize = (std::mem::size_of::<WAVEFORMATEXTENSIBLE>()
        - std::mem::size_of::<WAVEFORMATEX>()) as u16;
    format.Samples = WAVEFORMATEXTENSIBLE_0 {
        wValidBitsPerSample: 32,
    };
    format.dwChannelMask = channel_mask_for(channels);
    format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    format
}

#[cfg(target_os = "windows")]
fn select_wasapi_device(
    enumerator: &IMMDeviceEnumerator,
    device_ordinal: Option<u32>,
) -> Result<IMMDevice> {
    unsafe {
        if let Some(ordinal) = device_ordinal {
            let collection =
                enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
            let count = collection
                .GetCount()
                .map_err(|err| anyhow!("GetCount failed: {}", err))?;
            if ordinal >= count {
                return Err(anyhow!("WASAPI device ordinal out of range"));
            }
            let device = collection
                .Item(ordinal)
                .map_err(|err| anyhow!("EnumAudioEndpoints item failed: {}", err))?;
            Ok(device)
        } else {
            enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|err| anyhow!("GetDefaultAudioEndpoint failed: {}", err))
        }
    }
}

#[cfg(target_os = "windows")]
fn run_wasapi_exclusive_loop(
    stop: Arc<AtomicBool>,
    state: Arc<Mutex<EngineState>>,
    consumer: Arc<Mutex<HeapCons<f32>>>,
    control_shared: Option<Arc<Mutex<ControlShared>>>,
    device_ordinal: Option<u32>,
    sample_rate: u32,
    channels: u16,
) -> Result<()> {
    let _com = ComInit::new()?;
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|err| anyhow!("CoCreateInstance failed: {}", err))?
    };
    let device = select_wasapi_device(&enumerator, device_ordinal)?;
    let audio_client: IAudioClient = unsafe {
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|err| anyhow!("IMMDevice Activate failed: {}", err))?
    };
    let format = build_wave_format(channels, sample_rate);
    unsafe {
        audio_client
            .IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &format.Format, None)
            .ok()
            .map_err(|err| anyhow!("Exclusive format unsupported: {}", err))?;
    }
    let mut default_period = 0i64;
    let mut min_period = 0i64;
    unsafe {
        audio_client
            .GetDevicePeriod(Some(&mut default_period), Some(&mut min_period))
            .map_err(|err| anyhow!("GetDevicePeriod failed: {}", err))?;
    }
    let period = if default_period > 0 {
        default_period
    } else if min_period > 0 {
        min_period
    } else {
        10_000
    };
    unsafe {
        audio_client
            .Initialize(
                AUDCLNT_SHAREMODE_EXCLUSIVE,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                period,
                period,
                &format.Format,
                None,
            )
            .map_err(|err| anyhow!("IAudioClient Initialize failed: {}", err))?;
    }
    let event = unsafe {
        CreateEventA(None, false, false, PCSTR::null())
            .map_err(|err| anyhow!("CreateEventA failed: {}", err))?
    };
    unsafe {
        audio_client
            .SetEventHandle(event)
            .map_err(|err| anyhow!("SetEventHandle failed: {}", err))?;
    }
    let buffer_frames = unsafe {
        audio_client
            .GetBufferSize()
            .map_err(|err| anyhow!("GetBufferSize failed: {}", err))?
    };
    let render_client: IAudioRenderClient = unsafe {
        audio_client
            .GetService()
            .map_err(|err| anyhow!("GetService(IARenderClient) failed: {}", err))?
    };
    unsafe {
        audio_client
            .Start()
            .map_err(|err| anyhow!("AudioClient Start failed: {}", err))?;
    }
    let mut scratch = vec![0.0f32; buffer_frames as usize * channels as usize];
    while !stop.load(Ordering::Acquire) {
        let wait = unsafe { WaitForSingleObject(event, 100) };
        if wait != WAIT_OBJECT_0 {
            if wait == WAIT_TIMEOUT {
                continue;
            }
            continue;
        }
        let padding = unsafe {
            audio_client
                .GetCurrentPadding()
                .map_err(|err| anyhow!("GetCurrentPadding failed: {}", err))?
        };
        let available = buffer_frames.saturating_sub(padding);
        if available == 0 {
            continue;
        }
        let frames = available as usize;
        let needed = frames * channels as usize;
        if scratch.len() < needed {
            scratch.resize(needed, 0.0);
        }
        fill_output_buffer(&state, &consumer, &control_shared, &mut scratch[..needed]);
        let buffer = unsafe {
            render_client
                .GetBuffer(available)
                .map_err(|err| anyhow!("GetBuffer failed: {}", err))?
        };
        unsafe {
            std::ptr::copy_nonoverlapping(
                scratch.as_ptr(),
                buffer as *mut f32,
                needed,
            );
            render_client
                .ReleaseBuffer(available, 0)
                .map_err(|err| anyhow!("ReleaseBuffer failed: {}", err))?;
        }
    }
    unsafe {
        let _ = audio_client.Stop();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn start_wasapi_exclusive_stream(
    shared: &SharedState,
    device_ordinal: Option<u32>,
) -> Result<ExclusiveStreamHandle> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let state = shared.inner.clone();
    let consumer = shared.consumer.clone();
    let control_shared = shared.control_shared.clone();
    let (sample_rate, channels) = {
        let guard = state.lock().unwrap();
        (guard.sample_rate.max(8000), guard.channels.max(1) as u16)
    };
    let thread = thread::spawn(move || {
        if let Err(err) = run_wasapi_exclusive_loop(
            stop_flag,
            state,
            consumer,
            control_shared,
            device_ordinal,
            sample_rate,
            channels,
        ) {
            error!("wasapi exclusive stream failed: {}", err);
        }
    });
    Ok(ExclusiveStreamHandle {
        stop,
        thread: Some(thread),
    })
}

#[cfg(not(target_os = "windows"))]
fn start_wasapi_exclusive_stream(
    _shared: &SharedState,
    _device_ordinal: Option<u32>,
) -> Result<ExclusiveStreamHandle> {
    Err(anyhow!("WASAPI exclusive output is only supported on Windows"))
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

fn load_file_impl(shared: &SharedState, path: String) -> Result<()> {
    if !Path::new(&path).exists() {
        return Err(anyhow!("File not found"));
    }
    stop_stream(shared);
    let decoded = decode_file(&path).map_err(|err| anyhow!("decode failed: {}", err))?;
    let source_sample_rate = decoded.sample_rate;
    let source_channels = decoded.channels;
    let source_bit_depth = decoded.bit_depth;

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

    let mut final_data = decoded.samples;
    let mut final_sample_rate = decoded.sample_rate;
    if let Some(target) = target_samplerate {
        if target > 0 && target != final_sample_rate {
            let mode = normalize_resampler_mode(&resampler_mode);
            let quality = normalize_resampler_quality(&resampler_quality);
            let prefer_soxr = should_prefer_soxr(&mode, &quality, soxr_available);
            if prefer_soxr {
                match resample_audio_soxr(&final_data, source_channels, final_sample_rate, target) {
                    Ok(resampled) => {
                        final_data = resampled;
                        final_sample_rate = target;
                    }
                    Err(err) => {
                        if mode == "auto" {
                            error!("soxr resample failed, falling back to rubato: {}", err);
                            final_data = resample_audio(
                                &final_data,
                                source_channels,
                                final_sample_rate,
                                target,
                                &quality,
                            )
                                    .map_err(|e| anyhow!("resample failed: {}", e))?;
                            final_sample_rate = target;
                        } else {
                            return Err(anyhow!("soxr resample failed: {}", err));
                        }
                    }
                }
            } else {
                final_data = resample_audio(
                    &final_data,
                    source_channels,
                    final_sample_rate,
                    target,
                    &quality,
                )
                        .map_err(|e| anyhow!("resample failed: {}", e))?;
                final_sample_rate = target;
            }
        }
    }

    let duration = if final_sample_rate > 0 && source_channels > 0 {
        (final_data.len() / source_channels) as f64 / final_sample_rate as f64
    } else {
        0.0
    };

    {
        let mut state = shared.inner.lock().unwrap();
        state.data = final_data;
        state.sample_rate = final_sample_rate;
        state.channels = source_channels;
        state.source_sample_rate = source_sample_rate;
        state.source_channels = source_channels;
        state.source_bit_depth = source_bit_depth;
        state.position = 0;
        state.duration = duration;
        state.is_playing = false;
        state.is_paused = false;
        state.file_path = Some(path.clone());
        state.mode = "file".to_string();
        state.stream_status = "idle".to_string();
        state.queue_index = state.queue.iter().position(|track| track.path == path);
    }

    reset_ring_buffer(shared);
    let _ = ensure_output_stream(shared);
    send_state(shared);
    Ok(())
}

fn play_impl(shared: &SharedState) -> Result<()> {
    {
        let mut state = shared.inner.lock().unwrap();
        state.is_playing = true;
        state.is_paused = false;
    }
    let _ = ensure_output_stream(shared);
    send_state(shared);
    Ok(())
}

fn pause_impl(shared: &SharedState) -> Result<()> {
    {
        let mut state = shared.inner.lock().unwrap();
        state.is_paused = true;
    }
    send_state(shared);
    Ok(())
}

fn stop_impl(shared: &SharedState) -> Result<()> {
    {
        let mut state = shared.inner.lock().unwrap();
        state.is_playing = false;
        state.is_paused = false;
        state.position = 0;
        state.played_frames = 0;
        state.mode = "idle".to_string();
        state.buffered_frames = 0;
    }
    stop_stream(shared);
    send_state(shared);
    Ok(())
}

fn configure_output_impl(
    shared: &SharedState,
    device_id: Option<usize>,
    exclusive: Option<bool>,
) -> Result<()> {
    {
        let mut state = shared.inner.lock().unwrap();
        state.device_id = device_id;
        if let Some(exclusive) = exclusive {
            let effective = resolve_exclusive_mode(device_id, exclusive);
            if exclusive && !effective {
                info!("exclusive mode not supported for selected device, falling back to shared");
            }
            state.exclusive_mode = effective;
        } else if state.exclusive_mode {
            let effective = resolve_exclusive_mode(device_id, true);
            if !effective {
                info!("exclusive mode not supported for selected device, falling back to shared");
            }
            state.exclusive_mode = effective;
        }
    }
    stop_exclusive_stream(shared);
    shared.output_stream.lock().unwrap().0 = None;
    let _ = ensure_output_stream(shared);
    send_state(shared);
    Ok(())
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

async fn scan_library_handler(
    State(shared): State<SharedState>,
    Json(req): Json<LibraryScanRequest>,
) -> impl IntoResponse {
    match scan_library_impl(&req.path) {
        Ok(tracks) => {
            {
                let mut state = shared.inner.lock().unwrap();
                state.library = tracks.clone();
            }
            (StatusCode::OK, Json(json!({ "status": "success", "tracks": tracks })))
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "message": err.to_string() })),
        ),
    }
}

async fn queue_add_handler(
    State(shared): State<SharedState>,
    Json(req): Json<QueueAddRequest>,
) -> impl IntoResponse {
    let count = queue_add_impl(&shared, req.tracks, req.replace.unwrap_or(false));
    Json(json!({ "status": "success", "count": count }))
}

async fn queue_next_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    match queue_next_impl(&shared) {
        Ok(Some(track)) => (StatusCode::OK, Json(json!({ "status": "success", "track": track }))),
        Ok(None) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "message": "queue empty" })),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "status": "error", "message": err.to_string() })),
        ),
    }
}

async fn command_handler(
    State(shared): State<SharedState>,
    Json(req): Json<CommandRequest>,
) -> impl IntoResponse {
    let parsed = if let Some(action) = req.action.clone().filter(|a| !a.trim().is_empty()) {
        ParsedCommand {
            action,
            query: req.query.clone().filter(|q| !q.trim().is_empty()),
            raw: req.text.unwrap_or_default(),
        }
    } else if let Some(text) = req.text.as_ref() {
        match parse_command_text(text) {
            Some(cmd) => cmd,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "status": "error", "message": "command text empty" })),
                )
            }
        }
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "message": "command missing" })),
        );
    };

    match handle_command_impl(&shared, parsed.clone()) {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({
                "status": "success",
                "action": result.action,
                "matches": result.matches,
                "track": result.track,
                "raw": parsed.raw
            })),
        ),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "status": "error",
                "action": parsed.action,
                "message": err.to_string(),
                "raw": parsed.raw
            })),
        ),
    }
}

async fn cover_handler(
    State(_shared): State<SharedState>,
    Json(req): Json<CoverRequest>,
) -> impl IntoResponse {
    let path = Path::new(&req.path);
    if !path.exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": "error", "message": "file not found" })),
        );
    }
    match extract_cover_art(path) {
        Ok(Some((data, media_type))) => match write_cover_file(path, &data, &media_type) {
            Ok(saved) => (
                StatusCode::OK,
                Json(json!({
                    "status": "success",
                    "cover_path": saved.to_string_lossy().to_string(),
                    "media_type": media_type
                })),
            ),
            Err(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "status": "error", "message": err.to_string() })),
            ),
        },
        Ok(None) => (
            StatusCode::OK,
            Json(json!({ "status": "success", "cover_path": null })),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "status": "error", "message": err.to_string() })),
        ),
    }
}
async fn load_handler(State(shared): State<SharedState>, Json(req): Json<LoadRequest>) -> impl IntoResponse {
    match load_file_impl(&shared, req.path) {
        Ok(_) => {
            let state = shared.inner.lock().unwrap();
            (StatusCode::OK, Json(json!({ "status": "success", "state": build_state_view(&state) })))
        }
        Err(err) => {
            let message = err.to_string();
            let status = if message.contains("File not found") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "status": "error", "message": message })))
        }
    }
}

async fn play_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    let _ = play_impl(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn pause_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    let _ = pause_impl(&shared);
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn stop_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    let _ = stop_impl(&shared);
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
    let _ = configure_output_impl(&shared, req.device_id, req.exclusive);
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
        let normalized = normalize_dither_type(&value);
        if normalized != state.dither_type {
            reset_dither_shape_state(&mut state);
        }
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
            reset_dither_shape_state(&mut state);
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
    if let Some(value) = req.limiter_enabled {
        state.limiter_enabled = value;
    }
    if let Some(value) = req.limiter_threshold {
        state.limiter_threshold = normalize_limiter_threshold(value);
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
        state.source_sample_rate = state.sample_rate;
        state.source_channels = state.channels;
        state.source_bit_depth = None;
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
    if let Err(err) = start_capture_impl(&shared, req.device_id, req.samplerate, req.channels) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "status": "error",
                "message": err.to_string()
            })),
        );
    }
    let state = shared.inner.lock().unwrap();
    (
        StatusCode::OK,
        Json(json!({ "status": "success", "state": build_state_view(&state) })),
    )
}

async fn capture_stop_handler(State(shared): State<SharedState>) -> impl IntoResponse {
    if let Err(err) = stop_capture_impl(&shared) {
        return Json(json!({ "status": "error", "message": err.to_string() }));
    }
    let state = shared.inner.lock().unwrap();
    Json(json!({ "status": "success", "state": build_state_view(&state) }))
}

async fn spectrum_ws_handler(State(shared): State<SharedState>, Json(req): Json<SpectrumWsRequest>) -> impl IntoResponse {
    {
        let mut state = shared.inner.lock().unwrap();
        state.spectrum_ws_enabled = req.enabled;
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
        loop {
            let (sample_rate, ws_enabled) = {
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
                (state.sample_rate, state.spectrum_ws_enabled)
            };
            let spectrum = analyzer.compute(&sample_buffer, sample_rate);
            write_spectrum_shared(&spectrum_shared, spectrum);
            if ws_enabled {
                let payload = json!({ "type": "spectrum_data", "data": spectrum });
                let _ = state_clone.tx.send(payload.to_string());
            }
            tokio::time::sleep(Duration::from_millis(SPECTRUM_UPDATE_INTERVAL_MS)).await;
        }
    });
}

pub async fn run_http_server(
    shared: Option<SharedState>,
    port: Option<u16>,
) -> Result<()> {
    let _ = tracing_subscriber::fmt::try_init();
    let port = port
        .or_else(|| std::env::var("VMUSIC_ENGINE_PORT").ok().and_then(|v| v.parse::<u16>().ok()))
        .unwrap_or(55_554);

    let shared = match shared {
        Some(shared) => shared,
        None => create_shared_state(),
    };
    start_background_tasks(shared.clone());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/state", get(get_state_handler))
        .route("/devices", get(list_devices_handler))
        .route("/library/scan", post(scan_library_handler))
        .route("/queue/add", post(queue_add_handler))
        .route("/queue/next", post(queue_next_handler))
        .route("/command", post(command_handler))
        .route("/cover", post(cover_handler))
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
        .route("/spectrum/ws", post(spectrum_ws_handler))
        .route("/load_stream", post(load_stream_handler))
        .route("/capture/start", post(capture_start_handler))
        .route("/capture/stop", post(capture_stop_handler))
        .route("/capture/devices", get(capture_devices_handler))
        .route("/buffer/state", get(buffer_state_handler))
        .with_state(shared);

    let addr = format!("127.0.0.1:{}", port);
    info!("NTmusic engine listening on {}", addr);
    println!("VMUSIC_ENGINE_READY");
    axum::serve(tokio::net::TcpListener::bind(addr).await?, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_dither_type_accepts_shaped_variants() {
        assert_eq!(normalize_dither_type("tpdf_ns1"), "tpdf_ns1");
        assert_eq!(normalize_dither_type("TPDF_NS2"), "tpdf_ns2");
        assert_eq!(normalize_dither_type("off"), "off");
        assert_eq!(normalize_dither_type("unknown"), "tpdf");
    }

    #[test]
    fn quantize_to_step_aligns_to_lsb() {
        let step = 1.0 / 32768.0;
        let out = quantize_to_step(0.123456, step);
        let scaled = (out / step).round();
        let reconstructed = scaled * step;
        assert!((out - reconstructed).abs() < 1e-6);
        assert!(out <= 1.0 && out >= -1.0);
    }

    #[test]
    fn shaped_dither_advances_seed_and_bounds() {
        let mut data = vec![0.0f32; 64];
        let mut seed = 1u64;
        let mut err1 = [0.0f32; MAX_DITHER_CHANNELS];
        let mut err2 = [0.0f32; MAX_DITHER_CHANNELS];
        apply_tpdf_dither_shaped(&mut data, 16, 2, &mut seed, &mut err1, &mut err2, 1);
        assert_ne!(seed, 1u64);
        assert!(data.iter().all(|v| *v <= 1.0 && *v >= -1.0));
    }
}
