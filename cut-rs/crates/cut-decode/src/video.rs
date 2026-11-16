//! A video track's samples into pictures through a Media Foundation decoder transform, on the GPU (DXVA, frames as
//! D3D11 textures) or in software (frames in system memory).

use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::Arc;

use cut_formats::{Media, Track};
use cut_time::Ticks;
use windows::Win32::Graphics::Direct3D11::{D3D11_BIND_DECODER, D3D11_BIND_SHADER_RESOURCE, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::{
    MF_LOW_LATENCY, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_SUBTYPE, MF_SA_D3D11_AWARE,
    MF_SA_D3D11_BINDFLAGS, MFMediaType_Video, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT, MFVideoFormat_NV12,
    MFVideoFormat_P010, MFVideoInterlace_Progressive,
};

use crate::Codec;
use crate::annexb::AnnexB;
use crate::d3d::Device;
use crate::error::{DecodeError, Result};
use crate::mf::{MediaType, Pull, Sample, Transform, candidates};

/// Where decoding should happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Accel {
    /// The GPU of the preferred adapter ([`crate::prefer_adapter`]), else software (the JavaScript's hardware-first
    /// order).
    #[default]
    Auto,
    /// Only on the GPU: DXGI adapter `adapter` (`None`: the preferred one). Fails rather than fall back.
    Hardware { adapter: Option<u32> },
    /// Only in software: frames in system memory.
    Software,
}

/// Which decoder a [`VideoDecoder`] ended up with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Path {
    Software { decoder: String },
    Hardware { decoder: String, adapter: String },
}

/// The layout of a frame's pixels: luma, then interleaved Cb/Cr at half size both ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PixelFormat {
    /// 8 bits a sample.
    Nv12,
    /// 16 bits a sample, the value in the top 10 bits.
    P010,
}

impl PixelFormat {
    /// Bytes a sample.
    pub fn sample_bytes(self) -> u32 {
        match self {
            PixelFormat::Nv12 => 1,
            PixelFormat::P010 => 2,
        }
    }
}

/// A picture on the GPU: a slice of the decoder's texture array, held (out of the decoder's small pool) as long as
/// this lives.
pub struct GpuFrame {
    texture: ID3D11Texture2D,
    index: u32,
    device: Arc<Device>,
    /// Keeps the decoder from reusing the texture slice.
    _sample: Sample,
}

impl GpuFrame {
    /// The decoder's texture array (NV12 or P010, bound for decoding and, where the driver allowed, shader reads).
    pub fn texture(&self) -> &ID3D11Texture2D {
        &self.texture
    }

    /// The array slice holding this picture.
    pub fn index(&self) -> u32 {
        self.index
    }

    /// What the texture is: its size (coded, aligned), slices and D3D11 bind and misc flags.
    pub fn info(&self) -> TextureInfo {
        crate::d3d::describe(&self.texture)
    }

    /// The decoder's device.
    pub(crate) fn device(&self) -> &Arc<Device> {
        &self.device
    }
}

/// A decoder texture's description.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextureInfo {
    pub width: u32,
    pub height: u32,
    pub slices: u32,
    /// `D3D11_BIND_*`: DECODER (0x200) when DXVA decoded into it, SHADER_RESOURCE (0x8) when shaders can read it.
    pub bind_flags: u32,
    /// `D3D11_RESOURCE_MISC_*` (SHARED 0x2, SHARED_NTHANDLE 0x800 when it can be opened by another device).
    pub misc_flags: u32,
}

/// Where a frame's pixels are.
pub enum Pixels {
    /// Luma rows of `width * sample_bytes`, then `ceil(height / 2)` chroma rows of the same length.
    Memory(Vec<u8>),
    Gpu(GpuFrame),
}

/// A decoded picture and the sample it shows.
pub struct Frame {
    /// The sample (decode order index in the track's table).
    pub sample: usize,
    /// Its presentation time in ticks (the table's pts).
    pub pts: Ticks,
    /// The visible size.
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    pub pixels: Pixels,
}

impl Frame {
    /// The pixels in system memory (copied back from the GPU for a GPU frame), in the [`Pixels::Memory`] layout.
    pub fn to_memory(&self) -> Result<Cow<'_, [u8]>> {
        match &self.pixels {
            Pixels::Memory(b) => Ok(Cow::Borrowed(b)),
            Pixels::Gpu(g) => g
                .device
                .read_back(&g.texture, g.index, self.width, self.height, self.format.sample_bytes())
                .map(Cow::Owned),
        }
    }
}

/// Samples carry their presentation rank as time, in these 100 ns units, so outputs map back to their sample exactly.
const UNIT: i64 = 10_000;

/// The size and layout of the decoder's output.
#[derive(Debug, Clone, Copy)]
struct Geometry {
    /// Coded rows: where the chroma plane starts in a system memory picture.
    rows: u32,
    stride: Option<u32>,
    visible: [u32; 4],
}

/// One decoder transform for one video track, fed in decode order.
pub struct VideoDecoder<'t> {
    track: &'t Track,
    rank: Vec<u32>,
    annexb: AnnexB,
    mft: Transform,
    device: Option<Arc<Device>>,
    path: Path,
    /// Why the GPU was not used, for `Accel::Auto`.
    fallback: Option<DecodeError>,
    format: PixelFormat,
    geometry: Option<Geometry>,
    /// Pictures taken out so the transform would take a sample (at most a few).
    queue: VecDeque<Frame>,
    draining: bool,
    low_latency: bool,
    /// The presentation rank of the last picture out since the stream (re)started.
    last: Option<u32>,
    scratch: Vec<u8>,
}

fn video_of(track: &Track) -> Result<(Codec, &cut_formats::Video)> {
    let Media::Video(v) = &track.media else {
        return Err(DecodeError::Unsupported("not a video track".into()));
    };
    match Codec::of(&track.codec) {
        Some(c @ (Codec::H264 | Codec::Hevc | Codec::Vp8 | Codec::Vp9 | Codec::Av1)) => Ok((c, v)),
        _ => Err(DecodeError::Unsupported(format!("no Media Foundation decoder here for {}", track.codec))),
    }
}

impl<'t> VideoDecoder<'t> {
    /// A decoder for `track` (H.264 or HEVC), on the GPU or in software as `accel` asks.
    pub fn new(track: &'t Track, accel: Accel) -> Result<Self> {
        Self::with_latency(track, accel, None)
    }

    /// A decoder that, with `low_latency`, gives each picture as soon as the stream's reordering allows
    /// (`MF_LOW_LATENCY`) instead of after the decoder's whole picture buffer (up to 16 more samples a seek). A stream
    /// that does not say how far it reorders could then come out of order: that is caught
    /// ([`DecodeError::OutOfOrder`]) and the caller makes a decoder without it. `None` chooses as measured here: low
    /// latency on the GPU (no cost in speed, and fewer pictures held back from the small texture pool), not in
    /// software (where it stops the decoder's frame threading: 1080p H.264 at 110 frames/s instead of 245).
    pub fn with_latency(track: &'t Track, accel: Accel, low_latency: Option<bool>) -> Result<Self> {
        let gpu_low = low_latency.unwrap_or(true);
        let cpu_low = low_latency.unwrap_or(false);
        let (codec, video) = video_of(track)?;
        let annexb = AnnexB::new(codec, track.description.as_deref())?;
        let format = if video.bit_depth > 8 { PixelFormat::P010 } else { PixelFormat::Nv12 };
        let s = &track.samples;
        let mut rank = vec![0; s.count()];
        for (r, &i) in s.order.iter().enumerate() {
            rank[i as usize] = r as u32;
        }
        let (mft, device, fallback) = match accel {
            Accel::Software => (open(codec, video, format, None, cpu_low)?, None, None),
            Accel::Hardware { adapter } => {
                let device = Device::shared(adapter)?;
                (open(codec, video, format, Some(&device), gpu_low)?, Some(device), None)
            }
            Accel::Auto => {
                match Device::shared(None).and_then(|d| Ok((open(codec, video, format, Some(&d), gpu_low)?, d))) {
                    Ok((mft, d)) => (mft, Some(d), None),
                    Err(e) => (open(codec, video, format, None, cpu_low)?, None, Some(e)),
                }
            }
        };
        let low_latency = if device.is_some() { gpu_low } else { cpu_low };
        let path = match &device {
            Some(d) => Path::Hardware { decoder: mft.name.clone(), adapter: d.adapter.clone() },
            None => Path::Software { decoder: mft.name.clone() },
        };
        Ok(Self {
            track,
            rank,
            annexb,
            mft,
            device,
            path,
            fallback,
            format,
            geometry: None,
            queue: VecDeque::new(),
            draining: false,
            low_latency,
            last: None,
            scratch: Vec::new(),
        })
    }

    /// The decoder in use and where it runs.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the decoder runs in low-latency mode.
    pub fn low_latency(&self) -> bool {
        self.low_latency
    }

    /// Why `Accel::Auto` fell back to software, when it did.
    pub fn fallback(&self) -> Option<&DecodeError> {
        self.fallback.as_ref()
    }

    /// The track decoded.
    pub fn track(&self) -> &'t Track {
        self.track
    }

    /// Feeds sample `index` (its bytes as the table gives them); the pictures it completes wait in [`Self::receive`].
    pub fn send(&mut self, index: usize, bytes: &[u8]) -> Result<()> {
        let s = &self.track.samples;
        if index >= s.count() {
            return Err(DecodeError::Damaged(format!("no sample {index}")));
        }
        self.annexb.convert(bytes, s.key[index], &mut self.scratch)?;
        let sample = Sample::with_bytes(&self.scratch, i64::from(self.rank[index]) * UNIT, UNIT, s.key[index])?;
        while !self.mft.push(&sample)? {
            // The transform holds a picture: take it so it takes the sample. Only this queues pictures, one at a
            // time, since a hardware decoder stops for good once its few output textures are all held.
            match self.pull()? {
                Some(f) => self.queue.push_back(f),
                None => {
                    return Err(DecodeError::Platform {
                        call: "IMFTransform::ProcessInput",
                        hresult: 0,
                        message: "the decoder refuses input and has no output".into(),
                    });
                }
            }
        }
        Ok(())
    }

    /// The next picture in presentation order, or `None` when the decoder needs more samples (or, after
    /// [`Self::finish`], has given everything). Take pictures as they come and drop those not needed: a GPU decoder
    /// has a small pool of output textures and stops for good (the call never returns) when every one is held.
    pub fn receive(&mut self) -> Result<Option<Frame>> {
        if let Some(f) = self.queue.pop_front() {
            return Ok(Some(f));
        }
        let f = self.pull()?;
        if f.is_none() && self.draining {
            self.draining = false;
            self.last = None;
            self.mft.begin()?;
        }
        Ok(f)
    }

    /// Puts a picture back in front of the queue (one taken too early).
    pub(crate) fn unreceive(&mut self, f: Frame) {
        self.queue.push_front(f);
    }

    /// Drops everything fed and decoded (a seek): the next sample sent must be a sync sample.
    pub fn flush(&mut self) -> Result<()> {
        self.queue.clear();
        self.draining = false;
        self.last = None;
        self.mft.flush()
    }

    /// The end of the track: [`Self::receive`] then gives the pictures the decoder still holds, and `None` after the
    /// last; sending again afterwards starts a new stream.
    pub fn finish(&mut self) -> Result<()> {
        self.mft.drain()?;
        self.draining = true;
        Ok(())
    }

    fn pull(&mut self) -> Result<Option<Frame>> {
        loop {
            match self.mft.pull()? {
                Pull::NeedInput => return Ok(None),
                Pull::StreamChange => {
                    choose_output(&mut self.mft, self.format)?;
                    self.geometry = None;
                }
                Pull::Sample(s) => {
                    let f = self.frame(s)?;
                    let r = self.rank[f.sample];
                    if self.low_latency && self.last.is_some_and(|l| r < l) {
                        return Err(DecodeError::OutOfOrder);
                    }
                    self.last = Some(r);
                    return Ok(Some(f));
                }
            }
        }
    }

    fn geometry(&mut self) -> Result<Geometry> {
        if let Some(g) = self.geometry {
            return Ok(g);
        }
        let t = self.mft.output_type()?;
        let (w, h) = t.pair(MF_MT_FRAME_SIZE).unwrap_or((0, 0));
        let visible = t.aperture().unwrap_or([0, 0, w, h]);
        let stride = t.u32(MF_MT_DEFAULT_STRIDE).filter(|&s| (s as i32) > 0);
        let g = Geometry { rows: h, stride, visible };
        self.geometry = Some(g);
        Ok(g)
    }

    fn frame(&mut self, s: Sample) -> Result<Frame> {
        let g = self.geometry()?;
        let time = s.time().ok_or_else(|| DecodeError::Damaged("a picture without a time".into()))?;
        let r = usize::try_from((time + UNIT / 2).div_euclid(UNIT)).unwrap_or(usize::MAX);
        let order = &self.track.samples.order;
        let sample = *order.get(r).ok_or_else(|| DecodeError::Damaged(format!("a picture with time {time}")))? as usize;
        let [_, _, w, h] = g.visible;
        let bytes = self.format.sample_bytes();
        let pixels = match (&self.device, s.texture()) {
            (Some(device), Some((texture, index))) => {
                Pixels::Gpu(GpuFrame { texture, index, device: device.clone(), _sample: s })
            }
            _ => Pixels::Memory(s.read(|b, pitch| copy_planes(b, pitch.or(g.stride.map(|v| v as usize)), g, bytes))??),
        };
        Ok(Frame { sample, pts: self.track.samples.pts[sample], width: w, height: h, format: self.format, pixels })
    }
}

/// The visible rectangle of a system memory picture, packed.
fn copy_planes(b: &[u8], pitch: Option<usize>, g: Geometry, bytes: u32) -> Result<Vec<u8>> {
    let [x, y, w, h] = g.visible.map(|v| v as usize);
    let bytes = bytes as usize;
    let row = w * bytes;
    let pitch = pitch.unwrap_or(row.max((x + w) * bytes));
    let rows = (g.rows as usize).max(y + h);
    let chroma = pitch * rows;
    let ch = h.div_ceil(2);
    let need = chroma + pitch * (y / 2 + ch).saturating_sub(1) + x * bytes + row;
    if h == 0 || b.len() < need {
        return Err(DecodeError::Platform {
            call: "IMFTransform::ProcessOutput",
            hresult: 0,
            message: format!("a picture of {} bytes, {need} expected", b.len()),
        });
    }
    let mut out = Vec::with_capacity(row * (h + ch));
    for r in 0..h {
        let at = (y + r) * pitch + x * bytes;
        out.extend_from_slice(&b[at..at + row]);
    }
    for r in 0..ch {
        let at = chroma + (y / 2 + r) * pitch + x * bytes;
        out.extend_from_slice(&b[at..at + row]);
    }
    Ok(out)
}

fn choose_output(mft: &mut Transform, format: PixelFormat) -> Result<()> {
    let want = match format {
        PixelFormat::Nv12 => MFVideoFormat_NV12,
        PixelFormat::P010 => MFVideoFormat_P010,
    };
    let types = mft.output_types();
    let Some(t) = types.iter().find(|t| t.guid(MF_MT_SUBTYPE) == Some(want)) else {
        let offered: Vec<String> = types.iter().filter_map(|t| t.guid(MF_MT_SUBTYPE)).map(fourcc).collect();
        return Err(DecodeError::Unsupported(format!(
            "{} offers no {format:?} output (offers {})",
            mft.name,
            offered.join(", ")
        )));
    };
    mft.set_output(t)
}

fn fourcc(g: windows::core::GUID) -> String {
    let b = g.data1.to_le_bytes();
    if b.iter().all(|c| c.is_ascii_graphic()) { String::from_utf8_lossy(&b).into_owned() } else { format!("{g:?}") }
}

/// Creates, configures and starts the system decoder transform for the codec, with the device for DXVA when given.
fn open(
    codec: Codec,
    video: &cut_formats::Video,
    format: PixelFormat,
    device: Option<&Device>,
    low_latency: bool,
) -> Result<Transform> {
    let list = candidates(codec, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER)?;
    let Some(first) = list.first() else {
        return Err(DecodeError::Unsupported(codec.missing_decoder().into()));
    };
    let mut mft = Transform::create(first)?;
    if low_latency && let Some(a) = mft.attributes() {
        a.set_u32(MF_LOW_LATENCY, 1)?;
    }
    if let Some(d) = device {
        if !d.decodes(codec, format) {
            return Err(DecodeError::Unsupported(format!("{} has no {codec:?} {format:?} decoder", d.adapter)));
        }
        let aware = mft.attributes().and_then(|a| a.u32(MF_SA_D3D11_AWARE)).unwrap_or(0);
        if aware == 0 {
            return Err(DecodeError::Unsupported(format!("{} does not decode to D3D11", mft.name)));
        }
        mft.set_d3d_manager(&d.manager)?;
        if let Some(a) = mft.output_attributes() {
            // Shader-readable textures (drivers may ignore it). No extra output textures are asked for: every
            // caller copies a picture out (a ring texture, or memory) as soon as it takes it.
            let _ = a.set_u32(MF_SA_D3D11_BINDFLAGS, (D3D11_BIND_DECODER.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32);
        }
    }
    let input = MediaType::new(MFMediaType_Video, crate::mf::input_of(codec).2)?;
    input.set_pair(MF_MT_FRAME_SIZE, video.width, video.height)?;
    input.set_u32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    mft.set_input(&input)?;
    choose_output(&mut mft, format)?;
    mft.begin()?;
    Ok(mft)
}
