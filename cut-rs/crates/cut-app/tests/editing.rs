//! The editing tools, handles and actions without a window (the cases of `verify/cut-edit.mjs`, `cut-timeline.mjs`,
//! `cut-tools.mjs`, `cut-nest.mjs` and `cut-remap.mjs` that the screen decides): a press is turned into what the
//! timeline does with it ([`tools::press`]), each pointer step into the command it applies live, and the result is
//! read back from the project as the JavaScript tests read it (`A1:0-10[0]` is a clip on A1 from 0 to 10 s showing
//! source from 0 s).

use cut_app::edit::source::{self, SourceClip, SourceDrag, SourceItem};
use cut_app::edit::{self, Gap, Patch, dialogs, markers};
use cut_app::state::{App, Tool};
use cut_app::timeline::bands::{self, Extra, Half};
use cut_app::timeline::editing;
use cut_app::timeline::gesture::Mods;
use cut_app::timeline::layout::{self, Layout, RowKind, View};
use cut_app::timeline::tools::{self, At, Live, Pressed};
use cut_model::commands::build as C;
use cut_model::{History, Id, Sequence};
use cut_time::{TICKS, Ticks};
use serde_json::{Value as Json, json};

const S: Ticks = TICKS;
const F: Ticks = TICKS / 30;

/// A clip of the setup: media index, at, length, source in (seconds), tracks.
struct Spec {
    media: usize,
    at: f64,
    len: f64,
    in_: f64,
    video: Option<&'static str>,
    audio: Option<&'static str>,
}

fn clip(media: usize, at: f64, len: f64) -> Spec {
    Spec { media, at, len, in_: 0.0, video: Some("V1"), audio: Some("A1") }
}

fn secs(x: f64) -> Ticks {
    (x * S as f64).round() as Ticks
}

/// `__ed.fresh`: a 30 fps project with two 60 s videos with sound and a still, the clips placed in order.
fn fresh(list: &[Spec]) -> App {
    let mut p = cut_model::defaults::project();
    p.sequences[0].fps = cut_time::Fps { num: 30, den: 1 };
    let mut h = History::new(p, 1000).unwrap();
    let media = json!([
        { "path": "C:\\m\\a.mp4", "name": "a.mp4", "kind": "video", "duration": 60 * S,
          "video": { "w": 640, "h": 360, "fps": [30, 1], "codec": "avc1" }, "audio": { "rate": 48000, "channels": 2 } },
        { "path": "C:\\m\\b.mp4", "name": "b.mp4", "kind": "video", "duration": 60 * S,
          "video": { "w": 640, "h": 360, "fps": [30, 1], "codec": "avc1" }, "audio": { "rate": 48000, "channels": 2 } },
        { "path": "C:\\m\\c.png", "name": "c.png", "kind": "image", "duration": 0, "video": { "w": 64, "h": 48 } },
    ]);
    h.apply(&C::import_media(media, None)).unwrap();
    let ids: Vec<String> = h.project().media.iter().map(|m| m.id.as_str().to_owned()).collect();
    let seq = h.project().sequences[0].id.as_str().to_owned();
    for c in list {
        let opts = json!({
            "source": { "media": ids[c.media] }, "at": secs(c.at), "in": secs(c.in_), "out": secs(c.in_ + c.len),
            "video": c.video, "audio": c.audio, "mode": "overwrite",
        });
        h.apply(&C::place(&seq, opts)).unwrap();
    }
    App::new(h, None)
}

fn two() -> App {
    fresh(&[clip(0, 0.0, 10.0), clip(1, 10.0, 10.0)])
}

fn seq(app: &App) -> &Sequence {
    app.sequence().unwrap()
}

fn n(x: f64) -> String {
    let s = format!("{:.3}", x);
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// `__ed.lay()`: every clip as `track:start-end[in]` in seconds, sorted.
fn lay(app: &App) -> String {
    let mut out: Vec<String> = seq(app)
        .clips()
        .map(|c| {
            let s = |t: f64| n(t / S as f64);
            format!("{}:{}-{}[{}]", c.track.as_str(), s(c.start as f64), s(c.end() as f64), s(c.in_))
        })
        .collect();
    out.sort();
    out.join(" ")
}

fn label(app: &App) -> String {
    app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

fn steps(app: &App) -> usize {
    app.history.position()
}

fn view() -> View {
    View { pps: 100.0, scroll_x: 0.0, scroll_y: 0.0 }
}

fn set_heights(app: &mut App, h: f64) {
    let s = seq(app).id.as_str().to_owned();
    let list = seq(app).tracks.iter().map(|t| C::set_track(&s, t.id.as_str(), json!({ "height": h }))).collect();
    app.history.apply(&C::batch("Track Height", list)).unwrap();
}

/// `__ed.pt(t, track, dy)`: a lane point at time `t` (s) on a track, `dy` of the way down its row.
fn pt(app: &App, t: f64, track: &str, dy: f32) -> (f64, f32) {
    let l = Layout::of(seq(app));
    let r = l.rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == track)).unwrap();
    (t * 100.0, r.y + r.h * dy)
}

/// The point on a clip's keyframe line at time `t` (`__ed.band`).
fn band(app: &App, t: f64, track: &str) -> (f64, f32) {
    let l = Layout::of(seq(app));
    let r = l.rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == track)).unwrap().clone();
    let s = seq(app);
    let c = s.clips().find(|c| c.track.as_str() == track && c.start <= secs(t) && secs(t) < c.end()).unwrap();
    let prop = if r.kind == RowKind::Audio { "volume" } else { "opacity" };
    let (cy, ch) = bands::clip_box(&r, &view());
    let v = bands::value_at(c, prop, (secs(t) - c.start) as f64);
    (t * 100.0, bands::band_y(prop, v, cy, ch))
}

/// What a press at `at` decides, with the panel's hit tests.
fn press(app: &App, tool: Tool, at: (f64, f32), m: Mods) -> Option<Pressed> {
    let s = seq(app);
    let l = Layout::of(s);
    let v = view();
    let hit = layout::hit(&l, &v, at.0, at.1);
    let extra = bands::extra(app.project(), s, &l, &v, &app.edit.band, &hit, at);
    let snaps = |ex: &[Id]| l.snap_points(s, app.t, [app.in_out.in_, app.in_out.out], ex);
    let ctx = At {
        project: app.project(),
        seq: s,
        layout: &l,
        view: &v,
        bands: &app.edit.band,
        hit: &hit,
        extra,
        pos: at,
        frame: F,
    };
    tools::press(&ctx, tool, m, &snaps)
}

/// A drag as the panel runs it: the press, steps to the end point inside one history group, the release.
fn drag(app: &mut App, tool: Tool, from: (f64, f32), to: (f64, f32), m: Mods) -> Option<String> {
    let mut live = match press(app, tool, from, m)? {
        Pressed::Live { live, first, .. } => {
            if let Some(c) = first {
                app.history.begin(live.label);
                app.history.apply(&c).unwrap();
            }
            live
        }
        Pressed::Exec { cmd, .. } => {
            app.exec(&cmd);
            return None;
        }
        Pressed::Transition { live, .. } => live,
        other => panic!("not a drag: {other:?}"),
    };
    let mut open = app.history.revision() > 0 && live.keep_unmoved;
    let mut tip = None;
    let s = seq(app).clone();
    for i in 1..=10 {
        let k = f64::from(i) / 10.0;
        let p = (from.0 + (to.0 - from.0) * k, from.1 + (to.1 - from.1) * k as f32);
        if let Some(c) = live.step(&s, &view(), p, m, true, F) {
            if open {
                app.history.cancel();
            }
            app.history.begin(live.label);
            open = true;
            let r = app.history.apply(&c);
            tip = Some(live.tip(&r, app.sequence()));
        }
    }
    finish(app, &live, open);
    tip
}

fn finish(app: &mut App, live: &Live, open: bool) {
    if open {
        if live.moved || live.keep_unmoved {
            app.history.commit();
        } else {
            app.history.cancel();
        }
    }
}

fn shift() -> Mods {
    Mods { shift: true, ..Mods::default() }
}

#[test]
fn rate_stretch_keeps_the_source_and_changes_the_speed() {
    let mut app = fresh(&[Spec { in_: 2.0, ..clip(0, 0.0, 10.0) }]);
    let before = steps(&app);
    // 4 px inside the end at 100 px/s: within the 7 px edge zone, as cut-edit.mjs's 0.08 s is at its zoom
    let (a, b) = (pt(&app, 10.0 - 0.04, "V1", 0.55), pt(&app, 20.0 - 0.04, "V1", 0.55));
    let tip = drag(&mut app, Tool::Rate, a, b, Mods::default()).unwrap();
    assert_eq!(lay(&app), "A1:0-20[2] V1:0-20[2]", "the end dragged to 20 s, the audio too");
    let sp: Vec<(f64, f64, f64)> = seq(&app).clips().map(|c| (c.speed, c.in_ / S as f64, c.out / S as f64)).collect();
    assert_eq!(sp, [(0.5, 2.0, 12.0), (0.5, 2.0, 12.0)]);
    assert_eq!((steps(&app), label(&app).as_str()), (before + 1, "Rate Stretch"), "one undo step named Rate Stretch");
    assert!(tip.starts_with("Rate Stretch 50%"), "{tip}");
    app.undo();
    let (a, b) = (pt(&app, 0.04, "V1", 0.55), pt(&app, 5.04, "V1", 0.55));
    drag(&mut app, Tool::Rate, a, b, Mods::default());
    assert_eq!(lay(&app), "A1:5-10[2] V1:5-10[2]", "the start dragged to 5 s keeps the end");
    assert!(seq(&app).clips().all(|c| c.speed == 2.0));
    app.undo();
    assert_eq!(lay(&app), "A1:0-10[2] V1:0-10[2]");
    // Alt leaves the linked audio
    let (a, b) = (pt(&app, 10.0 - 0.04, "V1", 0.55), pt(&app, 20.0 - 0.04, "V1", 0.55));
    drag(&mut app, Tool::Rate, a, b, Mods { alt: true, ..Mods::default() });
    assert_eq!(lay(&app), "A1:0-10[2] V1:0-20[2]");
}

#[test]
fn slip_shows_other_source_and_stops_at_its_start() {
    let mut app = fresh(&[Spec { in_: 1.0, audio: None, ..clip(0, 2.0, 3.0) }]);
    let before = steps(&app);
    let (q1, q2) = (pt(&app, 3.5, "V1", 0.55), pt(&app, 4.0, "V1", 0.55));
    let tip = drag(&mut app, Tool::Slip, q1, q2, Mods::default()).unwrap();
    assert_eq!(lay(&app), "V1:2-5[0.5]", "dragging right shows source 0.5 s earlier");
    assert_eq!((steps(&app), label(&app).as_str()), (before + 1, "Slip"));
    assert!(tip.starts_with("Slip +00:00:00:15"), "{tip}");
    app.undo();
    assert_eq!(lay(&app), "V1:2-5[1]");
    let (q1, q2) = (pt(&app, 3.0, "V1", 0.55), pt(&app, 8.0, "V1", 0.55));
    drag(&mut app, Tool::Slip, q1, q2, Mods::default());
    assert_eq!(lay(&app), "V1:2-5[0]", "a slip past the source start stops at its first frame");
}

#[test]
fn slide_moves_the_clip_and_trims_its_neighbours() {
    let three = [
        Spec { audio: None, ..clip(0, 0.0, 5.0) },
        Spec { in_: 20.0, audio: None, ..clip(0, 5.0, 5.0) },
        Spec { in_: 40.0, audio: None, ..clip(0, 10.0, 5.0) },
    ];
    let mut app = fresh(&three);
    let (q1, q2) = (pt(&app, 7.0, "V1", 0.55), pt(&app, 8.0, "V1", 0.55));
    drag(&mut app, Tool::Slide, q1, q2, Mods::default());
    assert_eq!(lay(&app), "V1:0-6[0] V1:11-15[41] V1:6-11[20]");
    assert_eq!(label(&app), "Slide");
    app.undo();
    let (q1, q2) = (pt(&app, 7.0, "V1", 0.55), pt(&app, 5.0, "V1", 0.55));
    drag(&mut app, Tool::Slide, q1, q2, Mods::default());
    assert_eq!(lay(&app), "V1:0-3[0] V1:3-8[20] V1:8-15[38]", "sliding 2 s left lengthens r's head");
    app.undo();
    assert_eq!(lay(&app), "V1:0-5[0] V1:10-15[40] V1:5-10[20]");
}

fn keys(app: &App, track: &str, prop: &str) -> Vec<(i64, f64)> {
    let c = seq(app).clips().find(|c| c.track.as_str() == track).unwrap();
    c.keyframes
        .get(prop)
        .into_iter()
        .flatten()
        .map(|k| (k.t / F, if let cut_model::keyframes::Value::Num(v) = k.v { v } else { f64::NAN }))
        .collect()
}

/// A click: a press and a release where it was.
fn click(app: &mut App, tool: Tool, at: (f64, f32), m: Mods) {
    match press(app, tool, at, m) {
        Some(Pressed::Live { live, first, .. }) => {
            if let Some(c) = &first {
                app.history.begin(live.label);
                app.history.apply(c).unwrap();
            }
            finish(app, &live, first.is_some());
        }
        Some(Pressed::Exec { cmd, .. }) => {
            app.exec(&cmd);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_pen_adds_keyframes_on_the_lines() {
    let mut app = fresh(&[clip(0, 0.0, 10.0)]);
    set_heights(&mut app, 80.0);
    let before = steps(&app);
    let on = band(&app, 3.0, "A1");
    click(&mut app, Tool::Pen, on, Mods::default());
    assert_eq!(keys(&app, "A1", "volume"), [(90, 0.0)], "a click on the volume line: the line's value at that frame");
    assert_eq!(steps(&app), before + 1, "one undo step");
    let mut above = band(&app, 6.0, "A1");
    above.1 -= 6.0;
    click(&mut app, Tool::Pen, above, Mods::default());
    let two = keys(&app, "A1", "volume");
    assert!(
        two.len() == 2 && two[1].0 == 180 && two[1].1 > 0.0,
        "a click above the line adds a louder keyframe {two:?}"
    );
    let (q1,) = (band(&app, 4.0, "V1"),);
    click(&mut app, Tool::Pen, q1, Mods::default());
    assert_eq!(keys(&app, "V1", "opacity"), [(120, 100.0)], "on the video clip, opacity");
    let from = band(&app, 8.0, "A1");
    drag(&mut app, Tool::Pen, from, (from.0 + 100.0, from.1 + 10.0), Mods::default());
    let three = keys(&app, "A1", "volume");
    assert!(
        three.len() == 3 && three[2].0 == 270 && three[2].1 < 0.0,
        "a pen drag places the new key where released {three:?}"
    );
    for _ in 0..4 {
        app.undo();
    }
    assert!(keys(&app, "A1", "volume").is_empty() && keys(&app, "V1", "opacity").is_empty());
}

#[test]
fn the_line_drags_and_ctrl_click_adds_a_keyframe() {
    let mut app = fresh(&[clip(0, 0.0, 10.0)]);
    set_heights(&mut app, 80.0);
    let on = band(&app, 5.0, "V1");
    assert!(matches!(press(&app, Tool::Select, on, Mods::default()), Some(Pressed::Live { .. })));
    drag(&mut app, Tool::Select, on, (on.0, on.1 + 20.0), Mods::default());
    let c = seq(&app).clips().find(|c| c.track.as_str() == "V1").unwrap();
    let cut_model::Props::Video(p) = &c.props else { panic!() };
    assert!(
        p.opacity < 100.0 && c.keyframes.is_empty(),
        "without keyframes the line moves the static opacity {}",
        p.opacity
    );
    assert_eq!(label(&app), "Keyframes");
    let on = band(&app, 2.0, "V1");
    click(&mut app, Tool::Select, on, Mods { ctrl: true, ..Mods::default() });
    assert_eq!(keys(&app, "V1", "opacity").len(), 1, "Ctrl+click on the line adds a keyframe");
    // a keyframe itself is grabbed and moved in time and value
    let at = band(&app, 2.0, "V1");
    let pressed = press(&app, Tool::Select, at, Mods::default());
    assert!(matches!(pressed, Some(Pressed::Live { .. })), "{pressed:?}");
    drag(&mut app, Tool::Select, at, (at.0 + 50.0, at.1 - 10.0), Mods::default());
    let k = keys(&app, "V1", "opacity");
    assert_eq!(k[0].0, 75, "the keyframe moved half a second {k:?}");
}

#[test]
fn audio_fades_drag_from_their_handles() {
    let mut app = fresh(&[clip(0, 0.0, 10.0)]);
    set_heights(&mut app, 80.0);
    let l = Layout::of(seq(&app));
    let r = l.rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == "A1")).unwrap().clone();
    let y = r.y + 1.0 + 15.0 + 2.0;
    let hit = layout::hit(&l, &view(), 1.0, y);
    let ex = bands::extra(app.project(), seq(&app), &l, &view(), &app.edit.band, &hit, (1.0, y));
    assert!(matches!(ex, Some(Extra::Fade { out: false, .. })), "the fade-in handle over the start edge {ex:?}");
    let tip = drag(&mut app, Tool::Select, (1.0, y), (101.0, y), Mods::default()).unwrap();
    let c = seq(&app).clips().find(|c| c.track.as_str() == "A1").unwrap();
    assert_eq!(c.fade_in, S, "dragged one second in");
    assert!(tip.contains("00:00:01:00"), "{tip}");
    assert_eq!(label(&app), "Fade");
    let v = seq(&app).clips().find(|c| c.track.as_str() == "V1").unwrap();
    assert_eq!(v.fade_in, 0, "only the audio clip (linked: false)");
}

#[test]
fn the_tools_leave_locked_tracks_alone() {
    let mut app = two();
    let s = seq(&app).id.as_str().to_owned();
    app.history.apply(&C::set_track(&s, "A1", json!({ "locked": true }))).unwrap();
    let before = lay(&app);
    let (q1, q2) = (pt(&app, 5.0, "V1", 0.55), pt(&app, 6.0, "V1", 0.55));
    let tip = drag(&mut app, Tool::Slip, q1, q2, Mods::default());
    assert_eq!(lay(&app), before, "a slip whose linked audio is locked changes nothing ({tip:?})");
    let (q1, q2) = (pt(&app, 5.0, "V1", 0.55), pt(&app, 4.0, "V1", 0.55));
    drag(&mut app, Tool::Slip, q1, q2, Mods { alt: true, ..Mods::default() });
    assert_ne!(lay(&app), before, "Alt slips the video alone");
}

#[test]
fn transitions_are_grabbed_over_the_clips_and_change_length() {
    // the incoming clip starts 5 s into its media, so it has frames before its In to dissolve with
    let mut app = fresh(&[clip(0, 0.0, 10.0), Spec { in_: 5.0, ..clip(1, 10.0, 10.0) }]);
    let s = seq(&app).id.as_str().to_owned();
    app.history
        .apply(&C::add_transition(
            &s,
            json!({ "track": "V1", "at": 10 * S, "type": "dissolve", "align": "center", "duration": S }),
        ))
        .unwrap();
    let l = Layout::of(seq(&app));
    let r = l.rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == "V1")).unwrap().clone();
    let y = r.y + r.h - 6.0;
    let hit = layout::hit(&l, &view(), 1000.0, y);
    let ex = bands::extra(app.project(), seq(&app), &l, &view(), &app.edit.band, &hit, (1000.0, y));
    assert!(matches!(ex, Some(Extra::Transition { part: bands::TPart::Body, .. })), "{ex:?}");
    assert!(matches!(
        press(&app, Tool::Select, (1000.0, y), Mods::default()),
        Some(Pressed::Transition { live: Live { kind: tools::LiveKind::TransitionAlign { .. }, .. }, .. })
    ));
    // the end handle at 10.5 s, dragged right half a second: centred, so it grows twice that
    drag(&mut app, Tool::Select, (1049.0, y), (1099.0, y), Mods::default());
    assert_eq!(seq(&app).transitions[0].duration, 2 * S);
    assert_eq!(label(&app), "Transition Settings");
    let t = &seq(&app).transitions[0];
    assert!(
        !bands::short(app.project(), seq(&app), t, F),
        "the outgoing clip has 50 s after its Out, the incoming 5 s before its In"
    );
    // a clip at the media's very end has no tail to dissolve with
    let mut tight = fresh(&[clip(0, 0.0, 60.0), Spec { in_: 0.0, ..clip(1, 60.0, 10.0) }]);
    let s = seq(&tight).id.as_str().to_owned();
    tight
        .history
        .apply(&C::add_transition(
            &s,
            json!({ "track": "V1", "at": 60 * S, "type": "dissolve", "align": "center", "duration": S }),
        ))
        .unwrap();
    let t = seq(&tight).transitions[0].clone();
    assert!(bands::short(tight.project(), seq(&tight), &t, F), "the frames run out on both sides: striped");
}

#[test]
fn remap_keys_split_move_and_refuse() {
    let mut app = fresh(&[Spec { audio: None, ..clip(0, 0.0, 10.0) }]);
    set_heights(&mut app, 80.0);
    let c = seq(&app).clips().next().unwrap().clone();
    let s = seq(&app).id.as_str().to_owned();
    app.edit.band.insert(c.id, edit::Band::Remap);
    // Ctrl+click on the speed line adds a key
    let l = Layout::of(seq(&app));
    let r = l.rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == "V1")).unwrap().clone();
    let (cy, ch) = bands::clip_box(&r, &view());
    let y = bands::remap_y(100.0, cy, ch);
    let ctrl = Mods { ctrl: true, ..Mods::default() };
    assert!(matches!(press(&app, Tool::Select, (500.0, y), ctrl), Some(Pressed::Exec { .. })));
    click(&mut app, Tool::Select, (500.0, y), ctrl);
    assert_eq!(seq(&app).clips().next().unwrap().remap.as_ref().map(|r| r.keys.len()), Some(1), "a key at 5 s");
    // dragging the line after the key up: that segment plays faster, the clip gets shorter
    drag(&mut app, Tool::Select, (800.0, y), (800.0, bands::remap_y(200.0, cy, ch)), Mods::default());
    let now = seq(&app).clips().next().unwrap().clone();
    let r2 = now.remap.clone().unwrap();
    assert_eq!(r2.speeds.len(), 2);
    assert!((r2.speeds[1] - 2.0).abs() < 0.05, "{:?}", r2.speeds);
    assert!(now.duration() < 10 * S && now.duration() > 7 * S, "{}", now.duration());
    assert_eq!(label(&app), "Time Remapping");
    // the tab of the key moves it; a half splits it into a speed transition
    let g = bands::remap_keys(&view(), &now, cy, ch)[0];
    let tab = (f64::from(g.mid), cy + 16.0);
    let hit = layout::hit(&l, &view(), tab.0, tab.1);
    let ex = bands::extra(app.project(), seq(&app), &l, &view(), &app.edit.band, &hit, tab);
    assert!(matches!(ex, Some(Extra::RemapKey { half: Half::Tab, index: 0, .. })), "{ex:?}");
    let right = (f64::from(g.kb) + 3.0, g.yb);
    drag(&mut app, Tool::Select, right, (right.0 + 30.0, right.1), Mods::default());
    let k = seq(&app).clips().next().unwrap().remap.clone().unwrap().keys[0];
    assert!(k.ramp > 0, "the right half split the key into a transition {k:?}");
    // Ctrl-drag of a split key is refused with the JavaScript's message
    let g = bands::remap_keys(&view(), seq(&app).clips().next().unwrap(), cy, ch)[0];
    let pressed = press(&app, Tool::Select, (f64::from(g.mid), cy + 16.0), ctrl);
    assert!(matches!(pressed, Some(Pressed::Refuse { why: "Join the speed transition first.", .. })), "{pressed:?}");
    let _ = s;
}

#[test]
fn a_still_has_no_speed_line() {
    let mut app = fresh(&[Spec { audio: None, ..clip(2, 0.0, 5.0) }]);
    let c = seq(&app).clips().next().unwrap().clone();
    app.edit.band.insert(c.id, edit::Band::Remap);
    assert_eq!(
        bands::line_of(app.project(), &c, cut_model::TrackKind::Video, &app.edit.band),
        bands::Line::Prop("opacity")
    );
}

#[test]
fn ruler_markers_drag_and_click() {
    let mut app = two();
    let s = seq(&app).id.as_str().to_owned();
    app.history.apply(&C::add_marker(&s, json!({ "t": 5 * S, "duration": 2 * S }), json!({}))).unwrap();
    let v = view();
    let (m, end) = tools::marker_hit(seq(&app), &v, 501.0, 15.0).unwrap();
    assert!(!end, "the flag");
    let (_, end) = tools::marker_hit(seq(&app), &v, 702.0, 15.0).unwrap();
    assert!(end, "the range's end handle");
    assert!(tools::marker_hit(seq(&app), &v, 501.0, 5.0).is_none(), "above the marker row");
    let mut d = tools::MarkerDrag::new(m, false, &[], 500.0);
    d.step(&v, 501.0, true, F);
    assert!(!d.moved, "under the slop");
    assert_eq!(d.finish(seq(&app)).unwrap_err(), 5 * S, "a click puts the playhead on the marker");
    d.step(&v, 650.0, true, F);
    let c = d.finish(seq(&app)).unwrap().unwrap();
    app.exec(&c);
    assert_eq!((seq(&app).markers[0].t, seq(&app).markers[0].duration), (secs(6.5), 2 * S), "moved, the range kept");
    let m = seq(&app).markers[0].clone();
    let mut e = tools::MarkerDrag::new(&m, true, &[], 850.0);
    e.step(&v, 600.0, false, F);
    assert_eq!(e.duration, F, "the end never goes before the start");
}

#[test]
fn targets_and_patch_follow_the_track_headers() {
    let app = two();
    let s = seq(&app);
    let all = edit::targeted(s, None);
    assert_eq!(all.len(), s.tracks.len());
    let t = edit::toggle_target(s, None, Id::new("A1")).unwrap();
    assert!(!t.contains(&Id::new("A1")) && t.len() == s.tracks.len() - 1);
    assert_eq!(edit::toggle_target(s, Some(&t), Id::new("A1")), None, "every track again: no list");
    assert_eq!(edit::patch_for(s, &[Patch::First, Patch::First]), (Some(Id::new("V1")), Some(Id::new("A1"))));
    let p = edit::toggle_patch(s, &[Patch::First, Patch::First], Id::new("V2"));
    assert_eq!(edit::patch_for(s, &p).0, Some(Id::new("V2")));
    let off = edit::toggle_patch(s, &p, Id::new("V2"));
    assert_eq!(edit::patch_for(s, &off).0, None, "a click on the patched track turns the patch off");
    assert_eq!(edit::patch_for(s, &[Patch::Track(Id::new("gone")), Patch::Off]), (Some(Id::new("V1")), None));
}

#[test]
fn gaps_are_the_empty_stretches_before_a_clip() {
    let app = fresh(&[clip(0, 0.0, 5.0), clip(1, 8.0, 2.0)]);
    let s = seq(&app);
    assert_eq!(edit::gap_at(s, Id::new("V1"), 6 * S), Some(Gap { track: Id::new("V1"), a: 5 * S, b: 8 * S, t: 6 * S }));
    assert_eq!(edit::gap_at(s, Id::new("V1"), 2 * S), None, "on a clip");
    assert_eq!(edit::gap_at(s, Id::new("V1"), 20 * S), None, "after the last clip");
}

fn source_of(app: &App, media: usize, in_: Option<f64>, out: Option<f64>) -> SourceClip {
    let id = app.project().media[media].id;
    SourceClip { item: SourceItem::Media(id), in_: in_.map(secs), out: out.map(secs), t: 0 }
}

#[test]
fn insert_and_overwrite_place_the_source_on_the_patched_tracks() {
    let mut app = two();
    let src = source_of(&app, 1, Some(1.0), Some(3.0));
    let c =
        source::place_command(app.project(), seq(&app), &src, &app.edit.patch, (None, None), 5 * S, "insert").unwrap();
    let r = app.exec(&c).unwrap();
    assert_eq!(
        lay(&app),
        "A1:0-5[0] A1:12-22[0] A1:5-7[1] A1:7-12[5] V1:0-5[0] V1:12-22[0] V1:5-7[1] V1:7-12[5]",
        "source 1-3 s inserted at 5 s"
    );
    assert_eq!((r["at"].as_i64(), r["duration"].as_i64()), (Some(5 * S), Some(2 * S)));
    app.undo();
    // three-point edit: a sequence Out alone backtimes the source In to Out so it ends there
    let src = source_of(&app, 1, Some(1.0), Some(3.0));
    let c = source::place_command(app.project(), seq(&app), &src, &app.edit.patch, (None, Some(6 * S)), 0, "overwrite")
        .unwrap();
    app.exec(&c).unwrap();
    assert_eq!(lay(&app), "A1:0-4[0] A1:10-20[0] A1:4-6[1] A1:6-10[6] V1:0-4[0] V1:10-20[0] V1:4-6[1] V1:6-10[6]");
    app.undo();
    // the source monitor always sends its Out (the media's end when none is marked, as ui-monitors.js `place`), so
    // with a source In the sequence In decides where and the sequence Out is not used
    let src = source_of(&app, 1, Some(1.0), None);
    let c = source::place_command(
        app.project(),
        seq(&app),
        &src,
        &app.edit.patch,
        (Some(2 * S), Some(4 * S)),
        0,
        "overwrite",
    )
    .unwrap();
    assert_eq!((c["opts"]["in"].as_i64(), c["opts"]["out"].as_i64()), (Some(S), Some(60 * S)));
    app.exec(&c).unwrap();
    assert_eq!(lay(&app), "A1:0-2[0] A1:2-61[1] V1:0-2[0] V1:2-61[1]");
    app.undo();
    // the patch: video off places the sound alone; both off is refused with the JavaScript's message
    let patch = [Patch::Off, Patch::First];
    let src = source_of(&app, 1, Some(0.0), Some(1.0));
    let c = source::place_command(app.project(), seq(&app), &src, &patch, (None, None), 30 * S, "overwrite").unwrap();
    app.exec(&c).unwrap();
    assert!(lay(&app).contains("A1:30-31[0]") && !lay(&app).contains("V1:30"));
    let none =
        source::place_command(app.project(), seq(&app), &src, &[Patch::Off, Patch::Off], (None, None), 0, "overwrite");
    assert_eq!(none.unwrap_err(), "Choose a target track.");
    // a still has no sound: only the video patch counts
    let still = source_of(&app, 2, None, None);
    let c = source::place_command(
        app.project(),
        seq(&app),
        &still,
        &[Patch::First, Patch::First],
        (None, None),
        40 * S,
        "overwrite",
    )
    .unwrap();
    assert!(c["opts"]["audio"].is_null() && c["opts"]["out"] == json!(5 * S), "{c}");
}

#[test]
fn source_drags_drop_on_the_row_under_the_pointer() {
    let app = two();
    let id = app.project().media[1].id;
    let d = SourceDrag { item: SourceItem::Media(id), in_: 0, out: Some(2 * S), video: true, audio: false };
    let c = editing::drop_command(
        app.project(),
        seq(&app),
        &d,
        Some((RowKind::Video, 1, Some(Id::new("V2")))),
        &app.edit.patch,
        3 * S,
        "overwrite",
    )
    .unwrap();
    let opts = &c["commands"][0]["opts"];
    assert_eq!((opts["video"].as_str(), opts["audio"].as_str()), (Some("V2"), None), "video only, on V2");
    let both = SourceDrag { audio: true, ..d };
    let c = editing::drop_command(
        app.project(),
        seq(&app),
        &both,
        Some((RowKind::Audio, 1, Some(Id::new("A2")))),
        &app.edit.patch,
        0,
        "insert",
    )
    .unwrap();
    let opts = &c["commands"][0]["opts"];
    assert_eq!(
        (opts["video"].as_str(), opts["audio"].as_str(), c["label"].as_str()),
        (Some("V2"), Some("A2"), Some("Insert"))
    );
    let s = seq(&app).id;
    let own = SourceDrag { item: SourceItem::Sequence(s), in_: 0, out: None, video: true, audio: true };
    assert_eq!(
        editing::drop_command(app.project(), seq(&app), &own, None, &app.edit.patch, 0, "overwrite").unwrap_err(),
        "A sequence cannot be nested inside itself."
    );
}

#[test]
fn the_source_monitor_marks_and_steps() {
    let app = two();
    let id = app.project().media[0].id;
    let mut m = source::SourceMonitor::default();
    m.open(SourceClip::media(id));
    let p = app.project();
    assert!(m.run(p, "frameForward5"));
    assert_eq!(m.clip.unwrap().t, 5 * F);
    m.run(p, "markIn");
    m.run(p, "frameForward");
    m.run(p, "markOut");
    let c = m.clip.unwrap();
    assert_eq!((c.in_, c.out), (Some(5 * F), Some(7 * F)), "Out is the frame after the playhead");
    m.run(p, "frameBack5");
    m.run(p, "markOut");
    assert_eq!((m.clip.unwrap().in_, m.clip.unwrap().out), (None, Some(2 * F)), "an Out before the In clears the In");
    m.run(p, "goEnd");
    assert_eq!(m.clip.unwrap().t, 60 * S);
    m.run(p, "playPause");
    assert!(m.playing(), "play at the end starts over");
    assert_eq!(m.clip.unwrap().t, 0);
    m.run(p, "shuttleStop");
    assert!(!m.playing());
    m.run(p, "shuttleBack");
    assert!(!m.playing(), "J at the start does not play backwards");
    m.run(p, "shuttleForward");
    m.run(p, "shuttleForward");
    assert_eq!(m.rate(), 2.0, "L twice: double speed");
    assert!(!m.run(p, "lift"), "the source monitor has no Lift");
    assert_eq!(source::rate_of(&p.media[0]), cut_time::Fps { num: 30, den: 1 });
}

#[test]
fn the_source_project_holds_the_file_at_its_size() {
    let app = two();
    let m = &app.project().media[0];
    let (p, seq) = source::media_project(app.project(), m).unwrap();
    let s = p.sequence(seq).unwrap();
    assert_eq!((s.w, s.h, s.clip_count()), (640, 360, 2), "picture and sound of the file");
}

#[test]
fn speed_duration_patches_only_what_changed() {
    let app = fresh(&[clip(0, 0.0, 10.0)]);
    let s = seq(&app);
    let ids: Vec<Id> = s.clips().filter(|c| c.track.as_str() == "V1").map(|c| c.id).collect();
    assert!(dialogs::speed_patches(s, &ids, 100.0, Some(10 * S), false, true, false).is_empty(), "nothing changed");
    let p = dialogs::speed_patches(s, &ids, 50.0, Some(10 * S), false, true, false);
    assert_eq!(p[0].1, json!({ "ripple": true, "speed": 0.5 }));
    let p = dialogs::speed_patches(s, &ids, 100.0, Some(5 * S), true, false, false);
    assert_eq!(p[0].1, json!({ "ripple": false, "duration": 5 * S, "reverse": true }));
    let p = dialogs::speed_patches(s, &ids, 50.0, Some(5 * S), true, true, true);
    assert_eq!(p[0].1, json!({ "ripple": true, "duration": 5 * S }), "a still has no speed or reverse");
}

#[test]
fn the_markers_list_and_filter() {
    let mut app = two();
    let s = seq(&app).id.as_str().to_owned();
    app.history
        .apply(&C::add_marker(&s, json!({ "t": 4 * S, "name": "Intro", "color": "red", "kind": "chapter" }), json!({})))
        .unwrap();
    app.history.apply(&C::add_marker(&s, json!({ "t": S, "note": "check the sound" }), json!({}))).unwrap();
    let c = seq(&app).clips().find(|c| c.track.as_str() == "V1" && c.start == 10 * S).unwrap().id;
    app.history.apply(&C::add_marker(&s, json!({}), json!({ "clipId": c.as_str() }))).unwrap();
    let rows = markers::markers_of(seq(&app));
    let times: Vec<Ticks> = rows.iter().map(|r| r.t).collect();
    assert_eq!(times, [S, 4 * S, 10 * S], "in time order, the clip marker at its sequence time");
    assert_eq!(rows[2].name, "b.mp4", "a clip marker without a name is named after its clip");
    let mut v = markers::MarkersView::default();
    assert_eq!(rows.iter().filter(|r| v.shows(&r.marker)).count(), 3);
    v.search = "SOUND".into();
    assert_eq!(rows.iter().filter(|r| v.shows(&r.marker)).count(), 1, "the search reads the comment, any case");
    v.search.clear();
    v.kind = Some(cut_model::MarkerKind::Chapter);
    assert_eq!(rows.iter().filter(|r| v.shows(&r.marker)).count(), 1);
    v.kind = None;
    v.color = Some("red");
    assert_eq!(
        rows.iter().filter(|r| v.shows(&r.marker)).map(|r| r.marker.name.as_str()).collect::<Vec<_>>(),
        ["Intro"]
    );
}

#[test]
fn nest_names_take_the_first_free_number() {
    let mut app = two();
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    assert_eq!(dialogs::free_nest_name(app.project()), "Nested Sequence 1");
    app.history.apply(&C::add_sequence(json!({ "name": "Nested Sequence 1" }))).unwrap();
    assert_eq!(dialogs::free_nest_name(app.project()), "Nested Sequence 2");
}

#[test]
fn double_click_on_a_nest_opens_its_sequence_at_the_frame_shown() {
    let mut app = two();
    let s = seq(&app).id.as_str().to_owned();
    let ids: Vec<String> = seq(&app).clips().filter(|c| c.start == 10 * S).map(|c| c.id.as_str().to_owned()).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let r = app.exec(&C::nest(&s, &refs, json!({ "name": "N", "linked": true }))).unwrap();
    let nest = seq(&app).clip(Id::new(r["ids"][0].as_str().unwrap())).unwrap().clone();
    app.set_time(13 * S);
    let outer = seq(&app).clone();
    editing::open_nest(&mut app, &outer, &nest);
    assert_eq!(seq(&app).name, "N");
    assert_eq!(app.t, 13 * S - nest.start + nest.in_ as Ticks, "the inner sequence at the frame the playhead showed");
    assert!(app.edit.tabs.contains(&outer.id), "the outer sequence stays as a tab");
}

#[test]
fn the_label_and_speed_menus_build_one_step() {
    let mut app = two();
    let ids: Vec<Id> = seq(&app).clips().map(|c| c.id).collect();
    app.select(ids, false, false);
    let s = seq(&app).clone();
    let before = steps(&app);
    editing::set_speed(&mut app, &s, json!({ "speed": 2.0 }));
    assert_eq!(steps(&app), before + 1);
    assert_eq!(
        lay(&app),
        "A1:0-5[0] A1:5-10[0] V1:0-5[0] V1:5-10[0]",
        "a linked pair changes once, later clips move along"
    );
    let s = seq(&app).clone();
    editing::set_sampling(&mut app, &s, "blend");
    assert!(seq(&app).clips().filter(|c| c.track.as_str() == "V1").all(|c| c.sampling == cut_model::Sampling::Blend));
    assert_eq!(label(&app), "Time Interpolation");
}

#[test]
fn reveal_in_source_takes_the_clips_in_and_out() {
    let mut app = fresh(&[Spec { in_: 1.0, audio: None, ..clip(0, 2.0, 3.0) }]);
    let c = seq(&app).clips().next().unwrap().clone();
    editing::reveal_in_source(&mut app, &c);
    let s = app.edit.source.clip.unwrap();
    assert_eq!((s.in_, s.out, s.t), (Some(S), Some(4 * S), S));
    app.set_time(3 * S);
    let m = cut_app::edit::actions::match_clip(&app).unwrap();
    assert_eq!(m.source_time(app.t as f64), 2.0 * S as f64, "Match Frame: source 2 s");
}

#[test]
fn pressing_with_a_tool_that_has_no_handle_here_is_left_to_the_plain_gestures() {
    let app = two();
    for tool in [Tool::Hand, Tool::Zoom, Tool::Razor, Tool::TrackForward, Tool::Text] {
        assert!(press(&app, tool, pt(&app, 5.0, "V1", 0.55), Mods::default()).is_none(), "{tool:?}");
    }
    // the plain body of a clip with the Selection tool is a move, not a tool drag
    assert!(press(&app, Tool::Select, pt(&app, 5.0, "V1", 0.2), Mods::default()).is_none());
    // the Rate tool on a body moves the clip as the Selection tool does
    assert!(press(&app, Tool::Rate, pt(&app, 5.0, "V1", 0.2), shift()).is_none());
    let _: Option<Json> = None;
}

fn shell(app: App) -> (cut_app::shell::Shell, eframe::egui::Context) {
    let base = std::env::var_os("CUT_TEST_TMP").map_or_else(std::env::temp_dir, std::path::PathBuf::from);
    let dir =
        base.join(format!("cut-edit-{}-{:?}", std::process::id(), std::thread::current().id()).replace(['(', ')'], ""));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = cut_app::shell::Shell::new(cut_app::files::Home::at(dir));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.app = app;
    s.app.focus = Some(cut_app::state::Panel::Timeline);
    (s, eframe::egui::Context::default())
}

const START: &str = "A1:0-10[0] A1:10-20[0] V1:0-10[0] V1:10-20[0]";

#[test]
fn lift_and_extract_take_the_in_to_out_off_the_targeted_tracks() {
    let (mut s, ctx) = shell(two());
    s.app.set_in_out(Some(Some(2 * S)), Some(Some(5 * S)));
    let before = steps(&s.app);
    s.run_action("lift", &ctx);
    assert_eq!(lay(&s.app), "A1:0-2[0] A1:10-20[0] A1:5-10[5] V1:0-2[0] V1:10-20[0] V1:5-10[5]", "; leaves a gap");
    assert_eq!((steps(&s.app), label(&s.app).as_str()), (before + 1, "Lift"));
    assert_eq!(
        (s.app.t, s.app.in_out.in_, s.app.in_out.out),
        (2 * S, None, None),
        "the playhead at the In, In/Out cleared"
    );
    s.run_action("undo", &ctx);
    assert_eq!(lay(&s.app), START);
    s.app.set_in_out(Some(Some(2 * S)), Some(Some(5 * S)));
    s.run_action("extract", &ctx);
    assert_eq!(lay(&s.app), "A1:0-2[0] A1:2-7[5] A1:7-17[0] V1:0-2[0] V1:2-7[5] V1:7-17[0]", "' closes the gap");
    assert_eq!(label(&s.app), "Extract");
    s.run_action("undo", &ctx);
    // only V1 targeted: lift leaves A1 alone, extract still pulls the sync-locked A1 along
    let q = seq(&s.app).clone();
    let mut t = None;
    for id in ["A1", "V2", "A2"] {
        t = edit::toggle_target(&q, t.as_deref(), Id::new(id));
    }
    assert_eq!(t, Some(vec![Id::new("V1")]));
    s.app.edit.targets = t;
    s.app.set_in_out(Some(Some(2 * S)), Some(Some(5 * S)));
    s.run_action("lift", &ctx);
    assert_eq!(lay(&s.app), "A1:0-10[0] A1:10-20[0] V1:0-2[0] V1:10-20[0] V1:5-10[5]");
    s.run_action("undo", &ctx);
    s.app.set_in_out(Some(Some(2 * S)), Some(Some(5 * S)));
    s.run_action("extract", &ctx);
    assert_eq!(
        lay(&s.app),
        "A1:0-2[0] A1:2-7[5] A1:7-17[0] V1:0-2[0] V1:2-7[5] V1:7-17[0]",
        "extract keeps the sync-locked A1 in step"
    );
    s.run_action("undo", &ctx);
    s.app.edit.targets = None;
    // nothing marked: disabled, and no step
    let before = steps(&s.app);
    assert!(!s.action_enabled("lift"));
    s.run_action("lift", &ctx);
    assert_eq!((steps(&s.app), lay(&s.app).as_str()), (before, START));
    // one point is enough: the Out alone lifts from the start
    s.app.set_in_out(None, Some(Some(5 * S)));
    s.run_action("lift", &ctx);
    assert!(lay(&s.app).starts_with("A1:10-20[0] A1:5-10[5]"), "{}", lay(&s.app));
}

#[test]
fn extend_edit_rolls_or_trims_to_the_playhead() {
    let (mut s, ctx) = shell(two());
    s.app.set_time(12 * S);
    let before = steps(&s.app);
    s.run_action("extendEdit", &ctx);
    assert_eq!(lay(&s.app), "A1:0-12[0] A1:12-20[2] V1:0-12[0] V1:12-20[2]", "E rolls the nearest edit point");
    assert_eq!((steps(&s.app), label(&s.app).as_str()), (before + 1, "Extend Edit"));
    s.run_action("undo", &ctx);
    let c2: Vec<Id> = seq(&s.app).clips().filter(|c| c.start == 10 * S).map(|c| c.id).collect();
    s.app.select(c2, false, false);
    s.app.set_time(18 * S);
    s.run_action("extendEdit", &ctx);
    assert_eq!(
        lay(&s.app),
        "A1:0-10[0] A1:10-18[0] V1:0-10[0] V1:10-18[0]",
        "with c2 selected its end trims to the playhead"
    );
}

#[test]
fn select_at_playhead_and_split_use_the_targets() {
    let (mut s, ctx) =
        shell(fresh(&[clip(0, 0.0, 10.0), Spec { audio: None, video: Some("V2"), ..clip(1, 4.0, 3.0) }]));
    s.app.set_time(5 * S);
    s.run_action("selectAtPlayhead", &ctx);
    assert_eq!(s.app.selection.len(), 3, "D: every track");
    s.app.edit.targets = Some(vec![Id::new("V2")]);
    s.run_action("selectAtPlayhead", &ctx);
    let only: Vec<&str> = s.app.selected().iter().map(|id| seq(&s.app).clip(*id).unwrap().track.as_str()).collect();
    assert_eq!(only, ["V2"]);
    s.app.set_time(8 * S);
    s.run_action("selectAtPlayhead", &ctx);
    assert!(s.app.selection.is_empty(), "the targeted track is empty there");
    s.app.selection.clear();
    s.app.set_time(5 * S);
    s.app.edit.targets = Some(vec![Id::new("V1"), Id::new("A1")]);
    s.run_action("split", &ctx);
    assert_eq!(
        lay(&s.app),
        "A1:0-5[0] A1:5-10[5] V1:0-5[0] V1:5-10[5] V2:4-7[0]",
        "Ctrl+K cuts the targeted tracks only"
    );
    s.app.edit.targets = None;
    s.run_action("undo", &ctx);
    s.app.set_time(2 * S);
    s.run_action("rippleEnd", &ctx);
    s.app.set_time(8 * S);
    s.run_action("undo", &ctx);
    s.run_action("rippleStart", &ctx);
    assert_eq!(s.app.t, 7 * S, "Q: the playhead goes to the previous edit on the targeted tracks, V2's end");
    assert_eq!(lay(&s.app), "A1:0-7[0] A1:7-9[8] V1:0-7[0] V1:7-9[8] V2:4-7[0]", "7 s to 8 s taken out");
}

#[test]
fn default_transitions_go_on_the_selection_or_the_nearest_edit() {
    let (mut s, ctx) = shell(two());
    s.app.set_time(9 * S);
    s.run_action("transitionVideo", &ctx);
    let t = &seq(&s.app).transitions;
    assert_eq!(t.len(), 1, "{:?}", s.app.notices);
    assert_eq!(
        (t[0].track.as_str(), t[0].at, t[0].kind.as_str(), t[0].align),
        ("V1", 10 * S, "dissolve", cut_model::Align::Center)
    );
    assert_eq!(label(&s.app), "Add Transition");
    s.run_action("undo", &ctx);
    let c1: Vec<Id> = seq(&s.app).clips().filter(|c| c.start == 0).map(|c| c.id).collect();
    s.app.select(c1, false, false);
    s.run_action("transitionBoth", &ctx);
    let mut got: Vec<(String, Ticks, cut_model::Align)> =
        seq(&s.app).transitions.iter().map(|t| (t.track.as_str().to_owned(), t.at, t.align)).collect();
    got.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    use cut_model::Align::{Center, Start};
    assert_eq!(
        got,
        [
            ("A1".into(), 0, Start),
            ("A1".into(), 10 * S, Center),
            ("V1".into(), 0, Start),
            ("V1".into(), 10 * S, Center)
        ]
    );
    assert!(seq(&s.app).transitions.iter().filter(|t| t.track.as_str() == "A1").all(|t| t.kind == "crossfade.power"));
    // Delete takes the selected transition first
    let id = seq(&s.app).transitions[0].id;
    s.app.edit.transition = Some(id);
    s.run_action("delete", &ctx);
    assert_eq!(seq(&s.app).transitions.len(), 3);
    assert_eq!(seq(&s.app).clip_count(), 4, "the clips stay");
    // nothing under the playhead on an empty sequence: a message
    let (mut e, ctx) = shell(fresh(&[]));
    e.run_action("transitionVideo", &ctx);
    assert!(e.app.notices.iter().any(|n| n.text == "There is no edit point here."));
}

#[test]
fn delete_closes_a_picked_gap() {
    let (mut s, ctx) = shell(fresh(&[clip(0, 0.0, 5.0), clip(1, 8.0, 2.0)]));
    s.app.edit.gap = edit::gap_at(seq(&s.app), Id::new("V1"), 6 * S);
    s.run_action("delete", &ctx);
    assert!(lay(&s.app).contains("V1:5-7[0]"), "{}", lay(&s.app));
}

#[test]
fn match_frame_opens_the_source_at_the_frame() {
    let (mut s, ctx) = shell(fresh(&[Spec { in_: 1.0, audio: None, ..clip(0, 2.0, 3.0) }]));
    s.app.set_time(3 * S);
    s.run_action("matchFrame", &ctx);
    let src = s.app.edit.source.clip.unwrap();
    assert_eq!((src.in_, src.out, src.t), (Some(S), Some(4 * S), 2 * S), "F: In/Out of the clip, the source at 2 s");
    assert_eq!(s.app.focus, Some(cut_app::state::Panel::Source), "the source monitor has the keyboard");
    // its keys now go to the source monitor
    s.run_action("frameForward", &ctx);
    assert_eq!(s.app.edit.source.clip.unwrap().t, 2 * S + F);
    assert_eq!(s.app.t, 3 * S, "the program's playhead stays");
    s.app.set_time(30 * S);
    s.app.focus = Some(cut_app::state::Panel::Timeline);
    s.run_action("matchFrame", &ctx);
    assert!(s.app.notices.iter().any(|n| n.text == "There is no source clip under the playhead."));
}

#[test]
fn insert_from_the_source_monitor_clears_in_out_and_moves_the_playhead() {
    let (mut s, ctx) = shell(two());
    assert!(!s.action_enabled("insert"), "nothing in the source monitor");
    let id = s.app.project().media[1].id;
    s.app.edit.source.open(SourceClip { item: SourceItem::Media(id), in_: Some(0), out: Some(2 * S), t: 0 });
    s.app.set_time(5 * S);
    s.run_action("insert", &ctx);
    // the 640x360 clip does not match the 1920x1080 sequence with clips: asked once, the settings kept
    assert_eq!(s.app.edit.mismatch.open.as_ref().map(|a| a.clip.as_str()), Some("640x360 30 fps"));
    cut_app::edit::mismatch::answer(&mut s.app, false);
    assert_eq!(lay(&s.app), "A1:0-5[0] A1:12-22[0] A1:5-7[0] A1:7-12[5] V1:0-5[0] V1:12-22[0] V1:5-7[0] V1:7-12[5]");
    assert_eq!(s.app.t, 7 * S, "the playhead after what was placed");
    assert_eq!(s.app.selection.len(), 2, "the new clips are selected");
    s.app.set_in_out(Some(Some(30 * S)), None);
    s.run_action("overwrite", &ctx);
    assert!(lay(&s.app).contains("V1:30-32[0]") && s.app.in_out.in_.is_none());
}

#[test]
fn the_markers_panel_takes_delete_and_m() {
    let (mut s, ctx) = shell(two());
    s.app.focus = Some(cut_app::state::Panel::Markers);
    s.app.set_time(3 * S);
    s.run_action("addMarker", &ctx);
    s.app.set_time(6 * S);
    s.run_action("addMarker", &ctx);
    assert_eq!(seq(&s.app).markers.len(), 2);
    let second = seq(&s.app).markers.iter().find(|m| m.t == 6 * S).unwrap().id;
    assert_eq!(s.app.edit.markers.selected, Some(second), "M selects the new marker");
    s.run_action("prevEdit", &ctx);
    assert_eq!(s.app.t, 3 * S, "Up walks the list and moves the playhead");
    s.run_action("delete", &ctx);
    assert_eq!(seq(&s.app).markers.len(), 1);
    assert_eq!(seq(&s.app).clip_count(), 4, "Delete in the markers panel never removes clips");
}

#[test]
fn speed_and_nest_open_their_dialogs_or_say_why_not() {
    let (mut s, ctx) = shell(two());
    assert!(!s.action_enabled("speed") && !s.action_enabled("nest"));
    let ids: Vec<Id> = seq(&s.app).clips().filter(|c| c.start == 0).map(|c| c.id).collect();
    s.app.select(ids, false, false);
    s.run_action("speed", &ctx);
    assert!(matches!(s.app.edit.dialog, Some(dialogs::EditDialog::Speed { ref speed, .. }) if speed == "100"));
    s.app.edit.dialog = None;
    s.run_action("nest", &ctx);
    assert!(
        matches!(s.app.edit.dialog, Some(dialogs::EditDialog::Nest { ref name, .. }) if name == "Nested Sequence 1")
    );
}

#[test]
fn a_new_sequence_from_a_clip_has_its_size_and_holds_it() {
    let mut app = two();
    let m = app.project().media[0].id;
    let c = cut_app::edit::menus::sequence_from_clip_command(app.project(), m).unwrap();
    let r = app.exec(&c).unwrap();
    let id = Id::new(r["results"][0]["id"].as_str().unwrap());
    let q = app.project().sequence(id).unwrap();
    assert_eq!((q.name.as_str(), q.w, q.h, q.clip_count()), ("a", 640, 360, 2));
    assert_eq!(label(&app), "New Sequence");
}

#[test]
fn the_extra_hit_test_stays_in_microseconds_with_many_clips() {
    // three frames each: a clip is at least a frame long
    let specs: Vec<Spec> = (0..2000).map(|i| Spec { audio: None, ..clip(0, f64::from(i) * 0.1, 0.1) }).collect();
    let mut app = fresh(&specs);
    set_heights(&mut app, 80.0);
    let s = seq(&app);
    let l = Layout::of(s);
    let v = View { pps: 5000.0, scroll_x: 5000.0 * 20.0, scroll_y: 0.0 };
    let y = pt(&app, 0.0, "V1", 0.6).1;
    let t0 = std::time::Instant::now();
    let mut found = 0;
    for i in 0..1000 {
        let x = f64::from(i);
        let hit = layout::hit(&l, &v, x, y);
        found += usize::from(
            bands::extra(app.project(), s, &l, &v, &app.edit.band, &hit, (x, y)).is_some() || hit.clip.is_some(),
        );
    }
    let per = t0.elapsed().as_secs_f64() / 1000.0;
    println!("hit + extra: {:.2} us per pointer position over 2000 clips", per * 1e6);
    assert!(found > 0);
    assert!(per < 100e-6, "{per:e} s");
}
