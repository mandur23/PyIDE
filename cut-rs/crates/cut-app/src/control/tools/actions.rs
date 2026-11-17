//! list_actions and run_action (control-actions.js): the keyboard's actions an AI may run, what each needs, the
//! refusal when it is missing, and what changed after it ran.

use serde_json::{Map, Value as Json, json};

use crate::control::call::{Cx, Out, R, f, refuse, s, strs};
use crate::control::table::{self, needs};

pub fn list_actions(_c: &mut Cx, a: &Json) -> R<Out> {
    let search = s(a, "search").unwrap_or_default().to_lowercase();
    let words: Vec<&str> = search.split_whitespace().collect();
    let out: Vec<Json> = table::actions()
        .iter()
        .filter(|x| {
            let text = format!("{} {}", x.id, x.what).to_lowercase();
            words.iter().all(|w| text.contains(w))
        })
        .map(|x| {
            let mut o = json!({ "id": x.id, "what": x.what });
            if let Some(n) = &x.needs {
                o["needs"] = json!(needs(n));
            }
            if x.view {
                o["view"] = json!(true);
            }
            o
        })
        .collect();
    Ok(json!({ "actions": out }).into())
}

/// `lacks(c, needs)`: whether what an action needs is missing.
fn lacks(c: &Cx, need: &str) -> bool {
    let app = c.host.app();
    let seq = c.seq();
    let sel = seq.clips_in_order().filter(|x| app.selection.contains(&x.id)).count();
    let io = app.in_out;
    let t = app.t;
    let under: Vec<&cut_model::Clip> = seq
        .clips_in_order()
        .filter(|x| x.start <= t && t < x.end() && !seq.track(x.track).is_some_and(|k| k.locked))
        .collect();
    match need {
        "selection" => sel == 0,
        "two" => sel < 2,
        "clip" => under.is_empty(),
        "video" => !under.iter().any(|x| {
            seq.kind_of(x.track) == Some(cut_model::TrackKind::Video)
                && x.media_id().is_some()
                && !c.project().is_still(x)
        }),
        "in" => io.in_.is_none(),
        "out" => io.out.is_none(),
        "inOut" => match (io.in_, io.out) {
            (Some(i), Some(o)) => o <= i,
            _ => true,
        },
        "marker" => !seq.markers.iter().any(|m| m.t == t || (m.duration > 0 && m.t <= t && t < m.t + m.duration)),
        "markers" => seq.markers.is_empty(),
        "source" => app.edit.source.clip.is_none(),
        "clipboard" => c.host.clipboard() == 0,
        _ => false,
    }
}

/// What a person sees of the editor, before and after an action (`state`).
#[derive(PartialEq)]
struct Seen {
    steps: usize,
    last: Option<String>,
    position: usize,
    sequence: Option<cut_model::Id>,
    playhead: i64,
    selection: String,
    in_: Option<i64>,
    out: Option<i64>,
    tool: &'static str,
    source: String,
    view: String,
}

fn seen(c: &mut Cx) -> Seen {
    let view = c.host.view().to_string();
    let app = c.host.app();
    let h = &app.history;
    let done: Vec<String> = h.list().into_iter().filter(|x| x.done).map(|x| x.label).collect();
    let mut sel: Vec<&str> = app.selection.iter().map(|i| i.as_str()).collect();
    sel.sort_unstable();
    Seen {
        steps: done.len(),
        last: done.last().cloned(),
        position: h.position(),
        sequence: app.sequence_id,
        playhead: app.t,
        selection: sel.join(","),
        in_: app.in_out.in_,
        out: app.in_out.out,
        tool: app.tool.id(),
        source: format!("{:?}", app.edit.source.clip),
        view,
    }
}

pub fn run_action(c: &mut Cx, a: &Json) -> R<Out> {
    let id = s(a, "id").unwrap_or_default();
    let Some(x) = table::actions().iter().find(|x| x.id == id) else {
        return match table::entry(id) {
            Some(table::Entry { no: Some(no), .. }) => refuse(format!("{id} is not for AI: {no}")),
            Some(e) if !e.tools.is_empty() => refuse(format!("{id} has its own tool: {}.", e.tools.join(" or "))),
            _ => refuse(format!("There is no action {id}. list_actions lists them.")),
        };
    };
    c.context(None)?;
    if !c.host.can_act() {
        return refuse("Actions cannot run here.");
    }
    let clips = strs(a, "clip_ids");
    let mut found = Vec::new();
    for cid in clips.iter().flatten() {
        found.push(c.clip_of(cid, false)?.id);
    }
    if let Some(time) = f(a, "time") {
        let t = cut_time::snap(c.time_in(time, "time", false)?, c.fps(), false);
        c.host.seek(t);
    }
    if clips.is_some() {
        c.host.app_mut().select(found, false, false);
    }
    if let Some(n) = &x.needs
        && lacks(c, n)
    {
        return refuse(format!("{id} needs {}, and there is none. Nothing was changed.", needs(n)));
    }
    let before = seen(c);
    let r = c.host.action(id, x.panel.as_deref()).unwrap_or_default();
    if let Some(e) = r["error"].as_str() {
        return refuse(format!("{id} failed: {e}"));
    }
    let after = seen(c);
    let mut changed = Map::new();
    if after.steps != before.steps || after.last != before.last || after.position != before.position {
        changed.insert("undoStep".into(), json!(after.last));
    }
    if after.sequence != before.sequence {
        changed.insert("sequence".into(), json!(after.sequence.map(|i| i.as_str())));
    }
    if after.playhead != before.playhead {
        changed.insert("playhead".into(), c.sec(after.playhead as f64));
    }
    if after.selection != before.selection {
        let l: Vec<&str> = if after.selection.is_empty() { Vec::new() } else { after.selection.split(',').collect() };
        changed.insert("selection".into(), json!(l));
    }
    if after.in_ != before.in_ || after.out != before.out {
        changed.insert(
            "inOut".into(),
            json!({ "in": after.in_.map(|t| c.sec(t as f64)), "out": after.out.map(|t| c.sec(t as f64)) }),
        );
    }
    if after.tool != before.tool {
        changed.insert("tool".into(), json!(after.tool));
    }
    if after.source != before.source {
        let open = c.host.app().edit.source.clip.is_some();
        changed.insert("sourceMonitor".into(), json!(if open { "a clip is open" } else { "empty" }));
    }
    if after.view != before.view {
        changed.insert("view".into(), json!(true));
    }
    let said: Vec<String> = r["toasts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_str().filter(|x| !x.is_empty()).map(str::to_owned))
        .collect();
    if changed.is_empty() && !(x.view && r["ran"] == true) {
        let tail = if said.is_empty() { ".".to_owned() } else { format!("; the editor said: {}", said.join(" ")) };
        return refuse(format!("{id} changed nothing{tail}"));
    }
    let undo = changed.contains_key("undoStep");
    let mut value = json!({ "action": id, "changed": changed, "playhead": c.sec(c.host.app().t as f64) });
    if !said.is_empty() {
        value["said"] = json!(said);
    }
    if undo {
        value["edit"] = json!({ "at": c.host.app().t });
    }
    Ok(value.into())
}
