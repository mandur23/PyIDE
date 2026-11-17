//! Proxies (`ui-proxy.js`): small H.264 copies of video media that the monitors play while the Proxy switch is on;
//! export always reads the originals.
//!
//! Create Proxy queues the chosen video media. One job runs at a time on a thread of its own: a one-clip sequence of
//! the media at the proxy size (the short side the setting `proxyHeight`, 720 by default) and the nearest editor rate
//! goes through `cut_export::run` with no sound and a keyframe every 15 frames, into the Cut cache folder
//! (`proxy-<hash of path, size, mtime, height>-<height>p.mp4`, so the cache's limit and Clear Cache cover it). A job
//! waits to start while a monitor plays. When it is done the media gets its `proxy` through `History::amend` (no undo
//! step) if the project is still the one it was made for; a proxy file already in the cache is used at once.
//!
//! A running job also waits before each frame while a monitor plays (the export's `gate`), as the JavaScript's does.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};

use cut_model::commands::build as C;
use cut_model::{Id, Media, MediaKind};
use eframe::egui;
use serde_json::{Value as Json, json};

use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// A keyframe every this many frames (`KEY_EVERY`).
pub const KEY_EVERY: u32 = 15;

/// Where a job is (`state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Waiting,
    Running,
    Done,
    Cancelled,
    Failed,
}

/// One proxy to make.
pub struct Job {
    pub id: u64,
    pub media: Id,
    pub name: String,
    pub state: JobState,
    /// Waiting because a monitor plays: to start, or (running) before its next frame.
    pub paused: bool,
    pub path: PathBuf,
    pub error: Option<String>,
    /// The project it was made for (the autosave key of the open project then).
    project: String,
    copy: Media,
    cancel: Arc<AtomicBool>,
    /// Held while a monitor plays: the running export waits before its next frame (`gate`).
    gate: Arc<AtomicBool>,
    fraction: Arc<Mutex<f64>>,
    rx: Option<Receiver<Result<PathBuf, String>>>,
}

impl Job {
    /// The part made so far (0 to 1).
    pub fn fraction(&self) -> f64 {
        *self.fraction.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The queue.
#[derive(Default)]
pub struct Proxies {
    pub jobs: Vec<Job>,
    next: u64,
}

/// The proxy size (`proxyHeight`): 540, 720 or 1080, else 720.
pub fn height_of(settings: &crate::files::Settings) -> u32 {
    let h = super::number(settings, "proxyHeight");
    if [540.0, 720.0, 1080.0].contains(&h) { h as u32 } else { 720 }
}

/// `even`: the nearest even number, two at least (halves round up, as `Math.round`).
fn even(n: f64) -> u32 {
    (((n / 2.0 + 0.5).floor() * 2.0).max(2.0)) as u32
}

/// The proxy's size (`sizeOf`): the short side `height`, never larger than the media.
pub fn size_of(w: f64, h: f64, height: u32) -> (u32, u32) {
    // `m.video?.w || 1920`: zero and NaN are not given
    let w = if w == 0.0 || w.is_nan() { 1920.0 } else { w };
    let h = if h == 0.0 || h.is_nan() { 1080.0 } else { h };
    let k = (f64::from(height) / w.min(h)).min(1.0);
    (even(w * k), even(h * k))
}

/// FNV-1a of a text's UTF-16 code units, twice with two seeds: 16 hex digits (`hash`).
pub fn hash(text: &str) -> String {
    let (mut a, mut b) = (0x811c_9dc5_u32, 0x0100_0193_u32 ^ 0x5bd1_e995);
    for c in text.encode_utf16() {
        a = (a ^ u32::from(c)).wrapping_mul(0x0100_0193);
        b = (b ^ u32::from(c)).wrapping_mul(0x0100_0193 + 2);
    }
    format!("{a:08x}{b:08x}")
}

/// A JSON value as JavaScript's template string writes it (`${m.size}`).
pub fn js_text(v: &Json) -> String {
    match v {
        Json::Null => "null".into(),
        Json::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            Some(f) => format!("{f}"),
            None => n.to_string(),
        },
        Json::String(s) => s.clone(),
        Json::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

/// The proxy file of a media item (`pathOf`).
pub fn path_of(cache: &Path, m: &Media, height: u32) -> PathBuf {
    let key = format!("{}|{}|{}|{height}", m.path.to_lowercase(), js_text(&m.size), js_text(&m.mtime));
    cache.join(format!("proxy-{}-{height}p.mp4", hash(&key)))
}

/// The video media chosen in the Project panel.
pub fn chosen(s: &Shell) -> Vec<Id> {
    let p = s.app.project();
    let sel = s.project.selected();
    p.media.iter().filter(|m| sel.contains(&m.id) && m.kind == MediaKind::Video).map(|m| m.id).collect()
}

fn job_of(p: &Proxies, media: Id) -> Option<&Job> {
    p.jobs.iter().find(|j| j.media == media && matches!(j.state, JobState::Waiting | JobState::Running))
}

/// Queues proxies of `ids` (`create`) -> how many were queued.
pub fn create(s: &mut Shell, ids: &[Id]) -> usize {
    let offline = &s.features.prefs.relink.offline;
    let list: Vec<Media> = ids
        .iter()
        .filter_map(|id| s.app.project().media(*id))
        .filter(|m| m.kind == MediaKind::Video && m.video.is_some() && !offline.contains(&m.id))
        .cloned()
        .collect();
    if list.is_empty() {
        s.app.toast(tr("Choose video media to make proxies of."));
        return 0;
    }
    let mut n = 0;
    for m in list {
        let q = &mut s.features.prefs.proxy;
        if job_of(q, m.id).is_some() {
            continue;
        }
        q.next += 1;
        q.jobs.push(Job {
            id: q.next,
            media: m.id,
            name: m.name.clone(),
            state: JobState::Waiting,
            paused: false,
            path: PathBuf::new(),
            error: None,
            project: s.doc.key.clone(),
            copy: m,
            cancel: Arc::new(AtomicBool::new(false)),
            gate: Arc::new(AtomicBool::new(false)),
            fraction: Arc::new(Mutex::new(0.0)),
            rx: None,
        });
        n += 1;
    }
    if n > 0 {
        s.app.toast(trf("{n} proxies queued", &[("n", &n.to_string())]));
    }
    n
}

/// Whether a media item has a proxy waiting or being made.
pub fn queued(s: &Shell, media: Id) -> bool {
    job_of(&s.features.prefs.proxy, media).is_some()
}

/// Stops the job of a media item (`cancel`) -> whether there was one.
pub fn cancel(s: &mut Shell, media: Id) -> bool {
    let Some(j) = s
        .features
        .prefs
        .proxy
        .jobs
        .iter_mut()
        .find(|j| j.media == media && matches!(j.state, JobState::Waiting | JobState::Running))
    else {
        return false;
    };
    if j.state == JobState::Running {
        j.cancel.store(true, Ordering::Relaxed);
    } else {
        j.state = JobState::Cancelled;
    }
    true
}

/// The media no longer play their proxy, one undo step (`remove`); the files stay in the cache.
pub fn remove(s: &mut Shell, ids: &[Id]) {
    let with: Vec<Id> =
        ids.iter().copied().filter(|id| s.app.project().media(*id).is_some_and(|m| m.proxy.is_some())).collect();
    if with.is_empty() {
        return;
    }
    let list = with.iter().map(|id| C::set_proxy(id.as_str(), None)).collect();
    s.app.exec(&C::batch(&tr("Remove Proxy"), list));
}

/// The one-clip project a proxy is exported from: the media at the proxy size and its nearest editor rate.
fn proxy_project(m: &Media, w: u32, h: u32) -> Result<(cut_model::Project, Id), String> {
    let fps = crate::edit::source::rate_of(m);
    let mut hist = cut_model::History::new(cut_model::defaults::project(), 10).map_err(|e| e.to_string())?;
    let seq = hist.project().sequences[0].id;
    let mut media = serde_json::to_value(m).map_err(|e| e.to_string())?;
    media["proxy"] = Json::Null;
    if let Some(o) = media.as_object_mut() {
        o.remove("id");
    }
    let run = |hist: &mut cut_model::History, c: Json| hist.apply(&c).map_err(|e| e.message);
    run(&mut hist, C::set_sequence(seq.as_str(), json!({ "w": w, "h": h, "fps": [fps.num, fps.den] })))?;
    let r = run(&mut hist, C::import_media(json!([media]), None))?;
    let id = r["ids"][0].as_str().ok_or("no media")?.to_owned();
    let track = hist.project().sequences[0].tracks.iter().find(|t| t.kind == cut_model::TrackKind::Video).map(|t| t.id);
    let track = track.ok_or("no video track")?;
    run(
        &mut hist,
        C::place(
            seq.as_str(),
            json!({
                "source": { "media": id }, "in": 0, "out": m.duration, "at": 0,
                "video": track.as_str(), "audio": null, "mode": "overwrite",
            }),
        ),
    )?;
    Ok((hist.project().clone(), seq))
}

fn start(s: &mut Shell, ctx: &egui::Context, index: usize) {
    let height = height_of(&s.doc.settings);
    let cache = s.doc.home.cache.clone();
    let gpu = s.monitors.as_ref().map(|m| (m.program.engine.device().clone(), m.program.engine.queue().clone()));
    let journal = crate::export::journal(s);
    let j = &mut s.features.prefs.proxy.jobs[index];
    let m = j.copy.clone();
    let path = path_of(&cache, &m, height);
    j.path = path.clone();
    j.state = JobState::Running;
    j.paused = false;
    let (tx, rx) = channel();
    j.rx = Some(rx);
    let (cancel, gate, fraction, ctx) = (j.cancel.clone(), j.gate.clone(), j.fraction.clone(), ctx.clone());
    std::thread::Builder::new()
        .name("proxy".into())
        .spawn(move || {
            let r = make(&m, &path, height, Shared { gpu, gate, journal }, &cancel, &fraction, &ctx);
            let _ = tx.send(r);
            ctx.request_repaint();
        })
        .ok();
}

/// What a proxy's export shares with the app: its GPU, the gate that pauses it while playing, the part-file journal.
struct Shared {
    gpu: Option<(eframe::egui_wgpu::wgpu::Device, eframe::egui_wgpu::wgpu::Queue)>,
    gate: Arc<AtomicBool>,
    journal: Arc<dyn cut_export::sink::Journal>,
}

/// Makes one proxy file (`run`): a file made before is used at once.
fn make(
    m: &Media,
    path: &Path,
    height: u32,
    Shared { gpu, gate, journal }: Shared,
    cancel: &AtomicBool,
    fraction: &Mutex<f64>,
    ctx: &egui::Context,
) -> Result<PathBuf, String> {
    if std::fs::metadata(path).is_ok_and(|x| x.is_file() && x.len() > 0) {
        return Ok(path.to_owned());
    }
    let (vw, vh) = m.video.as_ref().map_or((1920.0, 1080.0), |v| (v.w, v.h));
    let (w, h) = size_of(vw, vh, height);
    let (project, seq) = proxy_project(m, w, h)?;
    let fps = project.sequences[0].fps;
    let preset = cut_export::presets::get("720p").ok_or("no 720p preset")?;
    let o = cut_export::presets::Overrides {
        w: Some(f64::from(w)),
        h: Some(f64::from(h)),
        mode: Some(cut_export::presets::RateMode::Variable),
        ..Default::default()
    };
    let mut settings = cut_export::presets::resolve(preset, fps, Some((f64::from(w), f64::from(h))), &o);
    settings.audio = None;
    settings.loudness = None;
    if let Some(v) = &mut settings.video {
        v.key_interval = KEY_EVERY;
    }
    let mut job = cut_export::Job::new(
        Arc::new(project),
        seq,
        path.to_owned(),
        settings,
        crate::transport::file_audio(cut_audio::Library::default()),
    );
    job.gpu = gpu;
    job.gate = Some(gate);
    job.journal = Some(journal);
    let r = cut_export::run(job, cancel, &mut |p| {
        let f = match p.phase {
            cut_export::Phase::Video => Some(p.fraction),
            cut_export::Phase::Finish | cut_export::Phase::Verify => Some(1.0),
            _ => None,
        };
        if let Some(f) = f {
            *fraction.lock().unwrap_or_else(|e| e.into_inner()) = f;
            ctx.request_repaint();
        }
    });
    match r {
        Ok(done) => Ok(done.path),
        Err(f) => Err(if f.code == "cancelled" { "cancelled".into() } else { crate::export::said(&f) }),
    }
}

/// The queue each frame: a finished job's proxy goes on its media, the next job starts unless a monitor plays.
pub fn poll(s: &mut Shell, ctx: &egui::Context) {
    let playing = s.transport.playing() || s.app.edit.source.playing();
    let mut finished = Vec::new();
    for (i, j) in s.features.prefs.proxy.jobs.iter_mut().enumerate() {
        if let Some(rx) = &j.rx
            && let Ok(r) = rx.try_recv()
        {
            j.rx = None;
            finished.push((i, r));
        }
    }
    for (i, r) in finished {
        let (media, project, name) = {
            let j = &s.features.prefs.proxy.jobs[i];
            (j.media, j.project.clone(), j.name.clone())
        };
        let cancelled = s.features.prefs.proxy.jobs[i].cancel.load(Ordering::Relaxed);
        let state = match r {
            _ if cancelled => JobState::Cancelled,
            Err(e) if e == "cancelled" => JobState::Cancelled,
            Err(e) => {
                s.app.report(trf(
                    "The proxy for {name} could not be made: {error}",
                    &[("name", &name), ("error", &tr(&e))],
                ));
                s.features.prefs.proxy.jobs[i].error = Some(e);
                JobState::Failed
            }
            Ok(path) => {
                if adopt(s, media, &project, &path) {
                    s.app.toast(trf("The proxy for {name} is ready", &[("name", &name)]));
                    JobState::Done
                } else {
                    JobState::Cancelled
                }
            }
        };
        let j = &mut s.features.prefs.proxy.jobs[i];
        j.state = state;
        if state != JobState::Failed {
            *j.fraction.lock().unwrap_or_else(|e| e.into_inner()) = 1.0;
        }
        let path = j.path.clone();
        if state == JobState::Cancelled {
            let _ = std::fs::remove_file(path.with_extension("mp4.part"));
        }
    }
    let q = &mut s.features.prefs.proxy;
    for j in q.jobs.iter_mut().filter(|j| j.state == JobState::Running) {
        j.gate.store(playing, Ordering::Relaxed);
        j.paused = playing;
    }
    if q.jobs.iter().any(|j| j.state == JobState::Running) {
        ctx.request_repaint_after(std::time::Duration::from_millis(200));
        return;
    }
    let Some(i) = q.jobs.iter().position(|j| j.state == JobState::Waiting) else { return };
    if playing {
        q.jobs[i].paused = true;
        ctx.request_repaint_after(std::time::Duration::from_millis(150));
        return;
    }
    // finished jobs leave the list when the next one starts; a failed one stays for its message
    q.jobs.retain(|j| !matches!(j.state, JobState::Done | JobState::Cancelled));
    let Some(i) = q.jobs.iter().position(|j| j.state == JobState::Waiting) else { return };
    start(s, ctx, i);
}

/// Sets the media's proxy in the project the job was made for, outside any drag (`adopt`) -> whether it did.
fn adopt(s: &mut Shell, media: Id, project: &str, path: &Path) -> bool {
    if s.doc.key != project || s.app.project().media(media).is_none() {
        return false;
    }
    let text = path.to_string_lossy().into_owned();
    if s.app.project().media(media).and_then(|m| m.proxy.as_ref()).is_some_and(|p| p.path == text) {
        return true;
    }
    match s.app.history.amend(&C::set_proxy(media.as_str(), Some(json!({ "path": text })))) {
        Ok(_) => true,
        Err(e) => {
            s.app.report(tr(&e.message).into_owned());
            false
        }
    }
}
