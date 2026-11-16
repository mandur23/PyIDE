//! `runs.js`: which run of an editor wrote a marker, and whether that run is still alive.
//!
//! The JavaScript asks `process.kill(pid, 0)` and trusts a pid only for a run that started after the computer did.
//! Without Win32 calls (the workspace denies `unsafe`) this asks PowerShell once for every pid in question, getting
//! each running process's start time: a pid counts as alive when a process has it and that process started before the
//! marker's run did (within [`START_SLACK_MS`]). A pid reused by a later process, after a restart or not, is dead.

use std::collections::HashMap;
use std::process::{Command, Stdio};

use serde_json::{Map, Value};

use super::atomic::{now_ms, random_u64};

/// How much later than its run's `started` a process may have started and still be that run: the clock may have been
/// set back between the process start and the run's start.
pub const START_SLACK_MS: i64 = 10 * 60_000;

/// One start of an editor: its process, an id unique to this start (12 hex digits), and when it started (ms).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub pid: u32,
    pub run: String,
    pub started: i64,
}

impl Default for Run {
    fn default() -> Self {
        Self::new()
    }
}

/// JavaScript's `Number(v)`, for marker fields another editor wrote.
pub(crate) fn num(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Some(_) => f64::NAN,
    }
}

impl Run {
    /// This start of this process.
    pub fn new() -> Self {
        Self { pid: std::process::id(), run: format!("{:012x}", random_u64() & 0xffff_ffff_ffff), started: now_ms() }
    }

    fn pid_of(&self, marker: &Map<String, Value>) -> Option<u32> {
        let pid = num(marker.get("pid"));
        let ok =
            pid.fract() == 0.0 && pid > 0.0 && pid <= f64::from(u32::MAX) && num(marker.get("started")).is_finite();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let pid = pid as u32;
        (ok && pid != self.pid).then_some(pid)
    }

    /// Whether the run that wrote each marker is alive: this run is; a marker of this process from an earlier run is
    /// not. One process query answers every marker.
    pub(crate) fn alive(&self, markers: &[&Map<String, Value>]) -> Vec<bool> {
        let mine = |m: &Map<String, Value>| m.get("run").and_then(Value::as_str) == Some(self.run.as_str());
        let mut pids: Vec<u32> = markers.iter().filter(|m| !mine(m)).filter_map(|m| self.pid_of(m)).collect();
        pids.sort_unstable();
        pids.dedup();
        let running = processes(&pids);
        markers
            .iter()
            .map(|m| {
                if mine(m) {
                    return true;
                }
                let Some(pid) = self.pid_of(m) else { return false };
                match running.get(&pid) {
                    None => false,
                    Some(None) => true,
                    Some(Some(start)) => (*start as f64) <= num(m.get("started")) + START_SLACK_MS as f64,
                }
            })
            .collect()
    }
}

/// The running processes among `pids`, each with its start time in ms when the system tells it (not for a process of
/// another user). When the question cannot be asked, every pid counts as running: another editor's markers are then
/// left alone rather than offered or deleted while it may still be writing them.
fn processes(pids: &[u32]) -> HashMap<u32, Option<i64>> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let all = || pids.iter().map(|&p| (p, None)).collect();
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let script = format!(
        "Get-Process -Id {list} -ErrorAction SilentlyContinue | ForEach-Object {{ '{{0}} {{1}}' -f $_.Id, $(if ($_.StartTime) {{ ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() }} else {{ '-' }}) }}; 'done'"
    );
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flashes up from a window app.
        cmd.creation_flags(0x0800_0000);
    }
    // The exit code says only whether some pid was missing; the last line says the query ran to its end.
    let Ok(out) = cmd.output() else { return all() };
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.lines().last().map(str::trim) != Some("done") {
        return all();
    }
    stdout
        .lines()
        .filter_map(|line| {
            let (pid, start) = line.trim().split_once(' ')?;
            Some((pid.parse().ok()?, start.parse().ok()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn marker(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn numbers_as_javascript_reads_them() {
        assert_eq!(num(Some(&json!(" 12 "))), 12.0);
        assert_eq!(num(Some(&json!(""))), 0.0);
        assert_eq!(num(Some(&json!(null))), 0.0);
        assert!(num(Some(&json!("x"))).is_nan());
        assert!(num(None).is_nan());
    }

    #[test]
    fn liveness() {
        let run = Run::new();
        let mut child = Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
        let now = now_ms();
        let markers = [
            marker(json!({ "pid": 1, "run": run.run, "started": 0 })),
            marker(json!({ "pid": run.pid, "run": "feedface", "started": now })),
            marker(json!({ "pid": child.id(), "run": "a", "started": now })),
            marker(json!({ "pid": child.id(), "run": "b", "started": now - 3_600_000 })),
            marker(json!({ "pid": child.id(), "run": "c" })),
            marker(json!({ "pid": 999_999, "run": "d", "started": now })),
            marker(json!({ "pid": -4, "run": "e", "started": now })),
        ];
        let refs: Vec<_> = markers.iter().collect();
        let alive = run.alive(&refs);
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(alive, [true, false, true, false, false, false, false]);
    }
}
