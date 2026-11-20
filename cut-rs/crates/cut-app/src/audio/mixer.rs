//! The Audio Track Mixer (`ui-mixer.js`): a strip per audio track of the sequence (its pan knob, mute and solo, a
//! vertical fader in dB over the track volume, a stereo meter, its name) and a master strip (the sequence's
//! `masterGain` and the mix's meter). The fader is the same track volume as the timeline header's 0-200%: the model
//! keeps dB, 200% is +6.02 dB and 0% is -144 dB, silence. A fader or knob drag is one undo step; Alt+click puts it
//! back to 0, a double click on the value (or the knob) types one.

use std::collections::HashMap;

use cut_model::commands::build as C;
use cut_model::{Id, Sequence, TrackKind};
use eframe::egui::{self, Align2, Color32, CornerRadius, FontId, Pos2, Rect, Sense, Stroke, StrokeKind, Vec2};
use serde_json::{Value as Json, json};

use super::meters::{self, Ballistics};
use crate::i18n::tr;
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::theme::Palette;

/// Fader travel: dB at points from the bottom (0) to the top (1), straight lines between, like a console's scale.
const SCALE: [(f64, f64); 10] = [
    (f64::NEG_INFINITY, 0.0),
    (-60.0, 0.04),
    (-48.0, 0.1),
    (-36.0, 0.2),
    (-24.0, 0.34),
    (-18.0, 0.44),
    (-12.0, 0.56),
    (-6.0, 0.7),
    (0.0, 0.84),
    (6.0, 1.0),
];
const TICK_LABELS: [f64; 9] = [6.0, 0.0, -6.0, -12.0, -18.0, -24.0, -36.0, -48.0, f64::NEG_INFINITY];
/// The model's 0% (the mixer plays it as silence).
pub const SILENT: f64 = -144.0;
/// The top of a track fader: 200%.
fn track_max() -> f64 {
    20.0 * 2f64.log10()
}
const MASTER_MAX: f64 = 6.0;
const CAP_H: f32 = 22.0;

/// Where `db` sits on the fader, 0 at the bottom to 1 at the top (`posOf`).
pub fn pos_of(db: f64) -> f64 {
    if db.is_nan() || db <= SILENT {
        return 0.0;
    }
    if db <= SCALE[1].0 {
        return SCALE[1].1 * ((db - SILENT) / (SCALE[1].0 - SILENT)).clamp(0.0, 1.0);
    }
    for w in SCALE[1..].windows(2) {
        let ((d0, p0), (d1, p1)) = (w[0], w[1]);
        if db <= d1 {
            return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
        }
    }
    1.0
}

/// The dB at a place on the fader (`dbOf`).
pub fn db_of(pos: f64) -> f64 {
    if pos <= 0.002 {
        return SILENT;
    }
    if pos <= SCALE[1].1 {
        return SILENT + (pos / SCALE[1].1) * (SCALE[1].0 - SILENT);
    }
    for w in SCALE[1..].windows(2) {
        let ((d0, p0), (d1, p1)) = (w[0], w[1]);
        if pos <= p1 {
            return d0 + ((pos - p0) / (p1 - p0)) * (d1 - d0);
        }
    }
    SCALE[SCALE.len() - 1].0
}

/// JavaScript's `Math.round`: halves up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn round(db: f64) -> f64 {
    if db <= SILENT { SILENT } else { js_round(db * 10.0) / 10.0 }
}

/// A volume as the strip shows it (`dbText`): one decimal, a plus above 0, `-∞` at silence.
pub fn db_text(db: f64) -> String {
    if db.is_nan() || db <= SILENT {
        "-∞".to_owned()
    } else {
        format!("{}{:.1}", if db > 0.0 { "+" } else { "" }, db)
    }
}

/// JavaScript's `Number(text)` for what a person types: blank is 0, `None` for what is not a finite number.
fn js_number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite() && !t.to_ascii_lowercase().contains("inf"))
}

/// A strip: an audio track's or the master's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Strip {
    Track(Id),
    Master,
}

/// The value a strip's fader shows (dB).
fn value_of(seq: &Sequence, strip: Strip) -> f64 {
    match strip {
        Strip::Master => seq.master_gain,
        Strip::Track(id) => seq.track(id).and_then(|t| t.volume).unwrap_or(0.0),
    }
}

/// The command a fader at `db` gives (`setValue`), none when it is the value already.
fn fader_command(seq: &Sequence, strip: Strip, db: f64) -> Option<Json> {
    let max = if strip == Strip::Master { MASTER_MAX } else { track_max() };
    let v = round(max.min(db));
    if (value_of(seq, strip) - v).abs() < 1e-9 {
        return None;
    }
    Some(match strip {
        Strip::Master => C::set_sequence(seq.id.as_str(), json!({ "masterGain": v })),
        Strip::Track(id) => C::set_track(
            seq.id.as_str(),
            id.as_str(),
            json!({ "volume": if v <= SILENT { SILENT } else { v.min(track_max()) } }),
        ),
    })
}

/// A typed fader value (`typeValue`): `-inf` or `∞` is silence, `dB` and a plus sign may be there.
pub fn typed_db(text: &str) -> Option<f64> {
    let t = text.trim().to_lowercase().replacen("db", "", 1);
    let t = t.trim();
    if matches!(t, "inf" | "-inf" | "∞" | "-∞") {
        return Some(SILENT);
    }
    js_number(&t.replacen('+', "", 1))
}

/// The pan after a knob drag of `dx`, `dy` pixels from `p0`: up or right turns it right, a pixel a step.
fn dragged_pan(p0: f64, dx: f64, dy: f64) -> f64 {
    js_round(p0 + dx - dy).clamp(-100.0, 100.0)
}

/// A typed pan, rounded to a step and kept within -100..100.
pub fn typed_pan(text: &str) -> Option<f64> {
    js_number(text).map(|v| js_round(v).clamp(-100.0, 100.0))
}

fn pan_text(p: f64) -> String {
    format!("{}", js_round(p) as i64)
}

#[derive(Debug, Clone, Copy)]
enum Drag {
    Fader { strip: Strip, p0: f64, y0: f32, travel: f32 },
    Knob { track: Id, p0: f64, from: Pos2 },
}

/// A strip's places on screen at the last frame (tests press and drag them as a person would).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shown {
    pub strip: Strip,
    pub fader: Rect,
    /// The cap's centre now, and where it is at the top and the bottom of its travel.
    pub cap: Pos2,
    pub top: f32,
    pub bottom: f32,
    pub knob: Option<Rect>,
    pub mute: Option<Rect>,
    pub solo: Option<Rect>,
    pub value: Rect,
}

/// What a double click asks to type: a strip's volume or a track's pan.
#[derive(Debug, Clone, PartialEq)]
pub enum Typing {
    Volume(Strip, String),
    Pan(Id, String),
}

/// The mixer's own state.
#[derive(Default)]
pub struct MixerView {
    drag: Option<Drag>,
    pub typing: Option<Typing>,
    pub meters: HashMap<Strip, Ballistics>,
    pub shown: Vec<Shown>,
}

impl MixerView {
    /// Ends a drag whose button went up while the panel was not drawn.
    pub fn settle(&mut self, app: &mut crate::state::App, down: bool) {
        if self.drag.is_some() && !down {
            self.drag = None;
            app.history.commit();
        }
    }
}

fn exec(s: &mut Shell, cmd: Option<Json>) {
    if let Some(c) = cmd {
        s.app.exec(&c);
    }
}

/// The Audio Track Mixer panel.
pub fn panel(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    let Some(seq) = s.app.shared_sequence() else { return };
    let tracks: Vec<(Id, String)> =
        seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).map(|t| (t.id, t.name.clone())).collect();
    let playing = s.transport.playing();
    let heard = if playing { s.transport.meters() } else { None };
    let area = ui.available_rect_before_wrap();
    ui.allocate_rect(area, Sense::hover());
    s.features.audio.mixer.shown.clear();
    let master_w = 84.0;
    let strips_r = Rect::from_min_max(area.min, Pos2::new(area.right() - master_w - 2.0, area.bottom()));
    let p = ui.painter_at(area);
    p.rect_filled(area, 0.0, pal.gray[1]);
    if tracks.is_empty() {
        p.text(
            strips_r.center(),
            Align2::CENTER_CENTER,
            tr("The sequence has no audio tracks."),
            FontId::proportional(12.0),
            pal.gray[8],
        );
    }
    let mut x = strips_r.left();
    for (id, name) in &tracks {
        if x + 76.0 > strips_r.right() + 0.5 {
            break;
        }
        let r = Rect::from_min_max(Pos2::new(x, area.top()), Pos2::new(x + 76.0, area.bottom()));
        let label = if name.is_empty() { id.as_str().to_owned() } else { name.clone() };
        let sub = if name.is_empty() || name == id.as_str() { String::new() } else { id.as_str().to_owned() };
        strip(s, ui, &pal, &seq, Strip::Track(*id), r, (&label, &sub), playing, heard.as_ref());
        p.vline(r.right() - 0.5, r.y_range(), Stroke::new(1.0, pal.gray[3]));
        x += 76.0;
    }
    let mr = Rect::from_min_max(Pos2::new(area.right() - master_w, area.top()), area.max);
    p.rect_filled(mr, 0.0, pal.gray[2].gamma_multiply(0.7));
    p.vline(mr.left() - 1.0, mr.y_range(), Stroke::new(2.0, pal.gray[4]));
    strip(s, ui, &pal, &seq, Strip::Master, mr, (&tr("Master"), ""), playing, heard.as_ref());
}

fn knob(p: &egui::Painter, c: Pos2, pan: f64, pal: &Palette) {
    p.circle(c, 11.0, pal.gray[3], Stroke::new(1.2, pal.gray[6]));
    let a = pan / 100.0 * 135.0;
    let at = |deg: f64, r: f32| {
        let rad = (deg - 90.0).to_radians();
        c + Vec2::new(r * rad.cos() as f32, r * rad.sin() as f32)
    };
    if a.abs() >= 0.5 {
        let n = (a.abs() / 5.0).ceil() as usize + 1;
        let pts: Vec<Pos2> = (0..=n).map(|i| at(a * i as f64 / n as f64, 11.0)).collect();
        p.add(egui::Shape::line(pts, Stroke::new(2.4, pal.accent)));
    }
    p.line_segment([c, at(a, 10.0)], Stroke::new(2.0, pal.gray[12]));
}

fn toggle(p: &egui::Painter, r: Rect, label: &str, on: bool, on_fill: Color32, on_text: Color32, pal: &Palette) {
    let (fill, stroke, text) = if on { (on_fill, on_fill, on_text) } else { (pal.gray[3], pal.gray[5], pal.gray[11]) };
    p.rect(r, CornerRadius::same(3), fill, Stroke::new(1.0, stroke), StrokeKind::Inside);
    p.text(r.center(), Align2::CENTER_CENTER, label, FontId::proportional(11.0), text);
}

#[allow(clippy::too_many_arguments)]
fn strip(
    s: &mut Shell,
    ui: &mut egui::Ui,
    pal: &Palette,
    seq: &Sequence,
    which: Strip,
    r: Rect,
    (name, sub): (&str, &str),
    playing: bool,
    heard: Option<&cut_audio::playback::Meters>,
) {
    let p = ui.painter_at(r);
    let inner = r.shrink2(Vec2::new(4.0, 2.0));
    let (alt, pressed, down, latest) =
        ui.input(|i| (i.modifiers.alt, i.pointer.primary_pressed(), i.pointer.primary_down(), i.pointer.latest_pos()));
    let key = ui.scope_id().with(("mixer", which));
    let mut knob_r = None;
    let mut mute_r = None;
    let mut solo_r = None;
    let top_h = 58.0;
    match which {
        Strip::Track(id) => {
            let t = seq.track(id);
            let pan = t.and_then(|t| t.pan).unwrap_or(0.0);
            let (mute, solo) = (t.and_then(|t| t.mute) == Some(true), t.and_then(|t| t.solo) == Some(true));
            let c = Pos2::new(inner.center().x, inner.top() + 16.0);
            let kr = Rect::from_center_size(c, Vec2::splat(28.0));
            knob(&p, c, pan, pal);
            p.text(
                Pos2::new(c.x, kr.bottom() + 6.0),
                Align2::CENTER_CENTER,
                pan_text(pan),
                FontId::monospace(10.0),
                pal.gray[9],
            );
            let kresp = ui
                .interact(kr, key.with("knob"), Sense::click_and_drag())
                .on_hover_text(tr("Pan: drag to turn, Alt+click to center, double-click to type a value"));
            if kresp.hovered() && pressed {
                if alt {
                    exec(s, Some(C::set_track(seq.id.as_str(), id.as_str(), json!({ "pan": 0 }))));
                } else if let Some(at) = latest {
                    s.app.history.begin("Track Pan");
                    s.features.audio.mixer.drag = Some(Drag::Knob { track: id, p0: pan, from: at });
                }
            }
            if kresp.double_clicked() {
                s.features.audio.mixer.typing = Some(Typing::Pan(id, pan_text(pan)));
            }
            let by = kr.bottom() + 14.0;
            let mr = Rect::from_min_size(Pos2::new(c.x - 25.5, by), Vec2::new(24.0, 18.0));
            let sr = Rect::from_min_size(Pos2::new(c.x + 1.5, by), Vec2::new(24.0, 18.0));
            toggle(&p, mr, "M", mute, Color32::from_rgb(0x2f, 0x6f, 0xb8), Color32::WHITE, pal);
            toggle(&p, sr, "S", solo, Color32::from_rgb(0xc9, 0xa2, 0x27), Color32::from_rgb(0x1b, 0x1b, 0x1b), pal);
            if ui.interact(mr, key.with("mute"), Sense::click()).on_hover_text(tr("Mute Track")).clicked() {
                exec(s, Some(C::set_track(seq.id.as_str(), id.as_str(), json!({ "mute": !mute }))));
            }
            if ui.interact(sr, key.with("solo"), Sense::click()).on_hover_text(tr("Solo Track")).clicked() {
                exec(s, Some(C::set_track(seq.id.as_str(), id.as_str(), json!({ "solo": !solo }))));
            }
            (knob_r, mute_r, solo_r) = (Some(kr), Some(mr), Some(sr));
        }
        Strip::Master => {
            p.text(
                Pos2::new(inner.center().x, inner.top() + top_h / 2.0),
                Align2::CENTER_CENTER,
                tr("Master"),
                FontId::proportional(12.0),
                pal.gray[10],
            );
        }
    }
    // the value, the name and the track id below the body
    let name_r = Rect::from_min_max(Pos2::new(inner.left(), inner.bottom() - 22.0), inner.max);
    let value_r =
        Rect::from_min_max(Pos2::new(inner.left(), name_r.top() - 20.0), Pos2::new(inner.right(), name_r.top() - 4.0));
    let body = Rect::from_min_max(
        Pos2::new(inner.left(), inner.top() + top_h + 4.0),
        Pos2::new(inner.right(), value_r.top() - 4.0),
    );
    let db = value_of(seq, which);
    p.rect(value_r, CornerRadius::same(3), pal.gray[2], Stroke::new(1.0, pal.gray[4]), StrokeKind::Inside);
    p.text(
        value_r.center(),
        Align2::CENTER_CENTER,
        format!("{} dB", db_text(db)),
        FontId::monospace(10.0),
        pal.gray[11],
    );
    let vresp =
        ui.interact(value_r, key.with("value"), Sense::click()).on_hover_text(tr("Double-click to type a value"));
    if vresp.double_clicked() {
        s.features.audio.mixer.typing = Some(Typing::Volume(which, db_text(db).replace("-∞", "-inf")));
    }
    p.text(
        Pos2::new(name_r.center().x, name_r.top() + 5.0),
        Align2::CENTER_CENTER,
        name,
        FontId::proportional(11.0),
        pal.gray[11],
    );
    p.text(
        Pos2::new(name_r.center().x, name_r.top() + 16.0),
        Align2::CENTER_CENTER,
        sub,
        FontId::monospace(9.0),
        pal.gray[8],
    );
    if body.height() < 40.0 {
        return;
    }
    // the body: the scale, the fader, the meter
    let scale = Rect::from_min_max(body.min, Pos2::new(body.left() + 20.0, body.bottom()));
    let fader =
        Rect::from_min_max(Pos2::new(scale.right() + 3.0, body.top()), Pos2::new(scale.right() + 21.0, body.bottom()));
    let meter = Rect::from_min_max(
        Pos2::new(fader.right() + 3.0, body.top() + CAP_H / 2.0),
        Pos2::new(body.right(), body.bottom() - CAP_H / 2.0),
    );
    let travel = (fader.height() - CAP_H).max(20.0);
    let y_at = |pos: f64| fader.bottom() - CAP_H / 2.0 - travel * pos as f32;
    for d in TICK_LABELS {
        let text = if d == f64::NEG_INFINITY {
            "-∞".to_owned()
        } else if d > 0.0 {
            format!("+{d}")
        } else {
            format!("{d}")
        };
        let y = y_at(pos_of(if d == f64::NEG_INFINITY { SILENT } else { d }));
        p.text(Pos2::new(scale.right(), y), Align2::RIGHT_CENTER, text, FontId::monospace(8.0), pal.gray[8]);
    }
    let groove = Rect::from_x_y_ranges(
        fader.center().x - 2.0..=fader.center().x + 2.0,
        fader.top() + CAP_H / 2.0..=fader.bottom() - CAP_H / 2.0,
    );
    p.rect(groove, CornerRadius::same(2), pal.gray[4], Stroke::new(1.0, pal.gray[5]), StrokeKind::Inside);
    p.hline(fader.left() + 1.0..=fader.right() - 1.0, y_at(pos_of(0.0)), Stroke::new(1.0, pal.gray[8]));
    let cap_y = y_at(pos_of(db));
    let cap = Rect::from_center_size(Pos2::new(fader.center().x, cap_y), Vec2::new(fader.width(), CAP_H));
    let muted = matches!(which, Strip::Track(id) if seq.track(id).and_then(|t| t.mute) == Some(true));
    let fade = if muted { 0.6 } else { 1.0 };
    p.rect(
        cap,
        CornerRadius::same(3),
        pal.gray[7].gamma_multiply(fade),
        Stroke::new(1.0, pal.gray[9].gamma_multiply(fade)),
        StrokeKind::Inside,
    );
    p.hline(cap.left() + 2.0..=cap.right() - 2.0, cap.center().y, Stroke::new(2.0, pal.gray[12].gamma_multiply(fade)));
    let fresp = ui
        .interact(fader, key.with("fader"), Sense::click_and_drag())
        .on_hover_text(tr("Volume: drag to change, Alt+click for 0 dB, double-click the value to type it"));
    if fresp.hovered()
        && pressed
        && let Some(at) = latest
    {
        if alt {
            exec(s, fader_command(seq, which, 0.0));
        } else {
            s.app.history.begin(if which == Strip::Master { "Master Volume" } else { "Track Volume" });
            let mut p0 = pos_of(db);
            if !cap.contains(at) {
                p0 = (1.0 - f64::from(at.y - (fader.top() + CAP_H / 2.0)) / f64::from(travel)).clamp(0.0, 1.0);
                exec(s, fader_command(seq, which, db_of(p0)));
            }
            s.features.audio.mixer.drag = Some(Drag::Fader { strip: which, p0, y0: at.y, travel });
        }
    }
    // a drag going on: the value follows the pointer from where it was taken
    match (s.features.audio.mixer.drag, latest) {
        (Some(Drag::Fader { strip: st, p0, y0, travel }), Some(at)) if st == which && down => {
            let now = s.app.sequence().cloned();
            if let Some(now) = now {
                let pos = (p0 - f64::from(at.y - y0) / f64::from(travel)).clamp(0.0, 1.0);
                exec(s, fader_command(&now, which, db_of(pos)));
            }
        }
        (Some(Drag::Knob { track, p0, from }), Some(at)) if Strip::Track(track) == which && down => {
            let v = dragged_pan(p0, f64::from(at.x - from.x), f64::from(at.y - from.y));
            let now = s.app.sequence().and_then(|q| q.track(track)).and_then(|t| t.pan).unwrap_or(0.0);
            if v != now {
                exec(s, Some(C::set_track(seq.id.as_str(), track.as_str(), json!({ "pan": v }))));
            }
        }
        _ => {}
    }
    let st = s.features.audio.mixer.meters.entry(which).or_default();
    let levels = heard.map(|m| match which {
        Strip::Master => meters::master(m),
        Strip::Track(id) => meters::track(m, id),
    });
    st.tick(ui.ctx(), playing, levels);
    meters::strip(&p, meter, st, pal);
    s.features.audio.mixer.shown.push(Shown {
        strip: which,
        fader,
        cap: cap.center(),
        top: y_at(1.0),
        bottom: y_at(0.0),
        knob: knob_r,
        mute: mute_r,
        solo: solo_r,
        value: value_r,
    });
}

/// The small window that types a value (`ide.ui.prompt`).
pub fn typing_window(s: &mut Shell, ctx: &egui::Context) {
    let Some(typing) = s.features.audio.mixer.typing.clone() else { return };
    let title = match &typing {
        Typing::Volume(Strip::Master, _) => tr("Master volume (dB)"),
        Typing::Volume(..) => tr("Track volume (dB)"),
        Typing::Pan(..) => tr("Pan (-100 left to 100 right)"),
    };
    let mut text = match &typing {
        Typing::Volume(_, t) | Typing::Pan(_, t) => t.clone(),
    };
    let mut done = None;
    egui::Window::new(title.clone())
        .id(egui::Id::unique("cut-mixer-typing"))
        .collapsible(false)
        .resizable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
        .show_titled(ctx, &title, None, |ui| {
            let r = ui.text_edit_singleline(&mut text);
            r.request_focus();
            let enter = ui.input(|i| i.key_pressed(egui::Key::Enter));
            let esc = ui.input(|i| i.key_pressed(egui::Key::Escape));
            crate::panels::dialogs::actions(ui, |ui| {
                if crate::panels::dialogs::primary(ui, tr("OK")).clicked() || enter {
                    done = Some(true);
                }
                if ui.button(tr("Cancel")).clicked() || esc {
                    done = Some(false);
                }
            });
        });
    match done {
        None => {
            s.features.audio.mixer.typing = Some(match typing {
                Typing::Volume(st, _) => Typing::Volume(st, text),
                Typing::Pan(id, _) => Typing::Pan(id, text),
            });
        }
        Some(ok) => {
            s.features.audio.mixer.typing = None;
            if ok {
                apply_typed(s, &typing, &text);
            }
        }
    }
}

/// A typed value applied to its strip or knob.
pub fn apply_typed(s: &mut Shell, typing: &Typing, text: &str) {
    let Some(seq) = s.app.sequence().cloned() else { return };
    match typing {
        Typing::Volume(strip, _) => {
            if let Some(v) = typed_db(text) {
                exec(s, fader_command(&seq, *strip, v));
            }
        }
        Typing::Pan(id, _) => {
            if let Some(v) = typed_pan(text) {
                exec(s, Some(C::set_track(seq.id.as_str(), id.as_str(), json!({ "pan": v }))));
            }
        }
    }
}
