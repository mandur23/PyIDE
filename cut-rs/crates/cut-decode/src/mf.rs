//! Safe owners of the Media Foundation objects this crate uses: startup, the list of decoder transforms, media types,
//! samples and a synchronous transform driven by `ProcessInput` / `ProcessOutput`.

use std::cell::Cell;
use std::mem::ManuallyDrop;
use std::sync::OnceLock;

use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree};
use windows::core::{GUID, Interface, PWSTR};

use crate::Codec;
use crate::error::{DecodeError, Result};

/// Turns a failed Windows call into a [`DecodeError::Platform`] naming the call.
pub(crate) fn fail(call: &'static str) -> impl FnOnce(windows::core::Error) -> DecodeError {
    move |e| DecodeError::Platform { call, hresult: e.code().0 as u32, message: e.message().trim().to_string() }
}

/// COM on this thread and Media Foundation in the process, once each; neither is ever shut down (decoders can live
/// as long as the app).
pub(crate) fn start() -> Result<()> {
    thread_local!(static COM: Cell<bool> = const { Cell::new(false) });
    if !COM.get() {
        // SAFETY: no reserved pointer. A thread already in an apartment answers S_FALSE or RPC_E_CHANGED_MODE; both
        // are fine, since the transforms here are synchronous and called only from the thread that made them.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        COM.set(true);
    }
    static STARTED: OnceLock<std::result::Result<(), (u32, String)>> = OnceLock::new();
    // SAFETY: MFStartup takes plain integers.
    let started = STARTED.get_or_init(|| {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) }.map_err(|e| (e.code().0 as u32, e.message()))
    });
    started.clone().map_err(|(hresult, message)| DecodeError::Platform { call: "MFStartup", hresult, message })
}

/// What a codec is to Media Foundation: the transform category and the input subtype.
pub(crate) fn input_of(codec: Codec) -> (GUID, GUID, GUID) {
    match codec {
        Codec::H264 => (MFT_CATEGORY_VIDEO_DECODER, MFMediaType_Video, MFVideoFormat_H264),
        Codec::Hevc => (MFT_CATEGORY_VIDEO_DECODER, MFMediaType_Video, MFVideoFormat_HEVC),
        Codec::Aac => (MFT_CATEGORY_AUDIO_DECODER, MFMediaType_Audio, MFAudioFormat_AAC),
        Codec::Vp8 => (MFT_CATEGORY_VIDEO_DECODER, MFMediaType_Video, MFVideoFormat_VP80),
        Codec::Vp9 => (MFT_CATEGORY_VIDEO_DECODER, MFMediaType_Video, MFVideoFormat_VP90),
        Codec::Av1 => (MFT_CATEGORY_VIDEO_DECODER, MFMediaType_Video, MFVideoFormat_AV1),
    }
}

/// A decoder transform the system lists, not created yet.
pub(crate) struct Candidate {
    pub(crate) name: String,
    /// A vendor's hardware transform (asynchronous; the system decoders reach the GPU through DXVA instead).
    pub(crate) hardware: bool,
    activate: IMFActivate,
}

fn string(attrs: &IMFAttributes, key: &GUID) -> Option<String> {
    let mut p = PWSTR::null();
    let mut len = 0;
    // SAFETY: on success the attribute store hands out a CoTaskMem string, read once and freed here.
    unsafe {
        attrs.GetAllocatedString(key, &mut p, &mut len).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

/// The transforms that decode `codec`, the system's choice order (`SORTANDFILTER`) first.
pub(crate) fn candidates(codec: Codec, flags: MFT_ENUM_FLAG) -> Result<Vec<Candidate>> {
    let (category, major, subtype) = input_of(codec);
    enumerate(category, flags, Some((major, subtype)), None)
}

/// The transforms that encode to `codec`.
pub(crate) fn encoders(codec: Codec, flags: MFT_ENUM_FLAG) -> Result<Vec<Candidate>> {
    let (category, out) = match codec {
        Codec::H264 => (MFT_CATEGORY_VIDEO_ENCODER, (MFMediaType_Video, MFVideoFormat_H264)),
        Codec::Hevc => (MFT_CATEGORY_VIDEO_ENCODER, (MFMediaType_Video, MFVideoFormat_HEVC)),
        Codec::Aac => (MFT_CATEGORY_AUDIO_ENCODER, (MFMediaType_Audio, MFAudioFormat_AAC)),
        c => (MFT_CATEGORY_VIDEO_ENCODER, (MFMediaType_Video, input_of(c).2)),
    };
    enumerate(category, flags, None, Some(out))
}

pub(crate) fn enumerate(
    category: GUID,
    flags: MFT_ENUM_FLAG,
    input: Option<(GUID, GUID)>,
    output: Option<(GUID, GUID)>,
) -> Result<Vec<Candidate>> {
    start()?;
    let info = |(major, subtype): (GUID, GUID)| MFT_REGISTER_TYPE_INFO { guidMajorType: major, guidSubtype: subtype };
    let (input, output) = (input.map(info), output.map(info));
    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut n = 0u32;
    // SAFETY: the type infos and out pointers are valid locals; the array MFTEnumEx returns holds `n` activates, each
    // moved out exactly once before the array itself is freed.
    let activates: Vec<IMFActivate> = unsafe {
        let (i, o) = (input.as_ref().map(|r| r as *const _), output.as_ref().map(|r| r as *const _));
        MFTEnumEx(category, flags, i, o, &mut list, &mut n).map_err(fail("MFTEnumEx"))?;
        if list.is_null() {
            return Ok(Vec::new());
        }
        let items = std::slice::from_raw_parts_mut(list, n as usize).iter_mut().filter_map(Option::take).collect();
        CoTaskMemFree(Some(list as *const _));
        items
    };
    Ok(activates
        .into_iter()
        .map(|activate| {
            let attrs: IMFAttributes = activate.clone().into();
            let name = string(&attrs, &MFT_FRIENDLY_NAME_Attribute).unwrap_or_else(|| "(no name)".into());
            let hardware = string(&attrs, &MFT_ENUM_HARDWARE_URL_Attribute).is_some();
            Candidate { name, hardware, activate }
        })
        .collect())
}

/// Every decoder (or encoder) of `codec` the system lists, synchronous and hardware, as `name` or `name (hardware)`.
pub(crate) fn list(codec: Codec, encode: bool) -> Vec<String> {
    let flags = MFT_ENUM_FLAG_SYNCMFT
        | MFT_ENUM_FLAG_ASYNCMFT
        | MFT_ENUM_FLAG_HARDWARE
        | MFT_ENUM_FLAG_LOCALMFT
        | MFT_ENUM_FLAG_SORTANDFILTER;
    if encode { encoders(codec, flags) } else { candidates(codec, flags) }
        .unwrap_or_default()
        .into_iter()
        .map(|c| if c.hardware { format!("{} (hardware)", c.name) } else { c.name })
        .collect()
}

/// An attribute store (a media type, a transform's or a stream's attributes).
pub(crate) struct Attrs(IMFAttributes);

impl Attrs {
    pub(crate) fn set_u32(&self, key: GUID, v: u32) -> Result<()> {
        // SAFETY: the key is a valid GUID for the call's duration.
        unsafe { self.0.SetUINT32(&key, v) }.map_err(fail("IMFAttributes::SetUINT32"))
    }

    pub(crate) fn u32(&self, key: GUID) -> Option<u32> {
        // SAFETY: as above.
        unsafe { self.0.GetUINT32(&key) }.ok()
    }
}

/// A media type being built or read.
pub(crate) struct MediaType(IMFMediaType);

impl MediaType {
    pub(crate) fn new(major: GUID, subtype: GUID) -> Result<Self> {
        start()?;
        // SAFETY: MFCreateMediaType has no inputs.
        let t = Self(unsafe { MFCreateMediaType() }.map_err(fail("MFCreateMediaType"))?);
        t.set_guid(MF_MT_MAJOR_TYPE, major)?;
        t.set_guid(MF_MT_SUBTYPE, subtype)?;
        Ok(t)
    }

    pub(crate) fn set_guid(&self, key: GUID, v: GUID) -> Result<()> {
        // SAFETY: both GUIDs live for the call.
        unsafe { self.0.SetGUID(&key, &v) }.map_err(fail("IMFMediaType::SetGUID"))
    }

    pub(crate) fn set_u32(&self, key: GUID, v: u32) -> Result<()> {
        // SAFETY: the key lives for the call.
        unsafe { self.0.SetUINT32(&key, v) }.map_err(fail("IMFMediaType::SetUINT32"))
    }

    /// A pair attribute (frame size, frame rate, aspect): `hi` in the upper 32 bits.
    pub(crate) fn set_pair(&self, key: GUID, hi: u32, lo: u32) -> Result<()> {
        // SAFETY: the key lives for the call.
        unsafe { self.0.SetUINT64(&key, (u64::from(hi) << 32) | u64::from(lo)) }
            .map_err(fail("IMFMediaType::SetUINT64"))
    }

    pub(crate) fn set_blob(&self, key: GUID, v: &[u8]) -> Result<()> {
        // SAFETY: the key and the slice live for the call; the store copies the bytes.
        unsafe { self.0.SetBlob(&key, v) }.map_err(fail("IMFMediaType::SetBlob"))
    }

    pub(crate) fn blob(&self, key: GUID) -> Option<Vec<u8>> {
        // SAFETY: the buffer is sized by GetBlobSize and the store writes at most that many bytes.
        unsafe {
            let n = self.0.GetBlobSize(&key).ok()?;
            let mut v = vec![0; n as usize];
            self.0.GetBlob(&key, &mut v, None).ok()?;
            Some(v)
        }
    }

    pub(crate) fn guid(&self, key: GUID) -> Option<GUID> {
        // SAFETY: the key lives for the call.
        unsafe { self.0.GetGUID(&key) }.ok()
    }

    pub(crate) fn u32(&self, key: GUID) -> Option<u32> {
        // SAFETY: the key lives for the call.
        unsafe { self.0.GetUINT32(&key) }.ok()
    }

    pub(crate) fn pair(&self, key: GUID) -> Option<(u32, u32)> {
        // SAFETY: the key lives for the call.
        let v = unsafe { self.0.GetUINT64(&key) }.ok()?;
        Some(((v >> 32) as u32, v as u32))
    }

    /// The visible rectangle `[x, y, w, h]` (`MF_MT_MINIMUM_DISPLAY_APERTURE`), when the type gives it.
    pub(crate) fn aperture(&self) -> Option<[u32; 4]> {
        let mut area = MFVideoArea::default();
        // SAFETY: the buffer is exactly one MFVideoArea, the blob's documented layout.
        let bytes = unsafe {
            std::slice::from_raw_parts_mut((&mut area as *mut MFVideoArea).cast::<u8>(), size_of::<MFVideoArea>())
        };
        // SAFETY: the key lives for the call; the store writes at most bytes.len().
        unsafe { self.0.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, bytes, None) }.ok()?;
        let (w, h) = (u32::try_from(area.Area.cx).ok()?, u32::try_from(area.Area.cy).ok()?);
        let (x, y) = (u32::try_from(area.OffsetX.value).ok()?, u32::try_from(area.OffsetY.value).ok()?);
        (w > 0 && h > 0).then_some([x, y, w, h])
    }
}

/// A Media Foundation sample: one compressed chunk going in, or a decoded picture or block of sound coming out.
pub(crate) struct Sample(IMFSample);

impl Sample {
    /// A sample made elsewhere (an allocator's).
    pub(crate) fn wrap(s: IMFSample) -> Self {
        Self(s)
    }

    /// A sample holding a copy of `bytes`, stamped with `time` and `duration` (100 ns units).
    pub(crate) fn with_bytes(bytes: &[u8], time: i64, duration: i64, key: bool) -> Result<Self> {
        let len = u32::try_from(bytes.len()).map_err(|_| DecodeError::Damaged("a sample over 4 GB".into()))?;
        // SAFETY: the buffer is locked for exactly the copy of `len` bytes into its `max >= len` bytes, then unlocked;
        // the sample and buffer are owned COM objects released on drop.
        unsafe {
            let buffer = MFCreateMemoryBuffer(len.max(1)).map_err(fail("MFCreateMemoryBuffer"))?;
            let mut p = std::ptr::null_mut();
            let mut max = 0;
            buffer.Lock(&mut p, Some(&mut max), None).map_err(fail("IMFMediaBuffer::Lock"))?;
            if max >= len {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            }
            buffer.Unlock().map_err(fail("IMFMediaBuffer::Unlock"))?;
            buffer.SetCurrentLength(len).map_err(fail("IMFMediaBuffer::SetCurrentLength"))?;
            let sample = MFCreateSample().map_err(fail("MFCreateSample"))?;
            sample.AddBuffer(&buffer).map_err(fail("IMFSample::AddBuffer"))?;
            sample.SetSampleTime(time).map_err(fail("IMFSample::SetSampleTime"))?;
            sample.SetSampleDuration(duration).map_err(fail("IMFSample::SetSampleDuration"))?;
            if key {
                sample.SetUINT32(&MFSampleExtension_CleanPoint, 1).map_err(fail("IMFSample::SetUINT32"))?;
            }
            Ok(Self(sample))
        }
    }

    /// An empty sample with one buffer of `size` bytes, for a transform that does not allocate its output.
    fn empty(size: u32, alignment: u32) -> Result<Self> {
        // SAFETY: plain constructors; the buffer is owned by the sample from AddBuffer on.
        unsafe {
            let buffer = if alignment > 1 {
                MFCreateAlignedMemoryBuffer(size, alignment - 1)
            } else {
                MFCreateMemoryBuffer(size)
            }
            .map_err(fail("MFCreateMemoryBuffer"))?;
            let sample = MFCreateSample().map_err(fail("MFCreateSample"))?;
            sample.AddBuffer(&buffer).map_err(fail("IMFSample::AddBuffer"))?;
            Ok(Self(sample))
        }
    }

    /// A 32-bit attribute of the sample (`MFSampleExtension_CleanPoint` ...).
    pub(crate) fn attr_u32(&self, key: GUID) -> Option<u32> {
        // SAFETY: the key lives for the call.
        unsafe { self.0.GetUINT32(&key) }.ok()
    }

    /// A 64-bit attribute of the sample (`MFSampleExtension_DecodeTimestamp` ...).
    pub(crate) fn attr_u64(&self, key: GUID) -> Option<u64> {
        // SAFETY: the key lives for the call.
        unsafe { self.0.GetUINT64(&key) }.ok()
    }

    /// The sample time in 100 ns units.
    pub(crate) fn time(&self) -> Option<i64> {
        // SAFETY: no arguments.
        unsafe { self.0.GetSampleTime() }.ok()
    }

    /// Calls `f` with the sample's bytes as one slice and the row pitch when the buffer is a 2D one.
    pub(crate) fn read<T>(&self, f: impl FnOnce(&[u8], Option<usize>) -> T) -> Result<T> {
        // SAFETY: the buffer stays locked for `f` only; the slice does not outlive the lock. A 2D buffer gives its
        // first line and pitch; its bytes run pitch * rows from there, which is what GetContiguousLength reports.
        unsafe {
            let buffer = self.0.ConvertToContiguousBuffer().map_err(fail("IMFSample::ConvertToContiguousBuffer"))?;
            if let Ok(b2) = buffer.cast::<IMF2DBuffer>() {
                let mut line = std::ptr::null_mut();
                let mut pitch = 0;
                if b2.Lock2D(&mut line, &mut pitch).is_ok() {
                    let len = b2.GetContiguousLength().unwrap_or(0) as usize;
                    let out = if pitch > 0 && !line.is_null() {
                        Some(f(std::slice::from_raw_parts(line, len), Some(pitch as usize)))
                    } else {
                        None
                    };
                    let _ = b2.Unlock2D();
                    if let Some(out) = out {
                        return Ok(out);
                    }
                    return Err(DecodeError::Platform {
                        call: "IMF2DBuffer::Lock2D",
                        hresult: 0,
                        message: "a bottom-up or empty picture".into(),
                    });
                }
            }
            let mut p = std::ptr::null_mut();
            let mut len = 0;
            buffer.Lock(&mut p, None, Some(&mut len)).map_err(fail("IMFMediaBuffer::Lock"))?;
            let out = f(if p.is_null() { &[] } else { std::slice::from_raw_parts(p, len as usize) }, None);
            let _ = buffer.Unlock();
            Ok(out)
        }
    }

    /// The D3D11 texture and array slice of a GPU picture, or `None` for a picture in system memory.
    pub(crate) fn texture(&self) -> Option<(ID3D11Texture2D, u32)> {
        // SAFETY: GetResource writes an AddRef'd texture into the Option, which then owns it.
        unsafe {
            let buffer = self.0.GetBufferByIndex(0).ok()?;
            let dxgi = buffer.cast::<IMFDXGIBuffer>().ok()?;
            let mut tex: Option<ID3D11Texture2D> = None;
            dxgi.GetResource(&ID3D11Texture2D::IID, &mut tex as *mut _ as *mut _).ok()?;
            Some((tex?, dxgi.GetSubresourceIndex().ok()?))
        }
    }
}

/// What a pull from the transform gave.
pub(crate) enum Pull {
    Sample(Sample),
    /// Nothing until more input.
    NeedInput,
    /// The output format changed (the first picture's real size, a new SPS): pick an output type again.
    StreamChange,
}

/// A synchronous decoder transform with one input and one output stream.
pub(crate) struct Transform {
    mft: IMFTransform,
    pub(crate) name: String,
    provides: bool,
    out_size: u32,
    out_align: u32,
}

impl Transform {
    /// Creates the transform a candidate names.
    pub(crate) fn create(c: &Candidate) -> Result<Self> {
        // SAFETY: the activate is a live COM object; ActivateObject returns an owned interface.
        let mft: IMFTransform = unsafe { c.activate.ActivateObject() }.map_err(fail("IMFActivate::ActivateObject"))?;
        Ok(Self { mft, name: c.name.clone(), provides: false, out_size: 0, out_align: 0 })
    }

    /// The transform's own attributes (where `MF_SA_D3D11_AWARE` and the low-latency switch live).
    pub(crate) fn attributes(&self) -> Option<Attrs> {
        // SAFETY: no arguments; returns an owned interface.
        unsafe { self.mft.GetAttributes() }.ok().map(Attrs)
    }

    /// The output stream's attributes (D3D11 bind flags, shared textures, pool size).
    pub(crate) fn output_attributes(&self) -> Option<Attrs> {
        // SAFETY: stream 0 is the only output stream.
        unsafe { self.mft.GetOutputStreamAttributes(0) }.ok().map(Attrs)
    }

    /// Sets a `CODECAPI_*` property to a 32-bit value through the transform's ICodecAPI.
    pub(crate) fn set_codec_u32(&self, api: GUID, value: u32) -> Result<()> {
        use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_UI4};
        let v = VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_UI4,
                    Anonymous: VARIANT_0_0_0 { ulVal: value },
                    ..Default::default()
                }),
            },
        };
        // SAFETY: a VT_UI4 variant owns nothing, so it needs no VariantClear; the API GUID lives for the call.
        unsafe {
            let codec: ICodecAPI = self.mft.cast().map_err(fail("IMFTransform as ICodecAPI"))?;
            codec.SetValue(&api, &v).map_err(fail("ICodecAPI::SetValue"))
        }
    }

    /// Hands the transform a DXGI device manager so it decodes on the GPU (DXVA).
    pub(crate) fn set_d3d_manager(&self, manager: &IMFDXGIDeviceManager) -> Result<()> {
        // SAFETY: the message's parameter is the manager's IUnknown pointer, which the transform AddRefs and keeps.
        unsafe { self.mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize) }
            .map_err(fail("ProcessMessage(SET_D3D_MANAGER)"))
    }

    pub(crate) fn set_input(&self, t: &MediaType) -> Result<()> {
        // SAFETY: the type is a live media type, copied by the transform.
        unsafe { self.mft.SetInputType(0, &t.0, 0) }.map_err(fail("IMFTransform::SetInputType"))
    }

    /// The output types the transform offers now, in its order of preference.
    pub(crate) fn output_types(&self) -> Vec<MediaType> {
        let mut out = Vec::new();
        for i in 0..64 {
            // SAFETY: stream 0, index i; the call fails with MF_E_NO_MORE_TYPES past the end.
            match unsafe { self.mft.GetOutputAvailableType(0, i) } {
                Ok(t) => out.push(MediaType(t)),
                Err(_) => break,
            }
        }
        out
    }

    pub(crate) fn set_output(&mut self, t: &MediaType) -> Result<()> {
        // SAFETY: as set_input; then the stream info is plain data.
        unsafe {
            self.mft.SetOutputType(0, &t.0, 0).map_err(fail("IMFTransform::SetOutputType"))?;
            let info = self.mft.GetOutputStreamInfo(0).map_err(fail("IMFTransform::GetOutputStreamInfo"))?;
            self.provides = info.dwFlags
                & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0) as u32
                != 0;
            self.out_size = info.cbSize;
            self.out_align = info.cbAlignment;
        }
        Ok(())
    }

    /// Output buffers of at least `bytes` (an encoder that reports a size too small for one frame).
    pub(crate) fn reserve_output(&mut self, bytes: u32) {
        self.out_size = self.out_size.max(bytes);
    }

    /// The output type in use.
    pub(crate) fn output_type(&self) -> Result<MediaType> {
        // SAFETY: stream 0.
        unsafe { self.mft.GetOutputCurrentType(0) }.map(MediaType).map_err(fail("IMFTransform::GetOutputCurrentType"))
    }

    fn message(&self, m: MFT_MESSAGE_TYPE, call: &'static str) -> Result<()> {
        // SAFETY: these messages take no parameter.
        unsafe { self.mft.ProcessMessage(m, 0) }.map_err(fail(call))
    }

    /// Tells the transform streaming starts (it allocates its resources here, not on the first sample).
    pub(crate) fn begin(&self) -> Result<()> {
        self.message(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, "ProcessMessage(BEGIN_STREAMING)")?;
        self.message(MFT_MESSAGE_NOTIFY_START_OF_STREAM, "ProcessMessage(START_OF_STREAM)")
    }

    /// Drops everything inside the transform (a seek).
    pub(crate) fn flush(&self) -> Result<()> {
        self.message(MFT_MESSAGE_COMMAND_FLUSH, "ProcessMessage(FLUSH)")
    }

    /// Asks for every picture still inside; pull until `NeedInput` after this.
    pub(crate) fn drain(&self) -> Result<()> {
        self.message(MFT_MESSAGE_COMMAND_DRAIN, "ProcessMessage(DRAIN)")
    }

    /// Offers a sample: `false` when the transform holds output to pull first (MF_E_NOTACCEPTING).
    pub(crate) fn push(&self, s: &Sample) -> Result<bool> {
        // SAFETY: the sample is a live COM object; the transform AddRefs it if it keeps it.
        match unsafe { self.mft.ProcessInput(0, &s.0, 0) } {
            Ok(()) => Ok(true),
            Err(e) if e.code() == MF_E_NOTACCEPTING => Ok(false),
            Err(e) => Err(fail("IMFTransform::ProcessInput")(e)),
        }
    }

    /// Takes one output.
    pub(crate) fn pull(&self) -> Result<Pull> {
        let given = if self.provides { None } else { Some(Sample::empty(self.out_size.max(1), self.out_align)?.0) };
        let mut buffer = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(given),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        };
        let mut status = 0;
        // SAFETY: one output buffer for stream 0. Whether we put the sample in or the transform did, the field holds
        // exactly one reference afterwards, taken back into an owned value below (as are any events).
        let r = unsafe { self.mft.ProcessOutput(0, std::slice::from_mut(&mut buffer), &mut status) };
        let sample = ManuallyDrop::into_inner(buffer.pSample);
        drop(ManuallyDrop::into_inner(buffer.pEvents));
        match r {
            Ok(()) => sample.map(|s| Pull::Sample(Sample(s))).ok_or_else(|| DecodeError::Platform {
                call: "IMFTransform::ProcessOutput",
                hresult: 0,
                message: "no sample in a successful output".into(),
            }),
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(Pull::NeedInput),
            Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => Ok(Pull::StreamChange),
            Err(e) => Err(fail("IMFTransform::ProcessOutput")(e)),
        }
    }
}

/// What the encoders (`encode`) reach beyond the decoders' use: transforms listed per adapter, the transform itself
/// (its event queue when it is asynchronous).
impl Candidate {
    pub(crate) fn from_activate(activate: IMFActivate) -> Self {
        let attrs: IMFAttributes = activate.clone().into();
        let name = string(&attrs, &MFT_FRIENDLY_NAME_Attribute).unwrap_or_else(|| "(no name)".into());
        let hardware = string(&attrs, &MFT_ENUM_HARDWARE_URL_Attribute).is_some();
        Candidate { name, hardware, activate }
    }

    /// A string attribute of the listing (`MFT_ENUM_HARDWARE_VENDOR_ID_Attribute` ...).
    pub(crate) fn attr_string(&self, key: &GUID) -> Option<String> {
        string(&self.activate.clone().into(), key)
    }
}

impl Transform {
    pub(crate) fn raw(&self) -> &IMFTransform {
        &self.mft
    }
}

impl MediaType {
    pub(crate) fn raw(&self) -> &IMFMediaType {
        &self.0
    }
}
