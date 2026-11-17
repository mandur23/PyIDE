//! The shell as the tools' host: the page's services (ui-assistant.js `services`, ui-control.js
//! `controlServices`) on the native editor. What keeps the user's files the user's is here, as in ui-control.js:
//! a file to import that is not in the project's folder comes in only after the user confirms it in a question that
//! lists it (nothing on the disk is looked at before); exports write new files only, in the project's folder (or
//! Projects), after the user says yes; save writes the project's own file and opens Save As for an untitled one.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use cut_model::{Id, MediaKind};
use cut_time::Ticks;
use eframe::egui;
use serde_json::{Value as Json, json};

use super::host::{Host, Task};
use super::panel::{Ask, Asks};
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::state::App;

/// The shell and its window's context, for one pump of the calls.
pub struct ShellHost<'a> {
    pub s: &'a mut Shell,
    pub ctx: &'a egui::Context,
}

impl ShellHost<'_> {
    /// The questions on screen (the panel's).
    fn asks(&self) -> Rc<RefCell<Asks>> {
        self.s.features.control.panel.asks.clone()
    }
}

fn shell(h: &mut dyn Host) -> Option<&mut Shell> {
    h.shell()
}

fn basename(p: &Path) -> String {
    p.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

fn norm(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// `inside(p, dir)`: `p` lies in the folder `dir` (by name).
fn inside(p: &str, dir: Option<&str>) -> bool {
    dir.is_some_and(|d| norm(p).starts_with(&format!("{}\\", norm(d))))
}

/// The folder new files go to: the project's, or Projects for a project never saved (`outputDir`).
fn output_dir(s: &Shell) -> PathBuf {
    s.app.path.as_ref().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| s.doc.home.projects.clone())
}

/// A file name in `dir` that is free: not on the disk, not used by the project, not being written by the queue
/// (`freePath`).
fn free_path(s: &Shell, dir: &Path, stem: &str, ext: &str) -> Option<PathBuf> {
    let mut clean = stem.to_owned();
    if let Some((a, e)) = clean.rsplit_once('.')
        && (2..=4).contains(&e.len())
        && e.chars().all(|c| c.is_ascii_alphanumeric())
    {
        clean = a.to_owned();
    }
    let mut out = String::new();
    for ch in clean.chars() {
        if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            if !out.ends_with('_') {
                out.push('_');
            }
        } else {
            out.push(ch);
        }
    }
    let clean = if out.trim().is_empty() { "Sequence".to_owned() } else { out.trim().to_owned() };
    let project = s.app.path.as_ref().map(|p| norm(&p.to_string_lossy())).unwrap_or_default();
    for n in 1..100 {
        let name = if n > 1 { format!("{clean} ({n}).{ext}") } else { format!("{clean}.{ext}") };
        let candidate = dir.join(name);
        let c = norm(&candidate.to_string_lossy());
        let used = s.app.project().media.iter().any(|m| norm(&m.path) == c)
            || s.features.export.queue.iter().any(|j| j.live() && norm(&j.spec.path.to_string_lossy()) == c)
            || project == c;
        if !used && !candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// A question on screen, and a task that waits for its answer and then runs `then`.
fn asked(
    asks: &Rc<RefCell<Asks>>,
    a: Ask,
    mut then: impl FnMut(&mut dyn Host, bool) -> Option<Json> + 'static,
) -> Task<Json> {
    let id = asks.borrow_mut().ask(a);
    let asks = asks.clone();
    let mut answer: Option<bool> = None;
    Box::new(move |h, _live| {
        if answer.is_none() {
            answer = asks.borrow_mut().answer(id);
        }
        then(h, answer?)
    })
}

fn ask(
    title: String,
    message: String,
    rows: Vec<(String, String)>,
    list: Vec<String>,
    note: String,
    yes: String,
    no: String,
) -> Ask {
    Ask { id: 0, title, message, rows, list, note, yes, no, answer: None }
}

fn png(pixels: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let enc = image::codecs::png::PngEncoder::new(&mut out);
    image::ImageEncoder::write_image(enc, pixels, w, h, image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Standard base64 with padding.
fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n =
            (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= c.len() { A[((n >> shift) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The program monitor's picture of `seq` at `t` (`framePng`): `width` wide when narrower than the sequence, with
/// the caption track `captions` burned in.
fn still(
    s: &Shell,
    seq: Id,
    t: Ticks,
    width: Option<u32>,
    captions: Option<Id>,
) -> Result<(Vec<u8>, u32, u32), String> {
    let Some(m) = &s.monitors else { return Err("the export engine is not loaded".into()) };
    let p = s.app.project();
    let Some(q) = p.sequence(seq) else { return Err("There is no such sequence.".into()) };
    let (sw, sh) = (q.w as f64, q.h as f64);
    let scale = width.map_or(1.0, |w| if f64::from(w) < sw { f64::from(w) / sw } else { 1.0 });
    let (w, h) = (((sw * scale).round() as u32).max(2), ((sh * scale).round() as u32).max(2));
    let px = m.still_captioned(p, seq, cut_time::snap(t, q.fps, false), (w, h), captions)?;
    Ok((px, w, h))
}

impl Host for ShellHost<'_> {
    fn app(&self) -> &App {
        &self.s.app
    }

    fn app_mut(&mut self) -> &mut App {
        &mut self.s.app
    }

    fn shell(&mut self) -> Option<&mut Shell> {
        Some(self.s)
    }

    fn playing(&self) -> bool {
        self.s.transport.playing()
    }

    fn offline(&self, media: Id) -> bool {
        crate::panels::media_marks::offline(self.s, media)
    }

    fn seek(&mut self, t: Ticks) {
        self.s.app.set_time(t);
    }

    fn play(&mut self) {
        if !self.s.transport.playing() {
            self.s.run_action("playPause", self.ctx);
        }
    }

    fn stop(&mut self) {
        if self.s.transport.playing() {
            self.s.transport.pause();
        }
    }

    fn can_act(&self) -> bool {
        true
    }

    fn action(&mut self, id: &str, _panel: Option<&str>) -> Option<Json> {
        let before = self.s.app.notices.len();
        let ran = self.s.action_enabled(id);
        self.s.run_action(id, self.ctx);
        let toasts: Vec<String> = self.s.app.notices.iter().skip(before).map(|n| n.text.clone()).collect();
        Some(json!({ "ran": ran, "toasts": toasts }))
    }

    fn view(&mut self) -> Json {
        let heights: Vec<String> =
            self.s.app.sequence().map(|q| q.tracks.iter().map(|t| t.height.to_string()).collect()).unwrap_or_default();
        json!({
            "workspace": format!("{:?}", self.s.features.workspace.current),
            "snapping": self.s.app.snapping,
            "focus": format!("{:?}", self.s.app.focus),
            "lower": format!("{:?}", self.s.lower_tab),
            "heights": heights.join(","),
        })
    }

    fn clipboard(&self) -> usize {
        self.s.app.clipboard.len()
    }

    fn frame(&mut self, seq: Id, t: Ticks, width: u32) -> Option<Task<Json>> {
        let captions = if self.s.app.sequence_id == Some(seq) {
            crate::captions::shown(self.s)
        } else {
            self.s.app.project().sequence(seq).and_then(|q| q.captions.first().map(|c| c.id))
        };
        let r = still(self.s, seq, t, Some(width), captions).and_then(|(px, w, h)| png(&px, w, h).map(|b| (b, w, h)));
        let out = match r {
            Ok((b, w, h)) => json!({ "ok": true, "base64": base64(&b), "width": w, "height": h }),
            Err(e) => json!({ "ok": false, "error": e }),
        };
        Some(Box::new(move |_, _| Some(out.clone())))
    }

    fn transcript(&mut self, seq: Id) -> Option<Vec<(f64, f64, String)>> {
        Some(super::native::transcript(self.s, seq))
    }

    fn silence(&mut self, seq: Id, threshold: f64, min_length: f64) -> Option<Task<Json>> {
        Some(super::native::silence(self.s, seq, threshold, min_length))
    }

    fn automation(&mut self, action: &str, args: &Json, seq: Id) -> Option<Task<Json>> {
        Some(super::jobs::start(self.s, action, args, seq))
    }

    fn import_media(
        &mut self,
        paths: Option<Vec<String>>,
        folder: bool,
        bin: Option<Id>,
        _seq: Id,
    ) -> Option<Task<Json>> {
        let before: Vec<Id> = self.s.app.project().media.iter().map(|m| m.id).collect();
        let Some(paths) = paths else {
            self.s.run_action(if folder { "importFolder" } else { "import" }, self.ctx);
            return Some(Box::new(move |h, _| {
                let s = shell(h)?;
                s.poll_import();
                if s.asking() || s.importer.pending() > 0 {
                    return None;
                }
                let ids: Vec<&str> =
                    s.app.project().media.iter().filter(|m| !before.contains(&m.id)).map(|m| m.id.as_str()).collect();
                Some(if ids.is_empty() { json!({ "declined": true }) } else { json!({ "ok": true, "ids": ids }) })
            }));
        };
        let dir = self.s.app.path.as_ref().and_then(|p| p.parent()).map(|p| p.to_string_lossy().into_owned());
        let dir_real = dir.as_ref().and_then(|d| std::fs::canonicalize(d).ok()).map(|p| real_text(&p));
        let (mut near, mut far): (Vec<String>, Vec<String>) =
            paths.iter().cloned().partition(|p| inside(p, dir.as_deref()));
        let mut files = Vec::new();
        let mut failed = Vec::new();
        let look = |p: &str, failed: &mut Vec<Json>| -> Option<PathBuf> {
            let path = PathBuf::from(p);
            match std::fs::metadata(&path) {
                Err(_) => {
                    failed.push(json!({ "name": basename(&path), "error": "not found" }));
                    None
                }
                Ok(m) if !m.is_file() => {
                    failed.push(json!({ "name": basename(&path), "error": "a folder (import_media with folder: true lets the user pick one)" }));
                    None
                }
                Ok(_) => Some(std::fs::canonicalize(&path).map_or(path, |r| PathBuf::from(real_text(&r)))),
            }
        };
        for p in std::mem::take(&mut near) {
            let Some(real) = look(&p, &mut failed) else { continue };
            if inside(&real.to_string_lossy(), dir_real.as_deref()) {
                files.push(real);
            } else {
                far.push(p);
            }
        }
        let mut seen = Vec::new();
        far.retain(|p| {
            !seen.contains(p) && {
                seen.push(p.clone());
                true
            }
        });
        let mut state: Option<(Vec<PathBuf>, Vec<Json>, Vec<Json>)> = None;
        let mut confirmed = far.is_empty();
        let question = (!far.is_empty()).then(|| {
            self.asks().borrow_mut().ask(ask(
                tr("Import Requested by AI").into_owned(),
                tr("The AI wants to import these files into the project:").into_owned(),
                Vec::new(),
                far.clone(),
                tr("Only these files are read; they are not changed.").into_owned(),
                tr("Import").into_owned(),
                tr("Don't Import").into_owned(),
            ))
        });
        let asks = self.asks();
        Some(Box::new(move |h, _| {
            let s = shell(h)?;
            if state.is_none() {
                if !confirmed {
                    match asks.borrow_mut().answer(question.unwrap_or(0))? {
                        false => return Some(json!({ "declined": true })),
                        true => confirmed = true,
                    }
                    for p in &far {
                        if let Some(r) = look(p, &mut failed) {
                            files.push(r);
                        }
                    }
                }
                let (captions, media): (Vec<PathBuf>, Vec<PathBuf>) = files.drain(..).partition(|p| {
                    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("srt") || e.eq_ignore_ascii_case("vtt"))
                });
                let mut tracks = Vec::new();
                for p in &captions {
                    let n = crate::captions::files::import_file(s, p, true);
                    if n > 0 {
                        tracks.push(json!({ "id": crate::captions::shown(s).map(|i| i.as_str()), "captions": n }));
                    } else {
                        failed.push(json!({ "name": basename(p), "error": "no captions in it" }));
                    }
                }
                if !media.is_empty() {
                    s.import_paths(media.clone(), bin);
                }
                state = Some((media, tracks, std::mem::take(&mut failed)));
            }
            if s.importer.pending() > 0 {
                s.poll_import();
            }
            if s.importer.pending() > 0 {
                return None;
            }
            let (media, tracks, mut failed) = state.take()?;
            let new: Vec<&cut_model::Media> =
                s.app.project().media.iter().filter(|m| !before.contains(&m.id)).collect();
            for p in &media {
                if !new.iter().any(|m| norm(&m.path) == norm(&p.to_string_lossy())) {
                    failed.push(json!({ "name": basename(p), "error": "not a media file Cut can read" }));
                }
            }
            let ids: Vec<&str> = new.iter().map(|m| m.id.as_str()).collect();
            Some(json!({ "ok": true, "ids": ids, "captionTracks": tracks, "failed": failed }))
        }))
    }

    fn save(&mut self) -> Option<Task<Json>> {
        let untitled = self.s.app.path.is_none();
        let before = self.s.app.notices.len();
        self.s.run_action("save", self.ctx);
        Some(Box::new(move |h, _| {
            let s = shell(h)?;
            if s.asking() {
                return None;
            }
            let said: Vec<String> =
                s.app.notices.iter().skip(before).filter(|n| n.error).map(|n| n.text.clone()).collect();
            let name = s.app.path.as_ref().map(|p| basename(p));
            Some(match name {
                Some(n) if !s.doc.dirty(&s.app) => json!({ "ok": true, "name": n }),
                _ if untitled && said.is_empty() && s.app.path.is_none() => json!({ "declined": true }),
                _ => {
                    json!({ "ok": false, "error": if said.is_empty() { "not saved".to_owned() } else { said.join(" ") } })
                }
            })
        }))
    }

    fn export_ask(&mut self, r: Json) -> Option<Task<Json>> {
        let s = &*self.s;
        let pid = r["preset"].as_str().unwrap_or_default().to_owned();
        let Some(p) = cut_export::presets::get(&pid) else {
            return Some(done(json!({ "ok": false, "error": "exporting is not available" })));
        };
        let seq_id = Id::new(r["seq"].as_str().unwrap_or_default());
        let seq = s.app.project().sequence(seq_id).cloned()?;
        let dir = output_dir(s);
        let stem = r["fileName"].as_str().map_or_else(|| seq.name.clone(), str::to_owned);
        let Some(path) = free_path(s, &dir, &stem, p.ext) else {
            return Some(done(json!({ "ok": false, "error": "no free file name" })));
        };
        let Ok(settings) = serde_json::from_value::<cut_export::presets::Settings>(r["settings"].clone()) else {
            return Some(done(json!({ "ok": false, "error": "exporting is not available" })));
        };
        let range = r["range"].as_object().map(|o| (o["in"].as_i64().unwrap_or(0), o["out"].as_i64().unwrap_or(0)));
        let mut rows = vec![
            (tr("Sequence:").into_owned(), seq.name.clone()),
            (tr("Preset:").into_owned(), tr(p.name).into_owned()),
        ];
        if let Some(v) = &settings.video {
            let family = if format!("{:?}", v.family).eq_ignore_ascii_case("hevc") { "HEVC" } else { "H.264" };
            rows.push((
                tr("Video:").into_owned(),
                format!("{}x{} {family} {:.1} Mbps", settings.width, settings.height, f64::from(v.bitrate) / 1e6),
            ));
        }
        rows.push((tr("File:").into_owned(), path.to_string_lossy().into_owned()));
        rows.push((
            tr("Range:").into_owned(),
            match range {
                Some((i, o)) => format!("{} – {}", cut_time::timecode(i, seq.fps), cut_time::timecode(o, seq.fps)),
                None => tr("Entire Sequence").into_owned(),
            },
        ));
        let burn = r["captions"] == "burn";
        let a = ask(
            tr("Export Requested by AI").into_owned(),
            tr("The AI wants to export this sequence to a new file.").into_owned(),
            rows,
            Vec::new(),
            tr("It joins the export queue. No existing file is replaced.").into_owned(),
            tr("Export").into_owned(),
            tr("Don't Export").into_owned(),
        );
        let mut settings = Some(settings);
        Some(asked(&self.asks(), a, move |h, yes| {
            if !yes {
                return Some(json!({ "ok": false, "declined": true }));
            }
            let s = shell(h)?;
            let shown = crate::captions::shown(s);
            let audio = p.kind == cut_export::presets::Kind::Audio;
            let spec = crate::export::Spec {
                project: Arc::new(s.app.project().clone()),
                seq: seq.id,
                path: path.clone(),
                settings: settings.take()?,
                range,
                captions: (burn && !audio && !seq.captions.is_empty()).then_some(cut_export::CaptionMode::Burn),
                caption_track: if burn { shown.or(seq.captions.first().map(|c| c.id)) } else { None },
            };
            let job = crate::export::queue::add(s, spec, seq.name.clone(), seq.fps, tr(p.name).into_owned());
            let name = basename(&path);
            s.app.toast(trf("Added {name} to the export queue", &[("name", &name)]));
            Some(json!({ "ok": true, "name": name, "path": path.to_string_lossy(), "job": job }))
        }))
    }

    fn export_wait(&mut self, job: u64) -> Option<Task<Json>> {
        let mut stopping = false;
        Some(Box::new(move |h, live| {
            let s = shell(h)?;
            let Some(j) = s.features.export.queue.iter().find(|j| j.id == job) else {
                return Some(json!({ "ok": false, "error": "the job left the queue" }));
            };
            use crate::export::queue::JobState as J;
            match j.state {
                J::Done => return Some(json!({ "ok": true })),
                J::Cancelled => return Some(json!({ "ok": false, "cancelled": true })),
                J::Failed => {
                    return Some(json!({ "ok": false, "error": j.error.clone().unwrap_or_else(|| "failed".into()) }));
                }
                J::Waiting => live.progress(Some(0.0), &tr("Waiting in the export queue")),
                J::Running => {
                    let f = s.features.export.progress().map_or(0.0, |p| p.0);
                    live.progress(Some(f), "");
                }
            }
            if live.aborted() && !stopping {
                stopping = true;
                queue_do(s, "cancel", job);
            }
            None
        }))
    }

    fn export_frame(&mut self, seq: Id, t: Ticks, file: Option<String>) -> Option<Task<Json>> {
        let s = &*self.s;
        let q = s.app.project().sequence(seq)?.clone();
        let tc = cut_time::timecode(t, q.fps);
        let stem = file.unwrap_or_else(|| {
            format!("{} {}", if q.name.is_empty() { "Frame" } else { &q.name }, tc.replace(':', "-"))
        });
        let Some(path) = free_path(s, &output_dir(s), &stem, "png") else {
            return Some(done(json!({ "ok": false, "error": "no free file name" })));
        };
        let a = ask(
            tr("Export Frame Requested by AI").into_owned(),
            tr("The AI wants to save a frame of this sequence as a new picture.").into_owned(),
            vec![
                (tr("Sequence:").into_owned(), q.name.clone()),
                (tr("Time:").into_owned(), tc),
                (tr("File:").into_owned(), path.to_string_lossy().into_owned()),
            ],
            Vec::new(),
            tr("No existing file is replaced.").into_owned(),
            tr("Save").into_owned(),
            tr("Don't Save").into_owned(),
        );
        Some(asked(&self.asks(), a, move |h, yes| {
            if !yes {
                return Some(json!({ "ok": false, "declined": true }));
            }
            let s = shell(h)?;
            let r = still(s, seq, t, None, None)
                .and_then(|(px, w, h)| png(&px, w, h))
                .and_then(|b| cut_export::sink::save_bytes(&path, &b, None).map(|_| ()).map_err(|f| f.to_string()));
            Some(match r {
                Ok(()) => {
                    let name = basename(&path);
                    s.app.toast(trf("Saved {name}", &[("name", &name)]));
                    json!({ "ok": true, "name": name })
                }
                Err(e) => json!({ "ok": false, "error": e }),
            })
        }))
    }

    fn export_captions(
        &mut self,
        seq: Id,
        track: Option<Id>,
        format: &str,
        file: Option<String>,
    ) -> Option<Task<Json>> {
        let s = &*self.s;
        let q = s.app.project().sequence(seq)?.clone();
        let shown = if s.app.sequence_id == Some(seq) { crate::captions::shown(s) } else { None };
        let t = track
            .and_then(|id| q.captions.iter().find(|c| c.id == id))
            .or_else(|| shown.and_then(|id| q.captions.iter().find(|c| c.id == id)))
            .or_else(|| q.captions.first())
            .filter(|t| !t.items.is_empty())
            .cloned();
        let Some(t) = t else { return Some(done(json!({ "ok": false, "error": "the caption track is empty" }))) };
        let stem = file.unwrap_or_else(|| format!("{} {}", q.name, t.name));
        let ext = format.to_owned();
        let Some(path) = free_path(s, &output_dir(s), &stem, &ext) else {
            return Some(done(json!({ "ok": false, "error": "no free file name" })));
        };
        let a = ask(
            tr("Export Captions Requested by AI").into_owned(),
            tr("The AI wants to save captions to a new file.").into_owned(),
            vec![
                (tr("Captions:").into_owned(), t.name.clone()),
                (tr("File:").into_owned(), path.to_string_lossy().into_owned()),
            ],
            Vec::new(),
            tr("No existing file is replaced.").into_owned(),
            tr("Save").into_owned(),
            tr("Don't Save").into_owned(),
        );
        Some(asked(&self.asks(), a, move |h, yes| {
            if !yes {
                return Some(json!({ "ok": false, "declined": true }));
            }
            let s = shell(h)?;
            let named = cut_export::plan::with_speakers(
                s.app.project().speakers.as_ref(),
                &t.style,
                t.items.clone(),
                &tr("Speaker {n}"),
            );
            let cues: Vec<cut_model::srt::Cue> = named
                .iter()
                .map(|it| cut_model::srt::Cue { start: it.start, end: it.end, text: it.text.clone() })
                .collect();
            let text = if ext == "vtt" { cut_model::srt::write_vtt(&cues) } else { cut_model::srt::write(&cues) };
            Some(match std::fs::write(&path, text) {
                Ok(()) => {
                    let name = basename(&path);
                    s.app.toast(trf("Saved {name}", &[("name", &name)]));
                    json!({ "ok": true, "name": name, "count": cues.len() })
                }
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            })
        }))
    }

    fn queue_jobs(&mut self) -> Option<Vec<Json>> {
        let ex = &self.s.features.export;
        let running = ex.progress().map(|p| p.0);
        Some(
            ex.queue
                .iter()
                .map(|j| {
                    use crate::export::queue::JobState as J;
                    let state = match j.state {
                        J::Waiting => "waiting",
                        J::Running => "running",
                        J::Done => "done",
                        J::Failed => "failed",
                        J::Cancelled => "cancelled",
                    };
                    let fraction = match j.state {
                        J::Done => 1.0,
                        J::Running => running.unwrap_or(0.0),
                        _ => 0.0,
                    };
                    json!({
                        "id": j.id, "name": basename(&j.spec.path), "seqName": j.seq_name, "presetName": j.preset,
                        "state": state, "fraction": fraction, "error": j.error,
                    })
                })
                .collect(),
        )
    }

    fn queue_do(&mut self, action: &str, id: u64) -> bool {
        queue_do(self.s, action, id)
    }

    fn has_proxies(&self) -> bool {
        true
    }

    fn proxy_state(&mut self, media: Id) -> Option<Json> {
        Some(proxy_state(self.s, media))
    }

    fn proxy_create(&mut self, media: &[Id]) -> usize {
        crate::prefs::proxy::create(self.s, media)
    }

    fn proxy_wait(&mut self, media: Vec<Id>) -> Option<Task<Json>> {
        let mut stopped = false;
        Some(Box::new(move |h, live| {
            let s = shell(h)?;
            use crate::prefs::proxy::JobState as J;
            let open = |st: J| matches!(st, J::Waiting | J::Running);
            let mine: Vec<(Id, J, f64)> = s
                .features
                .prefs
                .proxy
                .jobs
                .iter()
                .filter(|j| media.contains(&j.media))
                .map(|j| (j.media, j.state, j.fraction()))
                .collect();
            let done = media.iter().filter(|m| proxy_state(s, **m)["proxy"] == "ready").count();
            if !mine.iter().any(|j| open(j.1)) {
                return Some(json!({ "done": done, "cancelled": stopped }));
            }
            if live.aborted() && !stopped {
                stopped = true;
                for (m, st, _) in &mine {
                    if open(*st) {
                        crate::prefs::proxy::cancel(s, *m);
                    }
                }
            }
            let f = mine.iter().map(|j| if j.1 == J::Done { 1.0 } else { j.2 }).sum::<f64>() / mine.len().max(1) as f64;
            live.progress(
                Some(f),
                &trf("Proxies: {n} of {m} ready", &[("n", &done.to_string()), ("m", &media.len().to_string())]),
            );
            None
        }))
    }

    fn flash(&mut self, clips: &[Id]) {
        self.s.timeline.flash(clips);
    }

    fn show_caption_track(&mut self, seq: Id, track: Id) {
        if self.s.app.sequence_id != Some(seq) {
            self.s.app.set_sequence(seq);
        }
        crate::captions::choose(self.s, track);
    }
}

/// A task with its answer already.
fn done(v: Json) -> Task<Json> {
    Box::new(move |_, _| Some(v.clone()))
}

/// A path as Windows names it, without the `\\?\` prefix `canonicalize` adds.
fn real_text(p: &Path) -> String {
    let t = p.to_string_lossy();
    t.strip_prefix(r"\\?\").unwrap_or(&t).to_owned()
}

fn queue_do(s: &mut Shell, action: &str, id: u64) -> bool {
    use crate::export::queue::JobState as J;
    let q = &mut s.features.export.queue;
    match action {
        "clearFinished" => {
            q.retain(|j| j.live());
            true
        }
        "remove" => {
            let n = q.len();
            q.retain(|j| j.id != id || j.state == J::Running);
            q.len() != n
        }
        "retry" => match q.iter_mut().find(|j| j.id == id && matches!(j.state, J::Failed | J::Cancelled)) {
            Some(j) => {
                j.state = J::Waiting;
                j.error = None;
                true
            }
            None => false,
        },
        _ => match q.iter().find(|j| j.id == id).map(|j| j.state) {
            Some(J::Running) => {
                crate::export::cancel(s, Some(id));
                true
            }
            Some(J::Waiting) => {
                if let Some(j) = s.features.export.queue.iter_mut().find(|j| j.id == id) {
                    j.state = J::Cancelled;
                }
                true
            }
            _ => false,
        },
    }
}

/// A media item's proxy as ui-control.js reports it: `{proxy: none | waiting | running | ready | failed | cancelled}`.
fn proxy_state(s: &Shell, media: Id) -> Json {
    use crate::prefs::proxy::JobState as J;
    let m = s.app.project().media.iter().find(|m| m.id == media);
    let job = s.features.prefs.proxy.jobs.iter().rev().find(|j| j.media == media);
    let mut o = match job.map(|j| j.state) {
        Some(J::Waiting) => json!({ "proxy": "waiting" }),
        Some(J::Running) => {
            json!({ "proxy": "running", "progress": (job.map_or(0.0, |j| j.fraction()) * 1000.0).round() / 1000.0 })
        }
        _ if m.is_some_and(|m| m.proxy.is_some() && m.kind == MediaKind::Video) => json!({ "proxy": "ready" }),
        Some(J::Failed) => json!({ "proxy": "failed" }),
        Some(J::Cancelled) => json!({ "proxy": "cancelled" }),
        _ => json!({ "proxy": "none" }),
    };
    if let Some(e) = job.and_then(|j| j.error.clone()) {
        o["error"] = json!(e);
    }
    o
}
