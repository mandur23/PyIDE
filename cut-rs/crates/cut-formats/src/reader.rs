use std::borrow::Cow;
use std::fs::File;
use std::io;
use std::path::Path;

use crate::error::{FormatError, Result};

/// Where a file's bytes come from: a size and range reads, as the JavaScript's `{ size, read(offset, length) }`.
///
/// `read` returns `len` bytes, fewer only where the file ends. An in-memory reader lends its bytes; a file reader
/// returns what it read.
pub trait Reader {
    fn size(&self) -> u64;
    fn read(&self, offset: u64, len: usize) -> io::Result<Cow<'_, [u8]>>;
}

/// The bytes of `offset..offset + len` clamped to the file (empty when nothing of it is in the file).
pub fn read_range<R: Reader + ?Sized>(reader: &R, offset: u64, len: u64) -> Result<Cow<'_, [u8]>> {
    let size = reader.size();
    let end = offset.saturating_add(len).min(size);
    if end <= offset {
        return Ok(Cow::Borrowed(&[]));
    }
    let want =
        usize::try_from(end - offset).map_err(|_| FormatError::damaged("cannot read the file: too big a read"))?;
    let bytes =
        reader.read(offset, want).map_err(|err| FormatError::damaged(format!("cannot read the file: {err}")))?;
    Ok(match bytes {
        Cow::Borrowed(b) => Cow::Borrowed(&b[..b.len().min(want)]),
        Cow::Owned(mut v) => {
            v.truncate(want);
            Cow::Owned(v)
        }
    })
}

/// A reader over bytes in memory (tests, and data already held).
pub struct MemReader<B>(pub B);

impl<B: AsRef<[u8]>> Reader for MemReader<B> {
    fn size(&self) -> u64 {
        self.0.as_ref().len() as u64
    }

    fn read(&self, offset: u64, len: usize) -> io::Result<Cow<'_, [u8]>> {
        let b = self.0.as_ref();
        let start = usize::try_from(offset).unwrap_or(usize::MAX).min(b.len());
        Ok(Cow::Borrowed(&b[start..start.saturating_add(len).min(b.len())]))
    }
}

/// A reader over a file on disk: each read is a positioned read, so one reader serves several threads.
pub struct FileReader {
    file: File,
    size: u64,
}

impl FileReader {
    /// Opens the file for reading.
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        Ok(Self { file, size })
    }
}

impl Reader for FileReader {
    fn size(&self) -> u64 {
        self.size
    }

    fn read(&self, offset: u64, len: usize) -> io::Result<Cow<'_, [u8]>> {
        let len = len.min(usize::try_from(self.size.saturating_sub(offset)).unwrap_or(usize::MAX));
        let mut buf = vec![0; len];
        let mut done = 0;
        while done < len {
            let n = read_at(&self.file, &mut buf[done..], offset + done as u64)?;
            if n == 0 {
                break;
            }
            done += n;
        }
        buf.truncate(done);
        Ok(Cow::Owned(buf))
    }
}

#[cfg(windows)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
}

#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
}
