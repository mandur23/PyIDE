//! The timeline's geometry and gestures without a window: hit testing, snapping, the press decisions, and every drag
//! turned into a command and run on a real history.

use cut_app::cmd;
use cut_app::state::Tool;
use cut_app::timeline::gesture::{self, Mods, MoveDrag, Press, Selecting, TrimDrag};
use cut_app::timeline::layout::{self, Hit, Layout, Part, RowKind, View};
use cut_model::{History, Id, Project, Sequence};
use cut_time::{TICKS, Ticks, frame_start};
use serde_json::json;

const S: Ticks = TICKS;

/// A sequence at 30 fps with V1 [0,2s) [2s,4s), V2 [1s,3s), A1 [0,2s) linked to the first V1 clip.
fn history() -> History {
    let mut p = cut_model::defaults::project();
    p.sequences[0].fps = cut_time::Fps { num: 30, den: 1 };
    let mut h = History::new(p, 1000).unwrap();
    let media = json!([
        { "path": "C:\\m\\a.mp4", "name": "a.mp4", "kind": "video", "duration": 10 * S,
          "video": { "w": 1920, "h": 1080, "fps": [30, 1], "codec": "avc1" }, "audio": { "rate": 48000, "channels": 2 } },
        { "path": "C:\\m\\b.png", "name": "b.png", "kind": "image", "duration": 0, "video": { "w": 64, "h": 48 } },
    ]);
    h.apply(&cmd::import_media(media.as_array().unwrap().clone(), None)).unwrap();
    let seq = h.project().sequences[0].id;
    let (m1, m2) = (Id::new("m2"), Id::new("m3"));
    let ids: Vec<&str> = h.project().media.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["m2", "m3"], "media ids");
    h.apply(&json!({ "type": "place", "seqId": seq.as_str(), "opts": { "source": { "media": m1.as_str() }, "video": "V1", "audio": "A1", "at": 0, "out": 2 * S, "mode": "overwrite" } })).unwrap();
    h.apply(&json!({ "type": "place", "seqId": seq.as_str(), "opts": { "source": { "media": m1.as_str() }, "video": "V1", "at": 2 * S, "in": 2 * S, "out": 4 * S, "mode": "overwrite" } })).unwrap();
    h.apply(&json!({ "type": "place", "seqId": seq.as_str(), "opts": { "source": { "media": m2.as_str() }, "video": "V2", "at": S, "in": 0, "out": 2 * S, "mode": "overwrite" } })).unwrap();
    h
}

fn seq(h: &History) -> &Sequence {
    &h.project().sequences[0]
}

fn clip_on(h: &History, track: &str, start: Ticks) -> Id {
    seq(h).clips().find(|c| c.track.as_str() == track && c.start == start).map(|c| c.id).expect("a clip there")
}

fn view() -> View {
    View { pps: 100.0, scroll_x: 0.0, scroll_y: 0.0 }
}

fn y_of(l: &Layout, track: &str) -> f32 {
    let r = l.rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == track)).unwrap();
    r.y + r.h / 2.0
}

#[test]
fn rows_follow_the_javascript_order() {
    let h = history();
    let l = Layout::of(seq(&h));
    let kinds: Vec<(RowKind, Option<&str>)> = l.rows.iter().map(|r| (r.kind, r.id.map(Id::as_str))).collect();
    assert_eq!(
        kinds,
        [
            (RowKind::Video, Some("V2")),
            (RowKind::Video, Some("V1")),
            (RowKind::Divider, None),
            (RowKind::Audio, Some("A1")),
            (RowKind::Audio, Some("A2"))
        ]
    );
    assert_eq!(l.rows[2].h, layout::DIVIDER);
    assert_eq!(l.end, 4 * S);
}

#[test]
fn visible_finds_only_the_clips_in_the_range() {
    let h = history();
    let l = Layout::of(seq(&h));
    let v1 = Id::new("V1");
    assert_eq!(l.visible(v1, 0, S / 2).len(), 1);
    assert_eq!(l.visible(v1, 2 * S, 2 * S).len(), 2, "the cut touches both");
    assert_eq!(l.visible(v1, 5 * S, 9 * S).len(), 0);
    assert_eq!(l.visible(Id::new("nope"), 0, 9 * S).len(), 0);
}

#[test]
fn hit_picks_edges_bodies_and_the_side_of_a_cut() {
    let h = history();
    let l = Layout::of(seq(&h));
    let v = view();
    let y = y_of(&l, "V1");
    let first = clip_on(&h, "V1", 0);
    let second = clip_on(&h, "V1", 2 * S);
    // body
    let b = layout::hit(&l, &v, 100.0, y);
    assert_eq!((b.clip, b.part), (Some(first), Some(Part::Body)));
    // the start edge within EDGE points
    let e = layout::hit(&l, &v, 5.0, y);
    assert_eq!((e.clip, e.part), (Some(first), Some(Part::Start)));
    // At a cut between two touching clips the JavaScript's `near` rule keeps the first edge it met (a tie is not
    // "nearer"), so within EDGE on either side the outgoing clip's end is grabbed: kept as it is.
    for x in [194.0, 198.0, 200.0, 202.0, 206.0] {
        let at = layout::hit(&l, &v, x, y);
        assert_eq!((at.clip, at.part), (Some(first), Some(Part::End)), "x = {x}");
    }
    let inside = layout::hit(&l, &v, 210.0, y);
    assert_eq!((inside.clip, inside.part), (Some(second), Some(Part::Body)));
    let far = layout::hit(&l, &v, 395.0, y);
    assert_eq!((far.clip, far.part), (Some(second), Some(Part::End)));
    // empty lane, divider, below every row
    assert_eq!(layout::hit(&l, &v, 500.0, y).clip, None);
    let div = l.rows.iter().find(|r| r.kind == RowKind::Divider).unwrap();
    assert_eq!(layout::hit(&l, &v, 100.0, div.y + 1.0).clip, None);
    assert_eq!(layout::hit(&l, &v, 100.0, 10_000.0).row, None);
    // scrolled: the same clip under the same screen point after scrolling one second
    let scrolled = View { scroll_x: 100.0, ..v };
    assert_eq!(layout::hit(&l, &scrolled, 50.0, y).clip, Some(first));
    assert_eq!(layout::hit(&l, &scrolled, 150.0, y).clip, Some(second));
}

#[test]
fn a_tiny_clip_keeps_a_body_between_its_edges() {
    // At low zoom a clip is a few points wide: the edge zone is a third of it, never the whole clip.
    let h = history();
    let l = Layout::of(seq(&h));
    let v = View { pps: 6.0, ..view() };
    let y = y_of(&l, "V1");
    let mid = layout::hit(&l, &v, 6.0, y);
    assert_eq!(mid.part, Some(Part::Body), "{mid:?}");
}

#[test]
fn snapping_takes_the_nearest_point_within_the_limit() {
    let pts = [0, 100, 250, 1000];
    assert_eq!(layout::snap_delta(&[90], 0, &pts, 15.0), (10, Some(100)));
    assert_eq!(layout::snap_delta(&[90], 0, &pts, 5.0), (0, None));
    assert_eq!(layout::snap_delta(&[90, 247], 5, &pts, 15.0), (5 - 2, Some(250)), "the nearer of two candidates");
    assert_eq!(layout::snap_delta(&[90, 240], 5, &pts, 15.0), (10, Some(100)), "a tie: the first candidate");
    assert_eq!(layout::snap_delta(&[2000], 0, &pts, 15.0), (0, None));
    assert_eq!(layout::snap_delta(&[5], 0, &[], 15.0), (0, None));
    assert_eq!(
        layout::frames_delta(150.0, 100.0, frame_start(1, cut_time::Fps { num: 30, den: 1 })),
        45 * frame_start(1, cut_time::Fps { num: 30, den: 1 })
    );
}

#[test]
fn clicks_select_groups_and_links_as_the_javascript() {
    let h = history();
    let s = seq(&h);
    let v = clip_on(&h, "V1", 0);
    let a = clip_on(&h, "A1", 0);
    let none = Mods::default();
    assert_eq!(gesture::partners(s, v, false, true), vec![v, a], "linked selection takes the audio");
    assert_eq!(gesture::partners(s, v, false, false), vec![v]);
    assert_eq!(gesture::partners(s, v, true, true), vec![v], "Alt: only the clip");
    assert_eq!(gesture::press_selection(s, &[], v, none, true), Selecting::Set(vec![v, a]));
    assert_eq!(gesture::press_selection(s, &[v, a], v, none, true), Selecting::Keep, "a drag keeps the selection");
    assert_eq!(gesture::release_selection(s, &[v, a, Id::new("x")], v, none, true), Selecting::Set(vec![v, a]));
    let shift = Mods { shift: true, ..none };
    assert_eq!(gesture::press_selection(s, &[v, a], v, shift, true), Selecting::Remove(vec![v, a]));
    let ctrl = Mods { ctrl: true, ..none };
    assert_eq!(gesture::press_selection(s, &[], v, ctrl, true), Selecting::Keep, "Ctrl decides on release");
    assert_eq!(gesture::release_selection(s, &[], v, ctrl, true), Selecting::Add(vec![v, a]));
}

#[test]
fn track_select_picks_forward_and_backward() {
    let h = history();
    let s = seq(&h);
    let fwd = gesture::track_select(s, 2.5 * S as f64, true, None);
    assert_eq!(fwd.len(), 2, "the second V1 clip and the V2 still that ends at 3 s");
    let back = gesture::track_select(s, 1.5 * S as f64, false, None);
    assert_eq!(back.len(), 3);
    let only = gesture::track_select(s, 0.0, true, Some(Id::new("A1")));
    assert_eq!(only, vec![clip_on(&h, "A1", 0)]);
}

#[test]
fn press_decides_by_tool_and_part() {
    let h = history();
    let s = seq(&h);
    let l = Layout::of(s);
    let v = view();
    let y = y_of(&l, "V1");
    let edge = layout::hit(&l, &v, 198.0, y);
    let fps = s.fps;
    let first = clip_on(&h, "V1", 0);
    assert_eq!(
        gesture::press(s, &l, &edge, Tool::Select, Mods::default(), fps, None),
        Press::Trim { clip: first, edge: Part::End, mode: "normal" }
    );
    let ctrl = Mods { ctrl: true, ..Mods::default() };
    assert_eq!(
        gesture::press(s, &l, &edge, Tool::Select, ctrl, fps, None),
        Press::Trim { clip: first, edge: Part::End, mode: "ripple" }
    );
    assert_eq!(
        gesture::press(s, &l, &edge, Tool::Roll, Mods::default(), fps, None),
        Press::Trim { clip: first, edge: Part::End, mode: "roll" }
    );
    let body = layout::hit(&l, &v, 100.0, y);
    assert_eq!(gesture::press(s, &l, &body, Tool::Select, Mods::default(), fps, None), Press::Move { clip: first });
    assert_eq!(gesture::press(s, &l, &body, Tool::Hand, Mods::default(), fps, None), Press::Hand);
    let empty = layout::hit(&l, &v, 900.0, y);
    assert_eq!(gesture::press(s, &l, &empty, Tool::Select, Mods::default(), fps, None), Press::Empty);
    assert_eq!(gesture::press(s, &l, &empty, Tool::Razor, Mods::default(), fps, None), Press::Nothing);
    match gesture::press(s, &l, &body, Tool::Zoom, Mods { alt: true, ..Mods::default() }, fps, None) {
        Press::Zoom { factor, .. } => assert_eq!(factor, 0.5),
        other => panic!("{other:?}"),
    }
}

#[test]
fn razor_cuts_the_clip_and_its_link_at_the_frame() {
    let mut h = history();
    let l = Layout::of(seq(&h));
    let v = view();
    let hit: Hit = layout::hit(&l, &v, 101.3, y_of(&l, "V1"));
    let c = gesture::razor(seq(&h), &hit, Mods::default(), seq(&h).fps, None).unwrap();
    let before = seq(&h).clip_count();
    let r = h.apply(&c).unwrap();
    assert_eq!(r["ids"].as_array().unwrap().len(), 2, "video and its linked audio");
    assert_eq!(seq(&h).clip_count(), before + 2);
    let f = frame_start(1, seq(&h).fps);
    assert!(seq(&h).clips().any(|c| c.start == 30 * f), "cut at the frame nearest 1.013 s (frame 30)");
    // Alt: only the clip under the pointer
    let mut h2 = history();
    let c2 = gesture::razor(seq(&h2), &hit, Mods { alt: true, ..Mods::default() }, seq(&h2).fps, None).unwrap();
    assert_eq!(h2.apply(&c2).unwrap()["ids"].as_array().unwrap().len(), 1);
}

#[test]
fn a_move_drag_becomes_one_move_command() {
    let mut h = history();
    let l = Layout::of(seq(&h));
    let v = view();
    let first = clip_on(&h, "V1", 0);
    let audio = clip_on(&h, "A1", 0);
    let y = y_of(&l, "V1");
    let mut d = MoveDrag::new(seq(&h), &l, &[first, audio], first, vec![], (100.0, y), &v).unwrap();
    let f = frame_start(1, seq(&h).fps);
    d.step(&l, &v, (102.0, y), Mods::default(), false, f);
    assert!(!d.moved, "under the slop");
    // right 5 s would land on the second clip: an overwrite move; up one row to V2
    d.step(&l, &v, (100.0 + 500.0, y_of(&l, "V2")), Mods::default(), false, f);
    assert_eq!((d.delta, d.rows), (5 * S, 1));
    let c = d.finish(seq(&h), Mods::default()).unwrap();
    assert_eq!(c["opts"]["trackDelta"], json!({ "video": 1, "audio": 0 }));
    h.apply(&c).unwrap();
    let moved = seq(&h).clip(first).unwrap();
    assert_eq!((moved.track.as_str(), moved.start), ("V2", 5 * S));
    assert_eq!(seq(&h).clip(audio).unwrap().start, 5 * S, "the selected audio moved along");
}

#[test]
fn a_move_never_goes_before_zero_and_rows_stay_inside_the_kind() {
    let h = history();
    let l = Layout::of(seq(&h));
    let v = view();
    let first = clip_on(&h, "V1", 0);
    let y = y_of(&l, "V1");
    let mut d = MoveDrag::new(seq(&h), &l, &[first], first, vec![], (100.0, y), &v).unwrap();
    let f = frame_start(1, seq(&h).fps);
    d.step(&l, &v, (-400.0, y_of(&l, "A2")), Mods::default(), false, f);
    assert_eq!(d.delta, 0, "clamped at the sequence start");
    assert_eq!(d.rows, 0, "a video clip dragged over the audio tracks goes to V1");
    d.step(&l, &v, (-400.0, -500.0), Mods::default(), false, f);
    assert_eq!(d.rows, 0, "above every row: no row");
}

#[test]
fn a_move_snaps_to_the_playhead_unless_shift() {
    let h = history();
    let s = seq(&h);
    let l = Layout::of(s);
    let v = view();
    let first = clip_on(&h, "V1", 0);
    let pts = l.snap_points(s, 7 * S + 1000, [None, None], &[first]);
    let y = y_of(&l, "V1");
    let f = frame_start(1, s.fps);
    let mut d = MoveDrag::new(s, &l, &[first], first, pts, (0.0, y), &v).unwrap();
    d.step(&l, &v, (697.0, y), Mods::default(), true, f);
    assert_eq!(d.guide, Some(7 * S + 1000), "start snaps to the playhead 3 points away");
    d.step(&l, &v, (697.0, y), Mods { shift: true, ..Mods::default() }, true, f);
    assert_eq!(d.guide, None, "Shift turns snapping off");
}

#[test]
fn alt_drag_pastes_copies_and_keeps_the_originals() {
    let mut h = history();
    let l = Layout::of(seq(&h));
    let v = view();
    let first = clip_on(&h, "V1", 0);
    let audio = clip_on(&h, "A1", 0);
    let y = y_of(&l, "V1");
    let mut d = MoveDrag::new(seq(&h), &l, &[first, audio], first, vec![], (0.0, y), &v).unwrap();
    let alt = Mods { alt: true, ..Mods::default() };
    d.step(&l, &v, (600.0, y), alt, false, frame_start(1, seq(&h).fps));
    assert!(d.finish(seq(&h), alt).is_none(), "Alt at the drop is no move");
    let before = seq(&h).clip_count();
    let r = h.apply(&d.copy(seq(&h), alt).unwrap()).unwrap();
    assert_eq!(r["ids"].as_array().unwrap().len(), 2);
    assert_eq!(seq(&h).clip_count(), before + 2);
    assert_eq!(seq(&h).clip(first).unwrap().start, 0, "the original stays");
    let copies: Vec<_> = seq(&h).clips().filter(|c| c.start == 6 * S).collect();
    assert_eq!(copies.len(), 2);
    assert!(copies[0].link.is_some() && copies[0].link == copies[1].link, "the copies are linked to each other");
}

#[test]
fn trims_build_the_three_modes() {
    for (mode, second_start) in [
        ("normal", 2 * S),
        ("ripple", 2 * S - 15 * frame_start(1, cut_time::Fps { num: 30, den: 1 })),
        ("roll", 2 * S - 15 * frame_start(1, cut_time::Fps { num: 30, den: 1 })),
    ] {
        let mut h = history();
        let v = view();
        let first = clip_on(&h, "V1", 0);
        let second = clip_on(&h, "V1", 2 * S);
        let pts = Layout::of(seq(&h)).snap_points(
            seq(&h),
            0,
            [None, None],
            &gesture::trim_exclude(seq(&h), first, Part::End, mode),
        );
        let mut d = TrimDrag::new(seq(&h), first, (Part::End, mode), Mods::default(), pts, 200.0, &v).unwrap();
        let f = frame_start(1, seq(&h).fps);
        assert!(d.step(seq(&h), &v, 201.0, Mods::default(), true, f).is_none(), "under the slop");
        let c = d.step(seq(&h), &v, 150.0, Mods::default(), false, f).unwrap();
        h.begin("Trim");
        let r = h.apply(&c).unwrap();
        h.commit();
        assert_eq!(r["applied"].as_i64(), Some(-15 * f), "{mode}");
        assert_eq!(seq(&h).clip(first).unwrap().end(), 2 * S - 15 * f, "{mode}");
        assert_eq!(seq(&h).clip(second).unwrap().start, second_start, "{mode}");
        assert_eq!(h.list().len(), 5, "{mode}: the trim is one undo step after the four of the setup");
        h.undo();
        assert_eq!(seq(&h).clip(first).unwrap().end(), 2 * S);
    }
}

#[test]
fn trim_exclude_leaves_out_links_and_the_roll_partner() {
    let h = history();
    let first = clip_on(&h, "V1", 0);
    let ex = gesture::trim_exclude(seq(&h), first, Part::End, "roll");
    assert!(ex.contains(&clip_on(&h, "A1", 0)) && ex.contains(&clip_on(&h, "V1", 2 * S)) && ex.len() == 3);
    assert_eq!(gesture::trim_exclude(seq(&h), first, Part::Start, "normal").len(), 2);
}

#[test]
fn a_ten_thousand_clip_index_answers_in_microseconds() {
    let text = {
        let h = history();
        let mut json: serde_json::Value = serde_json::from_str(&h.serialize()).unwrap();
        let tpl =
            json["sequences"][0]["clips"].as_array().unwrap().iter().find(|c| c["track"] == "V1").unwrap().clone();
        let mut list = Vec::new();
        for i in 0..10_000i64 {
            let mut c = tpl.clone();
            c["id"] = json!(format!("c{}", 1000 + i));
            c["link"] = serde_json::Value::Null;
            c["track"] = json!(if i % 2 == 0 { "V1" } else { "V2" });
            c["start"] = json!((i / 2) * 2 * S);
            list.push(c);
        }
        json["sequences"][0]["clips"] = serde_json::Value::Array(list);
        json["nextId"] = json!(20_000);
        json.to_string()
    };
    let p = Project::load(&text).unwrap();
    let l = Layout::of(&p.sequences[0]);
    let v = View { pps: 50.0, scroll_x: 50.0 * 5000.0, scroll_y: 0.0 };
    let y = y_of(&l, "V1");
    let t0 = std::time::Instant::now();
    let mut found = 0;
    for i in 0..1000 {
        found += usize::from(layout::hit(&l, &v, f64::from(i), y).clip.is_some());
    }
    let per = t0.elapsed().as_secs_f64() / 1000.0;
    assert_eq!(found, 1000);
    assert!(per < 50e-6, "hit test {per:e} s");
}
