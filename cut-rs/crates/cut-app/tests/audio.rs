//! The Audio workspace's screens (the cases of `verify/cut-mixer.mjs` and the meters part of `cut-panels.mjs`): the
//! meters' ballistics and the mixer's fader scale against `ui-meters.js` and `ui-mixer.js` run by the oracle; the mixer
//! driven with the pointer as a person would (a fader drag is one undo step, Alt+click, the pan knob, mute, solo, the
//! master), and what each change does to the mix rendered offline; Essential Sound's effects and roles; Match Clip
//! Loudness and Match Loudness reaching their targets.

#[path = "media/mod.rs"]
mod media;

use std::time::{Duration, Instant};

use cut_app::audio::meters::{self, Ballistics, Heard};
use cut_app::audio::{essential, loudness, mixer};
use cut_app::files::Home;
use cut_app::shell::Shell;
use cut_app::state::App;
use cut_model::{Id, TrackKind};
use cut_oracle::Inputs;
use cut_time::TICKS;
use eframe::egui::{self, Event, Modifiers, PointerButton, Pos2};
use egui_kittest::Harness;
use serde_json::{Value, json};

const Q: f64 = f64::NEG_INFINITY;

fn db(v: &Value) -> f64 {
    v.as_f64().unwrap_or(Q)
}

fn pair(v: &Value) -> [f64; 2] {
    [db(&v[0]), db(&v[1])]
}

fn level(r: &mut Inputs) -> Value {
    match r.range(0, 9) {
        0 => Value::Null,
        1 => json!(r.range(0, 60) as f64 / 10.0),
        _ => json!(-(r.range(0, 900) as f64) / 10.0),
    }
}

/// Random frames: steps of 0 to 300 ms (sometimes 2 s), play and stop, levels from silence to +6 dBFS, resets.
fn frames(seed: u64, n: usize) -> Vec<Value> {
    let mut r = Inputs::new(seed);
    let mut now = 1000.0;
    let mut playing = true;
    let mut out = vec![json!({ "wake": true, "playing": true })];
    for _ in 0..n {
        match r.range(0, 39) {
            0 => out.push(json!({ "reset": true })),
            1 => {
                playing = !playing;
                out.push(json!({ "wake": true, "playing": playing }));
            }
            _ => {
                now += if r.range(0, 19) == 0 { 2000.0 } else { r.range(0, 300) as f64 };
                let heard = playing && r.range(0, 5) > 0;
                let mut f = json!({ "now": now, "playing": playing });
                if heard {
                    f["peak"] = json!([level(&mut r), level(&mut r)]);
                    f["rms"] = json!([level(&mut r), level(&mut r)]);
                    f["track"] = json!([level(&mut r), level(&mut r)]);
                }
                out.push(f);
            }
        }
    }
    out
}

fn heard(f: &Value, key: &str) -> Option<Heard> {
    let playing = f["playing"].as_bool().unwrap_or(false);
    (playing && !f[key].is_null())
        .then(|| Heard { peak: pair(&f[key]), rms: if key == "peak" { pair(&f["rms"]) } else { [Q, Q] } })
}

#[test]
fn meter_ballistics_are_the_javascripts() {
    let mut compared = 0;
    for seed in [1, 2, 3] {
        let steps = frames(seed, 700);
        let got = cut_oracle::ask("scenario/meters", &[json!(["run", steps.clone()])]);
        let js = got[0].as_array().expect("the meters' states");
        let mut b = Ballistics::default();
        let mut asks = false;
        for (i, (f, want)) in steps.iter().zip(js).enumerate() {
            if f["reset"] == true {
                b.reset();
            } else if f["wake"] == true {
                asks = true;
            } else {
                assert_eq!(
                    want["ran"],
                    json!(asks),
                    "seed {seed} step {i}: a frame runs only when the meter asked for one"
                );
                if asks {
                    asks = b.frame(f["now"].as_f64().unwrap(), f["playing"] == true, heard(f, "peak"));
                }
                assert_eq!(want["asks"], json!(asks), "seed {seed} step {i}: whether it asks for the next frame");
            }
            let st = &want["state"];
            for (name, mine) in [("peak", b.peak), ("rms", b.rms), ("hold", b.hold), ("max", b.max)] {
                let js = pair(&st[name]);
                for ch in 0..2 {
                    assert!(
                        js[ch] == mine[ch] || (js[ch] - mine[ch]).abs() < 1e-9,
                        "seed {seed} step {i} {name}[{ch}]: {} (JavaScript {})",
                        mine[ch],
                        js[ch]
                    );
                }
            }
            assert_eq!(st["clip"], json!(b.clip), "seed {seed} step {i}: the clip lights");
            assert_eq!(want["lights"], json!(b.clip), "seed {seed} step {i}: the lights shown");
            let read: Vec<String> = b.max.iter().map(|v| meters::readout_text(*v)).collect();
            assert_eq!(want["read"], json!(read), "seed {seed} step {i}: the readouts");
            compared += 1;
        }
    }
    eprintln!("{compared} meter states compared with ui-meters.js");
    assert!(compared > 2000);
}

#[test]
fn the_mixer_scale_and_strip_meters_are_the_javascripts() {
    let mut r = Inputs::new(9);
    let mut dbs: Vec<Value> = vec![
        Value::Null,
        json!(-200),
        json!(-144),
        json!(-143.9),
        json!(-60),
        json!(-59.99),
        json!(0),
        json!(6),
        json!(6.5),
        json!(20.0 * 2f64.log10()),
    ];
    dbs.extend((0..300).map(|_| json!(r.range(-1500, 120) as f64 / 10.0)));
    let mut pos: Vec<Value> =
        vec![json!(-0.1), json!(0), json!(0.002), json!(0.0021), json!(0.04), json!(0.84), json!(1), json!(1.3)];
    pos.extend((0..300).map(|_| json!(r.range(0, 10000) as f64 / 10000.0)));
    let steps = frames(4, 400);
    let got = cut_oracle::ask("scenario/meters", &[json!(["mixer", dbs.clone(), pos.clone(), steps.clone()])]);
    let g = &got[0];
    for (d, want) in dbs.iter().zip(g["pos"].as_array().unwrap()) {
        let mine = mixer::pos_of(db(d));
        assert!((mine - want.as_f64().unwrap()).abs() < 1e-12, "posOf({d}) = {mine}, JavaScript {want}");
    }
    for (p, want) in pos.iter().zip(g["db"].as_array().unwrap()) {
        let mine = mixer::db_of(p.as_f64().unwrap());
        assert!((mine - want.as_f64().unwrap()).abs() < 1e-9, "dbOf({p}) = {mine}, JavaScript {want}");
    }
    let (mut track, mut master) = (Ballistics::default(), Ballistics::default());
    let mut asks = false;
    let mut compared = 0;
    for (i, (f, want)) in steps.iter().zip(g["steps"].as_array().unwrap()).enumerate() {
        if f["wake"] == true {
            asks = true;
            continue;
        }
        if f["reset"] == true {
            continue;
        }
        assert_eq!(want["ran"], json!(asks), "step {i}");
        if asks {
            let playing = f["playing"] == true;
            let t = heard(f, "track").or_else(|| heard(f, "peak").map(|h| Heard { rms: [Q, Q], ..h }));
            let a = track.frame(f["now"].as_f64().unwrap(), playing, t);
            let b = master.frame(f["now"].as_f64().unwrap(), playing, heard(f, "peak"));
            asks = a || b;
        }
        for (k, st) in [(0, &track), (1, &master)] {
            let js = pair(&want["strips"][k]["peak"]);
            assert!(
                js == st.peak || (0..2).all(|c| (js[c] - st.peak[c]).abs() < 1e-9),
                "step {i} strip {k}: {:?} (JavaScript {js:?})",
                st.peak
            );
            compared += 1;
        }
    }
    eprintln!("{} fader positions and {compared} strip meter states compared with ui-mixer.js", dbs.len() + pos.len());
}

// ---------- the mixer driven with the pointer ----------

fn home_dir(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("cut-app-{name}-{}", std::process::id()))
}

fn home(name: &str) -> Home {
    let dir = home_dir(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Home::at(dir)
}

/// A shell with the eight-second tone (440 Hz left, 660 Hz right, 0.3) on A1 and again on A2, from 0 s.
fn shell_with_tone(name: &str) -> Shell {
    let mut s = Shell::new(home(name));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    let media = cut_app::import::probe_file(&media::tone_aac()).result.expect("the tone probes");
    let r = s.app.exec(&cut_app::cmd::import_media(vec![media], None)).unwrap();
    let m = Id::new(r["ids"][0].as_str().unwrap());
    let seq = s.app.sequence_id.unwrap();
    for t in ["A1", "A2"] {
        s.app.exec(&cut_app::cmd::place(seq, m, None, Some(Id::new(t)), 0, "overwrite")).expect("placed");
    }
    s
}

fn harness(s: Shell) -> Harness<'static, Shell> {
    let mut h =
        Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(|ui, s: &mut Shell| s.frame(ui), s);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("workspace.audio", &ctx);
    h.run_steps(3);
    h
}

fn shown(h: &Harness<'_, Shell>, strip: mixer::Strip) -> mixer::Shown {
    *h.state().features.audio.mixer.shown.iter().find(|x| x.strip == strip).expect("the strip is on screen")
}

fn press(h: &mut Harness<'_, Shell>, at: Pos2, mods: Modifiers) {
    h.hover_at(at);
    h.step();
    h.event_modifiers(
        Event::PointerButton { pos: at, button: PointerButton::Primary, pressed: true, modifiers: mods },
        mods,
    );
    h.step();
}

fn release(h: &mut Harness<'_, Shell>, at: Pos2) {
    h.event(Event::PointerButton {
        pos: at,
        button: PointerButton::Primary,
        pressed: false,
        modifiers: Modifiers::NONE,
    });
    h.run_steps(2);
}

fn drag(h: &mut Harness<'_, Shell>, from: Pos2, to: Pos2) {
    press(h, from, Modifiers::NONE);
    for i in 1..=5 {
        h.hover_at(from + (to - from) * (i as f32 / 5.0));
        h.step();
    }
    release(h, to);
}

fn click(h: &mut Harness<'_, Shell>, at: Pos2, mods: Modifiers) {
    press(h, at, mods);
    release(h, at);
}

fn track(s: &Shell, id: &str) -> cut_model::Track {
    s.app.sequence().unwrap().track(Id::new(id)).unwrap().info()
}

fn label(s: &Shell) -> String {
    s.app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

/// RMS of each channel of the mix of 1 s to 3 s, rendered offline as the export mixes.
fn rms(p: &cut_model::Project, seq: Id) -> [f64; 2] {
    let mut m = cut_audio::Mixer::new(48000, cut_app::transport::file_audio(cut_audio::Library::default()));
    let out = cut_audio::offline::render(&mut m, p, seq, TICKS, 3 * TICKS, 0.0);
    out.map(|c| (c.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / c.len() as f64).sqrt())
}

fn ratio_db(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [20.0 * (a[0] / b[0]).log10(), 20.0 * (a[1] / b[1]).log10()]
}

#[test]
fn the_mixer_changes_the_tracks_and_the_mix_follows() {
    let mut h = harness(shell_with_tone("mixer"));
    let seq = h.state().app.sequence_id.unwrap();
    let names: Vec<_> = h.state().features.audio.mixer.shown.iter().map(|x| x.strip).collect();
    let audio = h.state().app.sequence().unwrap().tracks.iter().filter(|t| t.kind == TrackKind::Audio).count();
    assert_eq!(names.len(), audio + 1, "a strip per audio track and a master strip: {names:?}");
    assert_eq!(names[..2], [mixer::Strip::Track(Id::new("A1")), mixer::Strip::Track(Id::new("A2"))]);
    assert_eq!(names.last(), Some(&mixer::Strip::Master));
    let base = rms(h.state().app.project(), seq);
    let alone = {
        let s = h.state_mut();
        s.app.history.begin("probe");
        s.app.exec(&cut_app::cmd::set_track(seq, Id::new("A2"), json!({ "mute": true })));
        let r = rms(s.app.project(), seq);
        s.app.history.cancel();
        r
    };
    assert!(
        (ratio_db(base, alone)[0] - 20.0 * 2f64.log10()).abs() < 0.01,
        "two copies of the tone are twice one: {base:?} {alone:?}"
    );

    // the A1 fader dragged 40 points down: one undo step, the value the scale gives, the mix that much quieter
    let a1 = mixer::Strip::Track(Id::new("A1"));
    let g = shown(&h, a1);
    assert!(
        (g.cap.y - (g.bottom - (g.bottom - g.top) * mixer::pos_of(0.0) as f32)).abs() < 1.5,
        "at 0 dB the cap sits at the 0 dB mark"
    );
    let steps = h.state().app.history.position();
    drag(&mut h, g.cap, g.cap + egui::vec2(0.0, 40.0));
    let vol = track(h.state(), "A1").volume.unwrap();
    let want = (mixer::db_of(mixer::pos_of(0.0) - 40.0 / f64::from(g.bottom - g.top)) * 10.0).round() / 10.0;
    assert!(
        (vol - want).abs() <= 0.11 && vol < -3.0,
        "dragging A1's fader 40 px down lowers it to the scale's value ({vol} dB, the scale says {want})"
    );
    assert_eq!(
        (h.state().app.history.position() - steps, label(h.state())),
        (1, "Track Volume".to_owned()),
        "one undo step"
    );
    let quieter = rms(h.state().app.project(), seq);
    let gain = 10f64.powf(vol / 20.0);
    let expect = (base[0] / 2.0 * (1.0 + gain)).log10() * 20.0 - base[0].log10() * 20.0;
    let got = ratio_db(quieter, base);
    assert!(
        (got[0] - expect).abs() < 0.02 && (got[1] - expect).abs() < 0.02,
        "the mix is {got:?} dB against {expect:.3} dB expected from A1 at {vol} dB"
    );
    h.state_mut().app.undo();
    assert_eq!(track(h.state(), "A1").volume.unwrap_or(0.0), 0.0, "Ctrl+Z puts the volume back to 0 dB");

    // the top of the fader is +6 dB; Alt+click puts it back to 0
    let g = shown(&h, a1);
    drag(&mut h, g.cap, Pos2::new(g.cap.x, g.top - 30.0));
    let top = track(h.state(), "A1").volume.unwrap();
    assert!((top - 20.0 * 2f64.log10()).abs() < 0.05, "the top is the timeline header's 200% ({top} dB)");
    let at = shown(&h, a1).cap;
    click(&mut h, at, Modifiers::ALT);
    assert_eq!(track(h.state(), "A1").volume, Some(0.0), "Alt+click puts it back to 0 dB");

    // a value typed: A2 at -6 dB is exactly 6 dB less of its copy
    mixer::apply_typed(
        h.state_mut(),
        &mixer::Typing::Volume(mixer::Strip::Track(Id::new("A2")), String::new()),
        "-6 dB",
    );
    assert_eq!(track(h.state(), "A2").volume, Some(-6.0));
    let got = rms(h.state().app.project(), seq);
    let expect = 20.0 * ((1.0 + 10f64.powf(-0.3)) / 2.0).log10();
    assert!(
        (ratio_db(got, base)[0] - expect).abs() < 0.01,
        "A2 at -6 dB: {:?} dB, expected {expect:.3}",
        ratio_db(got, base)
    );
    h.state_mut().app.undo();

    // the master fader is the sequence's master gain
    let m = shown(&h, mixer::Strip::Master);
    let steps = h.state().app.history.position();
    drag(&mut h, m.cap, m.cap + egui::vec2(0.0, 30.0));
    let mg = h.state().app.sequence().unwrap().master_gain;
    assert!(
        mg < -2.0 && h.state().app.history.position() == steps + 1 && label(h.state()) == "Master Volume",
        "the master fader lowers the master gain in one step ({mg} dB)"
    );
    let got = ratio_db(rms(h.state().app.project(), seq), base);
    assert!(
        (got[0] - mg).abs() < 0.01 && (got[1] - mg).abs() < 0.01,
        "the whole mix moves by the master gain: {got:?} for {mg} dB"
    );
    h.state_mut().app.undo();

    // the pan knob: 30 points right is 30 in one step; the left channel of A1 then has 0.7 of its level
    let knob = shown(&h, a1).knob.unwrap();
    let steps = h.state().app.history.position();
    drag(&mut h, knob.center(), knob.center() + egui::vec2(30.0, 0.0));
    assert_eq!(
        (track(h.state(), "A1").pan, label(h.state())),
        (Some(30.0), "Track Pan".to_owned()),
        "the knob pans A1 to 30"
    );
    assert_eq!(h.state().app.history.position(), steps + 1);
    let got = ratio_db(rms(h.state().app.project(), seq), base);
    let left = 20.0 * ((0.7 + 1.0) / 2.0f64).log10();
    assert!(
        (got[0] - left).abs() < 0.01 && got[1].abs() < 0.01,
        "pan 30 takes 30% off A1's left only: {got:?}, expected [{left:.3}, 0]"
    );
    let at = shown(&h, a1).knob.unwrap().center();
    click(&mut h, at, Modifiers::ALT);
    assert_eq!(track(h.state(), "A1").pan, Some(0.0), "Alt+click centres it");

    // mute and solo
    let at = shown(&h, a1).mute.unwrap().center();
    click(&mut h, at, Modifiers::NONE);
    assert_eq!(track(h.state(), "A1").mute, Some(true), "M mutes A1");
    let got = ratio_db(rms(h.state().app.project(), seq), base);
    assert!((got[0] + 20.0 * 2f64.log10()).abs() < 0.01, "a muted A1 leaves A2 alone: {got:?}");
    let at = shown(&h, a1).mute.unwrap().center();
    click(&mut h, at, Modifiers::NONE);
    let at = shown(&h, mixer::Strip::Track(Id::new("A2"))).solo.unwrap().center();
    click(&mut h, at, Modifiers::NONE);
    assert_eq!(
        (track(h.state(), "A1").mute, track(h.state(), "A2").solo),
        (Some(false), Some(true)),
        "M again unmutes; S solos A2"
    );
    let got = ratio_db(rms(h.state().app.project(), seq), base);
    assert!((got[0] + 20.0 * 2f64.log10()).abs() < 0.01, "a soloed A2 is heard alone: {got:?}");
    let at = shown(&h, mixer::Strip::Track(Id::new("A2"))).solo.unwrap().center();
    click(&mut h, at, Modifiers::NONE);
    assert_eq!(track(h.state(), "A2").solo, Some(false), "S again ends the solo");

    // typed values: dB with a plus sign, -inf, nonsense ignored; pans rounded and kept within -100..100
    assert_eq!(mixer::typed_db("+3.04dB"), Some(3.04));
    assert_eq!(mixer::typed_db("-inf"), Some(mixer::SILENT));
    assert_eq!(mixer::typed_db("loud"), None);
    assert_eq!(mixer::typed_pan("250"), Some(100.0));
    assert_eq!(mixer::typed_pan("-12.5"), Some(-12.0));
    assert_eq!(mixer::db_text(mixer::SILENT), "-∞");
    assert_eq!(mixer::db_text(3.0), "+3.0");
    let _ = std::fs::remove_dir_all(home_dir("mixer"));
}

// ---------- Essential Sound ----------

#[test]
fn essential_sound_adds_its_effects_and_sets_the_role_in_one_step_each() {
    let mut s = shell_with_tone("essential");
    let seq = s.app.sequence().unwrap().clone();
    let clip = seq.clips().find(|c| c.track.as_str() == "A1").unwrap().id;
    let app: &mut App = &mut s.app;
    assert!(essential::sound_clips(app, false).is_empty(), "nothing selected: no clips");
    assert_eq!(essential::sound_clips(app, true).len(), 2, "with all, every clip with sound");
    app.select([clip], false, false);
    assert_eq!(essential::sound_clips(app, false), vec![clip]);
    let steps = app.history.position();
    assert!(essential::add_effects(app, "clarity", "Clarity"));
    let kinds: Vec<String> =
        app.sequence().unwrap().clip(clip).unwrap().effects.iter().map(|e| e.kind.clone()).collect();
    assert_eq!(kinds, ["audio.eq", "audio.compressor"], "Clarity adds an equalizer and a compressor");
    assert_eq!(app.history.position(), steps + 1, "in one step");
    let eq = &app.sequence().unwrap().clip(clip).unwrap().effects[0];
    assert_eq!(
        (eq.params.get("hpFreq"), eq.params.get("b2Gain")),
        (Some(&json!(80)), Some(&json!(3))),
        "with the speech settings"
    );
    assert!(essential::set_role(app, Some(cut_model::Role::Dialogue)));
    assert_eq!(
        app.sequence().unwrap().clip(clip).unwrap().role,
        Some(cut_model::Role::Dialogue),
        "Dialogue marks the clip"
    );
    app.undo();
    app.undo();
    let c = app.sequence().unwrap().clip(clip).unwrap();
    assert!(c.effects.is_empty() && c.role.is_none(), "two undos take both back");
    for name in ["hum50", "hum60", "gate", "limit"] {
        assert!(essential::add_effects(app, name, "x"), "{name}");
    }
    let kinds: Vec<String> =
        app.sequence().unwrap().clip(clip).unwrap().effects.iter().map(|e| e.kind.clone()).collect();
    assert_eq!(kinds, ["audio.dehum", "audio.dehum", "audio.gate", "audio.limiter"]);
    let _ = std::fs::remove_dir_all(home_dir("essential"));
}

// ---------- the loudness matches ----------

fn until(s: &mut Shell, secs: u64, ctx: &egui::Context, done: impl Fn(&Shell) -> bool) -> bool {
    let start = Instant::now();
    while !done(s) {
        if start.elapsed() > Duration::from_secs(secs) {
            return false;
        }
        loudness::poll(s, ctx);
        std::thread::sleep(Duration::from_millis(20));
    }
    true
}

#[test]
fn the_loudness_matches_reach_their_targets() {
    let mut s = shell_with_tone("loudness");
    let ctx = egui::Context::default();
    let seq = s.app.sequence_id.unwrap();
    let clip = s.app.sequence().unwrap().clips().find(|c| c.track.as_str() == "A1").unwrap().id;
    // a clip alone, then its volume set for -16 LUFS
    s.app.select([clip], false, false);
    let before =
        loudness::measure(&loudness::alone(s.app.project(), seq, clip).unwrap(), seq, 0, 8 * TICKS, |_| true).unwrap();
    s.run_action("auto.clipLoudness", &ctx);
    let Some(loudness::Open::Clips { target, .. }) = &mut s.features.audio.loudness.open else {
        panic!("Match Clip Loudness opens")
    };
    *target = -16.0;
    loudness::start_clips(&mut s);
    let steps = s.app.history.position();
    assert!(until(&mut s, 60, &ctx, |s| s.features.audio.loudness.open.is_none()), "the clip is measured");
    assert_eq!((s.app.history.position(), label(&s)), (steps + 1, "Match Clip Loudness".to_owned()));
    let after =
        loudness::measure(&loudness::alone(s.app.project(), seq, clip).unwrap(), seq, 0, 8 * TICKS, |_| true).unwrap();
    eprintln!("clip: {:.2} LUFS before, {:.2} after", before.integrated, after.integrated);
    assert!(
        (after.integrated + 16.0).abs() < 0.06,
        "the clip meets -16 LUFS to the tenth of a dB its volume keeps ({:.3})",
        after.integrated
    );

    // the sequence's master gain for -24 LUFS
    s.app.selection.clear();
    s.run_action("auto.loudness", &ctx);
    assert!(
        until(&mut s, 60, &ctx, |s| matches!(
            &s.features.audio.loudness.open,
            Some(loudness::Open::Sequence { measured: Some(_), .. })
        )),
        "the sequence is measured"
    );
    let Some(loudness::Open::Sequence { target, .. }) = &mut s.features.audio.loudness.open else { unreachable!() };
    *target = -24.0;
    assert!(loudness::apply_sequence(&mut s));
    assert_eq!(label(&s), "Match Loudness");
    let p = s.app.project().clone();
    let l = loudness::measure(&p, seq, 0, 8 * TICKS, |_| true).unwrap();
    eprintln!("sequence: {:.2} LUFS at master gain {} dB", l.integrated, p.sequence(seq).unwrap().master_gain);
    assert!((l.integrated + 24.0).abs() < 0.02, "the mix meets -24 LUFS ({:.3})", l.integrated);
    assert!(l.true_peak <= -1.0);
    let _ = std::fs::remove_dir_all(home_dir("loudness"));
}

/// The literal texts of `tr("...")` and `trf("...", ..)` calls in a source file.
fn texts(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for start in ["tr(\"", "trf(\""] {
        let mut rest = src;
        while let Some(i) = rest.find(start) {
            let before = rest[..i].chars().last();
            rest = &rest[i + start.len()..];
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let mut text = String::new();
            let mut chars = rest.chars();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => match chars.next() {
                        Some('n') => text.push('\n'),
                        Some(o) => text.push(o),
                        None => {}
                    },
                    '"' => break,
                    _ => text.push(c),
                }
            }
            out.push(text);
        }
    }
    out
}

#[test]
fn every_text_of_the_audio_and_caption_screens_is_translated() {
    let sources = [
        include_str!("../src/audio/mod.rs"),
        include_str!("../src/audio/meters.rs"),
        include_str!("../src/audio/mixer.rs"),
        include_str!("../src/audio/essential.rs"),
        include_str!("../src/audio/loudness.rs"),
        include_str!("../src/captions/mod.rs"),
        include_str!("../src/captions/panel.rs"),
        include_str!("../src/captions/files.rs"),
        include_str!("../src/captions/style.rs"),
        include_str!("../src/captions/track.rs"),
    ];
    let mut all: Vec<String> = sources.iter().flat_map(|s| texts(s)).collect();
    all.extend(essential::ROLES.iter().map(|(_, n)| (*n).to_owned()));
    all.extend(loudness::TARGETS.iter().map(|(_, n)| (*n).to_owned()));
    all.extend(
        [
            "Clarity (EQ and Compressor)",
            "Reduce Hum (50 Hz)",
            "Reduce Hum (60 Hz)",
            "Noise Gate",
            "Match Clip Loudness…",
            "Match Loudness…",
            "Hard Limiter (-1 dB)",
            "Bottom",
            "Top",
            "Word color",
            "Word color and box",
            "Import Captions…",
            "Export Captions…",
            "Caption Style…",
            "Essential Sound",
            "Captions…",
            "Remove Silence…",
            "Detect Scene Changes…",
            "Detect Beats…",
            "Auto Captions…",
            "Remove Filler Words…",
            "Label Speakers",
            "Auto Ducking…",
            "Isolate Voice",
            "Auto Color",
            "Automation",
        ]
        .map(str::to_owned),
    );
    assert!(all.len() > 80, "{} texts found", all.len());
    let missing: Vec<&String> = all.iter().filter(|t| !cut_app::i18n::has_korean(t)).collect();
    assert!(missing.is_empty(), "untranslated: {missing:?}");
}
