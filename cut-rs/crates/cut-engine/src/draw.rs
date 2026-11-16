//! One frame on the GPU (compositor.js `encodeFrame`): each item's picture through its effects and masks in its own
//! frame, placed with crop, anchor, scale, rotation, position and opacity over the layers below, transitions mixing
//! their two clips, the result letterboxed and encoded to sRGB once at the end.

use std::collections::HashMap;
use std::num::NonZeroU64;

use cut_model::masks::gpu_data;

use crate::color::{YuvToRgb, clamp, hex_to_linear};
use crate::gpu::{F16, Gpu, OUT};
use crate::plan::{Item, ItemKind, Layer};
use crate::uniforms::{self, Info};

/// The planes of a decoded frame on the GPU: two integer textures written from memory, or the planes of a frame the
/// decoder shared (an NV12 or P010 texture read through normalized plane views).
#[derive(Clone)]
pub struct Planes {
    pub luma: wgpu::TextureView,
    pub chroma: wgpu::TextureView,
    /// The visible sizes of the planes, in texels.
    pub luma_size: (u32, u32),
    pub chroma_size: (u32, u32),
    /// Read through `unorm` views (a shared frame) rather than `uint` textures.
    pub normalized: bool,
    pub conv: YuvToRgb,
    /// The largest code value: 255 (8 bits) or 65472 (10 bits in the top of 16).
    pub max_code: f32,
}

/// What an item shows, found before the frame is encoded (compositor.js `fetchSources`).
// Made once a frame per item and only cloned into a few passes: boxing the planes would buy nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Clone)]
pub enum Picture {
    Frame {
        planes: Planes,
        second: Option<(Planes, f64)>,
    },
    /// An RGBA8 texture, not premultiplied (an image, a text clip's canvas, an error slate).
    Rgba(wgpu::Texture),
    /// A solid colour, linear, not premultiplied.
    Color([f64; 4]),
    /// A nest: its layers are drawn into it.
    Nest,
    /// Nothing to draw yet (no frame decoded).
    Empty,
}

/// An item's picture and the size it is placed at.
#[derive(Clone)]
pub struct Resolved {
    pub picture: Picture,
    /// The layer size in sequence pixels (a frame or image fitted to the sequence; full frame otherwise).
    pub w: f64,
    pub h: f64,
    /// Clockwise degrees the frames need.
    pub rotation0: u32,
}

/// A pass's pipeline name, target format, blending, whether it loads its target, the target, the texture bindings and
/// the uniform slot bindings.
type Pass<'a> =
    (String, wgpu::TextureFormat, bool, bool, &'a wgpu::Texture, Vec<(u32, wgpu::TextureView)>, Vec<(u32, usize)>);

enum Op {
    Clear {
        out: wgpu::Texture,
        color: [f64; 4],
    },
    Yuv {
        planes: Planes,
        out: wgpu::Texture,
        u: usize,
        over: bool,
    },
    Image {
        src: wgpu::Texture,
        out: wgpu::Texture,
        u: usize,
    },
    Effect {
        kind: String,
        src: wgpu::Texture,
        orig: wgpu::Texture,
        out: wgpu::Texture,
        u: usize,
        tex: Vec<(u32, wgpu::Texture)>,
    },
    Composite {
        src: wgpu::Texture,
        out: wgpu::Texture,
        u: usize,
    },
    Transition {
        kind: String,
        a: wgpu::Texture,
        b: wgpu::Texture,
        out: wgpu::Texture,
        u: usize,
    },
    Mask {
        keep: wgpu::Texture,
        under: wgpu::Texture,
        out: wgpu::Texture,
        u: usize,
        data: usize,
    },
    Final {
        src: wgpu::Texture,
        out: wgpu::Texture,
        u: usize,
    },
}

/// Builds the passes of one frame.
pub struct Frame<'g> {
    gpu: &'g mut Gpu,
    pictures: &'g HashMap<String, Resolved>,
    luts: Option<&'g serde_json::Value>,
    q: f64,
    ops: Vec<Op>,
    slots: Vec<[f32; 64]>,
    mslots: Vec<Vec<f32>>,
}

impl<'g> Frame<'g> {
    pub fn new(
        gpu: &'g mut Gpu,
        pictures: &'g HashMap<String, Resolved>,
        luts: Option<&'g serde_json::Value>,
        q: f64,
    ) -> Self {
        Self { gpu, pictures, luts, q, ops: Vec::new(), slots: Vec::new(), mslots: Vec::new() }
    }

    fn slot(&mut self, v: &[f64]) -> usize {
        let mut s = [0f32; 64];
        for (d, x) in s.iter_mut().zip(v) {
            *d = *x as f32;
        }
        self.slots.push(s);
        self.slots.len() - 1
    }

    fn fit_dim(&self, w: f64, h: f64) -> (u32, u32) {
        let mut tw = (w * self.q).round().max(1.0);
        let mut th = (h * self.q).round().max(1.0);
        let max = f64::from(self.gpu.max_dim);
        let s = (max / tw).min(max / th).min(1.0);
        if s < 1.0 {
            tw = (tw * s).floor().max(1.0);
            th = (th * s).floor().max(1.0);
        }
        (tw as u32, th as u32)
    }

    fn picture(&self, it: &Item<'_>) -> Resolved {
        self.pictures.get(&it.key).cloned().unwrap_or(Resolved {
            picture: Picture::Empty,
            w: it.seq_w,
            h: it.seq_h,
            rotation0: 0,
        })
    }

    /// An item's picture with its effects and masks, as an rgba16float texture of its layer size.
    fn item_texture(&mut self, it: &Item<'_>, r: &Resolved) -> wgpu::Texture {
        let sized = matches!(r.picture, Picture::Frame { .. } | Picture::Nest) || it.kind == ItemKind::Image;
        let (tw, th) = if sized {
            self.fit_dim(r.w, r.h)
        } else {
            (((it.seq_w * self.q).round().max(1.0)) as u32, ((it.seq_h * self.q).round().max(1.0)) as u32)
        };
        let mut cur = self.gpu.texture(tw, th, F16);
        let rot = f64::from((r.rotation0 / 90) % 4);
        match &r.picture {
            Picture::Frame { planes, second } => {
                let u = self.yuv_slot(planes, rot, 0.0);
                self.ops.push(Op::Yuv { planes: planes.clone(), out: cur.clone(), u, over: false });
                if let Some((p2, w)) = second {
                    let u = self.yuv_slot(p2, rot, *w);
                    self.ops.push(Op::Yuv { planes: p2.clone(), out: cur.clone(), u, over: true });
                }
            }
            Picture::Rgba(t) => {
                let u = self.slot(&[rot, 0.0, 0.0, 0.0]);
                self.ops.push(Op::Image { src: t.clone(), out: cur.clone(), u });
            }
            Picture::Nest => self.layers_into(&it.layers, &cur, tw, th, None),
            Picture::Color(c) => {
                self.ops.push(Op::Clear { out: cur.clone(), color: [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]] })
            }
            Picture::Empty => self.ops.push(Op::Clear { out: cur.clone(), color: [0.0; 4] }),
        }
        let px_scale = f64::from(tw) / r.w.max(1e-6);
        for e in &it.effects {
            let lut = e.lut.as_deref().and_then(|id| crate::lumetri::lut_of(self.luts, id));
            let info = Info {
                width: f64::from(tw),
                height: f64::from(th),
                px_scale,
                quality: self.q,
                frame: it.frame_index as f64,
                lut,
            };
            let kind = e.def.id;
            let passes = uniforms::effect(kind, &e.params, &info);
            let orig = cur.clone();
            let mut tex = Vec::new();
            let bindings = uniforms::bindings(kind);
            if !passes.is_empty() && !bindings.is_empty() {
                let tables = uniforms::textures(kind, &e.params, &info);
                for &(n, three_d) in bindings {
                    let t = match tables.iter().find(|t| t.binding == n) {
                        Some(t) => self.gpu.table(&t.key, t.size, &t.data),
                        None => self.gpu.dummy(three_d),
                    };
                    tex.push((n, t));
                }
            }
            for pass in &passes {
                let next = self.gpu.texture(tw, th, F16);
                let mut data = vec![f64::from(tw), f64::from(th), 1.0 / f64::from(tw), 1.0 / f64::from(th)];
                data.extend(pass.iter().take(16));
                let u = self.slot(&data);
                self.ops.push(Op::Effect {
                    kind: kind.to_string(),
                    src: cur,
                    orig: orig.clone(),
                    out: next.clone(),
                    u,
                    tex: tex.clone(),
                });
                cur = next;
            }
            if let Some(m) = &e.masks
                && !passes.is_empty()
            {
                cur = self.masked(cur, orig, m, tw, th, px_scale, 1.0);
            }
        }
        if let Some(m) = &it.masks {
            cur = self.masked(cur.clone(), cur, m, tw, th, px_scale, 0.0);
        }
        cur
    }

    fn yuv_slot(&mut self, p: &Planes, rot: f64, w: f64) -> usize {
        let c = &p.conv;
        let (lw, lh) = (f64::from(p.luma_size.0), f64::from(p.luma_size.1));
        let (cw, ch) = (f64::from(p.chroma_size.0), f64::from(p.chroma_size.1));
        let r = |i: usize| c.rows[i].map(f64::from);
        let (r0, r1, r2) = (r(0), r(1), r(2));
        // Normalized views give code / (2^n - 1): the shader scales them back to the integer codes, so both routes
        // compute with the same numbers.
        let unorm = match (p.normalized, p.max_code > 255.0) {
            (false, _) => 0.0,
            (true, false) => 255.0,
            (true, true) => 65535.0,
        };
        self.slot(&[
            rot,
            w,
            unorm,
            0.0,
            lw,
            lh,
            cw,
            ch,
            r0[0],
            r0[1],
            r0[2],
            0.0,
            r1[0],
            r1[1],
            r1[2],
            0.0,
            r2[0],
            r2[1],
            r2[2],
            f64::from(p.max_code),
            f64::from(c.y_offset),
            f64::from(c.c_offset),
            f64::from(c.y_range),
            f64::from(c.c_range),
        ])
    }

    /// A mask pass: keep inside the masks, under (weighted by `under`) outside.
    #[allow(clippy::too_many_arguments)]
    fn masked(
        &mut self,
        keep: wgpu::Texture,
        under: wgpu::Texture,
        masks: &[cut_model::masks::Mask],
        tw: u32,
        th: u32,
        px_scale: f64,
        w: f64,
    ) -> wgpu::Texture {
        let out = self.gpu.texture(tw, th, F16);
        let u = self.slot(&[f64::from(tw), f64::from(th), 1.0 / f64::from(tw), 1.0 / f64::from(th), w, 0.0, 0.0, 0.0]);
        self.mslots.push(gpu_data(masks, f64::from(tw), f64::from(th), px_scale));
        self.ops.push(Op::Mask { keep, under, out: out.clone(), u, data: self.mslots.len() - 1 });
        out
    }

    fn place_uniforms(&mut self, it: &Item<'_>, r: &Resolved) -> usize {
        let (sx, sy) = (it.scale[0] / 100.0, it.scale[1] / 100.0);
        let safe = |v: f64| if v.abs() < 1e-6 { if v < 0.0 { -1e-6 } else { 1e-6 } } else { v };
        let a = it.rotation * std::f64::consts::PI / 180.0;
        let c = it.crop;
        let z = |v: f64| if v.is_nan() { 0.0 } else { v };
        self.slot(&[
            it.seq_w,
            it.seq_h,
            z(it.position[0]),
            z(it.position[1]),
            a.cos(),
            a.sin(),
            1.0 / safe(sx),
            1.0 / safe(sy),
            r.w,
            r.h,
            z(it.anchor[0]),
            z(it.anchor[1]),
            z(c[3]) / 100.0,
            z(c[0]) / 100.0,
            z(c[1]) / 100.0,
            z(c[2]) / 100.0,
            clamp(it.opacity / 100.0, 0.0, 1.0),
            if it.extend { 1.0 } else { 0.0 },
            sx.abs().min(sy.abs()).max(1e-6) * self.q,
            0.0,
        ])
    }

    fn draw_item(&mut self, it: &Item<'_>, target: &wgpu::Texture) {
        let r = self.picture(it);
        let tex = self.item_texture(it, &r);
        let u = self.place_uniforms(it, &r);
        self.ops.push(Op::Composite { src: tex, out: target.clone(), u });
    }

    /// A sequence's layers over `target`: cleared to its background, or transparent inside a nest.
    fn layers_into(
        &mut self,
        layers: &[Layer<'_>],
        target: &wgpu::Texture,
        tw: u32,
        th: u32,
        background: Option<&str>,
    ) {
        let color = match background {
            Some(b) => {
                let c = hex_to_linear(b, [0.0, 0.0, 0.0, 1.0]);
                [c[0], c[1], c[2], 1.0]
            }
            None => [0.0; 4],
        };
        self.ops.push(Op::Clear { out: target.clone(), color });
        for l in layers {
            match l {
                Layer::Clip(it) => self.draw_item(it, target),
                Layer::Transition { def, params, progress, a, b, .. } => {
                    let ta = self.gpu.texture(tw, th, F16);
                    let tb = self.gpu.texture(tw, th, F16);
                    self.ops.push(Op::Clear { out: ta.clone(), color: [0.0; 4] });
                    self.ops.push(Op::Clear { out: tb.clone(), color: [0.0; 4] });
                    if let Some(a) = a {
                        self.draw_item(a, &ta);
                    }
                    if let Some(b) = b {
                        self.draw_item(b, &tb);
                    }
                    let mut data = vec![f64::from(tw), f64::from(th), 1.0 / f64::from(tw), 1.0 / f64::from(th)];
                    data.extend(uniforms::transition(def.id, params, *progress).into_iter().take(16));
                    let u = self.slot(&data);
                    self.ops.push(Op::Transition { kind: def.id.to_string(), a: ta, b: tb, out: target.clone(), u });
                }
            }
        }
    }

    /// Encodes and submits the frame: the sequence `seq_w` x `seq_h` with its layers, an overlay (captions) on top,
    /// letterboxed into `out`.
    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        mut self,
        layers: &[Layer<'_>],
        seq_w: f64,
        seq_h: f64,
        background: &str,
        overlay: Option<wgpu::Texture>,
        out: &wgpu::Texture,
    ) {
        let (w, h) = (((seq_w * self.q).round().max(1.0)) as u32, ((seq_h * self.q).round().max(1.0)) as u32);
        let accum = self.gpu.texture(w, h, F16);
        self.layers_into(layers, &accum, w, h, Some(background));
        if let Some(c) = overlay {
            let tex = self.gpu.texture(w, h, F16);
            let u = self.slot(&[0.0; 4]);
            self.ops.push(Op::Image { src: c, out: tex.clone(), u });
            let u = self.slot(&[
                seq_w, seq_h, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, seq_w, seq_h, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                self.q, 0.0,
            ]);
            self.ops.push(Op::Composite { src: tex, out: accum.clone(), u });
        }
        let (ow, oh) = (f64::from(out.width()), f64::from(out.height()));
        let fit = (ow / seq_w).min(oh / seq_h);
        let (bw, bh) = (seq_w * fit / ow, seq_h * fit / oh);
        let u = self.slot(&[(1.0 - bw) / 2.0, (1.0 - bh) / 2.0, (1.0 + bw) / 2.0, (1.0 + bh) / 2.0]);
        self.ops.push(Op::Final { src: accum, out: out.clone(), u });
        self.submit();
    }

    fn submit(self) {
        let Frame { gpu, ops, slots, mslots, .. } = self;
        let ubuf = gpu.uniforms(&slots).clone();
        let (sbuf, spans) = gpu.storage(&mslots);
        let sbuf = sbuf.cloned();
        let mut enc =
            gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("cut-engine frame") });
        for op in &ops {
            let ubind = |i: usize| {
                wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &ubuf,
                    offset: (i * 256) as u64,
                    size: NonZeroU64::new(256),
                })
            };
            let view = |t: &wgpu::Texture| t.create_view(&Default::default());
            let (name, format, blend, load, out, views, extra): Pass<'_> = match op {
                Op::Clear { out, color } => {
                    let v = view(out);
                    let [r, g, b, a] = *color;
                    enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: None,
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &v,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a }),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        ..Default::default()
                    });
                    continue;
                }
                Op::Yuv { planes, out, u, over } => (
                    if planes.normalized { "decodeYuvUnorm" } else { "decodeYuv" }.into(),
                    F16,
                    *over,
                    *over,
                    out,
                    vec![(0, planes.luma.clone()), (1, planes.chroma.clone())],
                    vec![(2, *u)],
                ),
                Op::Image { src, out, u } => {
                    ("decodeImage".into(), F16, false, false, out, vec![(0, view(src))], vec![(2, *u)])
                }
                Op::Effect { kind, src, orig, out, u, tex } => {
                    let mut v = vec![(0, view(src)), (3, view(orig))];
                    v.extend(tex.iter().map(|(b, t)| (*b, view(t))));
                    (format!("fx:{kind}"), F16, false, false, out, v, vec![(2, *u)])
                }
                Op::Composite { src, out, u } => {
                    ("composite".into(), F16, true, true, out, vec![(0, view(src))], vec![(2, *u)])
                }
                Op::Transition { kind, a, b, out, u } => {
                    (format!("tr:{kind}"), F16, true, true, out, vec![(0, view(a)), (1, view(b))], vec![(3, *u)])
                }
                Op::Mask { keep, under, out, u, .. } => {
                    ("mask".into(), F16, false, false, out, vec![(0, view(keep)), (1, view(under))], vec![(2, *u)])
                }
                Op::Final { src, out, u } => {
                    ("final".into(), OUT, false, false, out, vec![(0, view(src))], vec![(2, *u)])
                }
            };
            let pipe = gpu.pipeline(&name, format, blend).clone();
            let layout = pipe.get_bind_group_layout(0);
            let mut entries: Vec<wgpu::BindGroupEntry> = views
                .iter()
                .map(|(b, v)| wgpu::BindGroupEntry { binding: *b, resource: wgpu::BindingResource::TextureView(v) })
                .collect();
            for (b, i) in &extra {
                entries.push(wgpu::BindGroupEntry { binding: *b, resource: ubind(*i) });
            }
            let sampler_binding = match op {
                Op::Yuv { .. } | Op::Mask { .. } => None,
                Op::Transition { .. } => Some(2),
                _ => Some(1),
            };
            if let Some(b) = sampler_binding {
                entries
                    .push(wgpu::BindGroupEntry { binding: b, resource: wgpu::BindingResource::Sampler(&gpu.sampler) });
            }
            if let (Op::Mask { data, .. }, Some(sbuf)) = (op, sbuf.as_ref()) {
                let (o, s) = spans[*data];
                entries.push(wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: sbuf,
                        offset: o,
                        size: NonZeroU64::new(s),
                    }),
                });
            }
            let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &layout,
                entries: &entries,
            });
            let v = view(out);
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &v,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: if load { wgpu::LoadOp::Load } else { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&pipe);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
        gpu.recycle();
    }
}
