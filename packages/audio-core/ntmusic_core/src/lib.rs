use memmap2::MmapMut;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};
use ntmusic_engine::{DeviceInfo as CoreDeviceInfo, EngineHandle, LibraryTrack as CoreLibraryTrack};

const DEFAULT_SPECTRUM_BINS: u32 = 48;
const SPECTRUM_FILE_NAME: &str = "ntmusic_spectrum.bin";
const SPECTRUM_HEADER_BYTES: usize = std::mem::size_of::<u32>();
const DEFAULT_CONTROL_CAPACITY: u32 = 64;
const CONTROL_FILE_NAME: &str = "ntmusic_control.bin";
const CONTROL_HEADER_BYTES: usize = 16;
const CONTROL_CMD_BYTES: usize = 16;

#[napi(object)]
pub struct SpectrumSpec {
    pub path: String,
    pub bins: u32,
    pub byte_length: u32,
}

#[napi(object)]
pub struct ControlSpec {
    pub path: String,
    pub capacity: u32,
    pub byte_length: u32,
}

fn normalize_bins(bins: u32) -> u32 {
    if bins == 0 {
        DEFAULT_SPECTRUM_BINS
    } else {
        bins
    }
}

fn normalize_capacity(capacity: u32) -> u32 {
    if capacity == 0 {
        DEFAULT_CONTROL_CAPACITY
    } else {
        capacity
    }
}

fn ensure_spectrum_file(dir: &str, bins: u32) -> Result<(PathBuf, u32)> {
    let bins = normalize_bins(bins);
    let mut dir_path = PathBuf::from(dir);
    std::fs::create_dir_all(&dir_path)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    dir_path.push(SPECTRUM_FILE_NAME);
    let data_len = bins.saturating_mul(std::mem::size_of::<f32>() as u32);
    let file_len = (SPECTRUM_HEADER_BYTES as u32)
        .saturating_add(data_len);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&dir_path)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    file.set_len(file_len as u64)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    Ok((dir_path, data_len))
}

fn ensure_control_file(dir: &str, capacity: u32) -> Result<(PathBuf, u32)> {
    let capacity = normalize_capacity(capacity);
    let mut dir_path = PathBuf::from(dir);
    std::fs::create_dir_all(&dir_path)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    dir_path.push(CONTROL_FILE_NAME);
    let data_len = capacity.saturating_mul(CONTROL_CMD_BYTES as u32);
    let file_len = (CONTROL_HEADER_BYTES as u32).saturating_add(data_len);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&dir_path)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    file.set_len(file_len as u64)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    let mut mmap = unsafe {
        MmapMut::map_mut(&file)
            .map_err(|err| Error::from_reason(err.to_string()))?
    };
    let header_ptr = mmap.as_mut_ptr();
    let write_idx = unsafe { &*(header_ptr as *const AtomicU32) };
    let read_idx = unsafe { &*(header_ptr.add(4) as *const AtomicU32) };
    write_idx.store(0, Ordering::Release);
    read_idx.store(0, Ordering::Release);
    unsafe {
        *(header_ptr.add(8) as *mut u32) = capacity;
        *(header_ptr.add(12) as *mut u32) = 0;
    }
    Ok((dir_path, data_len))
}

#[napi]
pub fn create_spectrum_shm(dir: String, bins: u32) -> Result<SpectrumSpec> {
    let (path, byte_length) = ensure_spectrum_file(&dir, bins)?;
    Ok(SpectrumSpec {
        path: path.to_string_lossy().to_string(),
        bins: normalize_bins(bins),
        byte_length,
    })
}

#[napi]
pub fn create_control_shm(dir: String, capacity: u32) -> Result<ControlSpec> {
    let (path, byte_length) = ensure_control_file(&dir, capacity)?;
    Ok(ControlSpec {
        path: path.to_string_lossy().to_string(),
        capacity: normalize_capacity(capacity),
        byte_length,
    })
}

#[napi]
pub struct SpectrumReader {
    mmap: MmapMut,
    bins: usize,
    last_seq: u32,
}

#[napi]
impl SpectrumReader {
    #[napi(constructor)]
    pub fn new(path: String, bins: u32) -> Result<Self> {
        let bins = normalize_bins(bins) as usize;
        let path_buf = PathBuf::from(path);
        let data_len = bins.saturating_mul(std::mem::size_of::<f32>());
        let byte_len = SPECTRUM_HEADER_BYTES.saturating_add(data_len);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path_buf)
            .map_err(|err| Error::from_reason(err.to_string()))?;
        file.set_len(byte_len as u64)
            .map_err(|err| Error::from_reason(err.to_string()))?;
        let mmap = unsafe {
            MmapMut::map_mut(&file)
                .map_err(|err| Error::from_reason(err.to_string()))?
        };
        Ok(SpectrumReader {
            mmap,
            bins,
            last_seq: 0,
        })
    }

    #[napi]
    pub fn read_into(&mut self, mut target: Float32Array) -> Result<u32> {
        let target_slice = target.as_mut();
        let data_len = self.mmap.len().saturating_sub(SPECTRUM_HEADER_BYTES);
        let available_bins = data_len / std::mem::size_of::<f32>();
        let bins = self.bins.min(available_bins);
        if bins == 0 {
            return Ok(0);
        }
        let len = bins.min(target_slice.len());
        let seq = unsafe { &*(self.mmap.as_ptr() as *const AtomicU32) };
        let data_ptr = unsafe { self.mmap.as_ptr().add(SPECTRUM_HEADER_BYTES) as *const f32 };
        for _ in 0..2 {
            let seq_start = seq.load(Ordering::Acquire);
            if seq_start == self.last_seq && seq_start & 1 == 0 {
                return Ok(0);
            }
            if seq_start & 1 == 1 {
                continue;
            }
            let src = unsafe { std::slice::from_raw_parts(data_ptr, bins) };
            if len > 0 {
                target_slice[..len].copy_from_slice(&src[..len]);
            }
            if len < target_slice.len() {
                for value in &mut target_slice[len..] {
                    *value = 0.0;
                }
            }
            let seq_end = seq.load(Ordering::Acquire);
            if seq_start == seq_end && seq_end & 1 == 0 {
                self.last_seq = seq_end;
                return Ok(len as u32);
            }
        }
        for value in target_slice.iter_mut() {
            *value = 0.0;
        }
        Ok(0)
    }

    #[napi]
    pub fn bins(&self) -> u32 {
        self.bins as u32
    }
}

#[napi(object)]
#[derive(Clone)]
pub struct DeviceInfo {
    pub id: u32,
    pub name: String,
    pub hostapi: String,
    pub default_samplerate: u32,
}

#[napi(object)]
pub struct EngineStatusResult {
    pub status: String,
    pub message: Option<String>,
}

#[napi(object)]
pub struct DevicesResult {
    pub status: String,
    pub message: Option<String>,
    pub devices: Vec<DeviceInfo>,
}

#[napi(object)]
pub struct TrackInfo {
    pub path: Option<String>,
    pub title: Option<String>,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_depth: Option<u32>,
}

#[napi(object)]
pub struct LibraryTrack {
    pub path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: f64,
}

#[napi(object)]
pub struct LibraryScanResult {
    pub status: String,
    pub message: Option<String>,
    pub tracks: Vec<LibraryTrack>,
}

#[napi(object)]
pub struct QueueAddResult {
    pub status: String,
    pub message: Option<String>,
    pub count: u32,
}

#[napi(object)]
pub struct QueueNextResult {
    pub status: String,
    pub message: Option<String>,
    pub track: Option<LibraryTrack>,
}

#[napi(object)]
pub struct PositionInfo {
    pub current: f64,
    pub duration: f64,
    pub percent: f64,
}

fn resolve_engine_port() -> u16 {
    std::env::var("VMUSIC_ENGINE_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(55_554)
}

fn map_device(info: CoreDeviceInfo) -> DeviceInfo {
    DeviceInfo {
        id: info.id as u32,
        name: info.name,
        hostapi: info.hostapi,
        default_samplerate: info.default_samplerate,
    }
}

fn map_library_track(info: CoreLibraryTrack) -> LibraryTrack {
    LibraryTrack {
        path: info.path,
        title: info.title,
        artist: info.artist,
        album: info.album,
        duration: info.duration,
    }
}

fn map_library_track_to_core(track: LibraryTrack) -> CoreLibraryTrack {
    CoreLibraryTrack {
        path: track.path,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
    }
}

fn status_success() -> EngineStatusResult {
    EngineStatusResult {
        status: "success".to_string(),
        message: None,
    }
}

fn status_error(message: impl std::fmt::Display) -> EngineStatusResult {
    EngineStatusResult {
        status: "error".to_string(),
        message: Some(message.to_string()),
    }
}

#[napi]
pub struct AudioEngine {
    handle: Arc<Mutex<EngineHandle>>,
}

#[napi]
impl AudioEngine {
    #[napi(constructor)]
    pub fn new(_engine_url: Option<String>) -> Result<Self> {
        let handle = EngineHandle::new().map_err(|err| Error::from_reason(err.to_string()))?;
        let engine = AudioEngine {
            handle: Arc::new(Mutex::new(handle)),
        };
        let port = resolve_engine_port();
        if let Ok(guard) = engine.handle.lock() {
            let _ = guard.start_http_server(port);
        }
        Ok(engine)
    }

    #[napi]
    pub fn start_server(&self, port: Option<u16>) -> Result<EngineStatusResult> {
        let port = port.unwrap_or_else(resolve_engine_port);
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.start_http_server(port) {
            Ok(_) => Ok(status_success()),
            Err(err) => Ok(status_error(err)),
        }
    }

    #[napi]
    pub fn load(&self, path: String) -> Result<EngineStatusResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.load(path) {
            Ok(_) => Ok(status_success()),
            Err(err) => Ok(status_error(err)),
        }
    }

    #[napi]
    pub fn play(&self, path: Option<String>) -> Result<EngineStatusResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        if let Some(path) = path {
            match guard.load(path) {
                Ok(_) => match guard.play() {
                    Ok(_) => Ok(status_success()),
                    Err(err) => Ok(status_error(err)),
                },
                Err(err) => Ok(status_error(err)),
            }
        } else {
            match guard.play() {
                Ok(_) => Ok(status_success()),
                Err(err) => Ok(status_error(err)),
            }
        }
    }

    #[napi]
    pub fn resume(&self) -> Result<EngineStatusResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.play() {
            Ok(_) => Ok(status_success()),
            Err(err) => Ok(status_error(err)),
        }
    }

    #[napi]
    pub fn pause(&self) -> Result<EngineStatusResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.pause() {
            Ok(_) => Ok(status_success()),
            Err(err) => Ok(status_error(err)),
        }
    }

    #[napi]
    pub fn stop(&self) -> Result<EngineStatusResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.stop() {
            Ok(_) => Ok(status_success()),
            Err(err) => Ok(status_error(err)),
        }
    }

    #[napi]
    pub fn set_device(
        &self,
        device_id: Option<u32>,
        exclusive: Option<bool>,
    ) -> Result<EngineStatusResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.set_device(device_id.map(|id| id as usize), exclusive) {
            Ok(_) => Ok(status_success()),
            Err(err) => Ok(status_error(err)),
        }
    }

    #[napi]
    pub fn get_devices(&self) -> Result<DevicesResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        let devices = guard.get_devices().into_iter().map(map_device).collect();
        Ok(DevicesResult {
            status: "success".to_string(),
            message: None,
            devices,
        })
    }

    #[napi]
    pub fn current_track(&self) -> Result<TrackInfo> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        let track = guard.current_track();
        Ok(TrackInfo {
            path: track.path,
            title: track.title,
            duration: track.duration,
            sample_rate: track.sample_rate,
            channels: track.channels,
            bit_depth: track.bit_depth,
        })
    }

    #[napi]
    pub fn current_position(&self) -> Result<PositionInfo> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        let pos = guard.current_position();
        Ok(PositionInfo {
            current: pos.current,
            duration: pos.duration,
            percent: pos.percent,
        })
    }

    #[napi]
    pub fn scan_library(&self, dir: String) -> Result<LibraryScanResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.scan_library(dir) {
            Ok(tracks) => Ok(LibraryScanResult {
                status: "success".to_string(),
                message: None,
                tracks: tracks.into_iter().map(map_library_track).collect(),
            }),
            Err(err) => Ok(LibraryScanResult {
                status: "error".to_string(),
                message: Some(err.to_string()),
                tracks: Vec::new(),
            }),
        }
    }

    #[napi]
    pub fn queue_add(&self, tracks: Vec<LibraryTrack>, replace: Option<bool>) -> Result<QueueAddResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.queue_add(
            tracks.into_iter().map(map_library_track_to_core).collect(),
            replace.unwrap_or(false),
        ) {
            Ok(count) => Ok(QueueAddResult {
                status: "success".to_string(),
                message: None,
                count: count as u32,
            }),
            Err(err) => Ok(QueueAddResult {
                status: "error".to_string(),
                message: Some(err.to_string()),
                count: 0,
            }),
        }
    }

    #[napi]
    pub fn next_track(&self) -> Result<QueueNextResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.queue_next() {
            Ok(Some(track)) => Ok(QueueNextResult {
                status: "success".to_string(),
                message: None,
                track: Some(map_library_track(track)),
            }),
            Ok(None) => Ok(QueueNextResult {
                status: "error".to_string(),
                message: Some("queue empty".to_string()),
                track: None,
            }),
            Err(err) => Ok(QueueNextResult {
                status: "error".to_string(),
                message: Some(err.to_string()),
                track: None,
            }),
        }
    }

    #[napi]
    pub fn capture_start(
        &self,
        device_id: Option<String>,
        samplerate: Option<u32>,
        channels: Option<u16>,
    ) -> Result<EngineStatusResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.capture_start(device_id, samplerate, channels) {
            Ok(_) => Ok(status_success()),
            Err(err) => Ok(status_error(err)),
        }
    }

    #[napi]
    pub fn capture_stop(&self) -> Result<EngineStatusResult> {
        let guard = self.handle.lock().map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
        match guard.capture_stop() {
            Ok(_) => Ok(status_success()),
            Err(err) => Ok(status_error(err)),
        }
    }

    #[napi]
    pub fn start_loopback_capture(&self, enable: bool) -> Result<EngineStatusResult> {
        if enable {
            self.capture_start(None, None, None)
        } else {
            self.capture_stop()
        }
    }
}

#[napi]
pub struct ControlWriter {
    mmap: MmapMut,
    capacity: u32,
}

#[napi]
impl ControlWriter {
    #[napi(constructor)]
    pub fn new(path: String, capacity: u32) -> Result<Self> {
        let capacity = normalize_capacity(capacity);
        let path_buf = PathBuf::from(path);
        let data_len = (capacity as usize).saturating_mul(CONTROL_CMD_BYTES);
        let byte_len = CONTROL_HEADER_BYTES.saturating_add(data_len);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path_buf)
            .map_err(|err| Error::from_reason(err.to_string()))?;
        file.set_len(byte_len as u64)
            .map_err(|err| Error::from_reason(err.to_string()))?;
        let mut mmap = unsafe {
            MmapMut::map_mut(&file)
                .map_err(|err| Error::from_reason(err.to_string()))?
        };
        let header_ptr = mmap.as_mut_ptr();
        let write_idx = unsafe { &*(header_ptr as *const AtomicU32) };
        let read_idx = unsafe { &*(header_ptr.add(4) as *const AtomicU32) };
        write_idx.store(0, Ordering::Release);
        read_idx.store(0, Ordering::Release);
        unsafe {
            *(header_ptr.add(8) as *mut u32) = capacity;
            *(header_ptr.add(12) as *mut u32) = 0;
        }
        Ok(ControlWriter { mmap, capacity })
    }

    #[napi]
    pub fn push(&mut self, cmd: u32, value: f64) -> Result<bool> {
        let capacity = self.capacity.max(1);
        let value = value as f32;
        let header_ptr = self.mmap.as_mut_ptr();
        let write_idx = unsafe { &*(header_ptr as *const AtomicU32) };
        let read_idx = unsafe { &*(header_ptr.add(4) as *const AtomicU32) };
        let write = write_idx.load(Ordering::Acquire);
        let read = read_idx.load(Ordering::Acquire);
        let next = (write + 1) % capacity;
        if next == read {
            return Ok(false);
        }
        let cmd_offset = CONTROL_HEADER_BYTES + (write as usize * CONTROL_CMD_BYTES);
        unsafe {
            let cmd_ptr = header_ptr.add(cmd_offset);
            *(cmd_ptr as *mut u32) = cmd;
            *(cmd_ptr.add(4) as *mut f32) = value;
            *(cmd_ptr.add(8) as *mut u32) = 0;
            *(cmd_ptr.add(12) as *mut u32) = 0;
        }
        write_idx.store(next, Ordering::Release);
        Ok(true)
    }
}
