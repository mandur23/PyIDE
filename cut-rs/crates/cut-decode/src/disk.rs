//! The free space of a disk, so an export's faststart never fills it with its copy (`fs.statfs` in the JavaScript).

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::core::PCWSTR;

/// Bytes free to this user on the disk that holds `dir`, or `None` when Windows does not say.
pub fn free_space(dir: &Path) -> Option<u64> {
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    // SAFETY: a NUL-terminated path that outlives the call and one valid out pointer.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}
