//! Essential Sound (`ui-audiofx.js`'s panel): the selected clips' audio type (the clip role Auto Ducking reads) and
//! one-click actions that add effects with settings for speech (`audiofx.ESSENTIAL`), or open the loudness matches.
//! Isolate Voice runs [`crate::voice::isolate`].

use cut_model::commands::build as C;
use cut_model::{Clip, Id, Role, TrackKind};
use eframe::egui::{self, Button, RichText, Vec2};
use serde_json::{Value as Json, json};

use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::state::App;

/// An Essential Sound action: the effects it adds, with the settings that differ from the defaults.
pub fn preset(name: &str) -> Vec<(&'static str, Json)> {
    match name {
        "clarity" => vec![
            (
                "audio.eq",
                json!({ "hpOn": true, "hpFreq": 80, "hpSlope": "24", "b1Freq": 250, "b1Gain": -2, "b1Q": 1, "b2Freq": 3000,
                        "b2Gain": 3, "b2Q": 1, "hsFreq": 10000, "hsGain": 1.5 }),
            ),
            (
                "audio.compressor",
                json!({ "threshold": -24, "ratio": 3, "attack": 5, "release": 120, "knee": 6, "makeup": 4 }),
            ),
        ],
        "hum50" => vec![("audio.dehum", json!({ "frequency": "50" }))],
        "hum60" => vec![("audio.dehum", json!({ "frequency": "60" }))],
        "gate" => {
            vec![("audio.gate", json!({ "threshold": -50, "attack": 2, "hold": 80, "release": 150, "range": 18 }))]
        }
        "limit" => vec![("audio.limiter", json!({ "ceiling": -1, "release": 50, "truePeak": true }))],
        _ => Vec::new(),
    }
}

/// The roles in the panel's order, with their names.
pub const ROLES: [(Role, &str); 4] = [
    (Role::Dialogue, "Dialogue"),
    (Role::Music, "Music"),
    (Role::Effects, "Sound Effects"),
    (Role::Ambience, "Ambience"),
];

fn role_code(r: Role) -> &'static str {
    match r {
        Role::Dialogue => "dialogue",
        Role::Music => "music",
        Role::Effects => "effects",
        Role::Ambience => "ambience",
    }
}

/// The clips with sound the automation works on (`ui.auto.soundClips`): the selected ones and the audio linked to
/// selected video; with `all` and nothing selected, every one of the sequence. Disabled clips and clips on locked
/// tracks are left out; in time order.
pub fn sound_clips(app: &App, all: bool) -> Vec<Id> {
    let Some(seq) = app.sequence() else { return Vec::new() };
    let p = app.project();
    let with_sound = |c: &Clip| {
        seq.kind_of(c.track) == Some(TrackKind::Audio)
            && !c.is_freeze()
            && c.media_id().and_then(|m| p.media(m)).is_some_and(|m| m.audio.is_some())
    };
    let mut set: Vec<&Clip> = Vec::new();
    let picked: Vec<&Clip> = app.selected_clips();
    for c in &picked {
        if with_sound(c) && !set.iter().any(|x| x.id == c.id) {
            set.push(c);
        }
        for l in seq.linked_clips(c) {
            if with_sound(l) && !set.iter().any(|x| x.id == l.id) {
                set.push(l);
            }
        }
    }
    if picked.is_empty() && all {
        set.extend(seq.clips_in_order().filter(|c| with_sound(c)));
    }
    let mut out: Vec<&Clip> =
        set.into_iter().filter(|c| c.enabled && !seq.track(c.track).is_some_and(|t| t.locked)).collect();
    out.sort_by_key(|c| c.start);
    out.into_iter().map(|c| c.id).collect()
}

/// The effects of `preset` added to every clip the panel works on, one undo step named `label`.
pub fn add_effects(app: &mut App, name: &str, label: &str) -> bool {
    let clips = sound_clips(app, false);
    let Some(seq) = app.sequence_id.filter(|_| !clips.is_empty()) else {
        app.toast(tr("Select audio clips first."));
        return false;
    };
    let mut cmds = Vec::new();
    for c in &clips {
        for (kind, params) in preset(name) {
            cmds.push(C::add_effect(seq.as_str(), c.as_str(), kind, None, params));
        }
    }
    app.exec(&C::batch(label, cmds)).is_some()
}

/// The selected clips' role set to `role`, or taken off (`setRole`).
pub fn set_role(app: &mut App, role: Option<Role>) -> bool {
    let Some(seq) = app.sequence() else { return false };
    let ids: Vec<String> =
        app.selection.iter().filter(|id| seq.clip(**id).is_some()).map(|id| id.as_str().to_owned()).collect();
    if ids.is_empty() {
        return false;
    }
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let cmd = C::set_role(seq.id.as_str(), &refs, role.map(role_code), json!({}));
    app.exec(&cmd).is_some()
}

/// A button as the JavaScript's `.cut-btn`: framed, the full width, pressed in the accent.
fn button<'a>(s: &Shell, label: &str, pressed: bool, w: f32) -> Button<'a> {
    let p = &s.palette;
    let (fill, stroke) =
        if pressed { (p.accent.lerp_to_gamma(p.gray[3], 0.7), p.accent) } else { (p.gray[3], p.gray[5]) };
    Button::new(tr(label)).fill(fill).stroke(egui::Stroke::new(1.0, stroke)).min_size(Vec2::new(w, 22.0))
}

fn action(ui: &mut egui::Ui, s: &Shell, label: &str, on: bool) -> bool {
    ui.add_enabled(on, button(s, label, false, ui.available_width())).clicked()
}

fn title(ui: &mut egui::Ui, s: &Shell, text: &str) {
    ui.add_space(4.0);
    ui.label(RichText::new(tr(text)).strong().size(11.5).color(s.palette.gray[10]));
    ui.separator();
}

/// The Essential Sound panel.
pub fn panel(s: &mut Shell, ui: &mut egui::Ui) {
    let clips = sound_clips(&s.app, false);
    let roles: Vec<Option<Role>> = {
        let seq = s.app.sequence();
        clips.iter().map(|id| seq.and_then(|q| q.clip(*id)).and_then(|c| c.role)).collect()
    };
    let some = !clips.is_empty();
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.add_space(4.0);
            ui.vertical(|ui| {
                ui.set_width(ui.available_width() - 6.0);
                let head = if some {
                    trf("Selected audio clips: {n}", &[("n", &clips.len().to_string())])
                } else {
                    tr("Select audio clips in the timeline.").into_owned()
                };
                ui.label(RichText::new(head).size(11.0).color(s.palette.gray[9]));
                title(ui, s, "Audio Type");
                let w = (ui.available_width() - 4.0) / 2.0;
                egui::Grid::new("cut-es-roles").num_columns(2).spacing([4.0, 4.0]).show(ui, |ui| {
                    for (i, (role, name)) in ROLES.iter().enumerate() {
                        let pressed = some && roles.iter().all(|r| *r == Some(*role));
                        let b = button(s, name, pressed, w);
                        if ui.add_enabled(some, b).clicked() {
                            let next = if roles.iter().all(|r| *r == Some(*role)) { None } else { Some(*role) };
                            set_role(&mut s.app, next);
                        }
                        if i % 2 == 1 {
                            ui.end_row();
                        }
                    }
                });
                title(ui, s, "Dialogue");
                for (label, name, undo) in [
                    ("Clarity (EQ and Compressor)", "clarity", "Clarity"),
                    ("Reduce Hum (50 Hz)", "hum50", "Reduce Hum"),
                    ("Reduce Hum (60 Hz)", "hum60", "Reduce Hum"),
                    ("Noise Gate", "gate", "Noise Gate"),
                ] {
                    if action(ui, s, label, some) {
                        add_effects(&mut s.app, name, undo);
                    }
                }
                if action(ui, s, "Isolate Voice", some) {
                    crate::voice::isolate(s);
                }
                title(ui, s, "Music");
                if action(ui, s, "Auto Ducking…", true) {
                    let ctx = ui.ctx().clone();
                    s.run_action("auto.duck", &ctx);
                }
                title(ui, s, "Loudness");
                if action(ui, s, "Match Clip Loudness…", some) {
                    super::loudness::open_clips(s);
                }
                if action(ui, s, "Match Loudness…", true) {
                    super::loudness::open_sequence(s);
                }
                if action(ui, s, "Hard Limiter (-1 dB)", some) {
                    add_effects(&mut s.app, "limit", "Hard Limiter");
                }
                ui.add_space(6.0);
                ui.label(
                    RichText::new(tr("Auto Ducking lowers the clips marked Music under the ones marked Dialogue."))
                        .size(11.0)
                        .color(s.palette.gray[8]),
                );
            });
        });
    });
}
