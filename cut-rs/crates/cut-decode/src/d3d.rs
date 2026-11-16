//! The D3D11 device a hardware decoder works on, its DXGI device manager, and reading a decoded texture back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_FORMAT_P010, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1};
use windows::Win32::Media::MediaFoundation::{IMFDXGIDeviceManager, MFCreateDXGIDeviceManager};
use windows::core::Interface;

use crate::Codec;
use crate::error::{DecodeError, Result};
use crate::mf::{fail, start};
use crate::video::PixelFormat;

/// A D3D11 device with video support, shared with the decoder through a DXGI device manager.
pub(crate) struct Device {
    pub(crate) device: ID3D11Device,
    context: ID3D11DeviceContext,
    pub(crate) manager: IMFDXGIDeviceManager,
    /// The adapter's name, as DXGI gives it.
    pub(crate) adapter: String,
}

pub(crate) fn adapter_at(index: u32) -> Result<IDXGIAdapter1> {
    // SAFETY: plain factory and enumeration calls returning owned interfaces.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(fail("CreateDXGIFactory1"))?;
        factory.EnumAdapters1(index).map_err(fail("IDXGIFactory1::EnumAdapters1"))
    }
}

pub(crate) fn name_of(adapter: &IDXGIAdapter1) -> String {
    // SAFETY: GetDesc1 fills a plain struct.
    let desc = unsafe { adapter.GetDesc1() }.unwrap_or_default();
    let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
    String::from_utf16_lossy(&desc.Description[..end])
}

/// The names of the GPUs DXGI lists, in its order (the index [`Device::new`] takes).
pub(crate) fn adapters() -> Vec<String> {
    (0..16).map_while(|i| adapter_at(i).ok()).map(|a| name_of(&a)).collect()
}

fn luid_of(adapter: &IDXGIAdapter1) -> u64 {
    // SAFETY: GetDesc1 fills a plain struct.
    let l = unsafe { adapter.GetDesc1() }.unwrap_or_default().AdapterLuid;
    (u64::from(l.HighPart as u32) << 32) | u64::from(l.LowPart)
}

/// Each GPU's name and its LUID written as the performance counters write it (`0xHHHHHHHH_0xLLLLLLLL`).
pub(crate) fn adapter_luids() -> Vec<(String, String)> {
    (0..16)
        .map_while(|i| adapter_at(i).ok())
        .map(|a| {
            let l = luid_of(&a);
            (name_of(&a), format!("0x{:08X}_0x{:08X}", l >> 32, l & 0xffff_ffff))
        })
        .collect()
}

/// The DXGI index of the adapter with this LUID (`HighPart << 32 | LowPart`).
pub(crate) fn adapter_with_luid(luid: u64) -> Option<u32> {
    (0..16).map_while(|i| adapter_at(i).ok().map(|a| (i, a))).find(|(_, a)| luid_of(a) == luid).map(|(i, _)| i)
}

/// The adapter `Device::new(None)` takes: the one the app draws on, once it said which ([`prefer`]).
static PREFERRED: AtomicU32 = AtomicU32::new(0);

/// Makes DXGI adapter `index` the one every decoder without an explicit adapter opens on.
pub(crate) fn prefer(index: u32) {
    PREFERRED.store(index, Ordering::Relaxed);
}

/// The adapter decoders open on by default.
pub(crate) fn preferred() -> u32 {
    PREFERRED.load(Ordering::Relaxed)
}

/// Devices a GPU its decoders share. Each costs the driver about 26 MB of process memory here, but decoders on one
/// device queue their work and the copies of their frames on its one context: with one device a GPU a seek of three
/// 1080p sources took a median 140 ms to the whole frame, with four 85 ms, as with a device each
/// (`cut-engine/tests/playback.rs`, NEXT.md).
const DEVICES: usize = 4;

// SAFETY: an ID3D11Device and a DXGI device manager are free-threaded, and the immediate context is multithread
// protected (made so in `Device::new`, which fails otherwise): the runtime takes a lock around each call, so decoders
// and rings on several threads may use one device.
unsafe impl Send for Device {}
// SAFETY: as above.
unsafe impl Sync for Device {}

impl Device {
    /// A device for a decoder on DXGI adapter `index` (`None`: the preferred one): one of at most [`DEVICES`] a GPU
    /// that decoders share (the least used), made when fewer are alive. Its context is multithread protected, as
    /// Media Foundation requires of a device it shares.
    pub(crate) fn shared(index: Option<u32>) -> Result<Arc<Self>> {
        static ALIVE: OnceLock<Mutex<HashMap<u32, Vec<Weak<Device>>>>> = OnceLock::new();
        let index = index.unwrap_or_else(preferred);
        let mut alive = ALIVE.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
        let list = alive.entry(index).or_default();
        list.retain(|w| w.strong_count() > 0);
        if list.len() >= DEVICES
            && let Some(d) = list.iter().filter_map(Weak::upgrade).min_by_key(Arc::strong_count)
        {
            return Ok(d);
        }
        let d = Arc::new(Self::new(Some(index))?);
        list.push(Arc::downgrade(&d));
        Ok(d)
    }

    /// A device on DXGI adapter `index` (`None`: the preferred one, at first the system's default, adapter 0).
    pub(crate) fn new(index: Option<u32>) -> Result<Self> {
        start()?;
        let adapter = adapter_at(index.unwrap_or_else(preferred))?;
        let mut device = None;
        let mut context = None;
        // SAFETY: the out pointers are valid locals; the device and context come back owned. An explicit adapter
        // takes the UNKNOWN driver type.
        unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(fail("D3D11CreateDevice"))?;
        let missing = || DecodeError::Platform { call: "D3D11CreateDevice", hresult: 0, message: "no device".into() };
        let device: ID3D11Device = device.ok_or_else(missing)?;
        let context = context.ok_or_else(missing)?;
        // SAFETY: the decoder calls the immediate context from its own threads; multithread protection makes the
        // context lock around each call, as Media Foundation requires of a shared device.
        unsafe {
            let mt = device.cast::<ID3D11Multithread>().map_err(fail("ID3D11Multithread"))?;
            let _ = mt.SetMultithreadProtected(true);
        }
        let mut token = 0;
        let mut manager = None;
        // SAFETY: valid out pointers; ResetDevice hands the manager our device with the token it gave.
        unsafe {
            MFCreateDXGIDeviceManager(&mut token, &mut manager).map_err(fail("MFCreateDXGIDeviceManager"))?;
        }
        let manager: IMFDXGIDeviceManager = manager.ok_or_else(missing)?;
        // SAFETY: as above.
        unsafe { manager.ResetDevice(&device, token) }.map_err(fail("IMFDXGIDeviceManager::ResetDevice"))?;
        Ok(Self { device, context, manager, adapter: name_of(&adapter) })
    }

    /// The immediate context (multithread protected).
    pub(crate) fn context(&self) -> &ID3D11DeviceContext {
        &self.context
    }

    /// Whether the GPU itself decodes `codec` at this pixel format (a DXVA decoder profile), rather than the system
    /// decoder decoding in software and copying into textures (what it does on the Basic Render Driver).
    pub(crate) fn decodes(&self, codec: Codec, format: PixelFormat) -> bool {
        let (profile, dxgi) = match (codec, format) {
            (Codec::H264, PixelFormat::Nv12) => (D3D11_DECODER_PROFILE_H264_VLD_NOFGT, DXGI_FORMAT_NV12),
            (Codec::Hevc, PixelFormat::Nv12) => (D3D11_DECODER_PROFILE_HEVC_VLD_MAIN, DXGI_FORMAT_NV12),
            (Codec::Hevc, PixelFormat::P010) => (D3D11_DECODER_PROFILE_HEVC_VLD_MAIN10, DXGI_FORMAT_P010),
            (Codec::Vp8, PixelFormat::Nv12) => (D3D11_DECODER_PROFILE_VP8_VLD, DXGI_FORMAT_NV12),
            (Codec::Vp9, PixelFormat::Nv12) => (D3D11_DECODER_PROFILE_VP9_VLD_PROFILE0, DXGI_FORMAT_NV12),
            (Codec::Vp9, PixelFormat::P010) => (D3D11_DECODER_PROFILE_VP9_VLD_10BIT_PROFILE2, DXGI_FORMAT_P010),
            (Codec::Av1, PixelFormat::Nv12) => (D3D11_DECODER_PROFILE_AV1_VLD_PROFILE0, DXGI_FORMAT_NV12),
            (Codec::Av1, PixelFormat::P010) => (D3D11_DECODER_PROFILE_AV1_VLD_PROFILE0, DXGI_FORMAT_P010),
            _ => return false,
        };
        // SAFETY: plain queries on a live device.
        unsafe {
            self.device
                .cast::<ID3D11VideoDevice>()
                .and_then(|v| v.CheckVideoDecoderFormat(&profile, dxgi))
                .is_ok_and(|ok| ok.as_bool())
        }
    }

    /// Copies slice `index` of a decoded NV12 or P010 texture to system memory: the visible `w x h` with rows of
    /// `w * bytes` packed, luma then interleaved chroma.
    pub(crate) fn read_back(&self, tex: &ID3D11Texture2D, index: u32, w: u32, h: u32, bytes: u32) -> Result<Vec<u8>> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: GetDesc fills a plain struct.
        unsafe { tex.GetDesc(&mut desc) };
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: desc.Width,
            Height: desc.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: desc.Format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging = None;
        // SAFETY: valid descriptor and out pointer.
        unsafe { self.device.CreateTexture2D(&staging_desc, None, Some(&mut staging)) }
            .map_err(fail("ID3D11Device::CreateTexture2D"))?;
        let staging = staging.ok_or_else(|| DecodeError::Platform {
            call: "ID3D11Device::CreateTexture2D",
            hresult: 0,
            message: "no texture".into(),
        })?;
        let (w, h) = (w.min(desc.Width) as usize, h.min(desc.Height) as usize);
        let row = w * bytes as usize;
        let mut out = vec![0u8; row * (h + h.div_ceil(2))];
        // SAFETY: the copy is between two textures of the same format and size; the mapped pointer is read only while
        // mapped, within RowPitch * (Height + Height / 2) bytes, the NV12/P010 layout of a staging texture.
        unsafe {
            self.context.CopySubresourceRegion(&staging, 0, 0, 0, 0, tex, index, None);
            let mut map = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut map))
                .map_err(fail("ID3D11DeviceContext::Map"))?;
            let pitch = map.RowPitch as usize;
            let base = map.pData.cast::<u8>().cast_const();
            let chroma = base.add(pitch * desc.Height as usize);
            for y in 0..h {
                std::ptr::copy_nonoverlapping(base.add(y * pitch), out.as_mut_ptr().add(y * row), row);
            }
            for y in 0..h.div_ceil(2) {
                std::ptr::copy_nonoverlapping(chroma.add(y * pitch), out.as_mut_ptr().add((h + y) * row), row);
            }
            self.context.Unmap(&staging, 0);
        }
        Ok(out)
    }
}

/// A texture's size, slices and flags.
pub(crate) fn describe(tex: &ID3D11Texture2D) -> crate::video::TextureInfo {
    let mut d = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: GetDesc fills a plain struct.
    unsafe { tex.GetDesc(&mut d) };
    crate::video::TextureInfo {
        width: d.Width,
        height: d.Height,
        slices: d.ArraySize,
        bind_flags: d.BindFlags,
        misc_flags: d.MiscFlags,
    }
}
