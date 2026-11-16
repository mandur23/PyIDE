use std::borrow::Cow;

use serde::Serialize;

/// Why a file or a track cannot be used: the codes of the JavaScript's `FormatError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Unsupported,
    Damaged,
    Hdr,
    NoTracks,
}

/// A file (or a part of it) that cannot be used, with a message for people.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize)]
#[error("{detail}")]
pub struct FormatError {
    pub code: ErrorCode,
    pub detail: Cow<'static, str>,
}

impl FormatError {
    /// An error with its code and message.
    pub fn new(code: ErrorCode, detail: impl Into<Cow<'static, str>>) -> Self {
        Self { code, detail: detail.into() }
    }

    pub fn damaged(detail: impl Into<Cow<'static, str>>) -> Self {
        Self::new(ErrorCode::Damaged, detail)
    }

    pub fn unsupported(detail: impl Into<Cow<'static, str>>) -> Self {
        Self::new(ErrorCode::Unsupported, detail)
    }
}

/// A result whose error is a [`FormatError`].
pub type Result<T, E = FormatError> = std::result::Result<T, E>;

pub(crate) fn damaged<T>(detail: impl Into<Cow<'static, str>>) -> Result<T> {
    Err(FormatError::damaged(detail))
}

pub(crate) fn unsupported<T>(detail: impl Into<Cow<'static, str>>) -> Result<T> {
    Err(FormatError::unsupported(detail))
}
