//! What this process costs the machine, for benchmarks and the engine's statistics: CPU time across all its threads,
//! its memory, and how busy each GPU engine is with its work (the `\GPU Engine(*)\Utilization Percentage` counters).

use std::time::Duration;

use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Performance::{
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PdhAddEnglishCounterW, PdhCloseQuery,
    PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, GetProcessTimes};
use windows::core::{PCWSTR, w};

/// User plus kernel time of every thread of this process so far.
pub fn process_cpu() -> Duration {
    let (mut a, mut b, mut k, mut u) =
        (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: the pseudo handle of the current process and four valid out pointers.
    if unsafe { GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut k, &mut u) }.is_err() {
        return Duration::ZERO;
    }
    let ticks = |f: FILETIME| (u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime);
    Duration::from_nanos((ticks(k) + ticks(u)) * 100)
}

/// This process's memory, in bytes.
#[derive(Debug, Clone, Copy, Default)]
pub struct Memory {
    /// Pages in RAM now, and the most there ever were.
    pub working_set: u64,
    pub peak_working_set: u64,
    /// Memory committed to this process alone (what Task Manager calls its commit size).
    pub private: u64,
}

/// This process's memory now.
pub fn process_memory() -> Memory {
    let mut c = PROCESS_MEMORY_COUNTERS_EX { cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32, ..Default::default() };
    // SAFETY: the EX struct starts with the plain one and its size is given in `cb`.
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), (&raw mut c).cast(), c.cb) }.is_ok();
    if !ok {
        return Memory::default();
    }
    Memory {
        working_set: c.WorkingSetSize as u64,
        peak_working_set: c.PeakWorkingSetSize as u64,
        private: c.PrivateUsage as u64,
    }
}

/// How busy one kind of engine of one GPU was with this process's work over a measured span.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineUse {
    /// The adapter's LUID as the counters name it (`0x00000000_0x0000D1F2`) and its DXGI name when known.
    pub luid: String,
    pub adapter: String,
    /// `3D`, `VideoDecode`, `Copy`, `Compute_0` ...
    pub engine: String,
    /// Percent of the span, the busiest engine of this kind (as Task Manager shows it).
    pub percent: f64,
}

/// A span over which the GPU engine counters of this process are averaged: [`GpuUse::start`], the work, then
/// [`GpuUse::finish`].
pub struct GpuUse {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}

impl GpuUse {
    /// Starts measuring; `None` when the counters are not there (an older Windows, a stopped counter service).
    pub fn start() -> Option<Self> {
        let mut query = PDH_HQUERY::default();
        let mut counter = PDH_HCOUNTER::default();
        // SAFETY: valid out pointers; the query is closed in Drop, or here when the counter cannot be added.
        unsafe {
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return None;
            }
            if PdhAddEnglishCounterW(query, w!(r"\GPU Engine(*)\Utilization Percentage"), 0, &mut counter) != 0
                || PdhCollectQueryData(query) != 0
            {
                let _ = PdhCloseQuery(query);
                return None;
            }
        }
        Some(Self { query, counter })
    }

    /// The average use of each engine kind of each GPU by this process since [`GpuUse::start`].
    pub fn finish(self) -> Vec<EngineUse> {
        // SAFETY: the query and counter are live; the item buffer is sized as the first call asks, and its names
        // point into that buffer, read before it goes.
        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return Vec::new();
            }
            let (mut size, mut count) = (0u32, 0u32);
            let _ = PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
            if size == 0 {
                return Vec::new();
            }
            let n = (size as usize).div_ceil(size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>());
            let mut items = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); n];
            if PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(items.as_mut_ptr()),
            ) != 0
            {
                return Vec::new();
            }
            let prefix = format!("pid_{}_", GetCurrentProcessId());
            let names = crate::d3d::adapter_luids();
            let mut out: Vec<EngineUse> = Vec::new();
            for it in &items[..count as usize] {
                let name = it.szName.to_string().unwrap_or_default();
                let Some(rest) = name.strip_prefix(&prefix) else { continue };
                let value = it.FmtValue.Anonymous.doubleValue;
                // luid_0xHHHHHHHH_0xLLLLLLLL_phys_0_eng_N_engtype_KIND
                let luid = rest.strip_prefix("luid_").and_then(|r| r.get(..21)).unwrap_or("").to_string();
                let engine = rest.split("_engtype_").nth(1).unwrap_or("").to_string();
                let adapter = names
                    .iter()
                    .find(|(_, l)| luid.eq_ignore_ascii_case(l))
                    .map(|(n, _)| n.clone())
                    .unwrap_or_default();
                match out.iter_mut().find(|e| e.luid == luid && e.engine == engine) {
                    Some(e) => e.percent = e.percent.max(value),
                    None => out.push(EngineUse { luid, adapter, engine, percent: value }),
                }
            }
            out.sort_by(|a, b| (&a.adapter, &a.engine).cmp(&(&b.adapter, &b.engine)));
            out
        }
    }
}

impl Drop for GpuUse {
    fn drop(&mut self) {
        // SAFETY: the query opened in `start`, closed once.
        unsafe {
            let _ = PdhCloseQuery(self.query);
        }
    }
}

/// Video memory this process uses on one GPU, in bytes: its own memory (`local`; for an integrated GPU, the part of
/// RAM it reserves) and system memory it maps (`shared`), with what the OS lets the process use of the first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoMemory {
    /// The DXGI index (`Accel::Hardware { adapter }`) and name.
    pub index: u32,
    pub adapter: String,
    pub local: u64,
    pub shared: u64,
    pub budget: u64,
}

/// This process's video memory on each GPU DXGI lists.
pub fn video_memory() -> Vec<VideoMemory> {
    use windows::Win32::Graphics::Dxgi::{
        DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
        IDXGIAdapter3,
    };
    use windows::core::Interface;
    (0..16)
        .map_while(|i| crate::d3d::adapter_at(i).ok().map(|a| (i, a)))
        .filter_map(|(index, a)| {
            let a3: IDXGIAdapter3 = a.cast().ok()?;
            let (mut local, mut shared) =
                (DXGI_QUERY_VIDEO_MEMORY_INFO::default(), DXGI_QUERY_VIDEO_MEMORY_INFO::default());
            // SAFETY: plain queries filling structs.
            unsafe {
                a3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut local).ok()?;
                a3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL, &mut shared).ok()?;
            }
            Some(VideoMemory {
                index,
                adapter: crate::d3d::name_of(&a),
                local: local.CurrentUsage,
                shared: shared.CurrentUsage,
                budget: local.Budget,
            })
        })
        .collect()
}
