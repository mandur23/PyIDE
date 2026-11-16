//! Clip > Nest (port of commands.js's `nest`): clips move into a new sequence and one nest clip takes their place.

use serde_json::{Value as Json, json};

use super::{Code, R, context, fail, nid, opts};
use crate::defaults::{self, SequenceOpts};
use crate::history::journal::Tx;
use crate::id::Id;
use crate::project::{Project, Source, TrackKind};

/// The clips (with what links to them and the rest of their groups unless `linked: false`) move into a new sequence of
/// this one's size, rate and tracks; one nest clip spans them, video on the lowest of their video tracks, audio on the
/// lowest audio track. -> `{ id /* the sequence */, ids /* the nest clips */ }`
pub fn nest(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let chosen = c.with_linked(cmd.get("clipIds"), o.get("linked") != Some(&json!(false)), true)?;
    if chosen.is_empty() {
        return fail("Select the clips to nest.", Code::NoClips);
    }
    let clips: Vec<crate::project::Clip> = chosen.iter().map(|id| c.clip(*id).cloned()).collect::<R<_>>()?;
    for x in &clips {
        c.unlocked(x.track)?;
    }
    let t0 = clips.iter().map(|x| x.start).min().expect("not empty");
    let t1 = clips.iter().map(|x| x.end()).max().expect("not empty");
    let of_kind = |k: TrackKind| -> Vec<Id> { c.seq().tracks.iter().filter(|t| t.kind == k).map(|t| t.id).collect() };
    let (videos, audios) = (of_kind(TrackKind::Video), of_kind(TrackKind::Audio));
    let id = c.nid("s");
    let name =
        o.get("name").and_then(Json::as_str).map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Nested Sequence");
    let seq = c.seq();
    let mut inner = defaults::sequence(
        id,
        &SequenceOpts {
            name: name.to_owned(),
            w: seq.w,
            h: seq.h,
            fps: seq.fps,
            background: seq.background.clone(),
            master_gain: 0.0,
            video_tracks: videos.len(),
            audio_tracks: audios.len(),
        },
    );
    let inner_track = |t: Id| -> Id {
        let (letter, list) = if videos.contains(&t) { ("V", &videos) } else { ("A", &audios) };
        Id::numbered(letter, list.iter().position(|x| *x == t).map_or(0, |i| i as i64 + 1))
    };
    let carried: Vec<crate::project::Transition> = seq
        .transitions
        .iter()
        .filter(|t| {
            let there: Vec<Id> = seq
                .track(t.track)
                .map(|tr| tr.clips.iter().filter(|x| x.start == t.at || x.end() == t.at).map(|x| x.id).collect())
                .unwrap_or_default();
            !there.is_empty() && there.iter().all(|x| chosen.contains(x))
        })
        .cloned()
        .collect();
    for x in &clips {
        let mut copy = x.clone();
        copy.track = inner_track(x.track);
        copy.start = x.start - t0;
        if let Some(l) = copy.link
            && seq.clips().any(|y| y.link == Some(l) && !chosen.contains(&y.id))
        {
            copy.link = None;
        }
        inner.insert_clip(copy, None);
    }
    for t in &carried {
        let mut t2 = t.clone();
        t2.track = inner_track(t.track);
        t2.at = t.at - t0;
        inner.transitions.push(t2);
    }
    let lowest = |k: TrackKind, list: &[Id]| -> Option<Id> {
        list.iter().copied().find(|t| clips.iter().any(|x| x.track == *t && seq.kind_of(x.track) == Some(k)))
    };
    let (v_id, a_id) = (lowest(TrackKind::Video, &videos), lowest(TrackKind::Audio, &audios));
    let land = match a_id.or(audios.first().copied()) {
        Some(t) => c.track(t)?.clone(),
        None => return super::fail_at("There is no track there.", Code::NoTrack, "undefined"),
    };
    let outer: Vec<crate::project::Track> = c.seq().tracks.clone();
    let (mut vi, mut ai) = (0, 0);
    let mut infos = inner.track_infos();
    for t in &outer {
        let same: Vec<usize> = infos.iter().enumerate().filter(|(_, x)| x.kind == t.kind).map(|(i, _)| i).collect();
        if t.kind == TrackKind::Video {
            infos[same[vi]].visible = t.visible;
            vi += 1;
        } else {
            let x = &mut infos[same[ai]];
            x.mute = t.mute;
            x.solo = t.solo;
            x.volume = Some(t.volume.unwrap_or(0.0) - land.volume.unwrap_or(0.0));
            x.pan = Some((t.pan.unwrap_or(0.0) - land.pan.unwrap_or(0.0)).clamp(-100.0, 100.0));
            ai += 1;
        }
    }
    inner.set_tracks(infos);
    for x in &chosen {
        c.remove(*x);
    }
    if !carried.is_empty() {
        let gone: Vec<Id> = carried.iter().map(|t| t.id).collect();
        c.transitions_mut().retain(|t| !gone.contains(&t.id));
    }
    let outer_id = c.seq;
    c.p.sequences.push(inner);
    c.tx.seq_added(id);
    if let Some(b) = c.p.bins.iter().position(|b| b.items.contains(&outer_id)) {
        super::bins_mut(c.p, c.tx)[b].items.push(id);
    }
    for t in [v_id, a_id].into_iter().flatten() {
        c.clear_range(t, t0, t1);
    }
    let link = if v_id.is_some() && a_id.is_some() { Some(nid(c.p, c.tx, "L")) } else { None };
    let mut made = Vec::new();
    for (track, kind) in [(v_id, TrackKind::Video), (a_id, TrackKind::Audio)] {
        let Some(track) = track else { continue };
        let cid = c.nid("c");
        let source = Source::Nest { sequence: id, extra: Default::default() };
        let mut clip = defaults::clip(kind, cid, track, t0, 0.0, (t1 - t0) as f64, source, String::new());
        clip.link = link;
        c.add(clip, None);
        made.push(cid);
    }
    Ok(json!({ "id": id, "ids": made }))
}
