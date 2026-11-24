//! What making a motion graphic through the control tools turned up (2026-11-24), each as the call an AI makes:
//! two keyframes on one frame are refused instead of one being dropped; a transition at a clip's free end lies
//! inside the clip, and a cut between two clips keeps it centred; a made clip may go after the sequence's end, but
//! not an hour past it; a colour matte's step has its own name; the banner names a client once; the sound's device
//! is opened again when it must be.

use cut_app::control::call::{self, Started};
use cut_app::control::host::{Bare, Live};
use cut_app::state::App;
use serde_json::{Value as Json, json};

/// An editor on an empty project, and one call's answer: the result, or the refusal as `{"refused": sentence}`.
fn editor() -> Bare {
    Bare(App::new(cut_app::doc::fresh_history(), None))
}

fn tool(host: &mut Bare, name: &str, args: Json) -> Json {
    let live = Live::default();
    let answer = match call::call(name, &args, host, &live, None) {
        Started::Done(a) => a,
        Started::Waiting(mut p) => loop {
            if let Some(a) = p.poll(host, &live) {
                break a;
            }
        },
    };
    // the result itself, or {"error": sentence} for a refusal
    let p = answer.plain();
    if p["ok"] == true { p["value"].clone() } else { json!({ "error": p["error"] }) }
}

fn refusal(v: &Json) -> Option<&str> {
    v.get("error").and_then(Json::as_str).or_else(|| v.as_str())
}

#[test]
fn two_keyframes_on_one_frame_are_refused_and_nothing_is_dropped() {
    let mut h = editor();
    let g = tool(
        &mut h,
        "add_graphic",
        json!({ "at": 0, "duration": 5, "layers": [{ "id": "box", "kind": "rect", "size": [100, 100] }] }),
    );
    let clip = g["clip"].as_str().expect("the graphic clip").to_owned();
    // a loop's jump back, written as two times 10 ms apart: at 30 fps both are frame 30
    let keys = json!([
        { "time": 0.0, "value": [20, 20] }, { "time": 1.0, "value": [300, 300] },
        { "time": 1.01, "value": [20, 20] }, { "time": 2.0, "value": [300, 300] },
    ]);
    let r =
        tool(&mut h, "set_keyframes", json!({ "clip_id": clip, "property": "layers.box.scale", "keyframes": keys }));
    let said = refusal(&r).unwrap_or_else(|| panic!("a refusal, not {r}"));
    assert!(
        said.contains("keyframes[2]") && said.contains("same frame as keyframes[1]") && said.contains("ease hold"),
        "the refusal names both keyframes and says what to do: {said}"
    );
    let c = tool(&mut h, "get_clip", json!({ "clip_id": clip }));
    assert!(c["keyframes"].as_object().is_none_or(serde_json::Map::is_empty), "nothing was set: {}", c["keyframes"]);
    // a frame apart they are all kept
    let apart = json!([
        { "time": 0.0, "value": [20, 20] }, { "time": 1.0, "value": [300, 300], "ease": "hold" },
        { "time": 1.0 + 1.0 / 30.0, "value": [20, 20] }, { "time": 2.0, "value": [300, 300] },
    ]);
    let r =
        tool(&mut h, "set_keyframes", json!({ "clip_id": clip, "property": "layers.box.scale", "keyframes": apart }));
    assert_eq!(r["keyframes"], 4, "{r}");
    let c = tool(&mut h, "get_clip", json!({ "clip_id": clip }));
    let kept = c["keyframes"]["layers.box.scale"].as_array().map_or(0, Vec::len);
    assert_eq!(kept, 4, "every keyframe is in the clip: {}", c["keyframes"]);
}

#[test]
fn a_transition_at_a_free_end_lies_inside_the_clip_and_a_cut_keeps_it_centred() {
    let mut h = editor();
    tool(&mut h, "add_color_matte", json!({ "at": 0, "duration": 5, "track": "V1" }));
    tool(&mut h, "add_color_matte", json!({ "at": 5, "duration": 3, "track": "V1", "color": "#884422" }));
    for (at, said) in [(0, Some("start")), (5, None), (8, Some("end"))] {
        let r = tool(&mut h, "add_transition", json!({ "track": "V1", "at": at, "duration": 0.8 }));
        assert!(r["transition"].is_string(), "a transition at {at}: {r}");
        assert_eq!(r["align"].as_str(), said, "the answer says an alignment that is not the centre: {r}");
    }
    let seq = tool(&mut h, "get_sequence", json!({}));
    let align = |at: f64| {
        let t = seq["transitions"].as_array().unwrap().iter().find(|t| t["at"].as_f64() == Some(at));
        t.unwrap_or_else(|| panic!("the transition at {at} in {}", seq["transitions"]))["align"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(align(0.0), "start", "at the first clip's start the transition starts there");
    assert_eq!(align(5.0), "center", "on the cut between the two clips it is centred");
    assert_eq!(align(8.0), "end", "at the last clip's end the transition ends there");
    // an alignment asked for is kept
    let r = tool(&mut h, "add_transition", json!({ "track": "V1", "at": 8, "duration": 0.8, "align": "center" }));
    assert!(r["transition"].is_string(), "{r}");
    let seq = tool(&mut h, "get_sequence", json!({}));
    let last = seq["transitions"].as_array().unwrap().iter().find(|t| t["at"].as_f64() == Some(8.0)).unwrap();
    assert_eq!(last["align"], "center", "{last}");
}

#[test]
fn a_made_clip_may_go_after_the_end_but_not_an_hour_past_it() {
    let mut h = editor();
    // an empty sequence: 0 to 0 s
    let t = tool(&mut h, "add_text", json!({ "text": "Later", "at": 5, "duration": 2 }));
    assert!(t["clip"].is_string(), "a title at 5 s of an empty sequence: {t}");
    let g = tool(
        &mut h,
        "add_graphic",
        json!({ "at": 12, "duration": 1, "layers": [{ "id": "dot", "kind": "ellipse", "size": [40, 40] }] }),
    );
    assert!(g["clip"].is_string(), "a graphic after the title's end: {g}");
    let m = tool(&mut h, "add_color_matte", json!({ "at": 20, "duration": 1 }));
    assert!(m["clip"].is_string(), "a matte after that: {m}");
    let seq = tool(&mut h, "get_sequence", json!({}));
    let starts: Vec<f64> = seq["clips"].as_array().unwrap().iter().filter_map(|c| c["start"].as_f64()).collect();
    assert!([5.0, 12.0, 20.0].iter().all(|s| starts.contains(s)), "the clips are where they were asked: {starts:?}");
    assert_eq!(seq["duration"], 21, "the sequence is as long as its last clip's end");
    let far = tool(&mut h, "add_text", json!({ "text": "Far", "at": 21.0 + 3601.0 }));
    let said = refusal(&far).unwrap_or_else(|| panic!("a refusal, not {far}"));
    assert!(said.contains("more than an hour after the sequence's end"), "{said}");
    let again = tool(&mut h, "get_sequence", json!({}));
    assert_eq!(again["clips"].as_array().unwrap().len(), 3, "and the refused title is not there");
}

#[test]
fn a_colour_mattes_step_is_named_for_it() {
    let mut h = editor();
    tool(&mut h, "add_color_matte", json!({ "at": 0, "duration": 2 }));
    tool(&mut h, "add_graphic", json!({ "at": 2, "duration": 1, "layers": [{ "kind": "rect" }] }));
    tool(&mut h, "add_text", json!({ "text": "Title", "at": 3, "duration": 1 }));
    let steps: Vec<String> = h.0.history.list().into_iter().filter(|x| x.done).map(|x| x.label).collect();
    assert_eq!(steps, ["Add Color Matte", "Add Graphic", "Add Text"], "the History panel's three steps");
    cut_app::i18n::set_lang(cut_app::i18n::Lang::Ko);
    let ko = cut_app::i18n::tr("Add Color Matte").into_owned();
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    assert_eq!(ko, "컬러 매트 추가");
}

#[test]
fn the_banner_names_a_client_once_with_its_connections() {
    let names =
        |l: &[&str]| cut_app::control::panel::banner_names(&l.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>());
    assert_eq!(names(&["Claude Code"]), "Claude Code");
    assert_eq!(names(&["Claude Code"; 12]), "Claude Code ×12", "twelve connections of one client are one name");
    assert_eq!(names(&["Claude Code", "Other", "Claude Code"]), "Claude Code ×2, Other", "in the order they came");
}

#[test]
fn the_sounds_device_is_opened_again_when_it_must_be() {
    use cut_app::transport::must_reopen;
    let (speakers, headphones) = (Some("Speakers"), Some("Headphones"));
    assert!(!must_reopen(speakers, speakers, false, false), "the same device, working: it stays");
    assert!(must_reopen(speakers, headphones, false, false), "another device became the default");
    assert!(must_reopen(speakers, speakers, true, false), "the stream reported an error (unplugged, disabled)");
    assert!(must_reopen(speakers, speakers, false, true), "the sound's clock stood still in the last run");
    assert!(must_reopen(None, speakers, false, false), "there was no device at the start and now there is one");
    assert!(!must_reopen(None, None, false, false), "no device at all: nothing to open");
    assert!(must_reopen(speakers, None, true, false), "the device is gone and its stream failed: the dead player goes");
    assert!(!must_reopen(speakers, None, false, false), "no default is named but the stream still works: it stays");
}

#[test]
fn a_player_whose_sound_stood_still_opens_its_device_again_at_the_next_play() {
    use cut_app::transport::{Player, Transport};
    let (mut p, error) = Player::new(cut_audio::Library::default());
    let Some(device) = p.device().map(str::to_owned) else {
        eprintln!("no output device on this machine ({error:?}): not run");
        return;
    };
    p.set_output_gain(0.0);
    p.play(0, 1.0);
    p.pause();
    assert_eq!(p.reopened(), 0, "a device that works is not opened again");
    p.mark_stalled();
    p.play(0, 1.0);
    assert_eq!(p.reopened(), 1, "after a run whose sound stood still the device is opened again");
    assert_eq!(p.device(), Some(device.as_str()), "the default device");
    assert_eq!(p.clock(), "sound", "and the sound is the clock again");
    p.pause();
    p.play(0, 1.0);
    assert_eq!(p.reopened(), 1, "once");
    p.pause();
}
