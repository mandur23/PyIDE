//! A streaming H.264 / HEVC encoder over one Media Foundation transform: a GPU's asynchronous hardware transform,
//! driven by its event queue, or a synchronous software one, driven by `ProcessInput` / `ProcessOutput`. Pictures go
//! in as NV12 (P010 for Main 10) in system memory, one call each; packets come out as MP4 samples.

use std::time::{Duration, Instant};

use windows::Win32::Media::MediaFoundation::*;
use windows::core::Interface;

use super::list::{EncoderInfo, find, vendor};
use super::nal::Packager;
use super::upload::Upload;
use super::{EncodedSample, VideoSettings};
use crate::Codec;
use crate::d3d::Device;
use crate::error::{DecodeError, Result};
use crate::mf::{MediaType, Pull, Sample, Transform, fail};

/// Rate control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateControl {
    /// Constant bitrate.
    Constant,
    /// Variable, one pass, never above `peak` bits a second.
    Variable { peak: u32 },
}

/// What the export asks of an encoder beyond the picture settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderConfig {
    pub video: VideoSettings,
    pub rate: RateControl,
    /// The H.264 level_idc or the HEVC level times 30, as the codec string carries it; `None`: the encoder's choice.
    pub level: Option<u32>,
    /// Tag the stream BT.709, limited range (the colour every export writes).
    pub bt709: bool,
}

impl EncoderConfig {
    /// The plain settings with the encoder's own choices (the test media generator).
    pub fn plain(video: VideoSettings) -> Self {
        Self {
            video,
            rate: RateControl::Variable { peak: video.bitrate.saturating_mul(3) / 2 },
            level: None,
            bt709: false,
        }
    }
}

/// What waiting for an asynchronous transform's event ended with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ev {
    Next,
    Drained,
    Stopped,
}

/// An encoder that stops answering for this long has failed (a hung driver).
const STALL: Duration = Duration::from_secs(20);

/// One video stream being encoded. Not `Send`: it lives on the thread that made it.
pub struct VideoEncoder {
    mft: Transform,
    events: Option<IMFMediaEventGenerator>,
    /// Inputs the asynchronous transform asked for and has not had yet.
    wanted: u32,
    packager: Packager,
    frame_hns: f64,
    fps: [u32; 2],
    name: String,
    hardware: bool,
    vendor: Option<String>,
    frame_bytes: usize,
    /// The D3D11 device a Direct3D 12 encoder works through, kept as long as the transform.
    device: Option<Device>,
    /// The pool of input pictures (textures on `device`, or memory).
    upload: Option<Upload>,
    /// A picture's rows packed, for a transform given memory without the pool.
    packed: Vec<u8>,
    height: u32,
    /// Time `push` spent waiting for the transform to ask for a picture, and copying pictures into samples.
    input_wait: Duration,
    input_copy: Duration,
}

fn platform(call: &'static str, message: &str) -> DecodeError {
    DecodeError::Platform { call, hresult: 0, message: message.into() }
}

impl VideoEncoder {
    /// An encoder on the transform `info` names.
    pub fn new(cfg: &EncoderConfig, info: &EncoderInfo) -> Result<Self> {
        let c = find(info)?;
        let mft = Transform::create(&c)?;
        let vendor = vendor(&c);
        // A Direct3D 12 encoder works on the GPU of the device it is given; an asynchronous transform takes the
        // device only once unlocked. A GPU's own encoder is given a device of its GPU too, so pictures go in as
        // textures ([`Upload`]); one that refuses it takes pictures in memory.
        let device = match &info.adapter {
            Some((index, _)) if info.hardware => {
                if let Some(a) = mft.attributes() {
                    a.set_u32(MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                }
                let d = Device::new(Some(*index))?;
                match mft.set_d3d_manager(&d.manager) {
                    Ok(()) => Some(d),
                    Err(e) if info.shared => return Err(e),
                    Err(_) => None,
                }
            }
            _ => None,
        };
        Self::setup(mft, cfg, info.label(), info.hardware, vendor, device)
    }

    fn setup(
        mft: Transform,
        cfg: &EncoderConfig,
        name: String,
        hardware: bool,
        vendor: Option<String>,
        device: Option<Device>,
    ) -> Result<Self> {
        let s = &cfg.video;
        let hevc = match s.codec {
            Codec::H264 if !s.ten_bit => false,
            Codec::Hevc => true,
            _ => return Err(DecodeError::Unsupported(format!("encoding {:?} ten_bit {}", s.codec, s.ten_bit))),
        };
        let mut mft = mft;
        let events = match mft.attributes() {
            Some(a) if a.u32(MF_TRANSFORM_ASYNC) == Some(1) => {
                a.set_u32(MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                Some(
                    mft.raw()
                        .cast::<IMFMediaEventGenerator>()
                        .map_err(fail("IMFTransform as IMFMediaEventGenerator"))?,
                )
            }
            _ => None,
        };
        let codec_api = |mft: &Transform| {
            let (mode, peak) = match cfg.rate {
                RateControl::Constant => (eAVEncCommonRateControlMode_CBR.0 as u32, None),
                RateControl::Variable { peak } => (eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32, Some(peak)),
            };
            let _ = mft.set_codec_u32(CODECAPI_AVEncCommonRateControlMode, mode);
            let _ = mft.set_codec_u32(CODECAPI_AVEncCommonMeanBitRate, s.bitrate);
            if let Some(p) = peak {
                let _ = mft.set_codec_u32(CODECAPI_AVEncCommonMaxBitRate, p);
            }
            let _ = mft.set_codec_u32(CODECAPI_AVEncMPVGOPSize, s.key_every);
            let _ = mft.set_codec_u32(CODECAPI_AVEncMPVDefaultBPictureCount, s.b_frames);
        };
        codec_api(&mft);
        let colour = |t: &MediaType| -> Result<()> {
            if cfg.bt709 {
                t.set_u32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
                t.set_u32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
                t.set_u32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
                t.set_u32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            }
            Ok(())
        };
        let out = MediaType::new(MFMediaType_Video, if hevc { MFVideoFormat_HEVC } else { MFVideoFormat_H264 })?;
        out.set_u32(MF_MT_AVG_BITRATE, s.bitrate)?;
        out.set_pair(MF_MT_FRAME_RATE, s.fps[0], s.fps[1])?;
        out.set_pair(MF_MT_FRAME_SIZE, s.width, s.height)?;
        out.set_pair(MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
        out.set_u32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        let profile = match (hevc, s.ten_bit) {
            (false, _) => eAVEncH264VProfile_High.0 as u32,
            (true, false) => eAVEncH265VProfile_Main_420_8.0 as u32,
            (true, true) => eAVEncH265VProfile_Main_420_10.0 as u32,
        };
        out.set_u32(MF_MT_MPEG2_PROFILE, profile)?;
        if let Some(l) = cfg.level {
            out.set_u32(MF_MT_MPEG2_LEVEL, l)?;
        }
        colour(&out)?;
        mft.set_output(&out)?;
        let input = MediaType::new(MFMediaType_Video, if s.ten_bit { MFVideoFormat_P010 } else { MFVideoFormat_NV12 })?;
        input.set_pair(MF_MT_FRAME_RATE, s.fps[0], s.fps[1])?;
        input.set_pair(MF_MT_FRAME_SIZE, s.width, s.height)?;
        input.set_pair(MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
        input.set_u32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        colour(&input)?;
        mft.set_input(&input)?;
        // Some encoders take their modes only once both types are set.
        codec_api(&mft);
        let upload = (!s.ten_bit).then(|| Upload::new(device.as_ref(), &input, s.width, s.height).ok()).flatten();
        mft.begin()?;
        let bytes = if s.ten_bit { 2 } else { 1 };
        Ok(Self {
            mft,
            events,
            wanted: 0,
            packager: Packager::new(hevc),
            frame_hns: 1e7 * f64::from(s.fps[1]) / f64::from(s.fps[0]),
            fps: s.fps,
            name,
            hardware,
            vendor,
            frame_bytes: (s.width * s.height * 3 / 2 * bytes) as usize,
            device,
            upload,
            packed: Vec::new(),
            height: s.height,
            input_wait: Duration::ZERO,
            input_copy: Duration::ZERO,
        })
    }

    /// The transform, with its GPU for a hardware one.
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn hardware(&self) -> bool {
        self.hardware
    }

    /// The hardware transform's vendor (`VEN_10DE` ...).
    pub fn vendor(&self) -> Option<&str> {
        self.vendor.as_deref()
    }

    /// Bytes one picture takes: NV12 (P010) of the full size, rows packed.
    pub fn frame_bytes(&self) -> usize {
        self.frame_bytes
    }

    /// The codec string the stream's SPS gives and its avcC or hvcC, once the first packet came out.
    pub fn description(&self) -> Result<(String, Vec<u8>)> {
        self.packager.description()
    }

    fn time_of(&self, frame: u64) -> i64 {
        (frame as f64 * self.frame_hns).round() as i64
    }

    /// Encodes picture `frame` (counted from 0, one frame apart): NV12 (P010) rows `pitch` bytes apart, the chroma
    /// rows after the luma rows. `key` makes it a sync sample. Packets that came out go to `out`. `stop()` true gives
    /// up a wait for the transform: the picture is then not sent, and the caller, which asked to stop, drops the
    /// encoder.
    pub fn push(
        &mut self,
        frame: u64,
        pixels: &[u8],
        pitch: usize,
        key: bool,
        out: &mut Vec<EncodedSample>,
        stop: &dyn Fn() -> bool,
    ) -> Result<()> {
        let row = self.frame_bytes / (self.height as usize * 3 / 2);
        let rows = self.height as usize * 3 / 2;
        if pitch < row || pixels.len() < pitch * (rows - 1) + row {
            return Err(DecodeError::Damaged(format!("a picture of {} bytes at pitch {pitch}", pixels.len())));
        }
        let (t, d) = (self.time_of(frame), self.time_of(frame + 1) - self.time_of(frame));
        let sample = loop {
            let copying = Instant::now();
            let pooled = match &mut self.upload {
                Some(u) => u.sample(self.device.as_ref(), pixels, pitch, t, d)?,
                None => None,
            };
            let s = match pooled {
                Some(s) => Some(s),
                None if self.upload.is_none() || self.events.is_none() => {
                    let packed = if pitch == row {
                        &pixels[..self.frame_bytes]
                    } else {
                        self.packed.clear();
                        for r in 0..rows {
                            self.packed.extend_from_slice(&pixels[r * pitch..r * pitch + row]);
                        }
                        &self.packed[..]
                    };
                    Some(Sample::with_bytes(packed, t, d, false)?)
                }
                None => None,
            };
            self.input_copy += copying.elapsed();
            if let Some(s) = s {
                break s;
            }
            // Every texture is still inside the transform: wait for it to give one back.
            if self.event(out, stop)? == Ev::Stopped {
                return Ok(());
            }
        };
        if key && frame > 0 {
            let _ = self.mft.set_codec_u32(CODECAPI_AVEncVideoForceKeyFrame, 1);
        }
        if self.events.is_some() {
            let since = Instant::now();
            while self.wanted == 0 {
                if self.event(out, stop)? == Ev::Stopped {
                    return Ok(());
                }
            }
            self.input_wait += since.elapsed();
            self.wanted -= 1;
            if !self.mft.push(&sample)? {
                return Err(platform("IMFTransform::ProcessInput", "the encoder asked for a picture and refused it"));
            }
            return Ok(());
        }
        while !self.mft.push(&sample)? {
            self.take(out)?;
        }
        self.take(out)
    }

    /// Ends the stream: every packet still inside comes out.
    pub fn finish(&mut self, out: &mut Vec<EncodedSample>, stop: &dyn Fn() -> bool) -> Result<()> {
        let _ = self.message(MFT_MESSAGE_NOTIFY_END_OF_STREAM);
        self.mft.drain()?;
        if self.events.is_none() {
            return self.take(out);
        }
        loop {
            if self.event(out, stop)? != Ev::Next {
                return Ok(());
            }
        }
    }

    fn message(&self, m: MFT_MESSAGE_TYPE) -> Result<()> {
        // SAFETY: these messages take no parameter.
        unsafe { self.mft.raw().ProcessMessage(m, 0) }.map_err(fail("IMFTransform::ProcessMessage"))
    }

    /// Waits for the asynchronous transform's next event and handles it.
    fn event(&mut self, out: &mut Vec<EncodedSample>, stop: &dyn Fn() -> bool) -> Result<Ev> {
        let Some(events) = self.events.clone() else { return Ok(Ev::Drained) };
        let since = Instant::now();
        let ev = loop {
            // SAFETY: a plain call on a live event generator; NO_WAIT returns at once.
            match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(ev) => break ev,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                    if stop() {
                        return Ok(Ev::Stopped);
                    }
                    if since.elapsed() > STALL {
                        return Err(platform("IMFMediaEventGenerator::GetEvent", "the encoder stopped answering"));
                    }
                    std::thread::sleep(Duration::from_micros(500));
                }
                Err(e) => return Err(fail("IMFMediaEventGenerator::GetEvent")(e)),
            }
        };
        // SAFETY: plain getters on a live event.
        let (kind, status) = unsafe { (ev.GetType(), ev.GetStatus()) };
        if let Ok(st) = status
            && st.is_err()
        {
            return Err(DecodeError::Platform {
                call: "the encoder's event",
                hresult: st.0 as u32,
                message: windows::core::Error::from(st).message(),
            });
        }
        match kind.map_err(fail("IMFMediaEvent::GetType"))? as i32 {
            k if k == METransformNeedInput.0 => self.wanted += 1,
            k if k == METransformHaveOutput.0 => self.pull_one(out)?,
            k if k == METransformDrainComplete.0 => return Ok(Ev::Drained),
            _ => {}
        }
        Ok(Ev::Next)
    }

    fn pull_one(&mut self, out: &mut Vec<EncodedSample>) -> Result<()> {
        match self.mft.pull()? {
            Pull::Sample(s) => out.push(self.packet(&s)?),
            Pull::NeedInput => {}
            Pull::StreamChange => {
                return Err(platform("IMFTransform::ProcessOutput", "the encoder changed its output"));
            }
        }
        Ok(())
    }

    fn take(&mut self, out: &mut Vec<EncodedSample>) -> Result<()> {
        loop {
            match self.mft.pull()? {
                Pull::NeedInput => return Ok(()),
                Pull::StreamChange => {
                    return Err(platform("IMFTransform::ProcessOutput", "the encoder changed its output"));
                }
                Pull::Sample(s) => out.push(self.packet(&s)?),
            }
        }
    }

    fn packet(&mut self, s: &Sample) -> Result<EncodedSample> {
        let raw = s.read(|b, _| b.to_vec())?;
        let pts = s.time().unwrap_or(0);
        let dts = s.attr_u64(MFSampleExtension_DecodeTimestamp).map_or(pts, |v| v as i64);
        let key = s.attr_u32(MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
        Ok(EncodedSample { data: self.packager.sample(&raw), key, pts, dts })
    }

    /// Time [`VideoEncoder::push`] waited for a hardware transform to ask for a picture: the encoder was busy.
    pub fn input_wait(&self) -> Duration {
        self.input_wait
    }

    /// Time [`VideoEncoder::push`] spent copying pictures into Media Foundation samples.
    pub fn input_copy(&self) -> Duration {
        self.input_copy
    }

    /// The frame a packet time (100 ns) stamps.
    pub fn frame_of(&self, hns: i64) -> u64 {
        (hns as f64 / self.frame_hns).round().max(0.0) as u64
    }

    /// The frame rate given.
    pub fn fps(&self) -> [u32; 2] {
        self.fps
    }
}

/// The first software encoder of a codec (the test media generator's, and the export's last resort).
pub fn software(cfg: &EncoderConfig) -> Result<VideoEncoder> {
    let info = super::list::video_encoders(cfg.video.codec)
        .into_iter()
        .find(|e| !e.hardware)
        .ok_or_else(|| DecodeError::Unsupported(format!("this PC has no {:?} software encoder", cfg.video.codec)))?;
    VideoEncoder::new(cfg, &info)
}
