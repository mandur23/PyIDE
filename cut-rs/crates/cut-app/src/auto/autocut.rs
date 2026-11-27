//! AutoCut… (the Automation menu): the editor cuts a talking video by itself. Of the selected clips with sound (else
//! every one) it finds the silences (by their sound, the threshold set from the sound's own quiet and loud levels
//! unless it is typed), the filler words and long pauses (by the speech recognition's words, recognised first when
//! asked), and the pieces too short to keep between two cuts, previews every cut over the lanes with a list to look
//! at and leave out, and ripple-deletes what is left on as one undo step named AutoCut.
//!
//! Defaults (the owner asked for AutoCut without saying what it cuts): silences quieter than the automatic threshold
//! and at least 0.5 s, the speech's fillers and pauses when its words are there, pieces under 0.4 s, 0.1 s kept on
//! each side. Each is a field of the dialog and is remembered (`auto.autocut`).

use cut_audio::analysis::{silence_ranges, total};
use cut_model::{Id, Role};
use cut_time::TICKS;
use eframe::egui::{self, RichText};

use super::levels::{self, Read};
use super::silence::{Overlay, ripple_tracks};
use super::{Job, dialog, number};
use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::speech::text::{FillerOpts, Word, filler_plan};

/// Why a stretch is cut, in the order a merged cut keeps its reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Why {
    Piece,
    Silence,
    Pause,
    Filler,
}

impl Why {
    fn label(self) -> &'static str {
        match self {
            Why::Piece => "Short piece",
            Why::Silence => "Silence",
            Why::Pause => "Long pause",
            Why::Filler => "Filler word",
        }
    }
}

/// One cut of the timeline, ticks.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cut {
    pub from: f64,
    pub to: f64,
    pub why: Why,
}

impl Cut {
    /// The cut's place, whole ticks (what a cut left out is remembered by).
    pub fn key(&self) -> (i64, i64) {
        (self.from.round() as i64, self.to.round() as i64)
    }
}

/// The dialog's fields.
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    pub silence: bool,
    /// The threshold from the sound's levels ([`auto_threshold`]) rather than `threshold`.
    pub auto: bool,
    pub threshold: f64,
    /// Silences and pauses at least this long, seconds.
    pub min_silence: f64,
    pub speech: bool,
    /// Pieces shorter than this between two cuts (or a cut and a clip's edge) go too, seconds.
    pub min_piece: f64,
    /// Kept on each side of a silence or a word, seconds.
    pub margin: f64,
}

const DEFAULTS: [(&str, f64); 7] = [
    ("silence", 1.0),
    ("auto", 1.0),
    ("threshold", -40.0),
    ("minSilence", 0.5),
    ("speech", 1.0),
    ("minPiece", 0.4),
    ("margin", 0.1),
];

/// AutoCut's state.
#[derive(Default)]
pub struct AutoCutUi {
    pub job: Option<Job<levels::Measured>>,
    measuring: Vec<Id>,
    /// The clips measured and the dialog's fields, once measured.
    pub open: Option<(Vec<Id>, Form)>,
    /// Cuts unticked in the list, by [`Cut::key`].
    pub off: Vec<(i64, i64)>,
}

/// The silence threshold of these levels (dBFS): above the quiet the sound sits at (its 10th percentile) by a third
/// of the way to its speech (its 90th percentile), at least 6 dB, within -60..-20 dB. Digital silence (below
/// -100 dB) is left out of the count; no sound at all gives -40 dB.
pub fn auto_threshold(levels: &[&[f32]]) -> f64 {
    let mut all: Vec<f32> = levels.iter().flat_map(|l| l.iter().copied()).filter(|v| *v > -100.0).collect();
    if all.len() < 10 {
        return -40.0;
    }
    all.sort_by(f32::total_cmp);
    let at = |q: f64| f64::from(all[((all.len() - 1) as f64 * q).round() as usize]);
    let (quiet, loud) = (at(0.1), at(0.9));
    (quiet + ((loud - quiet) / 3.0).max(6.0)).clamp(-60.0, -20.0)
}

/// Puts `parts` together: overlapping or touching cuts become one (keeping the strongest reason), then a piece
/// shorter than `min_piece` between two cuts of one stretch of `spans` (the clips' places), or between a cut and the
/// stretch's edge, is cut too. -> the cuts in time order, and how many pieces were added.
pub fn combine(spans: &[(f64, f64)], mut parts: Vec<Cut>, min_piece: f64) -> (Vec<Cut>, usize) {
    parts.retain(|c| c.to > c.from);
    let merged = merge(parts);
    let mut pieces = Vec::new();
    for &(a, b) in &cut_audio::analysis::union(spans) {
        let inside: Vec<&Cut> = merged.iter().filter(|c| c.from < b && c.to > a).collect();
        let Some((first, last)) = inside.first().zip(inside.last()) else { continue };
        if first.from > a && first.from - a < min_piece {
            pieces.push(Cut { from: a, to: first.from, why: Why::Piece });
        }
        for w in inside.windows(2) {
            if w[1].from - w[0].to < min_piece {
                pieces.push(Cut { from: w[0].to, to: w[1].from, why: Why::Piece });
            }
        }
        if last.to < b && b - last.to < min_piece {
            pieces.push(Cut { from: last.to, to: b, why: Why::Piece });
        }
    }
    let n = pieces.len();
    let mut all = merged;
    all.extend(pieces);
    (merge(all), n)
}

fn merge(mut parts: Vec<Cut>) -> Vec<Cut> {
    parts.sort_by(|x, y| x.from.total_cmp(&y.from));
    let mut out: Vec<Cut> = Vec::new();
    for c in parts {
        match out.last_mut() {
            Some(l) if c.from <= l.to + 0.5 => {
                l.to = l.to.max(c.to);
                l.why = l.why.max(c.why);
            }
            _ => out.push(c),
        }
    }
    out
}

/// The cuts of `form` for these clips: the silences of the measured levels, the fillers and pauses of `words`.
pub fn plan(s: &Shell, clips: &[Id], form: &Form, words: &[Word]) -> (Vec<Cut>, usize, f64) {
    let Some(seq) = s.app.sequence() else { return (Vec::new(), 0, -40.0) };
    let t = TICKS as f64;
    let frame = cut_model::query::frame(seq.fps) as f64;
    let now: Vec<&cut_model::Clip> = clips.iter().filter_map(|id| seq.clip(*id)).collect();
    let spans: Vec<(f64, f64)> = now.iter().map(|c| levels::span(c)).collect();
    let measured: Vec<(&cut_model::Clip, std::sync::Arc<levels::Levels>)> = now
        .iter()
        .filter_map(|c| Read::of(s.app.project(), c).and_then(|r| s.features.auto.levels.get(&r.key)).map(|l| (*c, l)))
        .collect();
    let threshold = if form.auto {
        auto_threshold(&measured.iter().map(|(_, l)| l.levels.as_slice()).collect::<Vec<_>>())
    } else {
        form.threshold
    };
    let mut parts = Vec::new();
    if form.silence {
        let loud: Vec<(f64, f64)> =
            measured.iter().flat_map(|(c, l)| levels::loud_on_timeline(c, l, threshold)).collect();
        let quiet = silence_ranges(&spans, &loud, form.min_silence * t, form.margin * t, frame);
        parts.extend(quiet.into_iter().map(|(from, to)| Cut { from, to, why: Why::Silence }));
    }
    if form.speech && !words.is_empty() {
        let o = FillerOpts { fillers: true, pauses: true, pause_length: form.min_silence.max(0.3), keep: form.margin };
        let p = filler_plan(words, &o, frame);
        for &(from, to) in &p.ranges {
            let filler = p.fillers.iter().filter_map(|i| words.get(*i)).any(|w| w.t0 < to && w.t1 > from);
            parts.push(Cut { from, to, why: if filler { Why::Filler } else { Why::Pause } });
        }
    }
    let (cuts, pieces) = combine(&spans, parts, form.min_piece * t);
    (cuts, pieces, threshold)
}

fn form_of(s: &Shell) -> Form {
    let v = super::settings(s, "autocut", &DEFAULTS);
    Form {
        silence: v[0] != 0.0,
        auto: v[1] != 0.0,
        threshold: v[2],
        min_silence: v[3],
        speech: v[4] != 0.0,
        min_piece: v[5],
        margin: v[6],
    }
}

fn remember(s: &mut Shell, f: &Form) {
    let b = |x: bool| if x { 1.0 } else { 0.0 };
    super::remember(
        s,
        "autocut",
        &[
            ("silence", b(f.silence)),
            ("auto", b(f.auto)),
            ("threshold", f.threshold),
            ("minSilence", f.min_silence),
            ("speech", b(f.speech)),
            ("minPiece", f.min_piece),
            ("margin", f.margin),
        ],
    );
}

/// AutoCut… chosen: the clips with sound (with nothing selected, those not marked music, effects or ambience)
/// measured, then the dialog.
pub fn open(s: &mut Shell) {
    let picked = !s.app.selected_clips().is_empty();
    let mut clips = crate::audio::essential::sound_clips(&s.app, true);
    // with nothing selected, the speech: music, effects and ambience under it are never quiet (`silencePlan`)
    if !picked && let Some(seq) = s.app.sequence() {
        let other = |r: Option<Role>| matches!(r, Some(Role::Music | Role::Effects | Role::Ambience));
        clips.retain(|id| seq.clip(*id).is_some_and(|c| !other(c.role)));
    }
    let Some(seq) = s.app.sequence().filter(|_| !clips.is_empty()) else {
        s.app.toast(tr("There are no clips with sound to analyze."));
        return;
    };
    let reads: Vec<Read> = clips
        .iter()
        .filter_map(|id| seq.clip(*id))
        .filter_map(|c| Read::of(s.app.project(), c))
        .filter(|r| s.features.auto.levels.get(&r.key).is_none())
        .collect();
    let job =
        Job::start(tr("Analyzing the sound…").into_owned(), false, move |step| levels::measure_all(&reads, step));
    let a = &mut s.features.auto.autocut;
    a.job = Some(job);
    a.measuring = clips;
    a.off.clear();
}

/// Takes in the measurement and opens the dialog with its preview.
pub fn poll(s: &mut Shell, playing: bool) {
    let Some(out) = s.features.auto.autocut.job.as_ref().and_then(|j| j.poll(playing)) else { return };
    s.features.auto.autocut.job = None;
    let clips = std::mem::take(&mut s.features.auto.autocut.measuring);
    let Some(got) = super::ended(s, out) else { return };
    for (k, l) in got {
        s.features.auto.levels.put(k, l);
    }
    let f = form_of(s);
    s.features.auto.autocut.open = Some((clips, f));
}

/// The recognised words of these clips (none when they were not transcribed).
fn words_of(s: &mut Shell, clips: &[Id]) -> Vec<Word> {
    let st = crate::speech::store(s);
    let o = crate::speech::opts(s);
    let g = st.lock().unwrap_or_else(|e| e.into_inner());
    crate::speech::flow::timeline_words(&s.app, &g, &o, clips, None)
}

/// Cut pressed: the ticked cuts ripple-deleted from the clips' tracks and the tracks linked to them, one step.
pub fn apply(s: &mut Shell) -> bool {
    let Some((clips, f)) = s.features.auto.autocut.open.clone() else { return false };
    remember(s, &f);
    let words = if f.speech { words_of(s, &clips) } else { Vec::new() };
    let (cuts, ..) = plan(s, &clips, &f, &words);
    let off = std::mem::take(&mut s.features.auto.autocut.off);
    let ranges: Vec<(f64, f64)> = cuts.iter().filter(|c| !off.contains(&c.key())).map(|c| (c.from, c.to)).collect();
    close(s);
    if ranges.is_empty() {
        s.app.toast(tr("AutoCut found nothing to cut with these settings."));
        return false;
    }
    let Some(cmd) = s.app.sequence().and_then(|q| crate::speech::flow::ripple_command(q, &ranges, &clips, "AutoCut"))
    else {
        return false;
    };
    let ok = s.app.exec(&cmd).is_some();
    if ok {
        s.app.selection.clear();
        s.app.toast(trf(
            "AutoCut made {n} cuts ({time}). Undo brings them back.",
            &[("n", &ranges.len().to_string()), ("time", &super::seconds(total(&ranges)))],
        ));
    }
    ok
}

/// The dialog closed: the preview goes.
pub fn close(s: &mut Shell) {
    s.features.auto.autocut.open = None;
    s.features.auto.autocut.off.clear();
    s.timeline.overlay = None;
}

fn clock(ticks: f64) -> String {
    let secs = (ticks / TICKS as f64).max(0.0);
    let m = (secs / 60.0).floor();
    format!("{}:{:05.2}", m as i64, secs - m * 60.0)
}

/// The dialog and the preview, each frame; hidden while the speech is being recognised for it.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let Some((clips, mut f)) = s.features.auto.autocut.open.clone() else { return };
    if crate::speech::busy(s) || s.features.speech.setup.is_some() {
        return;
    }
    let words = if f.speech { words_of(s, &clips) } else { Vec::new() };
    let (cuts, pieces, threshold) = plan(s, &clips, &f, &words);
    let mut off = s.features.auto.autocut.off.clone();
    let on: Vec<(f64, f64)> = cuts.iter().filter(|c| !off.contains(&c.key())).map(|c| (c.from, c.to)).collect();
    let changed = s.app.sequence().map(|q| ripple_tracks(q, &clips).1).unwrap_or_default();
    s.timeline.overlay = Some(Overlay { ranges: on.clone(), tracks: Some(changed) });
    let length = s.app.sequence().map_or(0.0, |q| q.duration() as f64);
    let (mut go, mut cancel, mut transcribe, mut seek) = (false, false, false, None);
    let pal = s.palette.clone();
    dialog("AutoCut", "cutAutoCut", 480.0).show_titled(ctx, tr("AutoCut"), None, |ui| {
        ui.set_max_width(480.0);
        ui.label(trf(
            "Clips with sound: {n}. The cuts are ripple-deleted from their tracks and the tracks linked to them, as one step you can undo.",
            &[("n", &clips.len().to_string())],
        ));
        ui.checkbox(&mut f.silence, tr("Cut silences"));
        egui::Grid::new("cut-autocut").num_columns(2).show(ui, |ui| {
            ui.label(tr("Quieter than"));
            ui.horizontal(|ui| {
                ui.checkbox(&mut f.auto, trf("Automatic ({db} dB)", &[("db", &format!("{threshold:.0}"))]));
                if !f.auto {
                    number(ui, &mut f.threshold, (-90.0, -5.0, 1.0), 0, "dB");
                }
            });
            ui.end_row();
            ui.label(tr("Silences and pauses of at least"));
            number(ui, &mut f.min_silence, (0.1, 10.0, 0.05), 2, "s");
            ui.end_row();
        });
        ui.checkbox(&mut f.speech, tr("Cut filler words and long pauses (speech recognition)"));
        if f.speech && words.is_empty() {
            ui.horizontal(|ui| {
                ui.label(RichText::new(tr("The speech is not transcribed yet.")).size(11.0).color(pal.gray[9]));
                transcribe = ui.button(tr("Transcribe…")).clicked();
            });
        }
        egui::Grid::new("cut-autocut-2").num_columns(2).show(ui, |ui| {
            ui.label(tr("Cut pieces shorter than"));
            number(ui, &mut f.min_piece, (0.0, 5.0, 0.05), 2, "s");
            ui.end_row();
            ui.label(tr("Keep on each side"));
            number(ui, &mut f.margin, (0.0, 2.0, 0.05), 2, "s");
            ui.end_row();
        });
        ui.separator();
        let removed = total(&on);
        ui.label(if cuts.is_empty() {
            tr("AutoCut found nothing to cut with these settings.").into_owned()
        } else {
            trf(
                "Cuts: {n} · {time} removed · {from} → {to}",
                &[
                    ("n", &on.len().to_string()),
                    ("time", &super::seconds(removed)),
                    ("from", &clock(length)),
                    ("to", &clock((length - removed).max(0.0))),
                ],
            )
        });
        if pieces > 0 {
            ui.label(
                RichText::new(trf("Short pieces between cuts: {n}", &[("n", &pieces.to_string())]))
                    .size(11.0)
                    .color(pal.gray[9]),
            );
        }
        egui::ScrollArea::vertical().max_height(180.0).id_salt("cut-autocut-list").show(ui, |ui| {
            for c in &cuts {
                ui.horizontal(|ui| {
                    let mut kept = !off.contains(&c.key());
                    if ui.checkbox(&mut kept, "").changed() {
                        if kept {
                            off.retain(|k| *k != c.key());
                        } else {
                            off.push(c.key());
                        }
                    }
                    let text = format!(
                        "{} – {}  ·  {}  {}",
                        clock(c.from),
                        clock(c.to),
                        tr(c.why.label()),
                        super::seconds(c.to - c.from)
                    );
                    if ui.link(text).on_hover_text(tr("Show this cut in the monitor")).clicked() {
                        seek = Some(c.from);
                    }
                });
            }
        });
        crate::panels::dialogs::actions(ui, |ui| {
            go = crate::panels::dialogs::primary_if(ui, !on.is_empty(), tr("Apply Cuts")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    if let Some(t) = seek {
        s.app.set_time(t.round() as cut_time::Ticks);
    }
    if let Some(open) = &mut s.features.auto.autocut.open {
        open.1 = f.clone();
    }
    s.features.auto.autocut.off = off;
    if transcribe {
        remember(s, &f);
        crate::speech::dialogs::ensure_ready(s, None, crate::speech::Goal::Recognize { ids: clips, range: None });
    } else if go {
        apply(s);
    } else if cancel {
        close(s);
    }
}

/// Korean of AutoCut's texts.
pub const KO: [(&str, &str); 20] = [
    ("AutoCut…", "자동 컷 편집…"),
    ("AutoCut", "자동 컷 편집"),
    (
        "Clips with sound: {n}. The cuts are ripple-deleted from their tracks and the tracks linked to them, as one step you can undo.",
        "소리가 있는 클립: {n}개. 자른 곳은 그 트랙과 연결된 트랙에서 잔물결 삭제되고, 실행 취소 한 번으로 되돌릴 수 있습니다.",
    ),
    ("Cut silences", "무음 자르기"),
    ("Automatic ({db} dB)", "자동({db} dB)"),
    ("Silences and pauses of at least", "무음과 쉼의 최소 길이"),
    ("Cut filler words and long pauses (speech recognition)", "군말과 긴 쉼 자르기(음성 인식)"),
    ("The speech is not transcribed yet.", "아직 음성을 인식하지 않았습니다."),
    ("Transcribe…", "음성 인식…"),
    ("Cut pieces shorter than", "이보다 짧은 조각도 자르기"),
    ("AutoCut found nothing to cut with these settings.", "이 설정으로는 자를 곳이 없습니다."),
    ("Cuts: {n} · {time} removed · {from} → {to}", "자를 곳 {n}개 · {time} 줄어듦 · {from} → {to}"),
    ("Short pieces between cuts: {n}", "자른 곳 사이의 짧은 조각: {n}개"),
    ("Show this cut in the monitor", "모니터에서 이 자리 보기"),
    ("Apply Cuts", "자르기 적용"),
    (
        "AutoCut made {n} cuts ({time}). Undo brings them back.",
        "자동 컷 편집으로 {n}곳을 잘랐습니다({time}). 실행 취소로 되돌릴 수 있습니다.",
    ),
    ("Short piece", "짧은 조각"),
    ("Silence", "무음"),
    ("Long pause", "긴 쉼"),
    ("Filler word", "군말"),
];

#[cfg(test)]
mod tests {
    use super::*;

    const S: f64 = TICKS as f64;

    fn cut(a: f64, b: f64, why: Why) -> Cut {
        Cut { from: a * S, to: b * S, why }
    }

    #[test]
    fn overlapping_cuts_become_one_with_the_strongest_reason() {
        let (out, pieces) = combine(
            &[(0.0, 20.0 * S)],
            vec![cut(2.0, 3.0, Why::Silence), cut(2.8, 3.4, Why::Filler), cut(8.0, 9.0, Why::Pause)],
            0.0,
        );
        assert_eq!(out, [cut(2.0, 3.4, Why::Filler), cut(8.0, 9.0, Why::Pause)]);
        assert_eq!(pieces, 0);
    }

    #[test]
    fn short_pieces_between_cuts_and_at_a_clips_edge_go_too() {
        let spans = [(0.0, 10.0 * S), (12.0 * S, 20.0 * S)];
        let parts = vec![
            cut(0.2, 1.0, Why::Silence),
            cut(1.3, 2.0, Why::Silence),
            cut(5.0, 6.0, Why::Silence),
            cut(9.8, 9.9, Why::Filler),
            cut(12.5, 13.0, Why::Silence),
        ];
        let (out, pieces) = combine(&spans, parts, 0.4 * S);
        // 0..0.2 (edge), 1.0..1.3 (between), 9.9..10 (edge) are pieces; 12..12.5 is too long; 6..9.8 is kept
        assert_eq!(pieces, 3);
        assert_eq!(
            out,
            [
                cut(0.0, 2.0, Why::Silence),
                cut(5.0, 6.0, Why::Silence),
                cut(9.8, 10.0, Why::Filler),
                cut(12.5, 13.0, Why::Silence)
            ]
        );
    }

    #[test]
    fn the_threshold_sits_between_the_quiet_and_the_speech() {
        let mut lv = vec![-62.0f32; 600];
        lv.extend(vec![-18.0f32; 400]);
        let t = auto_threshold(&[&lv]);
        assert!((t - (-62.0 + 44.0 / 3.0)).abs() < 0.01, "{t}");
        // a noisy room: never above -20 dB, never closer than 6 dB to the quiet
        let close = vec![-30.0f32; 500].into_iter().chain(vec![-27.0f32; 500]).collect::<Vec<_>>();
        assert_eq!(auto_threshold(&[&close]), -24.0);
        assert_eq!(auto_threshold(&[&[-200.0f32; 50]]), -40.0, "digital silence alone");
        assert_eq!(auto_threshold(&[&vec![-90.0f32; 100]]), -60.0);
    }
}
