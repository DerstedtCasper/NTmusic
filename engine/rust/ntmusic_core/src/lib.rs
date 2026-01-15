use memmap2::MmapMut;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs::OpenOptions;
use std::path::PathBuf;

const DEFAULT_SPECTRUM_BINS: u32 = 48;
const SPECTRUM_FILE_NAME: &str = "ntmusic_spectrum.bin";

#[napi(object)]
pub struct SpectrumSpec {
    pub path: String,
    pub bins: u32,
    pub byte_length: u32,
}

fn normalize_bins(bins: u32) -> u32 {
    if bins == 0 {
        DEFAULT_SPECTRUM_BINS
    } else {
        bins
    }
}

fn ensure_spectrum_file(dir: &str, bins: u32) -> Result<(PathBuf, u32)> {
    let bins = normalize_bins(bins);
    let mut dir_path = PathBuf::from(dir);
    std::fs::create_dir_all(&dir_path)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    dir_path.push(SPECTRUM_FILE_NAME);
    let byte_len = bins
        .saturating_mul(std::mem::size_of::<f32>() as u32);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&dir_path)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    file.set_len(byte_len as u64)
        .map_err(|err| Error::from_reason(err.to_string()))?;
    Ok((dir_path, byte_len))
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
        let byte_len = bins.saturating_mul(std::mem::size_of::<f32>());
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
        let available_bins = self.mmap.len() / std::mem::size_of::<f32>();
        let bins = self.bins.min(available_bins);
        if bins == 0 {
            return Ok(0);
        }
        let len = bins.min(target_slice.len());
        let src = unsafe {
            std::slice::from_raw_parts(self.mmap.as_ptr() as *const f32, bins)
        };
        if len > 0 {
            target_slice[..len].copy_from_slice(&src[..len]);
        }
        if len < target_slice.len() {
            for value in &mut target_slice[len..] {
                *value = 0.0;
            }
        }
        Ok(len as u32)
    }

    #[napi]
    pub fn bins(&self) -> u32 {
        self.bins as u32
    }
}
