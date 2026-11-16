//! The GPU side of the compositor (compositor.js `createGpu`): the device, the reused WGSL turned into pipelines,
//! textures recycled by size, the uniform slots and mask data of a frame, and reading pixels back.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use wgpu::util::DeviceExt;

/// Every intermediate picture: linear light, premultiplied alpha.
pub const F16: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// The output: sRGB values (Rec. 709 primaries), as the canvas shows them.
pub const OUT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

macro_rules! wgsl {
    ($($name:literal => $file:literal),* $(,)?) => {
        /// The WGSL of a pipeline by name (`fx:<type>` and `tr:<type>` for effects and transitions).
        pub fn source(name: &str) -> Option<&'static str> {
            match name {
                $($name => Some(include_str!(concat!("../shaders/", $file))),)*
                _ => None,
            }
        }
        /// Every shader's name, for the test that compiles them all.
        pub const SHADERS: &[&str] = &[$($name),*];
    };
}

wgsl! {
    "decodeYuv" => "native/decode_yuv.wgsl",
    "decodeImage" => "compositor/decodeImage.wgsl",
    "composite" => "compositor/composite.wgsl",
    "final" => "compositor/final.wgsl",
    "blit" => "compositor/blit.wgsl",
    "mask" => "masks.wgsl",
    "scopes" => "scopes.wgsl",
    "fx:flip.horizontal" => "effects/flip.horizontal.wgsl",
    "fx:flip.vertical" => "effects/flip.vertical.wgsl",
    "fx:crop" => "effects/crop.wgsl",
    "fx:edge.extend" => "effects/edge.extend.wgsl",
    "fx:blur.gaussian" => "effects/blur.gaussian.wgsl",
    "fx:blur.directional" => "effects/blur.directional.wgsl",
    "fx:sharpen" => "effects/sharpen.wgsl",
    "fx:mosaic" => "effects/mosaic.wgsl",
    "fx:color.bw" => "effects/color.bw.wgsl",
    "fx:color.tint" => "effects/color.tint.wgsl",
    "fx:color.brightnessContrast" => "effects/color.brightnessContrast.wgsl",
    "fx:color.basic" => "effects/color.basic.wgsl",
    "fx:color.invert" => "effects/color.invert.wgsl",
    "fx:color.hue" => "effects/color.hue.wgsl",
    "fx:vignette" => "effects/vignette.wgsl",
    "fx:glow" => "effects/glow.wgsl",
    "fx:posterize" => "effects/posterize.wgsl",
    "fx:chromatic" => "effects/chromatic.wgsl",
    "fx:glitch" => "effects/glitch.wgsl",
    "fx:distort.lens" => "effects/distort.lens.wgsl",
    "fx:key.chroma" => "effects/key.chroma.wgsl",
    "fx:noise.grain" => "effects/noise.grain.wgsl",
    "tr:dissolve" => "transitions/dissolve.wgsl",
    "tr:dip.black" => "transitions/dip.black.wgsl",
    "tr:dip.white" => "transitions/dip.white.wgsl",
    "tr:push" => "transitions/push.wgsl",
    "tr:slide" => "transitions/slide.wgsl",
    "tr:wipe" => "transitions/wipe.wgsl",
    "tr:iris.round" => "transitions/iris.round.wgsl",
    "tr:zoom.cross" => "transitions/zoom.cross.wgsl",
}

/// The WGSL of a pipeline, its variants included: `decodeYuvUnorm` is `decodeYuv` reading normalized plane views
/// (a frame the decoder shared) instead of integer textures, turned back into integer codes by `rot.z` (255 or 65535)
/// so the two give the same pictures.
pub fn code(name: &str) -> Option<std::borrow::Cow<'static, str>> {
    match name {
        "decodeYuvUnorm" => source("decodeYuv").map(|c| {
            c.replace("texture_2d<u32>", "texture_2d<f32>")
                .replace("f32(textureLoad(lumaTex", "round(u.rot.z * textureLoad(lumaTex")
                .replace("vec2f(textureLoad(chromaTex", "round(u.rot.z * textureLoad(chromaTex")
                .into()
        }),
        _ => source(name).map(Into::into),
    }
}

/// Premultiplied OVER.
pub const OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
};

struct Pooled {
    tex: wgpu::Texture,
    used: u64,
}

/// A render pipeline's shader, target format and blending.
type PipeKey = (String, wgpu::TextureFormat, bool);

/// Every render pipeline the compositor draws with (`draw.rs` picks them per operation): the shaders but the scopes'
/// compute one, `decodeYuvUnorm` too; F16 targets except `final`'s output; blending for the composite, the
/// transitions and a frame decoded over another, else a copy. The most used first.
pub fn variants() -> Vec<PipeKey> {
    let first = ["decodeYuv", "decodeYuvUnorm", "decodeImage", "composite", "final"];
    let rest = SHADERS.iter().copied().filter(|n| !first.contains(n) && *n != "scopes");
    first
        .into_iter()
        .chain(rest)
        .flat_map(|name| {
            let format = if name == "final" { OUT } else { F16 };
            let blends: &[bool] = if name.starts_with("decodeYuv") {
                &[false, true]
            } else if name == "composite" || name.starts_with("tr:") {
                &[true]
            } else {
                &[false]
            };
            blends.iter().map(move |b| (name.to_string(), format, *b))
        })
        .collect()
}

fn make_pipeline(device: &wgpu::Device, (name, format, blend): &PipeKey) -> wgpu::RenderPipeline {
    let code = code(name).unwrap_or_else(|| panic!("no shader {name}"));
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(name),
        source: wgpu::ShaderSource::Wgsl(code),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(name),
        layout: None,
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: *format,
                blend: blend.then_some(OVER),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

type PoolKey = (u32, u32, wgpu::TextureFormat);

/// The device and what the compositor keeps on it between frames.
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub sampler: wgpu::Sampler,
    pub max_dim: u32,
    pipes: HashMap<PipeKey, wgpu::RenderPipeline>,
    /// What [`Gpu::warm`]'s thread made so far.
    warm: Arc<Mutex<HashMap<PipeKey, wgpu::RenderPipeline>>>,
    compiled: u64,
    compute: HashMap<String, wgpu::ComputePipeline>,
    free: HashMap<PoolKey, Vec<Pooled>>,
    in_use: Vec<(PoolKey, Pooled)>,
    pub frame_no: u64,
    ubuf: Option<wgpu::Buffer>,
    sbuf: Option<wgpu::Buffer>,
    dummies: HashMap<bool, wgpu::Texture>,
    /// Effect tables (LUTs, curves) by key, with the frame that last used each.
    tables: HashMap<String, (wgpu::Texture, u64)>,
}

impl Gpu {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("cut-engine linear"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let max_dim = device.limits().max_texture_dimension_2d;
        Self {
            device,
            queue,
            sampler,
            max_dim,
            pipes: HashMap::new(),
            warm: Arc::default(),
            compiled: 0,
            compute: HashMap::new(),
            free: HashMap::new(),
            in_use: Vec::new(),
            frame_no: 0,
            ubuf: None,
            sbuf: None,
            dummies: HashMap::new(),
            tables: HashMap::new(),
        }
    }

    /// A device of its own (tests, export) on the adapter the app runs on ([`pick_adapter`]).
    pub fn headless() -> Result<(wgpu::Device, wgpu::Queue), String> {
        // Direct3D 12 alone when it has an adapter: starting the other backends loads every GPU's Vulkan and GL
        // drivers into the process for nothing.
        let adapters = |backends| {
            let mut d = wgpu::InstanceDescriptor::new_without_display_handle();
            d.backends = backends;
            pollster::block_on(wgpu::Instance::new(d).enumerate_adapters(backends))
        };
        let mut found = adapters(wgpu::Backends::DX12);
        if found.iter().all(|a| a.get_info().device_type == wgpu::DeviceType::Cpu) {
            found = adapters(wgpu::Backends::all());
        }
        let adapter = pick_adapter(&found).ok_or("no GPU adapter")?;
        pollster::block_on(adapter.request_device(&device_descriptor(&adapter)))
            .map_err(|e| format!("no GPU device: {e}"))
    }

    /// The pipeline of a shader for a target format (`blend`: premultiplied OVER, else a copy): the one [`Gpu::warm`]
    /// made, else made now.
    pub fn pipeline(&mut self, name: &str, format: wgpu::TextureFormat, blend: bool) -> &wgpu::RenderPipeline {
        let key = (name.to_string(), format, blend);
        if !self.pipes.contains_key(&key) {
            let warm = self.warm.lock().unwrap_or_else(|p| p.into_inner()).get(&key).cloned();
            let p = warm.unwrap_or_else(|| {
                self.compiled += 1;
                make_pipeline(&self.device, &key)
            });
            self.pipes.insert(key.clone(), p);
        }
        &self.pipes[&key]
    }

    /// Makes every render pipeline the compositor draws with ([`variants`]) on a thread of its own, so that no render
    /// waits for one: Direct3D 12 takes up to 150 ms to compile a shader (Basic Color Correction), which on the UI
    /// thread drops frames the first time an effect, a mask or a transition plays.
    pub fn warm(&self) -> std::thread::JoinHandle<()> {
        let (device, made) = (self.device.clone(), self.warm.clone());
        std::thread::Builder::new()
            .name("cut-engine pipelines".into())
            .spawn(move || {
                for key in variants() {
                    let p = make_pipeline(&device, &key);
                    made.lock().unwrap_or_else(|p| p.into_inner()).insert(key, p);
                }
            })
            .expect("a thread")
    }

    /// The pipelines renders had to make themselves (none once [`Gpu::warm`] has finished).
    pub fn compiled(&self) -> u64 {
        self.compiled
    }

    /// The compute pipeline of a shader (the scopes' count).
    pub fn compute_pipeline(&mut self, name: &str) -> &wgpu::ComputePipeline {
        if !self.compute.contains_key(name) {
            let code = source(name).unwrap_or_else(|| panic!("no shader {name}"));
            let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(name),
                source: wgpu::ShaderSource::Wgsl(code.into()),
            });
            let p = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: None,
                module: &module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
            self.compute.insert(name.to_string(), p);
        }
        &self.compute[name]
    }

    /// A texture of a size and format for this frame, reused from earlier frames when one is free.
    pub fn texture(&mut self, w: u32, h: u32, format: wgpu::TextureFormat) -> wgpu::Texture {
        let key = (w, h, format);
        let p = self.free.get_mut(&key).and_then(Vec::pop).unwrap_or_else(|| Pooled {
            tex: self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("cut-engine picture"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            }),
            used: 0,
        });
        let tex = p.tex.clone();
        self.in_use.push((key, Pooled { tex: p.tex, used: self.frame_no }));
        tex
    }

    /// Bytes of the pictures the pool keeps (free and in this frame's use).
    pub fn pooled_bytes(&self) -> u64 {
        let size =
            |(w, h, f): &PoolKey| u64::from(*w) * u64::from(*h) * u64::from(f.block_copy_size(None).unwrap_or(8));
        let free: u64 = self.free.iter().map(|(k, l)| size(k) * l.len() as u64).sum();
        free + self.in_use.iter().map(|(k, _)| size(k)).sum::<u64>()
    }

    /// After a frame is submitted: its textures go back to the pool (queue order makes reuse safe); those unused for
    /// 90 frames are dropped.
    pub fn recycle(&mut self) {
        self.frame_no += 1;
        for (k, p) in self.in_use.drain(..) {
            self.free.entry(k).or_default().push(p);
        }
        let now = self.frame_no;
        self.free.retain(|_, list| {
            list.retain(|p| now - p.used < 90);
            !list.is_empty()
        });
        // Tables beyond the last 24 that this frame did not use go.
        if self.tables.len() > 24 {
            let last = now - 1;
            let mut stale: Vec<String> =
                self.tables.iter().filter(|(_, (_, u))| *u != last).map(|(k, _)| k.clone()).collect();
            stale.truncate(self.tables.len() - 24);
            for k in stale {
                self.tables.remove(&k);
            }
        }
    }

    /// The uniform slots of a frame (64 floats each, at 256-byte offsets) in one buffer.
    pub fn uniforms(&mut self, slots: &[[f32; 64]]) -> &wgpu::Buffer {
        let need = (slots.len().max(1) * 256) as u64;
        if self.ubuf.as_ref().is_none_or(|b| b.size() < need) {
            let cap = need.max(self.ubuf.as_ref().map_or(0, |b| b.size() * 2)).max(64 * 256);
            self.ubuf = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("cut-engine uniforms"),
                size: cap,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }
        let buf = self.ubuf.as_ref().expect("made above");
        if !slots.is_empty() {
            self.queue.write_buffer(buf, 0, bytemuck::cast_slice(slots));
        }
        buf
    }

    /// The masks' data of a frame in one storage buffer, each list at a 256-byte offset: the offsets and sizes.
    pub fn storage(&mut self, lists: &[Vec<f32>]) -> (Option<&wgpu::Buffer>, Vec<(u64, u64)>) {
        let mut at = 0u64;
        let mut spans = Vec::new();
        for l in lists {
            let bytes = (l.len() * 4).max(16) as u64;
            spans.push((at, bytes.div_ceil(16) * 16));
            at += bytes.div_ceil(256) * 256;
        }
        if lists.is_empty() {
            return (None, spans);
        }
        if self.sbuf.as_ref().is_none_or(|b| b.size() < at) {
            let cap = at.max(self.sbuf.as_ref().map_or(0, |b| b.size() * 2)).max(64 * 1024);
            self.sbuf = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("cut-engine masks"),
                size: cap,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }
        let mut data = vec![0f32; (at / 4) as usize];
        for (l, (o, _)) in lists.iter().zip(&spans) {
            data[(*o / 4) as usize..(*o / 4) as usize + l.len()].copy_from_slice(l);
        }
        let buf = self.sbuf.as_ref().expect("made above");
        self.queue.write_buffer(buf, 0, bytemuck::cast_slice(&data));
        (Some(buf), spans)
    }

    /// A small table of zeros for a binding an effect leaves empty (`three_d`: a 3D one).
    pub fn dummy(&mut self, three_d: bool) -> wgpu::Texture {
        let (device, queue) = (&self.device, &self.queue);
        self.dummies
            .entry(three_d)
            .or_insert_with(|| {
                let (size, dim) = if three_d {
                    ([2, 2, 2], wgpu::TextureDimension::D3)
                } else {
                    ([2, 1, 1], wgpu::TextureDimension::D2)
                };
                table_texture(device, queue, size, dim, &vec![0u16; size.iter().product::<u32>() as usize * 4])
            })
            .clone()
    }

    /// The table texture of a key, made from `data()` the first time.
    pub fn table(&mut self, key: &str, size: [u32; 3], data: &dyn Fn() -> Vec<u16>) -> wgpu::Texture {
        let now = self.frame_no;
        if let Some((t, used)) = self.tables.get_mut(key) {
            *used = now;
            return t.clone();
        }
        let dim = if size[2] > 1 { wgpu::TextureDimension::D3 } else { wgpu::TextureDimension::D2 };
        let t = table_texture(&self.device, &self.queue, size, dim, &data());
        self.tables.insert(key.to_string(), (t.clone(), now));
        t
    }

    /// The RGBA8 pixels of a texture (rows tightly packed).
    pub fn read_pixels(&self, tex: &wgpu::Texture) -> Vec<u8> {
        let (w, h) = (tex.width(), tex.height());
        let bpr = (w * 4).div_ceil(256) * 256;
        let buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cut-engine read back"),
            size: u64::from(bpr * h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            tex.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(h) },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);
        let slice = buf.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let Ok(data) = slice.get_mapped_range() else { return Vec::new() };
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for row in data.chunks(bpr as usize).take(h as usize) {
            out.extend_from_slice(&row[..(w * 4) as usize]);
        }
        out
    }
}

/// The features a frame the decoder shares needs: NV12 textures, and for 10-bit video P010 read through 16-bit
/// normalized plane views ([`cut_decode::share`]).
const SHARE_FEATURES: wgpu::Features = wgpu::Features::TEXTURE_FORMAT_NV12
    .union(wgpu::Features::TEXTURE_FORMAT_P010)
    .union(wgpu::Features::TEXTURE_FORMAT_16BIT_NORM);

/// The GPU the app, its engines and their decoders all run on, among `adapters` (any backends).
///
/// Decoding, compositing and the encoders must share one adapter, or every frame crosses between GPUs; Direct3D 12 is
/// the only backend a decoder can hand its frames to ([`cut_decode::share`]), so its adapters go first. Among them
/// `CUT_ADAPTER` (part of an adapter's name, any case) chooses; else the discrete GPU, measured faster here at every
/// load (`tests/playback.rs`, NEXT.md: with frames shared, 1080p with Lumetri at 684 / 263 / 131 frames a second for
/// 1, 3 and 6 layers on the GTX 1650 against 179 / 70 / 46 on the Radeon, which is busy drawing) although the
/// integrated one drives the laptop's screen: presenting the window across costs one copy of the window a frame.
/// Software adapters (WARP) come last.
pub fn pick_adapter(adapters: &[wgpu::Adapter]) -> Option<wgpu::Adapter> {
    let wanted = std::env::var("CUT_ADAPTER").ok().filter(|s| !s.is_empty()).map(|s| s.to_lowercase());
    adapters
        .iter()
        .min_by_key(|a| {
            let i = a.get_info();
            let named = wanted.as_ref().is_some_and(|w| i.name.to_lowercase().contains(w));
            let kind = match i.device_type {
                wgpu::DeviceType::DiscreteGpu => 0,
                wgpu::DeviceType::IntegratedGpu => 1,
                wgpu::DeviceType::VirtualGpu | wgpu::DeviceType::Other => 2,
                wgpu::DeviceType::Cpu => 3,
            };
            (!named, i.backend != wgpu::Backend::Dx12, kind)
        })
        .cloned()
}

/// The device the engine asks of an adapter: its limits, and the features shared frames need where it has them.
///
/// Two settings keep the device small (`tests/playback.rs memory_by_stage`, NEXT.md): Direct3D 12 sizes its one
/// shader-visible descriptor heap by `max_non_sampler_bindings` (a million descriptors, 32 MB, by default; the renders
/// hold a few hundred at once), and wgpu's default memory hints reserve 64 MB blocks of upload memory and 128 MB of
/// video memory at the first buffer or texture. Together 314 -> 107 MB of private memory for the device, with the
/// same frames a second.
pub fn device_descriptor(adapter: &wgpu::Adapter) -> wgpu::DeviceDescriptor<'static> {
    let mut limits = adapter.limits();
    limits.max_non_sampler_bindings = limits.max_non_sampler_bindings.min(1 << 17);
    wgpu::DeviceDescriptor {
        label: Some("cut-engine"),
        required_features: adapter.features() & SHARE_FEATURES,
        required_limits: limits,
        memory_hints: wgpu::MemoryHints::MemoryUsage,
        ..Default::default()
    }
}

fn table_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    size: [u32; 3],
    dim: wgpu::TextureDimension,
    data: &[u16],
) -> wgpu::Texture {
    device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("cut-engine table"),
            size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: size[2] },
            mip_level_count: 1,
            sample_count: 1,
            dimension: dim,
            format: F16,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        bytemuck::cast_slice(data),
    )
}
