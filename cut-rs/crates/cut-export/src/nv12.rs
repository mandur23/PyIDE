//! The rendered picture to the encoder's NV12 on the GPU: a compute pass turns the engine's RGBA (sRGB values,
//! Rec. 709 primaries) into BT.709 limited-range luma and 2x2-averaged chroma, so only 1.5 bytes a pixel cross to
//! system memory instead of 4, and the CPU does no colour arithmetic. Each picture is copied into a read-back
//! [`Frame`] that goes to the encoder's thread as it is: that thread waits for the GPU and gives the mapped bytes to the
//! encoder, which copies them once, into its own input picture; the frame then comes back for another picture. The
//! renderer never waits for the GPU while frames are free, and no copy of the picture is made in between.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

const SHADER: &str = r"
struct P { w: u32, h: u32, stride: u32, uv: u32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> p: P;

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn byte(v: f32) -> u32 { return u32(clamp(round(v), 0.0, 255.0)); }
fn px(x: u32, y: u32) -> vec3f {
  return textureLoad(src, vec2u(min(x, p.w - 1u), min(y, p.h - 1u)), 0).rgb;
}

// One invocation: 4 pixels across, 2 rows down.
@compute @workgroup_size(16, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x0 = id.x * 4u;
  let y0 = id.y * 2u;
  if (x0 >= p.stride || y0 >= p.h) { return; }
  var top = 0u;
  var bottom = 0u;
  var uv = 0u;
  for (var k = 0u; k < 4u; k++) {
    top |= byte(16.0 + 219.0 * luma(px(x0 + k, y0))) << (8u * k);
    bottom |= byte(16.0 + 219.0 * luma(px(x0 + k, y0 + 1u))) << (8u * k);
  }
  for (var j = 0u; j < 2u; j++) {
    let x = x0 + 2u * j;
    let c = (px(x, y0) + px(x + 1u, y0) + px(x, y0 + 1u) + px(x + 1u, y0 + 1u)) * 0.25;
    let y = luma(c);
    let cb = byte(128.0 + 224.0 * (c.b - y) / 1.8556);
    let cr = byte(128.0 + 224.0 * (c.r - y) / 1.5748);
    uv |= (cb | (cr << 8u)) << (16u * j);
  }
  dst[(y0 * p.stride + x0) / 4u] = top;
  if (y0 + 1u < p.h) { dst[((y0 + 1u) * p.stride + x0) / 4u] = bottom; }
  dst[(p.uv + (y0 / 2u) * p.stride + x0) / 4u] = uv;
}
";

/// Read-back frames: pictures between the GPU and the encoder.
pub(crate) const FRAMES: usize = 4;
const WAITING: u8 = 1;
const MAPPED: u8 = 2;
const FAILED: u8 = 3;

use crate::sink::Failure;

/// Why the device was lost, once it was (the device's lost callback sets it).
pub(crate) type LostSlot = Arc<Mutex<Option<String>>>;

/// A failed GPU call. A lost device fails every later call: the failure then says that it was lost, not which call
/// failed first.
pub(crate) fn gpu_failure(lost: &LostSlot, error: String) -> Failure {
    match lost.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        Some(why) => Failure::with("compositor", "the GPU device was lost: {error}", &[("error", why)]),
        None => Failure::with("compositor", "the compositor failed: {error}", &[("error", error)]),
    }
}

/// One picture's NV12 on its way back from the GPU.
pub(crate) struct Frame {
    buffer: wgpu::Buffer,
    device: wgpu::Device,
    state: Arc<AtomicU8>,
    submission: Option<wgpu::SubmissionIndex>,
    lost: LostSlot,
    /// Bytes a row (the width rounded up to 4) and rows of luma.
    pub stride: usize,
    pub height: usize,
}

impl Frame {
    /// Waits for the GPU to finish the picture and calls `f` with its NV12 (rows of `stride` bytes, `1.5 x height`
    /// of them), then gives the buffer back for the next picture.
    pub fn read<T>(&mut self, f: impl FnOnce(&[u8]) -> T) -> Result<T, Failure> {
        // A destroyed device fails this thread's wait before its lost callback has run (the callback runs in a poll):
        // the failure waits a moment for it, so it says that the device was lost.
        let lost = |m: &str| {
            let until = std::time::Instant::now() + std::time::Duration::from_millis(250);
            while self.lost.lock().unwrap_or_else(|e| e.into_inner()).is_none() && std::time::Instant::now() < until {
                let _ = self.device.poll(wgpu::PollType::Poll);
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            gpu_failure(&self.lost, m.to_owned())
        };
        if let Some(sub) = self.submission.take() {
            self.device
                .poll(wgpu::PollType::Wait { submission_index: Some(sub), timeout: None })
                .map_err(|e| lost(&format!("the GPU did not finish the picture: {e}")))?;
        }
        while self.state.load(Ordering::Acquire) == WAITING {
            let _ = self.device.poll(wgpu::PollType::Poll);
            std::thread::yield_now();
        }
        if self.state.load(Ordering::Acquire) != MAPPED {
            return Err(lost("the picture could not be read back from the GPU"));
        }
        let r = {
            let data = self
                .buffer
                .slice(..)
                .get_mapped_range()
                .map_err(|e| lost(&format!("the picture could not be read back: {e}")))?;
            f(&data[..self.stride * self.height * 3 / 2])
        };
        self.buffer.unmap();
        Ok(r)
    }
}

/// Converts pictures of one size to NV12 into read-back frames.
pub(crate) struct Nv12 {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    params: wgpu::Buffer,
    out: wgpu::Buffer,
    lost: LostSlot,
    h: u32,
    stride: u32,
}

impl Nv12 {
    /// A converter for `w x h` pictures (both even).
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, lost: LostSlot) -> Self {
        let stride = w.div_ceil(4) * 4;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("cut-export nv12"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("cut-export nv12"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cut-export nv12 params"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&params, 0, bytemuck::cast_slice(&[w, h, stride, stride * h]));
        let out = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cut-export nv12 out"),
            size: u64::from(stride) * u64::from(h) * 3 / 2,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        Self { device: device.clone(), queue: queue.clone(), pipeline, params, out, lost, h, stride }
    }

    /// The read-back frames to convert into, [`FRAMES`] of them.
    pub fn frames(&self) -> Vec<Frame> {
        (0..FRAMES)
            .map(|_| Frame {
                buffer: self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("cut-export nv12 read back"),
                    size: self.out.size(),
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }),
                device: self.device.clone(),
                state: Arc::new(AtomicU8::new(0)),
                submission: None,
                lost: self.lost.clone(),
                stride: self.stride as usize,
                height: self.h as usize,
            })
            .collect()
    }

    /// Queues the conversion of `tex` into `frame` and its read-back.
    pub fn submit(&mut self, tex: &wgpu::Texture, frame: &mut Frame) {
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cut-export nv12"),
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: self.out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.params.as_entire_binding() },
            ],
        });
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups((self.stride / 4).div_ceil(16), (self.h / 2).div_ceil(8), 1);
        }
        enc.copy_buffer_to_buffer(&self.out, 0, &frame.buffer, 0, self.out.size());
        frame.submission = Some(self.queue.submit([enc.finish()]));
        frame.state.store(WAITING, Ordering::Release);
        let state = frame.state.clone();
        frame.buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            state.store(if r.is_ok() { MAPPED } else { FAILED }, Ordering::Release);
        });
    }
}
