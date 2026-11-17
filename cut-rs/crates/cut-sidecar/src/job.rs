//! A setup job (`createJob`): commands run one at a time, their output streamed to a log, and a cancel that ends
//! the running command's process tree.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// No console window for the child (`windowsHide`).
pub(crate) const NO_WINDOW: u32 = 0x0800_0000;

type Log = Box<dyn Fn(&str) + Send + Sync>;

struct Inner {
    log: Log,
    cancelled: AtomicBool,
    pid: Mutex<Option<u32>>,
}

/// A setup job; clones share it (one thread runs it, another may cancel it).
#[derive(Clone)]
pub struct Job(Arc<Inner>);

impl Job {
    /// A job whose commands' output goes to `log`.
    pub fn new(log: impl Fn(&str) + Send + Sync + 'static) -> Job {
        Job(Arc::new(Inner { log: Box::new(log), cancelled: AtomicBool::new(false), pid: Mutex::new(None) }))
    }

    /// Writes a line of the job's own to its log.
    pub fn log(&self, text: &str) {
        (self.0.log)(text);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Runs `cmd args` to its end, its stdout and stderr in the log: `Err("Cancelled")` after a cancel,
    /// `Err("<cmd> exited with code <n>")` for a failure, the spawn error's message when it never started.
    pub fn run(&self, cmd: &Path, args: &[String], env: &[(&str, &str)]) -> Result<(), String> {
        if self.is_cancelled() {
            return Err("Cancelled".into());
        }
        let mut line = cmd.display().to_string();
        for a in args {
            line.push(' ');
            line.push_str(a);
        }
        self.log(&format!("> {line}\n"));
        let mut c = Command::new(cmd);
        c.args(args)
            .creation_flags(NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .env("HF_HUB_DISABLE_TELEMETRY", "1");
        for (k, v) in env {
            c.env(k, v);
        }
        let mut child = c.spawn().map_err(|e| format!("spawn {} {e}", cmd.display()))?;
        *self.0.pid.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
        // a cancel that came while it started
        if self.is_cancelled() {
            self.kill_tree();
        }
        let streams: Vec<Box<dyn Read + Send>> = [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .collect();
        let status = std::thread::scope(|sc| {
            for mut s in streams {
                let me = self.clone();
                sc.spawn(move || pump(&mut s, |t| me.log(t)));
            }
            child.wait()
        });
        *self.0.pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if self.is_cancelled() {
            return Err("Cancelled".into());
        }
        let status = status.map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            let name = cmd.file_name().map_or_else(|| cmd.display().to_string(), |n| n.to_string_lossy().into_owned());
            let code = status.code().map_or_else(|| "null".to_owned(), |c| c.to_string());
            Err(format!("{name} exited with code {code}"))
        }
    }

    /// Stops the job: the running command and everything it started end, later commands do not start.
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.kill_tree();
    }

    fn kill_tree(&self) {
        if let Some(pid) = *self.0.pid.lock().unwrap_or_else(|e| e.into_inner()) {
            let _ = Command::new("taskkill")
                .args(["/pid", &pid.to_string(), "/T", "/F"])
                .creation_flags(NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
    }
}

/// Reads a stream to its end, handing each piece on as text (a character split between two reads waits for the next).
pub(crate) fn pump(r: &mut dyn Read, mut out: impl FnMut(&str)) {
    let mut buf = [0u8; 8192];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        let valid = match std::str::from_utf8(&carry) {
            Ok(_) => carry.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => carry.len(),
        };
        if valid > 0 {
            out(&String::from_utf8_lossy(&carry[..valid]));
            carry.drain(..valid);
        }
    }
    if !carry.is_empty() {
        out(&String::from_utf8_lossy(&carry));
    }
}

static QUEUE: Mutex<()> = Mutex::new(());

/// Runs `f` while no other feature's setup runs: they share one environment, so pip runs one at a time.
pub fn exclusive<R>(f: impl FnOnce() -> R) -> R {
    let _g = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pump_keeps_characters_whole() {
        let text = "가나다 abc 한글".as_bytes().to_vec();
        struct Drip(Vec<u8>, usize);
        impl Read for Drip {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                if self.1 >= self.0.len() {
                    return Ok(0);
                }
                b[0] = self.0[self.1];
                self.1 += 1;
                Ok(1)
            }
        }
        let mut got = String::new();
        pump(&mut Drip(text, 0), |t| got.push_str(t));
        assert_eq!(got, "가나다 abc 한글");
    }

    #[test]
    fn a_command_fails_with_its_code_and_a_cancel_wins() {
        let lines = Arc::new(Mutex::new(String::new()));
        let l = lines.clone();
        let job = Job::new(move |t| l.lock().unwrap().push_str(t));
        let cmd = Path::new("cmd.exe");
        job.run(cmd, &["/C".into(), "echo hello".into()], &[]).unwrap();
        assert!(lines.lock().unwrap().contains("> cmd.exe /C echo hello\n") && lines.lock().unwrap().contains("hello"));
        assert_eq!(job.run(cmd, &["/C".into(), "exit 3".into()], &[]), Err("cmd.exe exited with code 3".into()));
        let j2 = job.clone();
        let t = std::thread::spawn(move || j2.run(cmd, &["/C".into(), "ping -n 30 127.0.0.1 >nul".into()], &[]));
        std::thread::sleep(std::time::Duration::from_millis(300));
        let at = std::time::Instant::now();
        job.cancel();
        assert_eq!(t.join().unwrap(), Err("Cancelled".into()));
        assert!(at.elapsed().as_secs() < 10);
        assert_eq!(job.run(cmd, &["/C".into(), "echo late".into()], &[]), Err("Cancelled".into()));
        assert!(Job::new(|_| {}).run(Path::new("no-such-program-here.exe"), &[], &[]).is_err());
    }
}
