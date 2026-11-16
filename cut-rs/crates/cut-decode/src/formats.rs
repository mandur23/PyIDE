//! The audio codecs WebCodecs plays beyond AAC, as one table: what each codec string names, the Media Foundation
//! subtype its transforms take, which of this PC's transforms may decode it, and the sentence a refusal shows when
//! none may. (VP8, VP9 and AV1 video are [`crate::Codec`]s: they go through the video decoder.)

use windows::Win32::Media::MediaFoundation::{
    MFAudioFormat_ALAC, MFAudioFormat_FLAC, MFAudioFormat_MP3, MFAudioFormat_Opus, MFAudioFormat_Vorbis,
    MFMediaType_Audio, MFT_CATEGORY_AUDIO_DECODER, MFT_CATEGORY_AUDIO_ENCODER, MFT_ENUM_FLAG, MFT_ENUM_FLAG_ASYNCMFT,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_LOCALMFT, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT,
};
use windows::core::GUID;

use crate::error::Result;
use crate::mf::{Candidate, enumerate};

/// An audio codec handed to a Media Foundation transform of its own (AAC is [`crate::Codec::Aac`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    Mp3,
    Flac,
    Opus,
    Vorbis,
    Alac,
}

/// A transform this PC lists for a [`Format`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub name: String,
    /// A vendor's hardware transform (the GPU's own decoder or encoder block).
    pub hardware: bool,
    /// A wrapper around FFmpeg some other program installed: listed, never used.
    pub refused: bool,
}

impl Format {
    /// Every format in the table.
    pub const ALL: [Format; 5] = [Format::Mp3, Format::Flac, Format::Opus, Format::Vorbis, Format::Alac];

    /// The format of a codec string as cut-formats writes it (`mp3`, `flac`, `opus`, `vorbis`, `alac`), or `None`.
    pub fn of(codec: &str) -> Option<Self> {
        Some(match codec {
            "mp3" => Format::Mp3,
            "flac" => Format::Flac,
            "opus" => Format::Opus,
            "vorbis" => Format::Vorbis,
            "alac" => Format::Alac,
            _ => return None,
        })
    }

    /// The codec's name in a sentence.
    pub fn name(self) -> &'static str {
        match self {
            Format::Mp3 => "MP3",
            Format::Flac => "FLAC",
            Format::Opus => "Opus",
            Format::Vorbis => "Vorbis",
            Format::Alac => "ALAC",
        }
    }

    pub(crate) fn subtype(self) -> GUID {
        match self {
            Format::Mp3 => MFAudioFormat_MP3,
            Format::Flac => MFAudioFormat_FLAC,
            Format::Opus => MFAudioFormat_Opus,
            Format::Vorbis => MFAudioFormat_Vorbis,
            Format::Alac => MFAudioFormat_ALAC,
        }
    }

    /// Why a track of this format is not played when no usable decoder is listed: the sentence the import list and
    /// the media panel show.
    pub fn refusal(self) -> &'static str {
        match self {
            Format::Vorbis => "Vorbis audio is not supported yet.",
            Format::Alac => "ALAC audio is not supported yet.",
            Format::Mp3 => "This PC has no MP3 decoder.",
            Format::Flac => "This PC has no FLAC decoder.",
            Format::Opus => "This PC has no Opus decoder.",
        }
    }

    /// The transforms this PC lists that decode (`encode` false) or encode the format, the system's order first.
    pub fn transforms(self, encode: bool) -> Vec<Listed> {
        let flags = MFT_ENUM_FLAG_SYNCMFT
            | MFT_ENUM_FLAG_ASYNCMFT
            | MFT_ENUM_FLAG_HARDWARE
            | MFT_ENUM_FLAG_LOCALMFT
            | MFT_ENUM_FLAG_SORTANDFILTER;
        self.list(encode, flags)
            .unwrap_or_default()
            .into_iter()
            .map(|c| Listed { refused: refused(&c.name), name: c.name, hardware: c.hardware })
            .collect()
    }

    /// Whether this PC has a decoder this crate may use for the format.
    pub fn decodable(self) -> bool {
        self.transforms(false).iter().any(|l| !l.refused)
    }

    pub(crate) fn list(self, encode: bool, flags: MFT_ENUM_FLAG) -> Result<Vec<Candidate>> {
        let t = Some((MFMediaType_Audio, self.subtype()));
        if encode {
            enumerate(MFT_CATEGORY_AUDIO_ENCODER, flags, None, t)
        } else {
            enumerate(MFT_CATEGORY_AUDIO_DECODER, flags, t, None)
        }
    }

    /// The decoders this crate may create, synchronous software ones (the system's choice order) first.
    pub(crate) fn usable(self, flags: MFT_ENUM_FLAG) -> Result<Vec<Candidate>> {
        Ok(self.list(false, flags)?.into_iter().filter(|c| !refused(&c.name)).collect())
    }
}

/// Third-party transforms that wrap FFmpeg (the owner's rule: never FFmpeg).
fn refused(name: &str) -> bool {
    name.to_ascii_lowercase().contains("ffmpeg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_strings_name_their_formats() {
        assert_eq!(Format::of("opus"), Some(Format::Opus));
        assert_eq!(Format::of("vp8"), None);
        assert_eq!(Format::of("avc1.64001f"), None);
        assert!(refused("FFmpegAudioDecoder"));
        assert!(!refused("Microsoft Opus Audio Decoder MFT"));
    }

    #[test]
    #[ignore]
    fn print_what_this_pc_lists() {
        for f in Format::ALL {
            eprintln!("{:?} decoders {:?}", f, f.transforms(false));
            eprintln!("{:?} encoders {:?}", f, f.transforms(true));
        }
    }
}
