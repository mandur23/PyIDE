//! The Speech Recognition page of the Preferences (`settingsSection`): the model with its state and Download…, the
//! language, the characters per caption line, whether uncertain words are marked.

use eframe::egui::{self, RichText};
use serde_json::json;

use super::engine::MODELS;
use super::{Goal, backend, format_bytes, set_setting, setting};
use crate::i18n::tr;
use crate::shell::Shell;

/// The page's rows, in the Preferences' two-column grid.
pub fn rows(s: &mut Shell, ui: &mut egui::Ui) {
    let st = backend(s).status();
    let v = setting(s, "speech.model");
    let id = v.as_str().filter(|id| MODELS.iter().any(|m| m.id == *id)).unwrap_or(MODELS[0].id).to_owned();
    let (m, installed) = st.model(&id);
    let ready = st.runtime && installed;
    ui.label(tr("Model:"));
    ui.horizontal(|ui| {
        let mut pick = None;
        egui::ComboBox::from_id_salt("cut-speech-model")
            .selected_text(format!("{} ({})", m.name, format_bytes(m.bytes)))
            .show_ui(ui, |ui| {
                for x in MODELS {
                    if ui.selectable_label(x.id == m.id, format!("{} ({})", x.name, format_bytes(x.bytes))).clicked() {
                        pick = Some(x.id);
                    }
                }
            });
        if let Some(p) = pick.filter(|p| *p != m.id) {
            set_setting(s, "speech.model", json!(p));
        }
        if !ready && ui.button(tr("Download…")).clicked() {
            super::dialogs::ensure_ready(s, Some(m.id), Goal::Download);
        }
    });
    ui.end_row();
    ui.label("");
    ui.label(
        RichText::new(if ready {
            tr("Downloaded")
        } else {
            tr("Not downloaded: it is downloaded when you first use it, after you agree")
        })
        .weak(),
    );
    ui.end_row();
    ui.label(tr("Language:"));
    let mut lang = super::language(s);
    if super::dialogs::language_box(ui, "cut-speech-language-setting", &mut lang) {
        set_setting(s, "speech.language", json!(lang));
    }
    ui.end_row();
    ui.label(tr("Characters per caption line:"));
    ui.horizontal(|ui| {
        let mut n = super::line_chars(s);
        if ui.add(egui::DragValue::new(&mut n).range(0.0..=80.0).speed(1.0).fixed_decimals(0)).changed() {
            set_setting(s, "speech.lineChars", json!(n.round() as i64));
        }
        ui.label(RichText::new(tr("0: 18 for Korean, 42 otherwise")).weak());
    });
    ui.end_row();
    ui.label("");
    let mut mark = super::marking(s);
    if ui.checkbox(&mut mark, tr("Mark the words Whisper was unsure of (Transcript and Captions panels)")).changed() {
        set_setting(s, "speech.markUncertain", json!(mark));
    }
    ui.end_row();
    ui.label("");
    let mut isolate = super::opts(s).isolate;
    let text = "Isolate the voice before recognition (HTDemucs): for speech over music, not over steady noise";
    if ui.checkbox(&mut isolate, tr(text)).changed() {
        set_setting(s, "speech.isolateVoice", json!(isolate));
    }
    ui.end_row();
}

/// The note under the page.
pub const NOTE: &str = "Whisper large-v3 turbo, the default, gets about half as many characters wrong as small, also through noise and music, and takes about 2.5 minutes per minute of sound on an 8-core CPU; Whisper small takes about 1 minute. Recognition runs on this PC only.";
