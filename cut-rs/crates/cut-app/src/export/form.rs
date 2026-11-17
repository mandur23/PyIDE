//! The export settings form (`ui-export.js` `form`): the sequence, a preset, codec (HEVC only when a GPU encodes
//! it), size, bitrate mode and target, key frame interval, audio bitrate, the loudness target, the range (all or In
//! to Out), captions, the file; the estimated size and time; then progress with Cancel, and the result with what the
//! check of the written file found.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::channel;

use cut_export::presets::{self, AUDIO_BITRATES, EXPORT, Family, Overrides, RateMode, Settings};
use cut_export::{CaptionMode, plan};
use cut_model::{Id, Sequence};
use eframe::egui::{self, Button, RichText};

use super::{Ask, Outcome, Spec, cancel, format_bytes, format_seconds, said, start};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// What the form holds.
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    pub seq: Option<Id>,
    pub preset: usize,
    pub codec: Family,
    pub w: u32,
    pub h: u32,
    pub mode: RateMode,
    pub mbps: f64,
    pub key_seconds: f64,
    pub audio_bitrate: u32,
    pub loudness: Option<f64>,
    pub in_out: bool,
    pub captions: Option<CaptionMode>,
    pub path: String,
    pub path_touched: bool,
    /// The sequence and preset the fields were filled from.
    filled: Option<(Id, usize)>,
}

impl Default for Form {
    fn default() -> Self {
        Self {
            seq: None,
            preset: 0,
            codec: Family::H264,
            w: 1920,
            h: 1080,
            mode: RateMode::Variable,
            mbps: 10.0,
            key_seconds: 2.0,
            audio_bitrate: 192_000,
            loudness: Some(-14.0),
            in_out: false,
            captions: None,
            path: String::new(),
            path_touched: false,
            filled: None,
        }
    }
}

/// A file name made of a name: the characters Windows refuses become `_`.
pub fn safe_name(name: &str, fallback: &str) -> String {
    let s: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let s = s.trim();
    if s.is_empty() { fallback.to_owned() } else { s.to_owned() }
}

impl Form {
    fn video(&self) -> bool {
        EXPORT[self.preset].video.is_some()
    }

    /// The form's changes to its preset (`overrides()`).
    pub fn overrides(&self) -> Overrides {
        let mut o = Overrides {
            audio_bitrate: Some(f64::from(self.audio_bitrate)),
            loudness: Some(self.loudness),
            ..Overrides::default()
        };
        if self.video() {
            o.w = Some(f64::from(self.w));
            o.h = Some(f64::from(self.h));
            o.codec = Some(self.codec);
            o.bitrate = Some((self.mbps * 1e6).round());
            o.mode = Some(self.mode);
            o.key_seconds = Some(self.key_seconds);
        }
        o
    }

    /// The settings the form resolves to for `seq`.
    pub fn resolved(&self, seq: &Sequence) -> Settings {
        presets::resolve(&EXPORT[self.preset], seq.fps, Some((seq.w as f64, seq.h as f64)), &self.overrides())
    }

    /// Fills the fields from the preset (`fromPreset`).
    fn fill_from_preset(&mut self, seq: &Sequence, hevc: bool) {
        let p = &EXPORT[self.preset];
        let r = presets::resolve(p, seq.fps, Some((seq.w as f64, seq.h as f64)), &Overrides::default());
        if let Some(v) = &r.video {
            self.w = r.width;
            self.h = r.height;
            self.mbps = (f64::from(v.bitrate) / 1e6 * 10.0).round() / 10.0;
            self.key_seconds = p.video.map_or(2.0, |v| v.key_seconds);
            self.mode = v.mode;
            self.codec = if v.family == Family::Hevc && hevc { Family::Hevc } else { Family::H264 };
        }
        self.audio_bitrate = r.audio.as_ref().map_or(192_000, |a| a.bitrate);
        self.loudness = r.loudness;
        self.filled = Some((seq.id, self.preset));
    }
}

/// The range the form exports: In to Out of the active sequence, or none for all of it.
fn range_of(s: &Shell, seq: &Sequence) -> Option<(i64, i64)> {
    let f = &s.features.export.form;
    if !f.in_out || Some(seq.id) != s.app.sequence_id {
        return None;
    }
    let io = s.app.in_out;
    if io.in_.is_none() && io.out.is_none() {
        return None;
    }
    Some((io.in_.unwrap_or(0), io.out.unwrap_or(seq.duration())))
}

fn default_path(s: &Shell, seq: &Sequence, ext: &str) -> String {
    let dir = s.app.path.as_ref().and_then(|p| p.parent()).map_or_else(|| s.doc.home.projects.clone(), Path::to_owned);
    dir.join(format!("{}.{ext}", safe_name(&seq.name, "Sequence"))).to_string_lossy().into_owned()
}

/// Clips that use offline media (inside nests too).
fn offline_clips(s: &Shell, seq: &Sequence) -> usize {
    cut_export::lost::preflight(s.app.project(), seq, 0, seq.duration()).len()
}

/// Keeps the form in step with the project: its sequence, the fields of a new preset, the path's extension.
fn refresh(s: &mut Shell) -> Option<Sequence> {
    let hevc = s.features.export.hevc();
    let list = &s.app.project().sequences;
    let pick = s.features.export.form.seq.filter(|id| list.iter().any(|q| q.id == *id)).or(s.app.sequence_id);
    let seq = pick.and_then(|id| s.app.project().sequence(id)).cloned()?;
    let f = &mut s.features.export.form;
    f.seq = Some(seq.id);
    if f.filled != Some((seq.id, f.preset)) {
        if f.filled.is_some_and(|(id, _)| id != seq.id) {
            f.path_touched = false;
        }
        f.fill_from_preset(&seq, hevc);
    }
    if seq.captions.iter().all(|c| c.items.is_empty()) || !s.features.export.form.video() {
        s.features.export.form.captions = None;
    }
    let ext = EXPORT[s.features.export.form.preset].ext;
    if !s.features.export.form.path_touched || s.features.export.form.path.is_empty() {
        let d = default_path(s, &seq, ext);
        s.features.export.form.path = d;
    }
    let f = &mut s.features.export.form;
    if !f.path.to_lowercase().ends_with(&format!(".{ext}")) {
        f.path = plan::with_ext(&f.path, ext);
    }
    Some(seq)
}

/// Polls the background work the form started: a chosen file, a saved frame, a measured loudness.
pub fn poll(s: &mut Shell) {
    let ex = &mut s.features.export;
    if let Some(rx) = &ex.picked
        && let Ok(p) = rx.try_recv()
    {
        ex.picked = None;
        if let Some(p) = p {
            ex.form.path = p.to_string_lossy().into_owned();
            ex.form.path_touched = true;
        }
        return;
    }
    if let Some(rx) = &ex.frame_pick
        && let Ok(p) = rx.try_recv()
    {
        ex.frame_pick = None;
        if let Some(p) = p {
            super::save_frame(s, p);
        }
        return;
    }
    let ex = &mut s.features.export;
    if let Some(rx) = &ex.frame_saved
        && let Ok(r) = rx.try_recv()
    {
        ex.frame_saved = None;
        match r {
            Ok(p) => {
                s.app.toast(trf("Saved {name}", &[("name", &p.file_name().unwrap_or_default().to_string_lossy())]))
            }
            Err(e) => s.app.report(trf("The frame could not be saved: {error}", &[("error", &e)])),
        }
        return;
    }
    let ex = &mut s.features.export;
    if let Some(rx) = &ex.measured
        && let Ok(t) = rx.try_recv()
    {
        ex.measured = None;
        ex.loudness_text = t;
    }
}

/// The checks before an export starts or joins the queue (`prepare`), then the start or the queue.
pub fn go(s: &mut Shell, queued: bool, asked: bool, ctx: &egui::Context) {
    let Some(seq) = refresh(s) else { return };
    let settings = s.features.export.form.resolved(&seq);
    let mut problems: Vec<String> = presets::validate(&settings).iter().map(|p| tr(p).into_owned()).collect();
    let range = range_of(s, &seq);
    let len = range.map_or(seq.duration(), |r| r.1 - r.0);
    if len <= 0 {
        problems.push(tr("The sequence is empty.").into_owned());
    }
    if let Some(p) = problems.first() {
        s.app.toast(p.clone());
        return;
    }
    if !queued && s.features.export.busy() {
        s.app.toast(tr("An export is already running."));
        return;
    }
    let path = PathBuf::from(s.features.export.form.path.trim());
    let same = |p: &str| p.replace('/', "\\").to_lowercase();
    let target = same(&path.to_string_lossy());
    if s.app.project().media.iter().any(|m| same(&m.path) == target) {
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        s.app.report(trf("{name} is a media file of this project. Export to another name.", &[("name", &name)]));
        return;
    }
    if s.features.export.queue.iter().any(|j| j.live() && same(&j.spec.path.to_string_lossy()) == target) {
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        s.app.toast(trf("An export in the queue already writes {name}.", &[("name", &name)]));
        return;
    }
    if !asked {
        if offline_clips(s, &seq) > 0 {
            s.features.export.ask = Some(Ask::Offline { queued });
            return;
        }
        if path.exists() {
            s.features.export.ask = Some(Ask::Replace { queued });
            return;
        }
    }
    let f = &s.features.export.form;
    let spec = Spec {
        project: Arc::new(s.app.project().clone()),
        seq: seq.id,
        path,
        settings,
        range,
        captions: f.captions,
        // the caption track the Captions panel shows, as the JavaScript's export burns in
        caption_track: crate::captions::shown(s),
    };
    if queued {
        let name = spec.path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let preset = tr(EXPORT[f.preset].name).into_owned();
        super::queue::add(s, spec, seq.name.clone(), seq.fps, preset);
        s.app.toast(trf("Added {name} to the export queue", &[("name", &name)]));
        s.features.export.form.path_touched = false;
    } else {
        start(s, spec, None, ctx);
    }
}

/// The questions the export asks.
pub fn ask(s: &mut Shell, ctx: &egui::Context) {
    let Some(a) = &s.features.export.ask else { return };
    let name = Path::new(&s.features.export.form.path).file_name().unwrap_or_default().to_string_lossy().into_owned();
    let (title, text, ok, queued) = match a {
        Ask::Replace { queued } => {
            let t = if *queued { tr("Add to Queue") } else { tr("Export") };
            (t, trf("{name} already exists. Replace it?", &[("name", &name)]), tr("Replace"), Some(*queued))
        }
        Ask::Offline { queued } => {
            let t = if *queued { tr("Add to Queue") } else { tr("Export") };
            (
                t.clone(),
                tr("Some clips use offline media and will export as a red \"media offline\" picture. Export anyway?")
                    .into_owned(),
                t,
                Some(*queued),
            )
        }
        Ask::Close => {
            (tr("Export"), tr("An export is running. Stop it and close the window?").into_owned(), tr("Close"), None)
        }
    };
    let offline = matches!(a, Ask::Offline { .. });
    let mut answer = None;
    egui::Modal::new(egui::Id::unique("cut-export-ask")).show(ctx, |ui| {
        ui.set_width(420.0);
        ui.heading(title.as_ref());
        ui.add_space(6.0);
        ui.label(text);
        ui.add_space(10.0);
        ui.horizontal(|ui| {
            if ui.add(Button::new(ok.as_ref()).fill(egui::Color32::from_rgb(0x35, 0x74, 0xf0))).clicked() {
                answer = Some(true);
            }
            if ui.button(tr("Cancel")).clicked() {
                answer = Some(false);
            }
        });
    });
    let Some(yes) = answer else { return };
    s.features.export.ask = None;
    match (yes, queued) {
        (true, Some(q)) => {
            // after the offline question, the replace question still comes
            if offline && Path::new(&s.features.export.form.path).exists() {
                s.features.export.ask = Some(Ask::Replace { queued: q });
            } else {
                go(s, q, true, ctx);
            }
        }
        (true, None) => {
            cancel(s, None);
            for j in s
                .features
                .export
                .queue
                .iter()
                .filter(|j| j.state == super::JobState::Running)
                .map(|j| j.id)
                .collect::<Vec<_>>()
            {
                cancel(s, Some(j));
            }
            s.features.export.leaving = true;
            s.guard(crate::shell::Then::Close, ctx);
        }
        _ => {}
    }
}

fn row(ui: &mut egui::Ui, label: &str, add: impl FnOnce(&mut egui::Ui)) {
    ui.label(tr(label));
    add(ui);
    ui.end_row();
}

fn section(ui: &mut egui::Ui, title: &str) {
    ui.add_space(6.0);
    ui.label(RichText::new(tr(title)).strong());
}

/// The label column of the form's four grids, so their values line up.
const LABEL_WIDTH: f32 = 120.0;

/// Draws the form; `inline` for the Export workspace's panel (with Export Frame), else the dialog.
#[allow(clippy::too_many_lines)]
pub fn show(s: &mut Shell, ui: &mut egui::Ui, inline: bool) {
    let Some(seq) = refresh(s) else {
        ui.label(tr("There is no such sequence."));
        return;
    };
    let ctx = ui.ctx().clone();
    let hevc = s.features.export.hevc();
    let sequences: Vec<(Id, String)> = s.app.project().sequences.iter().map(|q| (q.id, q.name.clone())).collect();
    let io = s.app.in_out;
    let has_io = Some(seq.id) == s.app.sequence_id && (io.in_.is_some() || io.out.is_some());
    let has_captions = seq.captions.iter().any(|c| !c.items.is_empty());
    // the track a burn-in draws, named when there is more than one
    let shown = crate::captions::shown(s).filter(|_| Some(seq.id) == s.app.sequence_id);
    let burned = shown
        .and_then(|id| seq.captions.iter().find(|c| c.id == id))
        .or(seq.captions.first())
        .filter(|_| seq.captions.len() > 1)
        .map(|c| trf("Burns in the caption track shown in the Captions panel: {name}", &[("name", &c.name)]));
    let busy = s.features.export.busy();
    let own = s.features.export.running_own();
    let f = &mut s.features.export.form;
    if !has_io {
        f.in_out = false;
    }
    let video = f.video();
    egui::Grid::new(("cut-export-form", inline)).num_columns(2).min_col_width(LABEL_WIDTH).spacing([12.0, 6.0]).show(
        ui,
        |ui| {
            row(ui, "Sequence", |ui| {
                egui::ComboBox::from_id_salt("cut-export-seq")
                    .selected_text(sequences.iter().find(|x| x.0 == seq.id).map_or("", |x| x.1.as_str()))
                    .show_ui(ui, |ui| {
                        for (id, name) in &sequences {
                            if ui.selectable_label(f.seq == Some(*id), name).clicked() {
                                f.seq = Some(*id);
                            }
                        }
                    });
            });
            row(ui, "Preset", |ui| {
                egui::ComboBox::from_id_salt("cut-export-preset").selected_text(tr(EXPORT[f.preset].name)).show_ui(
                    ui,
                    |ui| {
                        for (i, p) in EXPORT.iter().enumerate() {
                            ui.selectable_value(&mut f.preset, i, tr(p.name));
                        }
                    },
                );
            });
        },
    );
    if video {
        section(ui, "Video");
        egui::Grid::new(("cut-export-video", inline))
            .num_columns(2)
            .min_col_width(LABEL_WIDTH)
            .spacing([12.0, 6.0])
            .show(ui, |ui| {
                row(ui, "Codec", |ui| {
                    egui::ComboBox::from_id_salt("cut-export-codec")
                        .selected_text(if f.codec == Family::Hevc { tr("HEVC (hardware)") } else { "H.264".into() })
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut f.codec, Family::H264, "H.264");
                            if hevc {
                                ui.selectable_value(&mut f.codec, Family::Hevc, tr("HEVC (hardware)"));
                            }
                        });
                });
                row(ui, "Width", |ui| {
                    ui.add(egui::DragValue::new(&mut f.w).range(16..=8192).speed(2.0).suffix(" px"));
                });
                row(ui, "Height", |ui| {
                    ui.add(egui::DragValue::new(&mut f.h).range(16..=8192).speed(2.0).suffix(" px"));
                });
                row(ui, "Frame rate", |ui| {
                    let v = seq.fps.value();
                    ui.label(if v.fract() == 0.0 {
                        format!("{v} fps")
                    } else {
                        format!("{} fps", format!("{v:.3}").trim_end_matches('0'))
                    });
                });
                row(ui, "Bitrate mode", |ui| {
                    ui.radio_value(&mut f.mode, RateMode::Variable, tr("Variable bitrate, 1 pass"));
                    ui.radio_value(&mut f.mode, RateMode::Constant, tr("Constant bitrate"));
                });
                row(ui, "Target bitrate", |ui| {
                    ui.add(
                        egui::DragValue::new(&mut f.mbps)
                            .range(0.5..=200.0)
                            .speed(0.5)
                            .fixed_decimals(1)
                            .suffix(" Mbps"),
                    );
                });
                row(ui, "Keyframe every", |ui| {
                    ui.add(
                        egui::DragValue::new(&mut f.key_seconds)
                            .range(0.5..=10.0)
                            .speed(0.5)
                            .fixed_decimals(1)
                            .suffix(format!(" {}", tr("s"))),
                    );
                });
            });
    }
    section(ui, "Audio");
    egui::Grid::new(("cut-export-audio", inline)).num_columns(2).min_col_width(LABEL_WIDTH).spacing([12.0, 6.0]).show(
        ui,
        |ui| {
            row(ui, "Audio bitrate", |ui| {
                egui::ComboBox::from_id_salt("cut-export-ab")
                    .selected_text(format!("{} kbps", f.audio_bitrate / 1000))
                    .show_ui(ui, |ui| {
                        for b in AUDIO_BITRATES {
                            ui.selectable_value(&mut f.audio_bitrate, b, format!("{} kbps", b / 1000));
                        }
                    });
            });
            row(ui, "Loudness", |ui| {
                let label = |l: Option<f64>| match l {
                    Some(-14.0) => tr("YouTube (-14 LUFS)"),
                    Some(-24.0) => tr("Broadcast (-24 LUFS)"),
                    Some(v) => format!("{v} LUFS").into(),
                    None => tr("Do not change"),
                };
                egui::ComboBox::from_id_salt("cut-export-loud").selected_text(label(f.loudness)).show_ui(ui, |ui| {
                    for v in [Some(-14.0), Some(-24.0), None] {
                        ui.selectable_value(&mut f.loudness, v, label(v));
                    }
                });
            });
        },
    );
    section(ui, "Output");
    let mut browse = false;
    egui::Grid::new(("cut-export-out", inline)).num_columns(2).min_col_width(LABEL_WIDTH).spacing([12.0, 6.0]).show(
        ui,
        |ui| {
            row(ui, "Range", |ui| {
                ui.add_enabled_ui(has_io, |ui| {
                    ui.radio_value(&mut f.in_out, false, tr("Entire sequence"));
                    ui.radio_value(&mut f.in_out, true, tr("In to Out"));
                });
            });
            row(ui, "Captions", |ui| {
                ui.add_enabled_ui(has_captions && video, |ui| {
                    let label = |c: Option<CaptionMode>| match c {
                        None => tr("None"),
                        Some(CaptionMode::Burn) => tr("Burn into the video"),
                        Some(CaptionMode::Srt) => tr("SRT file beside the video"),
                        Some(CaptionMode::Both) => tr("Both"),
                    };
                    egui::ComboBox::from_id_salt("cut-export-cap").selected_text(label(f.captions)).show_ui(ui, |ui| {
                        for c in [None, Some(CaptionMode::Burn), Some(CaptionMode::Srt), Some(CaptionMode::Both)] {
                            ui.selectable_value(&mut f.captions, c, label(c));
                        }
                    });
                });
            });
            if let Some(note) = &burned
                && matches!(f.captions, Some(CaptionMode::Burn | CaptionMode::Both))
            {
                ui.label("");
                ui.label(RichText::new(note).small().weak());
                ui.end_row();
            }
            row(ui, "File", |ui| {
                ui.horizontal(|ui| {
                    if ui.add(egui::TextEdit::singleline(&mut f.path).desired_width(300.0)).changed() {
                        f.path_touched = true;
                    }
                    browse = ui.button(tr("Browse…")).clicked();
                });
            });
        },
    );
    let settings = f.resolved(&seq);
    let range = range_of(s, &seq);
    let len = range.map_or(seq.duration(), |r| r.1 - r.0);
    let mut problems: Vec<String> = presets::validate(&settings).iter().map(|p| tr(p).into_owned()).collect();
    if len <= 0 {
        problems.push(tr("The sequence is empty.").into_owned());
    }
    ui.add_space(8.0);
    if len > 0 {
        let speed = s.doc.setting("exportSpeed").and_then(|v| v.parse::<f64>().ok());
        ui.label(trf(
            "Duration {d} · about {size} · about {time} on this PC",
            &[
                ("d", &cut_time::timecode(len, seq.fps)),
                ("size", &format_bytes(presets::estimate(&settings, len))),
                ("time", &format_seconds(presets::estimate_seconds(&settings, len, speed))),
            ],
        ));
    }
    for p in &problems {
        ui.colored_label(egui::Color32::from_rgb(0xe0, 0x4b, 0x3a), p);
    }
    let offline = offline_clips(s, &seq);
    if offline > 0 {
        ui.colored_label(
            egui::Color32::from_rgb(0xe6, 0xc2, 0x29),
            trf(
                "{n} clips use offline media: they export as a red \"media offline\" picture.",
                &[("n", &offline.to_string())],
            ),
        );
    }
    if !s.features.export.loudness_text.is_empty() {
        ui.label(&s.features.export.loudness_text);
    }
    ui.horizontal(|ui| {
        if ui.button(tr("Measure Loudness")).clicked() {
            measure(s, &seq, range);
        }
        if ui.button(tr("Copy YouTube Chapters")).clicked() {
            let text = plan::chapters(&seq.markers, &tr("Intro"), None);
            if text.is_empty() {
                s.app.toast(tr("Add chapter markers first (M, then set the marker type to Chapter)."));
            } else {
                ctx.copy_text(text);
                s.app.toast(tr("YouTube chapters copied"));
            }
        }
    });
    if browse {
        let ext = settings.ext.clone();
        let path = PathBuf::from(&s.features.export.form.path);
        let (tx, rx) = channel();
        let (title, filter) = (
            tr("Export To").into_owned(),
            if ext == "m4a" { tr("MPEG-4 audio") } else { tr("MPEG-4 video") }.into_owned(),
        );
        std::thread::spawn(move || {
            let mut d = rfd::FileDialog::new().set_title(&title).add_filter(&filter, &[&ext]);
            if let Some(dir) = path.parent() {
                d = d.set_directory(dir);
            }
            if let Some(n) = path.file_name() {
                d = d.set_file_name(n.to_string_lossy());
            }
            let _ = tx.send(d.save_file());
        });
        s.features.export.picked = Some(rx);
    }
    // progress, result and the buttons
    if let Some((fraction, left, job)) = s.features.export.progress()
        && job.is_none()
    {
        ui.add_space(6.0);
        let text = if fraction == 0.0 && left.is_none() {
            tr("Starting…").into_owned()
        } else {
            trf(
                "{pct}% · {left} left",
                &[
                    ("pct", &((fraction * 100.0).floor() as u64).to_string()),
                    ("left", &left.map_or_else(|| "…".to_owned(), format_seconds)),
                ],
            )
        };
        ui.add(egui::ProgressBar::new(fraction as f32).text(text));
    }
    outcome(s, ui);
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        let start = ui.add_enabled(
            !busy && problems.is_empty(),
            Button::new(RichText::new(tr("Export")).strong()).fill(egui::Color32::from_rgb(0x35, 0x74, 0xf0)),
        );
        if start.clicked() {
            go(s, false, false, &ctx);
        }
        if ui.add_enabled(problems.is_empty(), Button::new(tr("Add to Queue"))).clicked() {
            go(s, true, false, &ctx);
        }
        if own && ui.button(tr("Cancel Export")).clicked() {
            cancel(s, None);
        }
        if inline {
            if ui.button(tr("Export Frame…")).clicked() {
                super::export_frame(s);
            }
        } else if ui.button(tr("Close")).clicked() {
            s.features.export.open = false;
        }
    });
}

/// The dialog's last result (`showResult`).
fn outcome(s: &mut Shell, ui: &mut egui::Ui) {
    let Some(o) = &s.features.export.outcome else { return };
    ui.add_space(6.0);
    match o {
        Outcome::Cancelled => {
            ui.label(RichText::new(tr("The export was cancelled.")).strong());
        }
        Outcome::Failed(f) => {
            ui.colored_label(
                egui::Color32::from_rgb(0xe0, 0x4b, 0x3a),
                trf("The export failed: {error}", &[("error", &said(f))]),
            );
        }
        Outcome::Done(d) => {
            let name = d.path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            ui.label(RichText::new(trf("Exported {name}", &[("name", &name)])).strong());
            ui.label(trf(
                "{size} in {time}",
                &[("size", &format_bytes(d.bytes)), ("time", &format_seconds(d.seconds))],
            ));
            if let Some(e) = &d.encoder {
                ui.label(RichText::new(format!("{} · {:.1}x", e.name, d.speed)).weak());
            }
            if let Some(v) = &d.verified {
                if v.ok && v.problems.is_empty() {
                    ui.colored_label(
                        egui::Color32::from_rgb(0x3c, 0xb3, 0x71),
                        tr("Checked: the file opens, and its length and frames are as expected."),
                    );
                } else {
                    let list: Vec<String> = v
                        .problems
                        .iter()
                        .map(|p| {
                            let params: Vec<(&str, &str)> = p.params.iter().map(|(k, v)| (*k, v.as_str())).collect();
                            trf(p.message, &params)
                        })
                        .collect();
                    ui.colored_label(
                        egui::Color32::from_rgb(0xe6, 0xc2, 0x29),
                        trf("The check found problems: {list}", &[("list", &list.join("; "))]),
                    );
                }
            }
            if ui.button(tr("Show in Explorer")).clicked() {
                super::reveal(&d.path);
            }
        }
    }
}

/// Measures the integrated loudness and true peak of the sequence (the range when one is chosen) on a thread.
fn measure(s: &mut Shell, seq: &Sequence, range: Option<(i64, i64)>) {
    let (from, to) = range.unwrap_or((0, seq.duration()));
    if to <= from {
        return;
    }
    let project = Arc::new(s.app.project().clone());
    let id = seq.id;
    let (tx, rx) = channel();
    s.features.export.loudness_text = tr("Measuring…").into_owned();
    std::thread::spawn(move || {
        let mut mixer = cut_audio::Mixer::new(48000, crate::transport::file_audio(cut_audio::Library::default()));
        mixer.load(&project, id, from as f64, to as f64);
        let l = cut_audio::offline::measure(&mut mixer, &project, id, from, to, 0.0, |_| true);
        let num = |v: f64| if v.is_finite() { format!("{v:.1}") } else { "-∞".into() };
        let text = match l {
            Some(l) => trf(
                "Integrated loudness {lufs} LUFS · true peak {peak} dBTP",
                &[("lufs", &num(l.integrated)), ("peak", &num(l.true_peak))],
            ),
            None => trf("The loudness could not be measured: {error}", &[("error", "cancelled")]),
        };
        let _ = tx.send(text);
    });
    s.features.export.measured = Some(rx);
}
