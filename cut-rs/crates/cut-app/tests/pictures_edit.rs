//! Pictures of the editing features drawn off screen, to look at: `CUT_PICTURES=<folder> cargo test -p cut-app --test
//! pictures_edit -- --ignored`. The timeline with transitions (one short of frames), a volume line with keyframes,
//! fades, a Speed line with a key, a picked gap, a grouped clip, a locked track, the source patch and targets, two
//! sequence tabs; the Source monitor with a clip and its In/Out; the Markers panel; the Speed/Duration and marker
//! dialogs.

use std::path::{Path, PathBuf};

use cut_app::edit::dialogs::EditDialog;
use cut_app::edit::source::{SourceClip, SourceItem};
use cut_app::edit::{self, Band, Patch};
use cut_app::files::Home;
use cut_app::i18n::{self, Lang};
use cut_app::shell::{LowerTab, Shell};
use cut_app::{cmd, import};
use cut_model::Id;
use cut_model::commands::build as C;
use eframe::egui;
use serde_json::json;

fn fixture(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../verify/fixtures").join(rel)
}

fn shell(dir: &Path) -> Shell {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).unwrap();
    let mut s = Shell::new(Home::at(dir));
    s.dialog = None;
    let media: Vec<_> = ["viewers/video/clip.mp4", "viewers/audio/tone.wav"]
        .iter()
        .map(|f| import::probe_file(&fixture(f)).result.unwrap())
        .collect();
    let r = s.app.exec(&cmd::import_media(media, None)).unwrap();
    let ids: Vec<Id> = r["ids"].as_array().unwrap().iter().map(|v| Id::new(v.as_str().unwrap())).collect();
    let seq = s.app.sequence_id.unwrap();
    let sid = seq.as_str().to_owned();
    let t = cut_time::TICKS;
    for i in 0..3 {
        s.app.exec(&cmd::place(seq, ids[0], Some(Id::new("V1")), Some(Id::new("A1")), i * 2 * t, "overwrite")).unwrap();
    }
    s.app.exec(&cmd::place(seq, ids[0], Some(Id::new("V2")), None, 8 * t, "overwrite")).unwrap();
    s.app.exec(&cmd::place(seq, ids[1], None, Some(Id::new("A2")), t, "overwrite")).unwrap();
    let heights: Vec<_> = s
        .app
        .sequence()
        .unwrap()
        .tracks
        .iter()
        .map(|tr| C::set_track(&sid, tr.id.as_str(), json!({ "height": 72 })))
        .collect();
    s.app.exec(&C::batch("Track Height", heights)).unwrap();
    for at in [2 * t, 4 * t] {
        s.app
            .exec(&C::add_transition(&sid, json!({ "track": "V1", "at": at, "type": "dissolve", "align": "center" })))
            .unwrap();
    }
    s.app
        .exec(&C::add_transition(
            &sid,
            json!({ "track": "A1", "at": 2 * t, "type": "crossfade.power", "align": "center" }),
        ))
        .unwrap();
    let q = s.app.sequence().unwrap().clone();
    let a1 = q.clips().find(|c| c.track.as_str() == "A1" && c.start == 2 * t).unwrap().id;
    let kf = json!([{ "t": 0, "v": 0.0, "ease": "linear" }, { "t": t, "v": -12.0, "ease": "linear" }, { "t": 3 * t / 2, "v": 3.0, "ease": "linear" }]);
    s.app.exec(&C::set_keyframes(&sid, a1.as_str(), "volume", Some(kf))).unwrap();
    let a2 = q.clips().find(|c| c.track.as_str() == "A2").unwrap().id;
    s.app.exec(&C::set_clip(&sid, a2.as_str(), json!({ "fadeIn": t / 2, "fadeOut": t / 3 }), json!({}))).unwrap();
    let v2 = q.clips().find(|c| c.track.as_str() == "V2").unwrap().clone();
    let remap = cut_model::remap::add_key(&v2.remap_of(), v2.duration() / 2).unwrap();
    let remap = cut_model::remap::set_segment_speed(&remap, 1, 2.0, t / 30);
    s.app.exec(&C::set_remap(&sid, v2.id.as_str(), Some(json!(remap)))).unwrap();
    s.app.edit.band.insert(v2.id, Band::Remap);
    let v1: Vec<String> =
        q.clips().filter(|c| c.track.as_str() == "V1" && c.start == 4 * t).map(|c| c.id.as_str().to_owned()).collect();
    let v1b: Vec<String> =
        q.clips().filter(|c| c.track.as_str() == "V1" && c.start == 0).map(|c| c.id.as_str().to_owned()).collect();
    let both: Vec<&str> = v1.iter().chain(&v1b).map(String::as_str).collect();
    s.app.exec(&C::group(&sid, &both)).unwrap();
    s.app.exec(&C::set_track(&sid, "A2", json!({ "locked": true }))).unwrap();
    s.app
        .exec(&C::add_marker(&sid, json!({ "t": 5 * t, "name": "Chorus", "color": "red", "duration": t }), json!({})))
        .unwrap();
    s.app
        .exec(&C::add_marker(&sid, json!({ "t": 7 * t, "name": "Beat", "kind": "beat", "color": "blue" }), json!({})))
        .unwrap();
    let other = s.app.exec(&C::add_sequence(json!({ "name": "B-roll" }))).unwrap()["id"].as_str().unwrap().to_owned();
    s.app.edit.tabs = vec![Id::new(&other)];
    s.app.edit.targets = Some(q.tracks.iter().map(|tr| tr.id).filter(|id| id.as_str() != "A2").collect());
    s.app.edit.patch = [Patch::Track(Id::new("V2")), Patch::First];
    s.app.edit.gap = edit::gap_at(s.app.sequence().unwrap(), Id::new("V2"), 7 * t);
    s.app.set_time(3 * t + t / 2);
    s.app.edit.source.open(SourceClip { item: SourceItem::Media(ids[0]), in_: Some(t / 2), out: Some(3 * t / 2), t });
    s.app.edit.source.picked = None;
    s.lower_tab = LowerTab::Markers;
    s
}

/// What a picture changes on the shell before it is drawn.
type Setup = fn(&mut Shell);

#[test]
#[ignore = "writes pictures to look at"]
fn pictures_of_the_editing_features() {
    let Some(out) = std::env::var_os("CUT_PICTURES").map(PathBuf::from) else { return };
    std::fs::create_dir_all(&out).unwrap();
    for (lang, theme) in [(Lang::En, cut_app::theme::ThemeKind::Dark), (Lang::Ko, cut_app::theme::ThemeKind::Light)] {
        let shots: [(&str, Setup); 3] = [
            ("timeline", |_| {}),
            ("speed", |s| s.app.edit.dialog = EditDialog::speed(&s.app).ok()),
            ("marker", |s| {
                let id = s.app.sequence().unwrap().markers[0].id;
                s.app.edit.dialog = EditDialog::marker(&s.app, id);
            }),
        ];
        for (name, setup) in shots {
            let mut s = shell(&out.join(format!("edit-home-{}-{name}", lang.code())));
            // after the shell, which sets the language of its settings
            i18n::set_lang(lang);
            s.palette = cut_app::theme::Palette::of(theme);
            let first = s
                .app
                .sequence()
                .unwrap()
                .clips()
                .find(|c| c.track.as_str() == "V1" && c.start == 2 * cut_time::TICKS)
                .unwrap()
                .id;
            s.app.select([first], false, false);
            setup(&mut s);
            let mut harness = egui_kittest::Harness::builder()
                .with_size(egui::Vec2::new(1440.0, 900.0))
                .wgpu()
                .build_ui(move |ui| s.frame(ui));
            harness.run_steps(6);
            let img = harness.render().expect("a picture");
            img.save(out.join(format!("edit-{name}-{}.png", lang.code()))).unwrap();
        }
    }
}
