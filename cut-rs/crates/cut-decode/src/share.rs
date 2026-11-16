//! Decoded pictures handed to a wgpu device without leaving the GPU.
//!
//! A [`Bridge`] is made once from the engine's wgpu device when it runs on Direct3D 12 with NV12 textures enabled. A
//! hardware decoder on the same adapter (found by LUID) gets a [`Ring`]: textures of its own device created shareable
//! with NT handles, each opened once in the wgpu device. Each kept picture is copied from the decoder's pool into a
//! free ring texture on the GPU ([`Ring::copy`]), so the decoder's few output textures are never held. Two shared
//! fences order the devices: the decoder's device signals `ready` after a copy and the wgpu queue waits for it before
//! a render that reads it ([`Bridge::before_reads`]); the wgpu queue signals `done` after that render
//! ([`Bridge::after_submit`]) and the decoder's device waits for it before it writes the texture again.
//!
//! The textures are only ever sampled on the wgpu side and are created there in the shader-resource state: Direct3D
//! 12 promotes a shared texture from the common state to a read state on first use and returns it to common at the
//! end of each command list, which is the state the other device needs.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_SHADER_RESOURCE, D3D11_FENCE_FLAG_SHARED, D3D11_RESOURCE_MISC_SHARED,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device5,
    ID3D11DeviceContext4, ID3D11Fence, ID3D11Texture2D,
};
use windows::Win32::Graphics::Direct3D12::{D3D12_FENCE_FLAG_SHARED, ID3D12CommandQueue, ID3D12Device, ID3D12Fence};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_FORMAT_P010, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE, IDXGIResource1};
use windows::core::{Interface, PCWSTR};

use crate::d3d::Device;
use crate::error::{DecodeError, Result};
use crate::mf::fail;
use crate::video::{GpuFrame, PixelFormat};

type Dx12 = wgpu::hal::api::Dx12;

/// The engine's wgpu device seen from Direct3D 12, with the fence its queue signals after each render.
#[derive(Clone)]
pub struct Bridge {
    inner: Arc<Inner>,
}

struct Inner {
    device: wgpu::Device,
    d3d12: ID3D12Device,
    queue: ID3D12CommandQueue,
    adapter: u32,
    name: String,
    p010: bool,
    done: ID3D12Fence,
    /// The NT handle of `done`, which each decoder device opens (a raw value: handles are plain numbers).
    done_handle: usize,
    done_value: AtomicU64,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // SAFETY: the handle made in `Bridge::new`, closed once.
        unsafe {
            let _ = CloseHandle(HANDLE(self.done_handle as *mut _));
        }
    }
}

fn missing(call: &'static str) -> DecodeError {
    DecodeError::Platform { call, hresult: 0, message: "no object".into() }
}

impl Bridge {
    /// The bridge for a wgpu device, or why there is none: not Direct3D 12, NV12 textures not enabled
    /// ([`wgpu::Features::TEXTURE_FORMAT_NV12`]), or an adapter DXGI does not list.
    pub fn new(device: &wgpu::Device) -> std::result::Result<Self, String> {
        if !device.features().contains(wgpu::Features::TEXTURE_FORMAT_NV12) {
            return Err("the wgpu device was made without NV12 textures".into());
        }
        let p010 =
            device.features().contains(wgpu::Features::TEXTURE_FORMAT_P010 | wgpu::Features::TEXTURE_FORMAT_16BIT_NORM);
        // SAFETY: the raw device and queue are only cloned (AddRef) out of the guard, which is dropped at once.
        let (d3d12, queue) = unsafe {
            let hal = device.as_hal::<Dx12>().ok_or("the wgpu device is not Direct3D 12")?;
            (hal.raw_device().clone(), hal.raw_queue().clone())
        };
        // SAFETY: plain calls on a live device; the fence is created shared and its handle kept until Drop.
        unsafe {
            let l = d3d12.GetAdapterLuid();
            let luid = (u64::from(l.HighPart as u32) << 32) | u64::from(l.LowPart);
            let adapter = crate::d3d::adapter_with_luid(luid).ok_or("DXGI does not list the wgpu adapter")?;
            let done: ID3D12Fence = d3d12.CreateFence(0, D3D12_FENCE_FLAG_SHARED).map_err(|e| e.to_string())?;
            let handle =
                d3d12.CreateSharedHandle(&done, None, GENERIC_ALL.0, PCWSTR::null()).map_err(|e| e.to_string())?;
            let name = crate::d3d::adapters().get(adapter as usize).cloned().unwrap_or_default();
            Ok(Self {
                inner: Arc::new(Inner {
                    device: device.clone(),
                    d3d12,
                    queue,
                    adapter,
                    name,
                    p010,
                    done,
                    done_handle: handle.0 as usize,
                    done_value: AtomicU64::new(0),
                }),
            })
        }
    }

    /// The DXGI index of the wgpu device's adapter, for `Accel::Hardware { adapter }`.
    pub fn adapter(&self) -> u32 {
        self.inner.adapter
    }

    /// The adapter's name.
    pub fn adapter_name(&self) -> &str {
        &self.inner.name
    }

    /// Whether pictures of this format can be shared (P010 needs two more wgpu features).
    pub fn shares(&self, format: PixelFormat) -> bool {
        format == PixelFormat::Nv12 || self.inner.p010
    }

    /// Before a submission that samples these frames: the wgpu queue waits on the GPU until their copies are done.
    pub fn before_reads(&self, frames: &[SharedFrame]) {
        for f in frames {
            // SAFETY: a fence query and a queued GPU wait on a live fence; ID3D12CommandQueue is free-threaded.
            unsafe {
                if f.slot.ready.GetCompletedValue() < f.ready {
                    let _ = self.inner.queue.Wait(&f.slot.ready, f.ready);
                }
            }
        }
    }

    /// After that submission: the queue signals the `done` fence, and the frames' textures are not written again
    /// before it has passed.
    pub fn after_submit(&self, frames: &[SharedFrame]) {
        if frames.is_empty() {
            return;
        }
        let v = self.inner.done_value.fetch_add(1, Ordering::Relaxed) + 1;
        // SAFETY: as above.
        unsafe {
            let _ = self.inner.queue.Signal(&self.inner.done, v);
        }
        for f in frames {
            f.slot.read_until.fetch_max(v, Ordering::Relaxed);
        }
    }
}

/// One ring texture as the wgpu side sees it.
struct Slot {
    texture: wgpu::Texture,
    /// The ring's `ready` fence opened in Direct3D 12.
    ready: ID3D12Fence,
    /// The `done` value after which no submitted render reads the texture any more.
    read_until: AtomicU64,
    format: PixelFormat,
}

/// A decoded picture in a ring texture of the wgpu device: NV12 or P010, the visible picture at the top left. The
/// texture is not reused while a `SharedFrame` of it lives.
#[derive(Clone)]
pub struct SharedFrame {
    slot: Arc<Slot>,
    ready: u64,
}

impl SharedFrame {
    /// The texture (format `NV12` or `P010`; sample its planes through views with aspect `Plane0` / `Plane1`).
    pub fn texture(&self) -> &wgpu::Texture {
        &self.slot.texture
    }

    pub fn format(&self) -> PixelFormat {
        self.slot.format
    }

    /// Video memory the texture takes, in bytes.
    pub fn bytes(&self) -> u64 {
        let t = &self.slot.texture;
        u64::from(t.width()) * u64::from(t.height()) * 3 / 2 * u64::from(self.slot.format.sample_bytes())
    }
}

/// The ring of one hardware decoder: lives on the decoder's thread, as its device does.
pub struct Ring {
    bridge: Bridge,
    device: Arc<Device>,
    context: ID3D11DeviceContext4,
    ready11: ID3D11Fence,
    ready12: ID3D12Fence,
    done11: ID3D11Fence,
    ready_value: u64,
    slots: Vec<(ID3D11Texture2D, Arc<Slot>)>,
}

impl Ring {
    /// A ring on the device of a decoder whose picture `frame` is (it must be on the bridge's adapter).
    pub fn new(bridge: &Bridge, frame: &GpuFrame) -> Result<Self> {
        let device = frame.device().clone();
        // SAFETY: interface casts and fence creation on a live device; the NT handle is closed once opened.
        unsafe {
            let d5: ID3D11Device5 = device.device.cast().map_err(fail("ID3D11Device5"))?;
            let context: ID3D11DeviceContext4 = device.context().cast().map_err(fail("ID3D11DeviceContext4"))?;
            let mut ready11: Option<ID3D11Fence> = None;
            d5.CreateFence(0, D3D11_FENCE_FLAG_SHARED, &mut ready11).map_err(fail("ID3D11Device5::CreateFence"))?;
            let ready11 = ready11.ok_or_else(|| missing("ID3D11Device5::CreateFence"))?;
            let h = ready11
                .CreateSharedHandle(None, GENERIC_ALL.0, PCWSTR::null())
                .map_err(fail("ID3D11Fence::CreateSharedHandle"))?;
            let mut ready12: Option<ID3D12Fence> = None;
            let opened = bridge.inner.d3d12.OpenSharedHandle(h, &mut ready12);
            let _ = CloseHandle(h);
            opened.map_err(fail("ID3D12Device::OpenSharedHandle"))?;
            let ready12 = ready12.ok_or_else(|| missing("ID3D12Device::OpenSharedHandle"))?;
            let mut done11: Option<ID3D11Fence> = None;
            d5.OpenSharedFence(HANDLE(bridge.inner.done_handle as *mut _), &mut done11)
                .map_err(fail("ID3D11Device5::OpenSharedFence"))?;
            let done11 = done11.ok_or_else(|| missing("ID3D11Device5::OpenSharedFence"))?;
            Ok(Self {
                bridge: bridge.clone(),
                device,
                context,
                ready11,
                ready12,
                done11,
                ready_value: 0,
                slots: Vec::new(),
            })
        }
    }

    fn slot(&mut self, w: u32, h: u32, format: PixelFormat) -> Result<usize> {
        let free = self.slots.iter().position(|(_, s)| {
            Arc::strong_count(s) == 1 && s.format == format && s.texture.width() == w && s.texture.height() == h
        });
        if let Some(i) = free {
            return Ok(i);
        }
        // Textures of another size or format that nothing holds go first.
        self.slots.retain(|(_, s)| Arc::strong_count(s) > 1 || (s.texture.width() == w && s.texture.height() == h));
        let (dxgi, wf) = match format {
            PixelFormat::Nv12 => (DXGI_FORMAT_NV12, wgpu::TextureFormat::NV12),
            PixelFormat::P010 => (DXGI_FORMAT_P010, wgpu::TextureFormat::P010),
        };
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: dxgi,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED.0) as u32,
        };
        let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
        // SAFETY: a valid descriptor and out pointers; the shared handle is closed once Direct3D 12 opened it; the
        // resource handed to wgpu was created as `desc` says and is initialized (by the copies before any read).
        let (tex11, texture) = unsafe {
            let mut tex = None;
            self.device
                .device
                .CreateTexture2D(&desc, None, Some(&mut tex))
                .map_err(fail("CreateTexture2D (shared)"))?;
            let tex: ID3D11Texture2D = tex.ok_or_else(|| missing("CreateTexture2D (shared)"))?;
            let res: IDXGIResource1 = tex.cast().map_err(fail("IDXGIResource1"))?;
            let h = res
                .CreateSharedHandle(None, DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0, PCWSTR::null())
                .map_err(fail("IDXGIResource1::CreateSharedHandle"))?;
            let mut r12 = None;
            let opened = self.bridge.inner.d3d12.OpenSharedHandle(h, &mut r12);
            let _ = CloseHandle(h);
            opened.map_err(fail("ID3D12Device::OpenSharedHandle (texture)"))?;
            let r12 = r12.ok_or_else(|| missing("ID3D12Device::OpenSharedHandle (texture)"))?;
            let hal = wgpu::hal::dx12::Device::texture_from_raw(r12, wf, wgpu::TextureDimension::D2, size, 1, 1);
            let texture = self.bridge.inner.device.create_texture_from_hal::<Dx12>(
                hal,
                &wgpu::TextureDescriptor {
                    label: Some("cut-decode shared frame"),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wf,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::TextureUses::RESOURCE,
            );
            (tex, texture)
        };
        let slot = Slot { texture, ready: self.ready12.clone(), read_until: AtomicU64::new(0), format };
        self.slots.push((tex11, Arc::new(slot)));
        Ok(self.slots.len() - 1)
    }

    /// Waits until every copy made so far is done. A flushed copy can still sit in the driver until the decoder's
    /// next submission (50 ms behind a seek's decoding, measured here), and the engine's queue waits for it: a
    /// picture someone waits for, and the last one before the decoder idles, are settled with this.
    pub fn settle(&self) {
        // SAFETY: a CPU wait on a live fence (no event handle: the call returns once the value is reached).
        unsafe {
            if self.ready11.GetCompletedValue() < self.ready_value {
                let _ = self.ready11.SetEventOnCompletion(self.ready_value, HANDLE::default());
            }
        }
    }

    /// Copies a decoded picture into a free ring texture (made when none is free) and gives it to the wgpu side;
    /// the decoder's own texture can go as soon as this returns.
    pub fn copy(&mut self, frame: &GpuFrame, format: PixelFormat) -> Result<SharedFrame> {
        let info = frame.info();
        let i = self.slot(info.width, info.height, format)?;
        let (tex, slot) = &self.slots[i];
        let after = slot.read_until.load(Ordering::Relaxed);
        self.ready_value += 1;
        // SAFETY: GPU-side waits and signals on live fences, and a copy between two textures of the same size and
        // format on the decoder's device (whose context is multithread protected).
        unsafe {
            if after > 0 {
                self.context.Wait(&self.done11, after).map_err(fail("ID3D11DeviceContext4::Wait"))?;
            }
            self.context.CopySubresourceRegion(tex, 0, 0, 0, 0, frame.texture(), frame.index(), None);
            self.context.Signal(&self.ready11, self.ready_value).map_err(fail("ID3D11DeviceContext4::Signal"))?;
            self.context.Flush();
        }
        Ok(SharedFrame { slot: slot.clone(), ready: self.ready_value })
    }
}
