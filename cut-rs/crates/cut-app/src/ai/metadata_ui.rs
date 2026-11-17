//! YouTube Title, Description and Chapters (`ui-ai.js`'s `youtubeMetadata`, `showMetadata`, `addChapters`): from the
//! sequence's words and markers, titles, a description, chapters (fixed for YouTube) and tags to copy, and the
//! chapters as markers on request (one undo step).
//!
//! The words are the transcripts' (speech recognition), else the shown caption track's.

use cut_formats::table::js_round;
use cut_model::MarkerKind;
use cut_model::commands::build as C;
use eframe::egui::{self, RichText};
use serde_json::{Value as Json, json};

use super::ask::Question;
use super::captions::{BUDGET, Condensed, SYSTEM, Segment, condense, segments_from_captions};
use super::js::T;
use super::metadata::{Chapter, MarkerLine, Metadata, chapter_text, metadata_prompt, validate_metadata};
use super::plan::marker_word;
use crate::auto::dialog;
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// Where the words came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Transcript,
    Captions,
}

/// The metadata shown: Claude's checked answer, the description as edited, and how the prompt was made.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub meta: Metadata,
    pub description: String,
    pub condensed: Condensed,
    pub source: Source,
}

/// The dialog's state.
#[derive(Default)]
pub struct MetadataAi {
    pub shown: Option<Shown>,
}

/// `segmentsFromWords`: the transcript's words as segments of about a sentence (the caption grouping rules).
pub fn segments_from_words(words: &[crate::speech::text::Word], frame: f64) -> Vec<Segment> {
    let o = crate::speech::text::CaptionOpts {
        frame,
        max_chars: 120,
        max_lines: 1,
        max_duration: 12.0,
        pause: 0.8,
        linger: 0.0,
        min_duration: 0.0,
        ..Default::default()
    };
    crate::speech::text::captions(words, &o)
        .into_iter()
        .map(|c| Segment { start: c.start, end: c.end, text: super::js::one_line(&c.text) })
        .collect()
}

/// `sequenceText`: the sequence's words as segments: from the transcripts, else the shown caption track. With neither,
/// a toast, or (clips with speech) the offer to recognise it first, after which `again` runs (`None` then).
pub fn sequence_text(s: &mut Shell, again: Option<super::notice::Pending>) -> Option<(Vec<Segment>, Source)> {
    let seq = s.app.sequence()?;
    let frame = cut_model::query::frame(seq.fps) as f64;
    let clips: Vec<cut_model::Id> =
        seq.clips().filter(|c| crate::speech::flow::speaks(&s.app, seq, c)).map(|c| c.id).collect();
    if !clips.is_empty() {
        crate::speech::flow::load_cached(s);
        let words = crate::speech::flow::sequence_words(s);
        if !words.is_empty() {
            return Some((segments_from_words(&words, frame), Source::Transcript));
        }
    }
    let id = crate::captions::shown(s);
    let track = s.app.sequence().and_then(|q| q.captions.iter().find(|t| Some(t.id) == id));
    if let Some(t) = track.filter(|t| !t.items.is_empty()) {
        return Some((segments_from_captions(&t.items), Source::Captions));
    }
    match again {
        _ if clips.is_empty() => {
            s.app.toast(tr("The sequence has no words to work from: add captions, or clips with speech."));
        }
        None => s.app.toast(tr("No speech was recognized.")),
        Some(then) => s.features.ai.notice.transcribe(clips, then),
    }
    None
}

/// `trimmedNote`.
pub fn trimmed_note(c: &Condensed) -> String {
    if !c.trimmed {
        return String::new();
    }
    trf(
        "The transcript is long: an evenly shortened version ({kept} of {lines} lines) was sent.",
        &[("kept", &c.kept.to_string()), ("lines", &c.lines.to_string())],
    )
}

/// YouTube Title, Description and Chapters… chosen.
pub fn open(s: &mut Shell) {
    ask(s, true);
}

fn ask(s: &mut Shell, first: bool) {
    if s.app.sequence().is_none() {
        return;
    }
    let again: Option<super::notice::Pending> = first.then(|| Box::new(|s: &mut Shell| ask(s, false)) as _);
    let Some((segments, source)) = sequence_text(s, again) else { return };
    let Some(seq) = s.app.sequence() else { return };
    let ends = seq.captions.iter().flat_map(|t| t.items.iter().map(|it| it.end));
    let duration = ends.chain([seq.duration(), 0]).max().unwrap_or(0) as f64;
    if duration <= 0.0 {
        s.app.toast(tr("The sequence is empty."));
        return;
    }
    let condensed = condense(&segments, BUDGET, 200);
    let markers: Vec<MarkerLine> =
        seq.markers.iter().map(|m| MarkerLine { t: m.t as f64, kind: marker_word(m.kind), name: &m.name }).collect();
    let prompt = metadata_prompt(&seq.name, duration, &condensed.text, &markers);
    let intro = tr("Intro").into_owned();
    super::job(s, "Writing the YouTube description with Claude…", move |ctx| {
        let q = Question { task: "metadata", system: SYSTEM, prompt, part: (0.0, 1.0), expect: 2500.0, label: None };
        let meta = ctx.ask(q, |v| validate_metadata(v, duration, &intro))?;
        Ok(Box::new(move |s: &mut Shell| {
            let description = meta.description.clone();
            s.features.ai.metadata.shown = Some(Shown { meta, description, condensed, source });
        }))
    });
}

/// `addChapters`: the sequence's chapter markers replaced by these, one undo step.
pub fn add_chapters(s: &mut Shell, chapters: &[Chapter]) -> bool {
    let Some(seq) = s.app.sequence() else { return false };
    let f = cut_model::query::frame(seq.fps) as f64;
    let id = seq.id.as_str();
    let mut cmds: Vec<Json> = seq
        .markers
        .iter()
        .filter(|m| m.kind == MarkerKind::Chapter)
        .map(|m| C::remove_marker(id, m.id.as_str()))
        .collect();
    for c in chapters {
        let t = (js_round((c.t * T) / f) * f) as i64;
        cmds.push(C::add_marker(id, json!({ "t": t, "name": c.title, "kind": "chapter", "color": "blue" }), json!({})));
    }
    let ok = s.app.exec(&C::batch("Add Chapter Markers", cmds)).is_some();
    if ok {
        s.app.toast(trf("Chapter markers added: {n}.", &[("n", &chapters.len().to_string())]));
    }
    ok
}

fn copy(s: &mut Shell, ctx: &egui::Context, text: String, what: &str) {
    ctx.copy_text(text);
    s.app.toast(trf("Copied: {what}.", &[("what", &tr(what))]));
}

fn note(ui: &mut egui::Ui, s: &Shell, text: &str) {
    ui.label(RichText::new(text).color(s.palette.gray[8]).size(12.0));
}

/// The dialog, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let Some(mut m) = s.features.ai.metadata.shown.clone() else { return };
    let chapters = chapter_text(&m.meta.chapters);
    let mut copies: Vec<(String, &str)> = Vec::new();
    let (mut add, mut close) = (false, false);
    dialog("YouTube Title, Description and Chapters", "cutAiMetadata", 640.0).show(ctx, |ui| {
        ui.label(RichText::new(tr("Titles")).strong());
        for t in &m.meta.titles {
            ui.horizontal(|ui| {
                ui.label(t);
                if ui.button(tr("Copy")).clicked() {
                    copies.push((t.clone(), "The title"));
                }
            });
        }
        ui.separator();
        ui.label(RichText::new(tr("Description")).strong());
        ui.add(egui::TextEdit::multiline(&mut m.description).desired_rows(7).desired_width(f32::INFINITY));
        ui.horizontal(|ui| {
            if ui.button(tr("Copy")).clicked() {
                copies.push((m.description.clone(), "The description"));
            }
            if ui.button(tr("Copy with Chapters")).clicked() {
                let all = if chapters.is_empty() {
                    m.description.clone()
                } else {
                    format!("{}\n\n{chapters}", super::js::trim(&m.description))
                };
                copies.push((all, "The description"));
            }
        });
        ui.separator();
        ui.label(RichText::new(tr("Chapters")).strong());
        if chapters.is_empty() {
            ui.label(tr("No chapters: YouTube needs a video of at least 30 seconds for three chapters of 10 seconds."));
        } else {
            ui.label(RichText::new(&chapters).monospace());
        }
        if !m.meta.fixed.is_empty() {
            let notes: Vec<String> = m.meta.fixed.iter().map(|n| tr(n).into_owned()).collect();
            note(ui, s, &trf("Fixed for YouTube: {notes}", &[("notes", &notes.join(" "))]));
        }
        if !m.meta.chapters.is_empty() {
            ui.horizontal(|ui| {
                if ui.button(tr("Copy")).clicked() {
                    copies.push((chapters.clone(), "The chapters"));
                }
                add = ui
                    .button(tr("Add as Chapter Markers"))
                    .on_hover_text(tr("Replaces the sequence's chapter markers (one undo step)"))
                    .clicked();
            });
        }
        ui.separator();
        ui.label(RichText::new(tr("Tags")).strong());
        let tags = m.meta.tags.join(", ");
        ui.horizontal(|ui| {
            ui.label(if tags.is_empty() { "-".to_owned() } else { tags.clone() });
            if ui.button(tr("Copy")).clicked() {
                copies.push((tags.clone(), "The tags"));
            }
        });
        let from = match m.source {
            Source::Transcript => tr("Made from the transcript and the markers."),
            Source::Captions => tr("Made from the captions and the markers."),
        };
        let line = [from.into_owned(), trimmed_note(&m.condensed)].into_iter().filter(|x| !x.is_empty());
        note(ui, s, &line.collect::<Vec<_>>().join(" "));
        close = ui.button(tr("Close")).clicked();
    });
    let chapters_list = m.meta.chapters.clone();
    s.features.ai.metadata.shown = (!close).then_some(m);
    for (text, what) in copies {
        copy(s, ctx, text, what);
    }
    if add {
        add_chapters(s, &chapters_list);
    }
}
