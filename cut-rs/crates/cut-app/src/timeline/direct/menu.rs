//! The clip menu's items for editing a clip in place: Audio Role and Automation (`ui-auto.js`'s `clipMenuItems`),
//! and the native app's own Replace With Clip > From Source Monitor, Replace Image… and Reveal in Project.
//!
//! A replacement keeps the clip where it is with its length, effects, keyframes, masks, speed and settings: the
//! clip (and the clips linked to it that the new media can fill) is taken out and a copy of it showing the new media
//! is pasted in its place, one undo step. From the Source Monitor the copy starts at the source's In (its playhead
//! when it has none); an image replaces only stills and keeps their In and Out.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, channel};

use cut_model::commands::build as C;
use cut_model::{Clip, Id, MediaKind, Sequence, TrackKind};
use eframe::egui::{self, Button};
use serde_json::{Value as Json, json};

use super::{Ask, Direct};
use crate::audio::essential;
use crate::edit::source::SourceItem;
use crate::i18n::tr;
use crate::import::Probed;
use crate::shell::Shell;
use crate::state::App;

/// The top bar's Automation items in their order (`ITEMS`), with the actions the native app has.
const AUTOMATION: [&[(&str, Option<&str>)]; 5] = [
    &[
        ("Remove Silence…", Some("auto.silence")),
        ("Detect Scene Changes…", Some("auto.scenes")),
        ("Detect Beats…", Some("auto.beats")),
    ],
    &[
        ("Auto Captions…", Some("auto.captions")),
        ("Remove Filler Words…", Some("auto.fillers")),
        ("Label Speakers", Some("auto.speakers")),
        ("Next Uncertain Word", Some("auto.nextUncertain")),
        ("Previous Uncertain Word", Some("auto.prevUncertain")),
    ],
    &[
        ("Polish Captions with Claude…", Some("auto.aiPolish")),
        ("Translate Captions with Claude…", Some("auto.aiTranslate")),
        ("YouTube Title, Description and Chapters…", Some("auto.aiMetadata")),
        ("Highlights to Shorts…", Some("auto.aiHighlights")),
        ("Edit Command…", Some("auto.aiCommand")),
        ("AI Assistant", Some("auto.aiAssistant")),
    ],
    &[
        ("Match Loudness…", Some("auto.loudness")),
        ("Match Clip Loudness…", Some("auto.clipLoudness")),
        ("Auto Ducking…", Some("auto.duck")),
        ("Isolate Voice", Some("auto.isolateVoice")),
    ],
    &[("Auto Color", Some("auto.color"))],
];

/// A file dialog of Replace Image running on its own thread: the clip, and the file read once picked.
pub struct Picking {
    clip: Id,
    rx: Receiver<Option<Probed>>,
}

/// Replace With Clip, Replace Image… and Reveal in Project, after Reveal in Source Monitor. -> whether one was chosen.
pub fn replace_items(ui: &mut egui::Ui, app: &mut App, c: &Clip, d: &mut Direct) -> bool {
    let mut chose = false;
    let media = c.media_id().is_some() && !c.is_freeze();
    let from_source = matches!(app.edit.source.clip.as_ref().map(|x| x.item), Some(SourceItem::Media(_)));
    ui.add_enabled_ui(media, |ui| {
        ui.menu_button(tr("Replace With Clip"), |ui| {
            if ui.add_enabled(from_source, Button::new(tr("From Source Monitor"))).clicked() {
                replace_from_source(app, c.id);
                chose = true;
            }
        });
    });
    let still = c.media_id().and_then(|m| app.project().media(m)).is_some_and(|m| m.kind == MediaKind::Image);
    if ui.add_enabled(still, Button::new(tr("Replace Image…"))).clicked() {
        d.asks.push(Ask::ReplaceImage(c.id));
        chose = true;
    }
    let nest = match c.source {
        cut_model::Source::Nest { sequence, .. } => Some(sequence),
        _ => None,
    };
    let item = c.media_id().or(nest);
    if ui.add_enabled(item.is_some(), Button::new(tr("Reveal in Project"))).clicked()
        && let Some(id) = item
    {
        d.asks.push(Ask::Reveal(id));
        chose = true;
    }
    chose
}

/// The JavaScript's part of the clip menu (`clipMenuItems`): the selected clips' audio role, and the Automation menu.
pub fn auto_items(ui: &mut egui::Ui, app: &mut App, seq: &Sequence, c: &Clip, d: &Direct) -> bool {
    let mut chose = false;
    let audio = seq.kind_of(c.track) == Some(TrackKind::Audio)
        || seq.linked_clips(c).iter().any(|l| seq.kind_of(l.track) == Some(TrackKind::Audio));
    ui.add_enabled_ui(audio, |ui| {
        ui.menu_button(tr("Audio Role"), |ui| {
            if super::super::editing::check(ui, "None", c.role.is_none()) {
                essential::set_role(app, None);
                chose = true;
            }
            for (role, name) in essential::ROLES {
                if super::super::editing::check(ui, name, c.role == Some(role)) {
                    essential::set_role(app, Some(role));
                    chose = true;
                }
            }
        });
    });
    ui.menu_button(tr("Automation"), |ui| {
        for (i, group) in AUTOMATION.iter().enumerate() {
            if i > 0 {
                ui.separator();
            }
            for (label, id) in *group {
                let on = id.is_some_and(|id| d.marks.auto.get(id).copied().unwrap_or(false));
                let mut b = ui.add_enabled(on, Button::new(tr(label)));
                if id.is_none() {
                    b = b.on_disabled_hover_text(tr("Not available yet"));
                }
                if b.clicked()
                    && let Some(id) = id
                {
                    app.edit.request(id);
                    chose = true;
                }
            }
        }
    });
    chose
}

/// The clips a replacement by `media` takes: `clip` and what it links to, each of a kind the media has.
fn targets(app: &App, seq: &Sequence, clip: Id, media: Id) -> Vec<Clip> {
    let p = app.project();
    let (Some(c), Some(m)) = (seq.clip(clip), p.media(media)) else { return Vec::new() };
    let has = |k: TrackKind| match k {
        TrackKind::Video => m.kind == MediaKind::Image || m.video.is_some(),
        TrackKind::Audio => m.audio.is_some(),
    };
    let mut out = vec![c.clone()];
    out.extend(seq.linked_clips(c).into_iter().cloned());
    out.retain(|x| x.media_id().is_some() && !x.is_freeze() && seq.kind_of(x.track).is_some_and(has));
    out
}

/// The command that puts `media` in the place of `clips` from source time `in_` (`None`: each keeps its In and Out),
/// or why not.
pub fn replace_command(
    app: &App,
    seq: &Sequence,
    clips: &[Clip],
    media: Id,
    in_: Option<f64>,
) -> Result<Json, &'static str> {
    let p = app.project();
    let m = p.media(media).ok_or("The file could not be read.")?;
    let mut copies = Vec::new();
    for c in clips {
        let kind = seq.kind_of(c.track).ok_or("There is no track there.")?;
        let index = seq.tracks.iter().filter(|t| t.kind == kind).position(|t| t.id == c.track).unwrap_or(0);
        let mut v = serde_json::to_value(c).map_err(|_| "The file could not be read.")?;
        v["source"]["media"] = json!(media.as_str());
        if let Some(a) = in_.filter(|_| m.kind != MediaKind::Image) {
            let b = a + (c.out - c.in_);
            if b > m.duration + 0.5 {
                return Err("The source is shorter than the clip.");
            }
            v["in"] = json!(a);
            v["out"] = json!(b);
        }
        let old = c.media_id().and_then(|o| p.media(o)).map(|o| o.name.as_str());
        if c.name.is_empty() || Some(c.name.as_str()) == old {
            v["name"] = json!(m.name);
        }
        v["kind"] = json!(if kind == TrackKind::Video { "video" } else { "audio" });
        v["trackIndex"] = json!(index);
        copies.push(v);
    }
    let at = clips.iter().map(|c| c.start).min().ok_or("Select a clip first.")?;
    let ids: Vec<Id> = clips.iter().map(|c| c.id).collect();
    Ok(C::batch(
        &tr("Replace"),
        vec![crate::cmd::remove(seq.id, &ids, false, false), crate::cmd::paste(seq.id, copies, at, None, None, false)],
    ))
}

/// Runs a replacement inside the open undo step and selects the new clips -> whether it was done.
fn apply_replace(app: &mut App, clip: Id, media: Id, in_: Option<f64>) -> bool {
    let Some(seq) = app.sequence().cloned() else { return false };
    let list = targets(app, &seq, clip, media);
    if list.is_empty() {
        app.toast(tr("Select a clip first."));
        return false;
    }
    match replace_command(app, &seq, &list, media, in_) {
        Ok(cmd) => match app.history.apply(&cmd) {
            Ok(r) => {
                let ids = r["results"][1]["ids"].as_array().into_iter().flatten().filter_map(Json::as_str).map(Id::new);
                app.select(ids.collect::<Vec<_>>(), false, false);
                true
            }
            Err(e) => {
                app.report(tr(&e.message).into_owned());
                false
            }
        },
        Err(why) => {
            app.toast(tr(why));
            false
        }
    }
}

/// Replace With Clip > From Source Monitor: the media open there, from its In (else its playhead), one step.
pub fn replace_from_source(app: &mut App, clip: Id) {
    let Some(src) = app.edit.source.clip else {
        app.toast(tr("Open a clip in the Source Monitor first."));
        return;
    };
    let SourceItem::Media(media) = src.item else {
        app.toast(tr("Open a clip in the Source Monitor first."));
        return;
    };
    let from = src.in_.unwrap_or(src.t) as f64;
    app.history.begin(&tr("Replace"));
    apply_replace(app, clip, media, Some(from));
    app.history.commit();
}

/// Replace Image…: a file dialog on a thread of its own (`CUT_DIALOG`'s `pickImage` answers it in tests); the file is
/// read there too.
pub fn ask_image(s: &mut Shell, clip: Id, ctx: &egui::Context) {
    let (tx, rx) = channel();
    let answer = Shell::dialog_override("pickImage");
    let title = tr("Replace Image…").into_owned();
    let images = tr("Media files").into_owned();
    let wake = ctx.clone();
    std::thread::spawn(move || {
        let picked: Option<PathBuf> = match answer {
            Some(a) => a.and_then(|v| v.into_iter().next()),
            None => rfd::FileDialog::new().set_title(&title).add_filter(&images, &crate::import::IMAGE_EXT).pick_file(),
        };
        let _ = tx.send(picked.map(|p| crate::import::probe_file(&p)));
        wake.request_repaint();
    });
    s.timeline.direct.picking = Some(Picking { clip, rx });
}

/// The picked image, once read: imported unless the project has it, and put in the clip's place, one step.
pub fn poll(s: &mut Shell, ctx: &egui::Context) {
    let Some(p) = &s.timeline.direct.picking else { return };
    let Ok(got) = p.rx.try_recv() else {
        ctx.request_repaint_after(std::time::Duration::from_millis(100));
        return;
    };
    let clip = p.clip;
    s.timeline.direct.picking = None;
    let Some(got) = got else { return };
    let entry = match got.result {
        Ok(e) if e["kind"] == "image" => e,
        Ok(_) => {
            s.app.toast(tr("Choose an image file."));
            return;
        }
        Err(r) => {
            s.app.report(tr(crate::import::refusal_text(&r)).into_owned());
            return;
        }
    };
    let path = got.path.to_string_lossy().into_owned();
    s.app.history.begin(&tr("Replace"));
    let known = s.app.project().media.iter().find(|m| m.path.eq_ignore_ascii_case(&path)).map(|m| m.id);
    let media = known.or_else(|| {
        let bin = s.project.current_bin();
        let r = s.app.history.apply(&crate::cmd::import_media(vec![entry], bin)).ok()?;
        r["ids"][0].as_str().map(Id::new)
    });
    if !media.is_some_and(|m| apply_replace(&mut s.app, clip, m, None)) {
        s.app.history.cancel();
        return;
    }
    s.app.history.commit();
}
