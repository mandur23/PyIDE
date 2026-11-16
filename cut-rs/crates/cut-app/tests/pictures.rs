//! Pictures of the window drawn off screen (wgpu through egui_kittest), to look at: `CUT_PICTURES=<folder> cargo test
//! -p cut-app --test pictures -- --ignored`. Dark and light, at 1280x800 and 1024x720, with a project of a few
//! tracks and clips, a selection, a marker and In/Out.

use std::path::{Path, PathBuf};

use cut_app::files::Home;
use cut_app::i18n::{self, Lang};
use cut_app::shell::Shell;
use cut_app::theme::ThemeKind;
use cut_app::{cmd, import};
use cut_model::Id;
use eframe::egui;

fn fixture(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../verify/fixtures").join(rel)
}

fn shell(dir: &Path) -> Shell {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).unwrap();
    let mut s = Shell::new(Home::at(dir));
    let media: Vec<_> = ["viewers/video/clip.mp4", "viewers/audio/tone.wav", "viewers/images/sample.png"]
        .iter()
        .map(|f| import::probe_file(&fixture(f)).result.unwrap())
        .collect();
    let r = s.app.exec(&cmd::import_media(media, None)).unwrap();
    let ids: Vec<Id> = r["ids"].as_array().unwrap().iter().map(|v| Id::new(v.as_str().unwrap())).collect();
    let seq = s.app.sequence_id.unwrap();
    let t = cut_time::TICKS;
    for i in 0..4 {
        s.app.exec(&cmd::place(seq, ids[0], Some(Id::new("V1")), Some(Id::new("A1")), i * 2 * t, "overwrite")).unwrap();
    }
    s.app.exec(&cmd::place(seq, ids[2], Some(Id::new("V2")), None, t, "overwrite")).unwrap();
    s.app.exec(&cmd::place(seq, ids[1], None, Some(Id::new("A2")), 3 * t, "overwrite")).unwrap();
    s.app.exec(&cmd::add_marker(seq, 5 * t, None)).unwrap();
    s.app.exec(&cmd::add_bin("Footage", None)).unwrap();
    let first = s.app.sequence().unwrap().clips_in_order().next().unwrap().id;
    s.app.select([first], false, false);
    s.app.set_time(3 * t + t / 2);
    s.app.set_in_out(Some(Some(2 * t)), Some(Some(6 * t)));
    s
}

#[test]
#[ignore = "writes pictures to look at"]
fn pictures_of_the_window() {
    let Some(out) = std::env::var_os("CUT_PICTURES").map(PathBuf::from) else { return };
    std::fs::create_dir_all(&out).unwrap();
    for (lang, theme) in [(Lang::Ko, ThemeKind::Dark), (Lang::En, ThemeKind::Light)] {
        for (w, h) in [(1280.0, 800.0), (1024.0, 720.0)] {
            let mut s = shell(&out.join(format!("home-{}-{w}", theme.code())));
            i18n::set_lang(lang);
            s.palette = cut_app::theme::Palette::of(theme);
            let mut harness = egui_kittest::Harness::builder()
                .with_size(egui::Vec2::new(w, h))
                .wgpu()
                .build_ui(move |ui| s.frame(ui));
            harness.run_steps(4);
            let img = harness.render().expect("a picture");
            let file = out.join(format!("{}-{}-{w}x{h}.png", theme.code(), lang.code()));
            img.save(&file).unwrap();
            if lang == Lang::En && w > 1100.0 {
                use egui_kittest::kittest::Queryable;
                harness.query_all_by_label("Sequence").next().expect("the Sequence menu").click();
                harness.run_steps(3);
                harness.render().expect("a picture").save(out.join("light-en-menu.png")).unwrap();
            }
        }
    }
}
