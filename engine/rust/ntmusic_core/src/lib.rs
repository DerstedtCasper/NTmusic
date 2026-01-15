use memmap2::MmapMut;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

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
        Ok(SpectrumReader { mmap, bins })
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
