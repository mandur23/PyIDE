use cut_formats::{ErrorCode, FormatError};

/// Why a track could not be decoded. `code()` is the JavaScript's error code.
#[derive(Debug, Clone, thiserror::Error)]
pub enum DecodeError {
    /// No decoder on this PC takes the track (codec, profile, bit depth), or this crate does not hand it to one.
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// The sample bytes or the decoder description do not read.
    #[error("damaged: {0}")]
    Damaged(String),
    /// A Media Foundation or Direct3D call failed: which call, and its HRESULT.
    #[error("{call} failed: 0x{hresult:08x} {message}")]
    Platform { call: &'static str, hresult: u32, message: String },
    /// A low-latency decoder gave pictures out of presentation order (the stream does not say how far it reorders).
    #[error("the decoder gave pictures out of order")]
    OutOfOrder,
    /// Reading the file failed.
    #[error(transparent)]
    Format(#[from] FormatError),
}

impl DecodeError {
    /// `unsupported`, `damaged`, `decoder` (the platform's decoder failed), or a read error's own code.
    pub fn code(&self) -> &'static str {
        match self {
            DecodeError::Unsupported(_) => "unsupported",
            DecodeError::Damaged(_) => "damaged",
            DecodeError::Platform { .. } | DecodeError::OutOfOrder => "decoder",
            DecodeError::Format(e) => match e.code {
                ErrorCode::Unsupported => "unsupported",
                ErrorCode::Damaged => "damaged",
                ErrorCode::Hdr => "hdr",
                ErrorCode::NoTracks => "noTracks",
            },
        }
    }
}

/// A decode result.
pub type Result<T> = std::result::Result<T, DecodeError>;
