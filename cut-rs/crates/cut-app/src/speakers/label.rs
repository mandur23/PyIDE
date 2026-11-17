//! Label Speakers and the changes by hand (`ui-speakers.js label`, `rename`, `reassign`, `captionUpdates`,
//! `wordSpeakers`, `captions`): the labels made from the embeddings of the transcripts' windows, matched to the
//! speakers of before so names and colours stay; a speaker renamed; a stretch of words given to another speaker or a
//! new one; and the captions that name a speaker following the labels in the same undo step.

use std::collections::BTreeMap;

use cut_model::commands::build as C;
use cut_model::{Id, Media};
use eframe::egui;
use serde_json::{Value as Json, json};

use super::core::{self as K, Labels, Opts, Speaker, Turn, Word};
use super::embed::{Embedder, embed_media};
use crate::auto::{Step, Stop};
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::speech::text::Caption;
use crate::state::App;
use crate::voice::setup::{Model, Outcome, Setup};

/// A media file's transcript to label: its words in source seconds, in time order.
pub struct MediaWords {
    pub media: Media,
    pub words: Vec<Word>,
}

/// What a labelling found: the turns of each media file with labels `"0"`, `"1"`, ..., and how many labels.
#[derive(Debug, Clone, PartialEq)]
pub struct Labelled {
    pub turns: BTreeMap<String, Vec<Turn>>,
    pub n: usize,
}

/// The labelling on the analysis thread (`label`'s task after recognition): each media file's windows embedded, all
/// of them clustered together, each word's speaker, the turns. `split` is the share of the progress recognition took.
/// -> `None` when there is no speech.
pub fn label(
    e: &Embedder<'_>,
    jobs: &[MediaWords],
    count: u32,
    step: &Step,
    split: f64,
) -> Result<Option<Labelled>, Stop> {
    let o = Opts::default();
    let jobs: Vec<(&MediaWords, Vec<K::Window>)> =
        jobs.iter().map(|j| (j, K::windows_of(&j.words, &o))).filter(|(_, w)| !w.is_empty()).collect();
    if jobs.is_empty() {
        return Ok(None);
    }
    let total: usize = jobs.iter().map(|(_, w)| w.len()).sum();
    let mut done = 0;
    let mut kept = Vec::new();
    for (j, windows) in &jobs {
        let base = done;
        let n = windows.len();
        let emb = embed_media(e, &j.media, windows, step, &|f| {
            step.progress(split + (1.0 - split) * 0.95 * ((base as f64 + f * n as f64) / total as f64));
        })?;
        kept.push(emb);
        done += n;
    }
    step.step().map_err(Err)?;
    let mut vectors: Vec<Option<&[f32]>> = Vec::with_capacity(total);
    let mut speech = Vec::with_capacity(total);
    for ((_, windows), emb) in jobs.iter().zip(&kept) {
        for (k, w) in windows.iter().enumerate() {
            vectors.push(emb.as_ref().and_then(|e| e.data.get(k * e.dim..(k + 1) * e.dim)));
            speech.push(w.speech);
        }
    }
    let opts = Opts { count: (count > 0).then_some(f64::from(count)), ..o };
    let labels = K::cluster(&vectors, &speech, &opts);
    let mut turns = BTreeMap::new();
    let mut from = 0;
    for (j, windows) in &jobs {
        let wl = K::word_labels(&j.words, windows, &labels[from..from + windows.len()], &o);
        let ids: Vec<String> = wl.iter().map(|l| l.to_string()).collect();
        let ids: Vec<Option<&str>> = wl.iter().zip(&ids).map(|(l, s)| (*l >= 0).then_some(s.as_str())).collect();
        turns.insert(j.media.id.as_str().to_owned(), K::turns_of(&j.words, &ids));
        from += windows.len();
    }
    step.progress(1.0);
    Ok(Some(Labelled { turns, n: labels.iter().max().map_or(0, |m| (m + 1).max(0) as usize) }))
}

/// The clips whose speech counts in the sequence.
fn speaking(app: &App) -> Vec<Id> {
    let Some(seq) = app.sequence() else { return Vec::new() };
    seq.clips().filter(|c| crate::speech::flow::speaks(app, seq, c)).map(|c| c.id).collect()
}

/// Label Speakers (the Automation menu, the Transcript panel): `count` speakers (`None`: the count the labels were made
/// with, else Auto). As `label` asks: Whisper's setup dialog first when some clip is not transcribed yet (and the voice
/// model's when the voice is isolated first), then the speakers' model's, then recognition of what is not transcribed
/// and the labelling.
pub fn start(s: &mut Shell, count: Option<u32>) {
    if crate::speech::busy(s) || super::running(s) || crate::voice::running(s) {
        s.app.toast(tr("Another analysis is running."));
        return;
    }
    let count = count.unwrap_or_else(|| Labels::of(s.app.project()).map_or(0, |l| l.count));
    if speaking(&s.app).is_empty() {
        s.app.toast(tr("There are no clips with speech to transcribe."));
        return;
    }
    s.features.speakers.backend.configure(s.doc.settings.get("ai.idleUnloadMinutes"));
    go(s, count);
}

/// Whether the speakers' model is there; else its setup dialog opens, and Label Speakers goes on from [`go`] once it
/// is downloaded.
pub fn ready(s: &mut Shell, count: u32) -> bool {
    let st = s.features.speakers.backend.status();
    if st.runtime && st.installed {
        return true;
    }
    let need = crate::voice::setup::Need {
        name: super::backend::NAME,
        bytes: super::backend::BYTES,
        installed: st.installed,
        runtime: st.runtime,
        runtime_bytes: st.runtime_bytes,
    };
    s.features.speakers.setup = Some(Setup::new(Model::Speakers, need));
    s.features.speakers.want = Some(count);
    false
}

/// Recognition first when some clip is not transcribed (after the models it needs, then the speakers' model), else
/// the labelling once the speakers' model is there.
pub fn go(s: &mut Shell, count: u32) {
    crate::speech::flow::load_cached(s);
    let ids = speaking(&s.app);
    let store = crate::speech::store(s);
    let o = crate::speech::opts(s);
    let untranscribed = {
        let g = store.lock().unwrap_or_else(|e| e.into_inner());
        let p = s.app.project();
        let seq = s.app.sequence();
        ids.iter().any(|id| {
            let m = seq.and_then(|q| q.clip(*id)).and_then(|c| c.media_id()).and_then(|m| p.media(m));
            m.is_some_and(|m| g.transcript_of(m, &o).is_none())
        })
    };
    if untranscribed {
        crate::speech::dialogs::ensure_ready(s, None, crate::speech::Goal::Speakers { ids, count });
    } else if ready(s, count) {
        run_labels(s, count);
    }
}

/// The labelling of the transcribed clips' media on the analysis thread.
pub fn run_labels(s: &mut Shell, count: u32) {
    let store = crate::speech::store(s);
    let o = crate::speech::opts(s);
    let files = crate::speech::sound_files(s);
    let mut jobs: Vec<MediaWords> = Vec::new();
    {
        let g = store.lock().unwrap_or_else(|e| e.into_inner());
        let p = s.app.project();
        let seq = s.app.sequence();
        for id in speaking(&s.app) {
            let Some(m) = seq.and_then(|q| q.clip(id)).and_then(|c| c.media_id()).and_then(|m| p.media(m)) else {
                continue;
            };
            if jobs.iter().any(|j| j.media.id == m.id) {
                continue;
            }
            let mut words = g.transcript_of(m, &o).map(|(_, t)| t.words.clone()).unwrap_or_default();
            words.sort_by(|a, b| a.t0.partial_cmp(&b.t0).unwrap_or(std::cmp::Ordering::Equal));
            jobs.push(MediaWords { media: m.clone(), words });
        }
    }
    let gb = Some(crate::prefs::number(&s.doc.settings, "cacheLimitGB")).filter(|v| *v > 0.0);
    let cache = crate::files::cache::Cache::new(s.doc.home.cache.clone(), (gb.unwrap_or(10.0) * 1073741824.0) as u64);
    let (backend, memory) = (s.features.speakers.backend.clone(), s.features.speakers.memory.clone());
    let job = crate::auto::Job::start(tr("Labeling speakers…").into_owned(), false, move |step| {
        let e = Embedder { backend: &backend, memory: &memory, cache: &cache, files: &files };
        label(&e, &jobs, count, step, 0.0)
    });
    s.features.speakers.job = Some(job);
    s.features.speakers.count = count;
}

/// Takes in a finished labelling: the labels made, one undo step.
pub fn poll(s: &mut Shell) {
    let Some(out) = s.features.speakers.job.as_ref().and_then(|j| j.poll(false)) else { return };
    s.features.speakers.job = None;
    match out {
        crate::auto::Outcome::Done(None) => s.app.toast(tr("No speech was recognized.")),
        crate::auto::Outcome::Done(Some(made)) => {
            let words = crate::speech::flow::sequence_words(s);
            let (cmd, found) = commands(&s.app, &made, s.features.speakers.count, &words);
            if s.app.exec(&cmd).is_some() {
                s.app.toast(trf("Speakers labeled: {n}.", &[("n", &found.to_string())]));
            }
        }
        crate::auto::Outcome::Failed(e) => match e.strip_prefix("speakers:") {
            Some(m) => s.app.report(trf("Speaker labels failed: {error}", &[("error", m)])),
            None => s.app.report(tr(&e).into_owned()),
        },
        crate::auto::Outcome::Cancelled => s.app.toast(tr("The analysis was cancelled.")),
    }
}

/// The setup dialog, each frame.
fn setup_window(s: &mut Shell, ctx: &egui::Context) {
    let Some(mut dialog) = s.features.speakers.setup.take() else { return };
    let backend = s.features.speakers.backend.clone();
    let wake = ctx.clone();
    let mut toasts = Vec::new();
    let outcome = dialog.show(ctx, &mut |t| toasts.push(t), &mut |d: &mut Setup| {
        let b = backend.clone();
        d.start(move |job, progress| b.setup(job, progress), wake.clone());
    });
    for t in toasts {
        s.app.toast(t);
    }
    match outcome {
        Outcome::Open => s.features.speakers.setup = Some(dialog),
        Outcome::Ready => {
            if let Some(count) = s.features.speakers.want.take() {
                go(s, count);
            }
        }
        Outcome::Closed => s.features.speakers.want = None,
    }
}

/// JavaScript's truthiness of a style flag.
fn on(style: &cut_model::Extra, key: &str) -> bool {
    match style.get(key) {
        Some(Json::Bool(b)) => *b,
        Some(Json::Null) | None => false,
        Some(Json::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Json::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// The speaker of each timeline word by the turns of its clip's media at the source time of its middle
/// (`wordSpeakers`).
pub fn word_speakers(app: &App, words: &[Word], sp: Option<&Labels>) -> Vec<Option<String>> {
    let (Some(sp), Some(seq)) = (sp.filter(|s| !s.list.is_empty()), app.sequence()) else {
        return vec![None; words.len()];
    };
    let t = cut_time::TICKS as f64;
    words
        .iter()
        .map(|w| {
            let c = seq.clip(w.clip?)?;
            let turns = sp.turns.get(c.media_id()?.as_str())?;
            K::at(turns, c.source_time((w.t0 + w.t1) / 2.0) / t, 1.0).map(str::to_owned)
        })
        .collect()
}

/// The captions that name a speaker (or are on a track showing speakers) given the speaker most of their words have
/// under `sp` (`captionUpdates`): the commands, so a change of labels carries to them in the same undo step.
pub fn caption_updates(app: &App, words: &[Word], sp: &Labels) -> Vec<Json> {
    let Some(seq) = app.sequence() else { return Vec::new() };
    let ids = word_speakers(app, words, Some(sp));
    let mut out = Vec::new();
    for ct in &seq.captions {
        if !on(&ct.style, "speakerColor")
            && !on(&ct.style, "speakerName")
            && !ct.items.iter().any(|it| it.speaker.is_some())
        {
            continue;
        }
        for it in &ct.items {
            let mut time: Vec<(&str, f64)> = Vec::new();
            for (w, id) in words.iter().zip(&ids) {
                let ov = w.t1.min(it.end as f64) - w.t0.max(it.start as f64);
                if let Some(id) = id.as_deref().filter(|_| ov > 0.0) {
                    match time.iter_mut().find(|(x, _)| *x == id) {
                        Some(e) => e.1 += ov,
                        None => time.push((id, ov)),
                    }
                }
            }
            time.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let best = time.first().map(|x| x.0);
            let (sid, tid, iid) = (seq.id.as_str(), ct.id.as_str(), it.id.as_str());
            match (best, it.speaker.as_deref().filter(|s| !s.is_empty())) {
                (Some(b), now) if Some(b) != now => out.push(C::set_caption(sid, tid, iid, json!({ "speaker": b }))),
                (None, Some(now)) if sp.get(now).is_none() => {
                    out.push(C::set_caption(sid, tid, iid, json!({ "speaker": null })))
                }
                _ => {}
            }
        }
    }
    out
}

/// The labels a labelling makes (`label`'s end): the new labels matched to the speakers of before, speakers of other
/// media files kept, and the captions following them -> the batch and how many speakers were found.
pub fn commands(app: &App, made: &Labelled, count: u32, words: &[Word]) -> (Json, usize) {
    let before = Labels::of(app.project());
    let new_ids: Vec<String> = (0..made.n).map(|k| k.to_string()).collect();
    let empty = BTreeMap::new();
    let matched = K::match_labels(before.as_ref().map_or(&empty, |b| &b.turns), &made.turns, &new_ids);
    let old_list = before.as_ref().map_or(&[][..], |b| b.list.as_slice());
    let (mut list, id_of) = K::list_for(made.n, old_list, &matched, &K::in_use(app.project()));
    let turns: BTreeMap<String, Vec<Turn>> = made
        .turns
        .iter()
        .map(|(m, t)| {
            let t =
                t.iter().filter_map(|(a, b, l)| Some((*a, *b, id_of.get(l.parse::<usize>().ok()?)?.clone()))).collect();
            (m.clone(), t)
        })
        .collect();
    // speakers of other media files' labels (not in this sequence) stay in the list
    if let Some(b) = &before {
        for (m, t) in &b.turns {
            if turns.contains_key(m) {
                continue;
            }
            for (_, _, id) in t {
                if !list.iter().any(|s| s.id == *id)
                    && let Some(s) = b.get(id)
                {
                    list.push(s.clone());
                }
            }
        }
    }
    let count = count.min(K::MAX as u32);
    let mut all = before.as_ref().map(|b| b.turns.clone()).unwrap_or_default();
    all.extend(turns.clone());
    let next = Labels { list: list.clone(), turns: all, count };
    let mut cmds = vec![C::set_speakers(Some(json!({ "list": list, "turns": turns, "count": count })))];
    cmds.extend(caption_updates(app, words, &next));
    let mut found: Vec<&str> = turns.values().flatten().map(|t| t.2.as_str()).collect();
    found.sort_unstable();
    found.dedup();
    (C::batch("Label Speakers", cmds), found.len())
}

/// The words given to speaker `id` (`None`: a new speaker), one undo step: their media's turns over the source
/// seconds the words span (`reassign`). -> whether it was done.
pub fn reassign(app: &mut App, words: &[Word], all_words: &[Word], id: Option<&str>) -> bool {
    let (Some(sp), Some(seq)) = (Labels::of(app.project()), app.sequence()) else { return false };
    if words.is_empty() {
        return false;
    }
    let mut list = sp.list.clone();
    let id: String = match id {
        Some(id) => id.to_owned(),
        None => {
            let same: Vec<(String, String)> =
                list.iter().enumerate().map(|(k, s)| (k.to_string(), s.id.clone())).collect();
            let (made, ids) = K::list_for(list.len() + 1, &list, &same, &K::in_use(app.project()));
            list = made;
            ids[list.len() - 1].clone()
        }
    };
    let t = cut_time::TICKS as f64;
    let mut spans: Vec<(String, f64, f64)> = Vec::new();
    for w in words {
        let Some(c) = w.clip.and_then(|id| seq.clip(id)) else { continue };
        let Some(m) = c.media_id() else { continue };
        let x = c.source_time(w.t0) / t;
        let y = c.source_time(w.t0.max(w.t1 - 1.0)) / t;
        match spans.iter_mut().find(|s| s.0 == m.as_str()) {
            Some(s) => {
                s.1 = s.1.min(x.min(y));
                s.2 = s.2.max(x.max(y));
            }
            None => spans.push((m.as_str().to_owned(), x.min(y), x.max(y))),
        }
    }
    let mut turns = BTreeMap::new();
    for (m, a, b) in spans {
        if b > a {
            let now = sp.turns.get(&m).map_or(&[][..], Vec::as_slice);
            turns.insert(m, K::assign(now, a, b, &id));
        }
    }
    // a speaker no turn names any more leaves the list
    let mut all = sp.turns.clone();
    all.extend(turns.clone());
    list.retain(|s| all.values().flatten().any(|t| t.2 == s.id));
    let next = Labels { list: list.clone(), turns: all, count: sp.count };
    let mut cmds = vec![C::set_speakers(Some(json!({ "list": list, "turns": turns })))];
    cmds.extend(caption_updates(app, all_words, &next));
    app.exec(&C::batch("Change Speaker", cmds)).is_some()
}

/// The name shown for a speaker of the project (`nameOf`).
pub fn name_of(app: &App, id: &str) -> String {
    let list = Labels::of(app.project()).map(|l| l.list).unwrap_or_default();
    K::name_of(&list, id, &tr("Speaker {n}"))
}

/// Renames a speaker, one undo step; an empty name goes back to "Speaker N" (`rename`'s OK).
pub fn rename(app: &mut App, id: &str, name: &str) -> bool {
    let Some(sp) = Labels::of(app.project()) else { return false };
    let Some(s) = sp.get(id) else { return false };
    let units: Vec<u16> = name.split_whitespace().collect::<Vec<_>>().join(" ").encode_utf16().take(60).collect();
    let name = String::from_utf16_lossy(&units);
    if name == s.name {
        return true;
    }
    let list: Vec<Speaker> = sp
        .list
        .iter()
        .map(|x| if x.id == id { Speaker { name: name.clone(), ..x.clone() } } else { x.clone() })
        .collect();
    app.exec(&C::batch("Rename Speaker", vec![C::set_speakers(Some(json!({ "list": list })))])).is_some()
}

/// The setup dialog, the labelling's result and the Rename Speaker dialog, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    setup_window(s, ctx);
    poll(s);
    let Some((id, mut name)) = s.features.speakers.rename.take() else { return };
    let Some(sp) = Labels::of(s.app.project()) else { return };
    let Some(place) = sp.list.iter().position(|x| x.id == id) else { return };
    let unnamed = trf("Speaker {n}", &[("n", &(place + 1).to_string())]);
    let (mut ok, mut cancel, mut open) = (false, false, true);
    egui::Window::new(tr("Rename Speaker"))
        .id(egui::Id::unique("cutSpeakerRename"))
        .open(&mut open)
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_CENTER, egui::Vec2::ZERO)
        .default_width(400.0)
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(tr("Name"));
                let r = ui.add(egui::TextEdit::singleline(&mut name).hint_text(&unnamed).desired_width(260.0));
                if r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                    ok = true;
                }
            });
            ui.label(trf(
                "Empty: \"{name}\". The name shows in the Transcript panel and in captions that show speakers' names.",
                &[("name", &unnamed)],
            ));
            ui.horizontal(|ui| {
                ok |= ui.button(tr("OK")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
    if ok {
        rename(&mut s.app, &id, &name);
    } else if !cancel && open {
        s.features.speakers.rename = Some((id, name));
    }
}

/// How a caption track shows speakers (`CAPTION_MODES`): the setting's word and the label.
pub const CAPTION_MODES: [(&str, &str); 4] = [
    ("off", "No speakers"),
    ("color", "Speaker colors"),
    ("name", "Speaker names"),
    ("both", "Speaker colors and names"),
];

/// Auto Captions' speakers choice (`captionField`): the remembered mode (`cut.speakers.captions`, colours by default),
/// when the project has speaker labels.
pub fn caption_mode(s: &Shell) -> Option<&'static str> {
    Labels::of(s.app.project()).filter(|l| !l.list.is_empty())?;
    let saved = s.doc.settings.get("speakers.captions").and_then(Json::as_str);
    Some(CAPTION_MODES.iter().map(|m| m.0).find(|m| Some(*m) == saved).unwrap_or("color"))
}

/// Captions of timeline words that never hold two speakers, each with its speaker (`captions`): `make` turns a run of
/// one speaker's words into captions; a caption that would run into the next ends where it starts (a frame at
/// least). Without labels, `make` of all the words.
pub fn captions(
    app: &App,
    words: &[Word],
    make: impl Fn(&[Word]) -> Vec<Caption>,
    frame: f64,
) -> Vec<(Caption, Option<String>)> {
    let sp = Labels::of(app.project());
    let ids = word_speakers(app, words, sp.as_ref());
    if !ids.iter().any(Option::is_some) {
        return make(words).into_iter().map(|c| (c, None)).collect();
    }
    let mut items: Vec<(Caption, Option<String>)> = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let j = (i..words.len()).find(|&k| ids[k] != ids[i]).unwrap_or(words.len());
        items.extend(make(&words[i..j]).into_iter().map(|c| (c, ids[i].clone())));
        i = j;
    }
    items.sort_by(|a, b| a.0.start.partial_cmp(&b.0.start).unwrap_or(std::cmp::Ordering::Equal));
    for k in 0..items.len().saturating_sub(1) {
        let next = items[k + 1].0.start;
        let c = &mut items[k].0;
        if c.end > next {
            c.end = (c.start + frame).max(next);
        }
    }
    items
}

/// The style flags of a mode (`styleOf`).
pub fn style_of(mode: &str) -> Json {
    json!({ "speakerColor": mode == "color" || mode == "both", "speakerName": mode == "name" || mode == "both" })
}

/// The Caption Style dialog's Speakers row: the mode chosen in a list.
pub fn style_row(ui: &mut egui::Ui, mode: &mut &'static str) {
    ui.horizontal(|ui| {
        ui.label(tr("Speakers"));
        let label = |m: &str| CAPTION_MODES.iter().find(|(v, _)| *v == m).map_or("", |(_, l)| *l);
        egui::ComboBox::from_id_salt("cut-cap-speakers").selected_text(tr(label(mode))).show_ui(ui, |ui| {
            for (v, l) in CAPTION_MODES {
                ui.selectable_value(mode, v, tr(l));
            }
        });
    });
}

/// The mode of a track's style (`modeOf`).
pub fn mode_of(style: &cut_model::Extra) -> &'static str {
    match (on(style, "speakerColor"), on(style, "speakerName")) {
        (true, true) => "both",
        (true, false) => "color",
        (false, true) => "name",
        (false, false) => "off",
    }
}
