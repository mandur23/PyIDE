//! The Transcript panel's speaker parts (`ui-speakers.js bar`, `labelOf`, `speakerMenu`): the row above the words
//! (a chip per speaker with its colour, name and word count: a click selects its words, a double click renames it,
//! the right button opens its menu; the number of speakers; Label Speakers) and each paragraph's speaker, whose menu
//! is Change Speaker (every speaker, New Speaker), Rename Speaker… and Select Words of {name}.

use eframe::egui::{self, Color32, RichText, Sense, Stroke};

use super::core::{self as K, Labels};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// What the speaker parts were asked to do, done once the panel is drawn.
pub enum Act {
    /// The paragraph starting at this word given to a speaker (`None`: a new one).
    Reassign(usize, Option<String>),
    Rename(String),
    Select(String),
}

/// A speaker's colour (`--spk`), grey without one.
fn colour(s: &Shell, hex: Option<&str>) -> Color32 {
    hex.and_then(|h| Color32::from_hex(h).ok()).unwrap_or(s.palette.gray[8])
}

fn name_of(labels: &Labels, id: &str) -> String {
    K::name_of(&labels.list, id, &tr("Speaker {n}"))
}

/// A dot of the speaker's colour before `text` (`.cut-spk-dot`).
fn dotted(ui: &egui::Ui, dot: Color32, text: &str, size: f32, strong: bool) -> egui::text::LayoutJob {
    let mut job = egui::text::LayoutJob::default();
    let font = egui::FontId::proportional(size);
    let normal = ui.visuals().text_color();
    job.append("● ", 0.0, egui::TextFormat::simple(font.clone(), dot));
    let mut f = egui::TextFormat::simple(font, if strong { dot } else { normal });
    f.underline = Stroke::NONE;
    job.append(text, 0.0, f);
    job
}

/// The speaker menu's items (`speakerMenu`): Change Speaker for a paragraph (`start`), Rename Speaker…, Select Words.
fn menu(ui: &mut egui::Ui, labels: &Labels, id: &str, start: Option<usize>, acts: &mut Vec<Act>) {
    if let Some(start) = start {
        ui.menu_button(tr("Change Speaker"), |ui| {
            for sp in &labels.list {
                if ui.add(egui::Button::new(name_of(labels, &sp.id)).selected(sp.id == id)).clicked() {
                    acts.push(Act::Reassign(start, Some(sp.id.clone())));
                    ui.close();
                }
            }
            ui.separator();
            let room = labels.list.len() < K::MAX;
            if ui.add_enabled(room, egui::Button::new(tr("New Speaker"))).clicked() {
                acts.push(Act::Reassign(start, None));
                ui.close();
            }
        });
    }
    if ui.button(tr("Rename Speaker…")).clicked() {
        acts.push(Act::Rename(id.to_owned()));
        ui.close();
    }
    let select = trf("Select Words of {name}", &[("name", &name_of(labels, id))]);
    if ui.button(select).clicked() {
        acts.push(Act::Select(id.to_owned()));
        ui.close();
    }
}

/// A paragraph's speaker (`labelOf`): its name in its colour; a click opens the speaker menu.
pub fn para_label(s: &Shell, ui: &mut egui::Ui, id: &str, start: usize, acts: &mut Vec<Act>) {
    let Some(labels) = s.features.speech.panel.labels.as_ref() else { return };
    let dot = colour(s, labels.get(id).map(|x| x.color.as_str()));
    let job = dotted(ui, dot, &name_of(labels, id), 11.5, true);
    let button = egui::Button::new(job).fill(dot.gamma_multiply(0.12));
    let (r, _) =
        egui::containers::menu::MenuButton::from_button(button).ui(ui, |ui| menu(ui, labels, id, Some(start), acts));
    r.on_hover_text(tr("Change Speaker, Rename Speaker…, Select Words"));
}

/// The row above the transcript (`bar`): the speakers with their word counts, the number of speakers, Label
/// Speakers.
pub fn bar(s: &mut Shell, ui: &mut egui::Ui) {
    let p = &s.features.speech.panel;
    let sp = p.labels.clone().unwrap_or_default();
    let mut counts: Vec<(String, usize)> = Vec::new();
    for id in p.ids.iter().flatten() {
        match counts.iter_mut().find(|(x, _)| x == id) {
            Some(c) => c.1 += 1,
            None => counts.push((id.clone(), 1)),
        }
    }
    let shown: Vec<(&K::Speaker, usize)> =
        sp.list.iter().filter_map(|x| counts.iter().find(|c| c.0 == x.id).map(|c| (x, c.1))).collect();
    let has_words = !p.words.is_empty();
    let seq = s.app.sequence_id;
    let labelled = p.labels.is_some();
    let mut count = match &p.labels {
        Some(l) => l.count,
        None => p.count.filter(|(q, _)| Some(*q) == seq).map_or(0, |c| c.1),
    };
    let mut acts = Vec::new();
    let mut label_now = false;
    ui.horizontal(|ui| {
        ui.set_min_height(26.0);
        ui.add_space(6.0);
        if shown.is_empty() && has_words {
            ui.label(RichText::new(tr("No speaker labels yet.")).size(11.0).color(s.palette.gray[8]));
        }
        for (speaker, n) in &shown {
            let name = name_of(&sp, &speaker.id);
            let job = dotted(ui, colour(s, Some(&speaker.color)), &name, 11.5, false);
            let mut chip = job;
            chip.append(
                &format!("  {n}"),
                0.0,
                egui::TextFormat::simple(egui::FontId::proportional(10.5), s.palette.gray[8]),
            );
            let r = ui.add(egui::Button::new(chip).corner_radius(11.0).sense(Sense::click()));
            let tip = trf(
                "{name}: {n} words. Click to select them, double-click to rename.",
                &[("name", &name), ("n", &n.to_string())],
            );
            if r.double_clicked() {
                acts.push(Act::Rename(speaker.id.clone()));
            } else if r.clicked() {
                acts.push(Act::Select(speaker.id.clone()));
            }
            r.context_menu(|ui| menu(ui, &sp, &speaker.id, None, &mut acts));
            r.on_hover_text(tip);
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(6.0);
            let b = ui.add_enabled(!crate::speakers::running(s), egui::Button::new(tr("Label Speakers")));
            label_now =
                b.on_hover_text(tr("Tell who speaks when (on this PC); with a number, that many speakers")).clicked();
            let label = |k: u32| match k {
                0 => tr("Auto").into_owned(),
                1 => tr("1 speaker").into_owned(),
                k => trf("{n} speakers", &[("n", &k.to_string())]),
            };
            egui::ComboBox::from_id_salt("cut-spk-count")
                .icon(crate::theme::combo_icon)
                .selected_text(label(count))
                .width(96.0)
                .show_ui(ui, |ui| {
                    for k in 0..=6 {
                        ui.selectable_value(&mut count, k, label(k));
                    }
                })
                .response
                .on_hover_text(tr("Number of speakers"));
        });
    });
    if let Some(q) = seq.filter(|_| !labelled) {
        s.features.speech.panel.count = Some((q, count));
    }
    if label_now {
        super::label::start(s, Some(count));
    }
    run(s, acts);
}

/// Does what the speaker parts were asked.
pub fn run(s: &mut Shell, acts: Vec<Act>) {
    for a in acts {
        match a {
            Act::Reassign(start, to) => {
                let p = &s.features.speech.panel;
                let words: Vec<_> = p.segment(start).into_iter().filter_map(|i| p.words.get(i).cloned()).collect();
                let all = p.words.clone();
                super::label::reassign(&mut s.app, &words, &all, to.as_deref());
            }
            Act::Rename(id) => {
                let name = Labels::of(s.app.project()).and_then(|l| l.get(&id).map(|x| x.name.clone()));
                if let Some(name) = name {
                    s.features.speakers.rename = Some((id, name));
                }
            }
            Act::Select(id) => {
                let p = &mut s.features.speech.panel;
                let list: Vec<usize> = (0..p.ids.len()).filter(|&i| p.ids[i].as_deref() == Some(id.as_str())).collect();
                p.pick_words(list);
                s.focus(crate::state::Panel::Transcript);
            }
        }
    }
}
