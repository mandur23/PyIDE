//! The encoder's input pictures from a pool the transform recycles (`IMFVideoSampleAllocatorEx`), so no picture
//! allocates. For a hardware encoder given a device of its GPU the pool holds D3D11 textures there: a picture is
//! written into a staging texture (a ring of them, so the CPU never waits for the GPU's copy of the one before) and
//! copied on the GPU, instead of the transform copying system memory into a surface itself inside `ProcessInput`.
//! Otherwise the pool holds memory buffers, reused instead of a fresh 3 MB (12 MB at 4K) allocation a frame.

use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Media::MediaFoundation::*;
use windows::core::Interface;

use crate::d3d::Device;
use crate::error::{DecodeError, Result};
use crate::mf::{MediaType, Sample, fail};

/// Pictures in the pool: the transform holds a few while it encodes.
const POOL: u32 = 8;
/// Staging textures written in turn.
const STAGING: usize = 3;

/// The input pictures of one encoder: NV12, `width` x `height`.
pub(crate) struct Upload {
    allocator: IMFVideoSampleAllocatorEx,
    width: u32,
    height: u32,
    staging: Vec<ID3D11Texture2D>,
    next: usize,
}

impl Upload {
    /// A pool of pictures of the input type `t`: textures on `device` when given, else memory.
    pub(crate) fn new(device: Option<&Device>, t: &MediaType, width: u32, height: u32) -> Result<Self> {
        // SAFETY: plain constructors and setters on owned COM objects; the IID matches the out interface; the texture
        // descriptions are valid locals.
        unsafe {
            let mut raw = std::ptr::null_mut();
            MFCreateVideoSampleAllocatorEx(&IMFVideoSampleAllocatorEx::IID, &mut raw)
                .map_err(fail("MFCreateVideoSampleAllocatorEx"))?;
            let allocator = IMFVideoSampleAllocatorEx::from_raw(raw);
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 1).map_err(fail("MFCreateAttributes"))?;
            let attrs = attrs.ok_or_else(|| DecodeError::Unsupported("no attribute store".into()))?;
            let mut staging = Vec::new();
            if let Some(d) = device {
                allocator.SetDirectXManager(&d.manager).map_err(fail("IMFVideoSampleAllocator::SetDirectXManager"))?;
                attrs
                    .SetUINT32(&MF_SA_D3D11_BINDFLAGS, D3D11_BIND_VIDEO_ENCODER.0 as u32)
                    .map_err(fail("SetUINT32"))?;
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                    MiscFlags: 0,
                };
                for _ in 0..STAGING {
                    let mut tex = None;
                    d.device.CreateTexture2D(&desc, None, Some(&mut tex)).map_err(fail("CreateTexture2D"))?;
                    staging.push(tex.ok_or_else(|| DecodeError::Unsupported("no staging texture".into()))?);
                }
            }
            allocator
                .InitializeSampleAllocatorEx(POOL / 2, POOL, &attrs, t.raw())
                .map_err(fail("IMFVideoSampleAllocatorEx::InitializeSampleAllocatorEx"))?;
            Ok(Self { allocator, width, height, staging, next: 0 })
        }
    }

    /// A sample of a free picture holding `nv12` (rows `pitch` bytes apart, the chroma rows after the luma), or
    /// `None` while the transform holds every picture.
    pub(crate) fn sample(
        &mut self,
        device: Option<&Device>,
        nv12: &[u8],
        stride: usize,
        time: i64,
        duration: i64,
    ) -> Result<Option<Sample>> {
        let (w, h) = (self.width as usize, self.height as usize);
        if stride < w || nv12.len() < stride * (h * 3 / 2 - 1) + w {
            return Err(DecodeError::Damaged(format!("a picture of {} bytes", nv12.len())));
        }
        // SAFETY: the sample, its buffer and the textures are owned COM objects. Every write stays inside the mapped
        // or locked rows: `rows` rows of `w` bytes at the pitch Windows gives, `rows` = 1.5 x the height (NV12's
        // luma then chroma rows), read from `nv12`, which holds that many rows `stride` apart.
        unsafe {
            let s = match self.allocator.AllocateSample() {
                Ok(s) => s,
                Err(e) if e.code() == MF_E_SAMPLEALLOCATOR_EMPTY => return Ok(None),
                Err(e) => return Err(fail("IMFVideoSampleAllocator::AllocateSample")(e)),
            };
            let buffer = s.GetBufferByIndex(0).map_err(fail("IMFSample::GetBufferByIndex"))?;
            let rows = h * 3 / 2;
            let copy = |dst: *mut u8, pitch: usize| {
                for r in 0..rows {
                    std::ptr::copy_nonoverlapping(nv12.as_ptr().add(r * stride), dst.add(r * pitch), w);
                }
            };
            match device.filter(|_| !self.staging.is_empty()) {
                Some(d) => {
                    let dxgi = buffer.cast::<IMFDXGIBuffer>().map_err(fail("IMFDXGIBuffer"))?;
                    let mut raw = std::ptr::null_mut();
                    dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw).map_err(fail("IMFDXGIBuffer::GetResource"))?;
                    let tex = ID3D11Texture2D::from_raw(raw);
                    let index = dxgi.GetSubresourceIndex().map_err(fail("IMFDXGIBuffer::GetSubresourceIndex"))?;
                    let stage = &self.staging[self.next];
                    self.next = (self.next + 1) % self.staging.len();
                    let cx = d.context();
                    let mut m = D3D11_MAPPED_SUBRESOURCE::default();
                    cx.Map(stage, 0, D3D11_MAP_WRITE, 0, Some(&mut m)).map_err(fail("ID3D11DeviceContext::Map"))?;
                    copy(m.pData.cast(), m.RowPitch as usize);
                    cx.Unmap(stage, 0);
                    cx.CopySubresourceRegion(&tex, index, 0, 0, 0, stage, 0, None);
                }
                None => {
                    let b2 = buffer.cast::<IMF2DBuffer>().map_err(fail("IMF2DBuffer"))?;
                    let (mut p, mut pitch) = (std::ptr::null_mut(), 0i32);
                    b2.Lock2D(&mut p, &mut pitch).map_err(fail("IMF2DBuffer::Lock2D"))?;
                    if pitch >= w as i32 {
                        copy(p, pitch as usize);
                    }
                    b2.Unlock2D().map_err(fail("IMF2DBuffer::Unlock2D"))?;
                    if pitch < w as i32 {
                        return Err(DecodeError::Unsupported(format!("a picture buffer with pitch {pitch}")));
                    }
                }
            }
            s.SetSampleTime(time).map_err(fail("IMFSample::SetSampleTime"))?;
            s.SetSampleDuration(duration).map_err(fail("IMFSample::SetSampleDuration"))?;
            Ok(Some(Sample::wrap(s)))
        }
    }
}
