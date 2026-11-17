//! The Transcript panel (`ui-speech.js mount`): the sequence's words with their times, a paragraph at each pause of
//! 1.2 s and wherever the speaker changes. The word under the playhead is lit; a click moves the playhead to a word,
//! a drag or Shift+click chooses a run of words, a double click corrects one (Enter or leaving keeps the text, Esc
//! puts it back; a word kept as it was is confirmed, no longer uncertain); Delete or Remove ripple-deletes the chosen
//! words from their clips' tracks and the tracks linked to them, one undo step. Transcribe, the search (Enter for the
//! next match, Shift+Enter the one before), Fillers…, Word List… and the uncertain words' count with Next Uncertain
//! Word. The speakers' row and each paragraph's speaker menu are `crate::speakers::row`.
//!
//! The words are read again only when the project, the sequence, the transcripts or the marks setting change.

use cut_model::Id;
use cut_time::{TICKS, snap, timecode};
use eframe::egui::{self, Color32, Key, Modifiers, RichText, Sense, Stroke, Vec2};

use super::text::{self, UNCERTAIN, Word};
use super::{Goal, flow};
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::speakers::core::Labels;
use crate::state::Panel;

/// The colour of matches and of the uncertain words' wavy line (`--yellow`).
const YELLOW: Color32 = Color32::from_rgb(0xf5, 0xc5, 0x42);
/// The search field's id.
pub const SEARCH: &str = "cut-tr-search";
/// A pause this long starts a paragraph.
const PARAGRAPH: f64 = 1.2;

/// What the words were read for: the project's revision, the sequence, the transcripts' generation, the marks.
type Read = (u64, Option<Id>, u64, bool);

/// The panel's state: the words shown and what is chosen of them.
#[derive(Default)]
pub struct Transcript {
    read: Option<Read>,
    /// The sequence's words on the timeline, in time order, and each one's speaker.
    pub words: Vec<Word>,
    pub ids: Vec<Option<String>>,
    /// The project's speaker labels as the words were read.
    pub labels: Option<Labels>,
    /// The first word of each paragraph.
    pub paras: Vec<usize>,
    /// The run of words chosen, or the words picked one by one (a speaker's: Select Words).
    pub sel: Option<(usize, usize)>,
    pub pick: Option<Vec<usize>>,
    anchor: Option<usize>,
    dragging: bool,
    pub search: String,
    matches: Vec<(usize, usize)>,
    match_at: Option<usize>,
    /// The word being corrected and its text so far; whether its field has had the keyboard yet.
    pub editing: Option<(usize, String, bool)>,
    /// The word to scroll to on the next frame.
    scroll_to: Option<usize>,
    /// Label Speakers' count chosen in the row before the project has labels, for that sequence only.
    pub count: Option<(Id, u32)>,
}

impl Transcript {
    /// The words chosen, in order.
    pub fn chosen(&self) -> Vec<usize> {
        match (&self.pick, self.sel) {
            (Some(p), _) => p.clone(),
            (None, Some((i, j))) => (i..=j).collect(),
            (None, None) => Vec::new(),
        }
    }

    /// Words `i..=j` chosen (`select`).
    fn select(&mut self, i: usize, j: usize) {
        self.sel = Some((i.min(j), i.max(j)));
        self.pick = None;
    }

    /// The word indexes of the paragraph that starts at word `start` (`segmentOf`).
    pub fn segment(&self, start: usize) -> Vec<usize> {
        let Some(p) = self.paras.iter().position(|&x| x == start) else { return Vec::new() };
        let end = self.paras.get(p + 1).copied().unwrap_or(self.words.len());
        (start..end).collect()
    }

    /// Words picked one by one (Select Words of a speaker): Delete and Remove take them all.
    pub fn pick_words(&mut self, list: Vec<usize>) {
        self.sel = None;
        self.scroll_to = list.iter().min().copied();
        self.pick = (!list.is_empty()).then_some(list);
    }

    fn find(&mut self) {
        self.matches = text::search(&self.words, &self.search);
        self.match_at = None;
    }
}

/// Whether a word is marked as one Whisper was unsure of (`doubtful`).
fn doubtful(s: &Shell, w: &Word) -> bool {
    super::marking(s) && text::is_uncertain(w.p, UNCERTAIN)
}

/// Reads the words again when what they come from changed (`draw`); a sequence opened reads its cached transcripts
/// first and forgets what was chosen.
pub fn refresh(s: &mut Shell) {
    let generation = super::store(s).lock().unwrap_or_else(|e| e.into_inner()).generation();
    let key = (s.app.history.revision(), s.app.sequence_id, generation, super::marking(s));
    let p = &s.features.speech.panel;
    if p.read == Some(key) {
        return;
    }
    if p.read.is_none_or(|r| r.1 != key.1) {
        s.features.speech.panel.sel = None;
        s.features.speech.panel.pick = None;
        flow::load_cached(s);
    }
    let words = flow::sequence_words(s);
    let labels = Labels::of(s.app.project());
    let ids = crate::speakers::label::word_speakers(&s.app, &words, labels.as_ref());
    let mut paras = Vec::new();
    for i in 0..words.len() {
        if i == 0 || words[i].t0 - words[i - 1].t1 >= PARAGRAPH * TICKS as f64 || ids[i] != ids[i - 1] {
            paras.push(i);
        }
    }
    let generation = super::store(s).lock().unwrap_or_else(|e| e.into_inner()).generation();
    let p = &mut s.features.speech.panel;
    if p.sel.is_some_and(|(_, j)| j >= words.len()) {
        p.sel = None;
    }
    if p.pick.as_ref().is_some_and(|k| k.iter().any(|&i| i >= words.len())) {
        p.pick = None;
    }
    p.words = words;
    p.ids = ids;
    p.labels = labels;
    p.paras = paras;
    p.find();
    p.read = Some((key.0, key.1, generation, key.3));
}

/// The ranges that remove the chosen words, on frames, and the clips they are of.
fn removal(s: &Shell) -> Option<(Vec<super::Span>, Vec<Id>)> {
    let p = &s.features.speech.panel;
    let seq = s.app.sequence()?;
    let chosen = p.chosen();
    let ranges = text::removal_ranges(&p.words, &chosen, cut_model::query::frame(seq.fps) as f64);
    let mut clips: Vec<Id> = Vec::new();
    for c in chosen.iter().filter_map(|&k| p.words.get(k)?.clip) {
        if !clips.contains(&c) && seq.clip(c).is_some() {
            clips.push(c);
        }
    }
    (!ranges.is_empty()).then_some((ranges, clips))
}

/// Whether the panel takes `id` now: Delete or Ripple Delete while it has the keyboard and words are chosen whose
/// removal cuts something (else the timeline's Delete runs, as `removeSelected() || false` lets it).
pub fn takes(s: &Shell, id: &str) -> bool {
    matches!(id, "delete" | "rippleDelete")
        && s.app.focus == Some(Panel::Transcript)
        && (s.features.speech.panel.sel.is_some() || s.features.speech.panel.pick.is_some())
        && removal(s).is_some()
}

/// Delete Words (`removeSelected`): the chosen words ripple-deleted, one undo step, the playhead at the first cut.
/// -> whether something was cut.
pub fn remove_selected(s: &mut Shell) -> bool {
    let Some((ranges, clips)) = removal(s) else { return false };
    if !flow::ripple(s, &ranges, &clips, "Delete Words") {
        return false;
    }
    let p = &mut s.features.speech.panel;
    (p.sel, p.pick, p.anchor) = (None, None, None);
    s.app.set_time(ranges[0].0 as i64);
    true
}

/// The word at frame `t` chosen and scrolled to (Next Uncertain Word): an uncertain word starting on that frame,
/// else the word there.
pub fn reveal(s: &mut Shell, t: i64) {
    refresh(s);
    let Some(fps) = s.app.sequence().map(|q| q.fps) else { return };
    let p = &s.features.speech.panel;
    let at = p.words.iter().position(|w| snap(w.t0 as i64, fps, false) == t && doubtful(s, w));
    let Some(i) = at.or_else(|| text::word_at(&s.features.speech.panel.words, t as f64)) else { return };
    let p = &mut s.features.speech.panel;
    p.select(i, i);
    p.scroll_to = Some(i);
}

/// The Transcript panel's Transcribe (`transcribeSequence`): every clip with speech recognised.
fn transcribe_sequence(s: &mut Shell) {
    let Some(seq) = s.app.sequence() else { return };
    let ids: Vec<Id> = seq.clips().filter(|c| flow::speaks(&s.app, seq, c)).map(|c| c.id).collect();
    if ids.is_empty() {
        s.app.toast(tr("There are no clips with speech to transcribe."));
        return;
    }
    if super::busy(s) {
        s.app.toast(tr("Another analysis is running."));
        return;
    }
    super::dialogs::ensure_ready(s, None, Goal::Panel { ids });
}

/// The word lit under the playhead (`highlight`): the last word starting at or before it, while the playhead is in it
/// or within half a second after it (never past the next word's start).
fn current(words: &[Word], t: f64) -> Option<usize> {
    let i = text::word_at(words, t)?;
    let w = &words[i];
    let reach = words.get(i + 1).map_or(w.t1, |n| n.t0.min(w.t1 + 0.5 * TICKS as f64));
    (t < w.t1.max(reach)).then_some(i)
}

fn toolbar(s: &mut Shell, ui: &mut egui::Ui) {
    let running = s.features.speech.job.is_some();
    ui.horizontal(|ui| {
        ui.add_space(4.0);
        let run = ui.add_enabled(!running, egui::Button::new(tr("Transcribe")));
        if run.on_hover_text(tr("Recognize the speech of the sequence")).clicked() {
            transcribe_sequence(s);
        }
        let p = &mut s.features.speech.panel;
        let field = egui::TextEdit::singleline(&mut p.search)
            .id(egui::Id::unique(SEARCH))
            .hint_text(tr("Search"))
            .desired_width(150.0);
        let r = ui.add(field);
        if r.changed() {
            p.find();
        }
        if r.has_focus() || r.lost_focus() {
            s.focus(Panel::Transcript);
        }
        let p = &mut s.features.speech.panel;
        let enter = r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
        if enter && !p.matches.is_empty() {
            let n = p.matches.len();
            let back = ui.input(|i| i.modifiers.shift);
            let at = match (p.match_at, back) {
                (None, true) => n - 1,
                (None, false) => 0,
                (Some(k), true) => (k + n - 1) % n,
                (Some(k), false) => (k + 1) % n,
            };
            let (i, j) = p.matches[at];
            p.match_at = Some(at);
            p.select(i, j);
            p.scroll_to = Some(i);
            let t = p.words[i].t0 as i64;
            r.request_focus();
            s.app.set_time(t);
        }
        let p = &s.features.speech.panel;
        if !p.search.trim().is_empty() {
            let n = p.matches.len().to_string();
            ui.label(RichText::new(trf("{n} found", &[("n", &n)])).size(11.0).color(s.palette.gray[8]));
        }
        let chosen = p.sel.is_some() || p.pick.is_some();
        let remove = ui.add_enabled(chosen, egui::Button::new(tr("Remove")));
        if remove.on_hover_text(tr("Ripple delete the selected words")).clicked() {
            remove_selected(s);
        }
        if ui.button(tr("Fillers…")).on_hover_text(tr("Remove Filler Words…")).clicked() {
            let ctx = ui.ctx().clone();
            s.run_action("auto.fillers", &ctx);
        }
        if ui.button(tr("Word List…")).on_hover_text(tr("Names and terms Whisper is told of")).clicked() {
            super::dialogs::open_terms(s);
        }
    });
}

/// What a press, drag or double click on a word does.
enum Act {
    Down(usize, bool),
    Over(usize),
    Edit(usize),
}

/// One word, drawn and asked what was done to it.
fn word(s: &Shell, ui: &mut egui::Ui, i: usize, now: Option<usize>, fps: cut_time::Fps, acts: &mut Vec<Act>) {
    let p = &s.features.speech.panel;
    let pal = &s.palette;
    let w = &p.words[i];
    let selected = match (&p.pick, p.sel) {
        (Some(k), _) => k.contains(&i),
        (None, Some((a, b))) => (a..=b).contains(&i),
        (None, None) => false,
    };
    let matched = p.matches.iter().any(|(a, b)| (*a..=*b).contains(&i));
    let lit = now == Some(i);
    let mut rich = RichText::new(&w.text).color(if selected || lit || matched { pal.gray[12] } else { pal.gray[11] });
    rich = if selected {
        rich.background_color(pal.blue6.gamma_multiply(if lit { 0.55 } else { 0.45 }))
    } else if lit {
        rich.background_color(pal.accent.gamma_multiply(0.18))
    } else if matched {
        rich.background_color(YELLOW.gamma_multiply(0.28))
    } else {
        rich
    };
    let r = ui.add(egui::Label::new(rich).selectable(false).sense(Sense::click_and_drag()));
    if lit {
        let y = r.rect.bottom() - 1.0;
        ui.painter().hline(r.rect.x_range(), y, Stroke::new(2.0, pal.accent));
    }
    let unsure = doubtful(s, w);
    if unsure {
        let (y, mut x) = (r.rect.bottom() + 1.5, r.rect.left());
        let mut points = Vec::new();
        let mut up = true;
        while x <= r.rect.right() {
            points.push(egui::pos2(x, if up { y - 1.2 } else { y + 1.2 }));
            up = !up;
            x += 2.0;
        }
        ui.painter().add(egui::Shape::line(points, Stroke::new(1.0, YELLOW)));
    }
    if p.scroll_to == Some(i) {
        r.scroll_to_me(Some(egui::Align::Center));
    } else if lit && s.transport.playing() {
        r.scroll_to_me(None);
    }
    // a word keeps no keyboard focus: the editor's keys (Delete, the transport) work while the panel has the keyboard
    if r.has_focus() {
        r.surrender_focus();
    }
    let pressed = r.contains_pointer() && ui.input(|x| x.pointer.primary_pressed());
    if r.double_clicked() {
        acts.push(Act::Edit(i));
    } else if pressed {
        acts.push(Act::Down(i, ui.input(|x| x.modifiers.shift)));
    } else if p.dragging && r.contains_pointer() {
        acts.push(Act::Over(i));
    }
    let mut tip = format!("{} – {}", timecode(w.t0 as i64, fps), timecode(w.t1 as i64, fps));
    if unsure {
        let pc = format!("{}%", text::js_round(w.p.unwrap_or(0.0) * 100.0));
        tip.push('\n');
        tip.push_str(&trf("Whisper was unsure of this word ({p}). Double-click to correct it.", &[("p", &pc)]));
    }
    r.on_hover_text(tip);
}

/// The word being corrected, as a field in its place -> `Some(keep)` once it is left.
fn edit_field(s: &mut Shell, ui: &mut egui::Ui) -> Option<bool> {
    let (_, buf, focused) = s.features.speech.panel.editing.as_mut()?;
    let width = (buf.chars().count() as f32 + 3.0) * 8.0;
    let id = egui::Id::unique("cut-tr-edit");
    let esc = ui.memory(|m| m.has_focus(id)) && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape));
    let r = ui.add(egui::TextEdit::singleline(buf).id(id).desired_width(width.max(30.0)));
    r.widget_info(|| egui::WidgetInfo::labeled(egui::Role::TextInput, true, tr("Correct the word")));
    if !*focused {
        // the field takes the keyboard with its text selected, so typing replaces the word (`input.select()`)
        r.request_focus();
        if let Some(mut st) = egui::TextEdit::load_state(ui.ctx(), id) {
            let all = egui::text::CCursorRange::two(
                egui::text::CCursor::new(0),
                egui::text::CCursor::new(buf.chars().count()),
            );
            st.cursor.set_char_range(Some(all));
            st.store(ui.ctx(), id);
        }
        *focused = true;
        return None;
    }
    if esc {
        return Some(false);
    }
    r.lost_focus().then_some(true)
}

/// The word's correction ends: kept (a word left as it was is confirmed when it was uncertain), or put back.
fn finish_edit(s: &mut Shell, keep: bool) {
    let Some((i, buf, _)) = s.features.speech.panel.editing.take() else { return };
    let Some(w) = s.features.speech.panel.words.get(i).cloned() else { return };
    let value = text::js_trim(&buf).to_owned();
    if keep && !value.is_empty() && (value != w.text || doubtful(s, &w)) {
        flow::correct_word(s, &w, &value);
    }
}

fn text_area(s: &mut Shell, ui: &mut egui::Ui, height: f32) {
    let Some(fps) = s.app.sequence().map(|q| q.fps) else { return };
    let now = current(&s.features.speech.panel.words, s.app.t as f64);
    let mut acts = Vec::new();
    let mut ended = None;
    let mut speaker_acts = Vec::new();
    egui::ScrollArea::vertical().max_height(height).auto_shrink([false, false]).show(ui, |ui| {
        ui.add_space(4.0);
        let paras = s.features.speech.panel.paras.clone();
        for (k, &start) in paras.iter().enumerate() {
            let end = paras.get(k + 1).copied().unwrap_or(s.features.speech.panel.words.len());
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(4.0, 4.0);
                ui.add_space(6.0);
                if let Some(id) = s.features.speech.panel.ids[start].clone() {
                    crate::speakers::row::para_label(s, ui, &id, start, &mut speaker_acts);
                }
                let t0 = s.features.speech.panel.words[start].t0 as i64;
                ui.label(RichText::new(timecode(t0, fps)).size(10.5).color(s.palette.gray[8]).monospace());
                for i in start..end {
                    if s.features.speech.panel.editing.as_ref().is_some_and(|e| e.0 == i) {
                        ended = edit_field(s, ui).or(ended);
                    } else {
                        word(s, ui, i, now, fps, &mut acts);
                    }
                }
            });
            ui.add_space(6.0);
        }
    });
    s.features.speech.panel.scroll_to = None;
    if let Some(keep) = ended {
        finish_edit(s, keep);
    }
    crate::speakers::row::run(s, speaker_acts);
    let down = ui.input(|i| i.pointer.primary_down());
    let p = &mut s.features.speech.panel;
    if !down {
        p.dragging = false;
    }
    for a in acts {
        s.focus(Panel::Transcript);
        let p = &mut s.features.speech.panel;
        match a {
            Act::Down(i, true) if p.anchor.is_some() => {
                let a = p.anchor.unwrap_or(i);
                p.select(a, i);
            }
            Act::Down(i, _) => {
                p.anchor = Some(i);
                p.dragging = true;
                p.select(i, i);
                let t = p.words[i].t0 as i64;
                s.app.set_time(t);
            }
            Act::Over(i) => {
                let a = p.anchor.unwrap_or(i);
                p.select(a, i);
            }
            Act::Edit(i) if p.editing.is_none() => {
                p.editing = Some((i, p.words[i].text.clone(), false));
            }
            Act::Edit(_) => {}
        }
    }
}

/// The Transcript panel.
pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    if s.features.speech.panel.editing.is_none() {
        refresh(s);
    }
    let pal = s.palette.clone();
    toolbar(s, ui);
    crate::speakers::row::bar(s, ui);
    ui.separator();
    let foot_h = 22.0;
    let height = (ui.available_height() - foot_h).max(0.0);
    let has_words = !s.features.speech.panel.words.is_empty();
    if has_words {
        text_area(s, ui, height);
    } else {
        let speaks = s.app.sequence().is_some_and(|q| q.clips().any(|c| flow::speaks(&s.app, q, c)));
        let note = if speaks {
            "No transcript yet. Press Transcribe to recognize the speech of the sequence on this PC."
        } else {
            "The sequence has no clips with speech."
        };
        ui.allocate_ui(Vec2::new(ui.available_width(), height), |ui| {
            ui.centered_and_justified(|ui| ui.label(RichText::new(tr(note)).color(pal.gray[8])));
        });
    }
    let focused = s.app.focus == Some(Panel::Transcript);
    let p = &s.features.speech.panel;
    if focused && (p.sel.is_some() || p.pick.is_some()) && p.editing.is_none() && !ui.ctx().egui_wants_keyboard_input()
    {
        let esc = ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape));
        if esc {
            let p = &mut s.features.speech.panel;
            (p.sel, p.pick) = (None, None);
        }
    }
    let p = &s.features.speech.panel;
    let unsure = p.words.iter().filter(|w| doubtful(s, w)).count();
    let count = p.words.len();
    ui.horizontal(|ui| {
        ui.add_space(6.0);
        if count > 0 {
            ui.label(RichText::new(trf("{n} words", &[("n", &count.to_string())])).size(11.0).color(pal.gray[8]));
        }
        if unsure > 0 {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let b =
                    egui::Button::new(RichText::new(trf("{n} uncertain ›", &[("n", &unsure.to_string())])).size(11.0))
                        .fill(YELLOW.gamma_multiply(0.16));
                if ui.add(b).on_hover_text(tr("Next Uncertain Word")).clicked() {
                    flow::next_uncertain(s, 1);
                }
            });
        }
    });
}
