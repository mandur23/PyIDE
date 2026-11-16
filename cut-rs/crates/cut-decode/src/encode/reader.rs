//! Windows' own Media Foundation source reader on a written file: a file only this crate's reader accepts is not an
//! export. The reader parses the file itself and decodes it with the system's decoders.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Media::MediaFoundation::*;
use windows::core::PCWSTR;

use crate::error::Result;
use crate::mf::{MediaType, fail, start};

/// What the source reader read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SourceReaderReport {
    /// Pictures decoded (as NV12), and the first and last one's time in 100 ns units.
    pub frames: u64,
    pub first_frame: Option<i64>,
    pub last_frame: Option<i64>,
    /// Sound samples a channel decoded (as float), and the time of the first block.
    pub audio_samples: u64,
    pub first_audio: Option<i64>,
}

const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
const AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

/// Opens `path` with `MFCreateSourceReaderFromURL` and decodes every picture and all the sound.
pub fn read_with_source_reader(path: &Path) -> Result<SourceReaderReport> {
    start()?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: a NUL-terminated path that outlives the call; no attributes.
    let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), None) }
        .map_err(fail("MFCreateSourceReaderFromURL"))?;
    let mut out = SourceReaderReport::default();
    let nv12 = MediaType::new(MFMediaType_Video, MFVideoFormat_NV12)?;
    let float = MediaType::new(MFMediaType_Audio, MFAudioFormat_Float)?;
    // SAFETY: the stream constants and live media types; a stream the file lacks just fails.
    let (has_video, has_audio) = unsafe {
        (
            reader.SetCurrentMediaType(VIDEO, None, nv12.raw()).is_ok(),
            reader.SetCurrentMediaType(AUDIO, None, float.raw()).is_ok(),
        )
    };
    for (stream, on) in [(VIDEO, has_video), (AUDIO, has_audio)] {
        if !on {
            continue;
        }
        let channels = if stream == AUDIO {
            // SAFETY: the stream's current type, an owned interface.
            unsafe { reader.GetCurrentMediaType(stream) }
                .ok()
                .and_then(|t| unsafe { t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) }.ok())
                .unwrap_or(2)
        } else {
            1
        };
        loop {
            let (mut flags, mut time, mut sample) = (0u32, 0i64, None);
            // SAFETY: valid out pointers; the sample comes back owned.
            unsafe { reader.ReadSample(stream, 0, None, Some(&mut flags), Some(&mut time), Some(&mut sample)) }
                .map_err(fail("IMFSourceReader::ReadSample"))?;
            if let Some(s) = sample {
                if stream == VIDEO {
                    out.frames += 1;
                    out.first_frame.get_or_insert(time);
                    out.last_frame = Some(time);
                } else {
                    // SAFETY: a plain getter.
                    let bytes = unsafe { s.GetTotalLength() }.unwrap_or(0);
                    out.audio_samples += u64::from(bytes) / 4 / u64::from(channels.max(1));
                    out.first_audio.get_or_insert(time);
                }
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
        }
    }
    Ok(out)
}
