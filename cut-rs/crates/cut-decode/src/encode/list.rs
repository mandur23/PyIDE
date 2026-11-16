//! The video encoders this PC has: each GPU's own hardware encoder transforms (listed per adapter, so a laptop's
//! integrated and discrete GPUs each show theirs), Windows' Direct3D 12 encoder transforms on each GPU (they are
//! listed once and work on the GPU whose device they are given), then the software ones.

use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIAdapter1, IDXGIFactory1};
use windows::Win32::Media::MediaFoundation::*;
use windows::core::GUID;

use crate::Codec;
use crate::error::Result;
use crate::mf::{Candidate, fail, start};

/// A video encoder transform the system lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderInfo {
    /// The transform's friendly name (`NVIDIA H.264 Encoder MFT`, `H264 Encoder MFT` ...).
    pub name: String,
    pub codec: Codec,
    /// A GPU's encoder (an asynchronous hardware transform).
    pub hardware: bool,
    /// The DXGI adapter it belongs to (index, name), for hardware encoders.
    pub adapter: Option<(u32, String)>,
    /// Its place in its listing, to find it again.
    slot: usize,
    /// A transform listed for no adapter in particular, given the adapter's D3D11 device.
    pub(crate) shared: bool,
}

impl EncoderInfo {
    /// Windows' Direct3D 12 encoder on a GPU (listed for no adapter in particular), not the GPU maker's own.
    pub fn direct3d12(&self) -> bool {
        self.shared
    }

    /// `name`, with the GPU for a hardware encoder: what the export dialog and the report show.
    pub fn label(&self) -> String {
        match &self.adapter {
            Some((_, gpu)) => format!("{} ({gpu})", self.name),
            None => self.name.clone(),
        }
    }
}

fn output_of(codec: Codec) -> GUID {
    match codec {
        Codec::Hevc => MFVideoFormat_HEVC,
        _ => MFVideoFormat_H264,
    }
}

/// The hardware GPUs DXGI lists: index, name, LUID.
fn gpus() -> Vec<(u32, String, u64)> {
    let mut out = Vec::new();
    // SAFETY: plain factory and enumeration calls returning owned interfaces and plain structs.
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return out };
        for i in 0..16 {
            let Ok(adapter): windows::core::Result<IDXGIAdapter1> = factory.EnumAdapters1(i) else { break };
            let Ok(d) = adapter.GetDesc1() else { continue };
            if d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let end = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
            let luid = (u64::from(d.AdapterLuid.HighPart as u32) << 32) | u64::from(d.AdapterLuid.LowPart);
            out.push((i, String::from_utf16_lossy(&d.Description[..end]), luid));
        }
    }
    out
}

fn enumerate(codec: Codec, flags: MFT_ENUM_FLAG, luid: Option<u64>) -> Result<Vec<Candidate>> {
    start()?;
    let out = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: output_of(codec) };
    let mut attrs = None;
    // SAFETY: a fresh attribute store; the out pointer is a valid local.
    unsafe { MFCreateAttributes(&mut attrs, 1) }.map_err(fail("MFCreateAttributes"))?;
    let attrs: IMFAttributes = attrs.ok_or_else(|| crate::DecodeError::Unsupported("no attribute store".into()))?;
    if let Some(l) = luid {
        // SAFETY: the key lives for the call.
        unsafe { attrs.SetBlob(&MFT_ENUM_ADAPTER_LUID, &l.to_le_bytes()) }.map_err(fail("IMFAttributes::SetBlob"))?;
    }
    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut n = 0u32;
    // SAFETY: the type info, attributes and out pointers are valid; the array holds `n` activates, each moved out once
    // before the array is freed.
    let activates: Vec<IMFActivate> = unsafe {
        MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, flags, None, Some(&out), &attrs, &mut list, &mut n)
            .map_err(fail("MFTEnum2"))?;
        if list.is_null() {
            return Ok(Vec::new());
        }
        let items = std::slice::from_raw_parts_mut(list, n as usize).iter_mut().filter_map(Option::take).collect();
        windows::Win32::System::Com::CoTaskMemFree(Some(list as *const _));
        items
    };
    Ok(activates.into_iter().map(Candidate::from_activate).collect())
}

const HARDWARE: MFT_ENUM_FLAG = MFT_ENUM_FLAG(MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0);
const ANY_HARDWARE: MFT_ENUM_FLAG =
    MFT_ENUM_FLAG(MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_ASYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0);
const SOFTWARE: MFT_ENUM_FLAG = MFT_ENUM_FLAG(MFT_ENUM_FLAG_SYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0);

/// The hardware transforms listed for no adapter in particular (Windows' Direct3D 12 encoders).
fn shared(codec: Codec, own: &[String]) -> Result<Vec<(usize, Candidate)>> {
    Ok(enumerate(codec, ANY_HARDWARE, None)?.into_iter().enumerate().filter(|(_, c)| !own.contains(&c.name)).collect())
}

/// The encoders of `codec`: each GPU's own hardware ones in DXGI's adapter order, the Direct3D 12 ones on each GPU,
/// then the software ones. An encoder listed twice for one GPU (AMD registers its transform twice) is shown once.
pub fn video_encoders(codec: Codec) -> Vec<EncoderInfo> {
    let mut out: Vec<EncoderInfo> = Vec::new();
    let gpus = gpus();
    let mut own = Vec::new();
    for (index, gpu, luid) in &gpus {
        for (slot, c) in enumerate(codec, HARDWARE, Some(*luid)).unwrap_or_default().into_iter().enumerate() {
            own.push(c.name.clone());
            let adapter = Some((*index, gpu.clone()));
            if !out.iter().any(|e| e.name == c.name && e.adapter == adapter) {
                out.push(EncoderInfo { name: c.name, codec, hardware: true, adapter, slot, shared: false });
            }
        }
    }
    let common = shared(codec, &own).unwrap_or_default();
    for (index, gpu, _) in &gpus {
        for (slot, c) in &common {
            let adapter = Some((*index, gpu.clone()));
            out.push(EncoderInfo { name: c.name.clone(), codec, hardware: true, adapter, slot: *slot, shared: true });
        }
    }
    for (slot, c) in enumerate(codec, SOFTWARE, None).unwrap_or_default().into_iter().enumerate() {
        out.push(EncoderInfo { name: c.name, codec, hardware: false, adapter: None, slot, shared: false });
    }
    out
}

/// The transform an [`EncoderInfo`] names, listed again.
pub(crate) fn find(info: &EncoderInfo) -> Result<Candidate> {
    let gone = || crate::DecodeError::Unsupported(format!("the encoder {} is not listed any more", info.label()));
    let list = match &info.adapter {
        Some(_) if info.shared => enumerate(info.codec, ANY_HARDWARE, None)?,
        Some((index, _)) => {
            let luid = gpus().into_iter().find(|g| g.0 == *index).map(|g| g.2).ok_or_else(gone)?;
            enumerate(info.codec, HARDWARE, Some(luid))?
        }
        None => enumerate(info.codec, SOFTWARE, None)?,
    };
    list.into_iter().nth(info.slot).filter(|c| c.name == info.name).ok_or_else(gone)
}

/// The vendor of a hardware transform as `VEN_xxxx` (`VEN_10DE` NVIDIA, `VEN_1002` AMD, `VEN_1414` Microsoft).
pub(crate) fn vendor(c: &Candidate) -> Option<String> {
    c.attr_string(&MFT_ENUM_HARDWARE_VENDOR_ID_Attribute)
}
