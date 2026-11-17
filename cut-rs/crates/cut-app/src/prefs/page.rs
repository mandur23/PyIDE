//! The Preferences window (`ui-settings.js`'s Video Editor page and the settings window's Appearance and Language
//! pages): a list of pages on the left, the page's settings on the right, each change saved at once as the settings
//! window's fields are. Speech recognition's page is [`crate::speech::settings`]; the AI section is not part of this
//! app.

use std::sync::mpsc::{Receiver, channel};

use eframe::egui::{self, RichText};
use serde_json::json;

use super::{Screen, flag, number, set};
use crate::i18n::{Lang, lang, tr, trf};
use crate::keys::Preset;
use crate::shell::Shell;
use crate::theme::ThemeKind;

/// A page of the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Autosave,
    Cache,
    Timeline,
    Playback,
    Proxies,
    Speech,
    Claude,
    AiControl,
    Appearance,
    Language,
    Keyboard,
}

impl Page {
    pub const ALL: [Page; 11] = [
        Page::Autosave,
        Page::Cache,
        Page::Timeline,
        Page::Playback,
        Page::Proxies,
        Page::Speech,
        Page::Claude,
        Page::AiControl,
        Page::Appearance,
        Page::Language,
        Page::Keyboard,
    ];

    /// The page of an action `settings.<page>` (`CUT_ACTIONS` opens a page with it).
    pub fn from_id(id: &str) -> Option<Page> {
        let name = id.strip_prefix("settings.")?;
        Page::ALL.into_iter().find(|p| format!("{p:?}").eq_ignore_ascii_case(name))
    }

    /// The English title (the key of its translation).
    pub fn title(self) -> &'static str {
        match self {
            Page::Autosave => "Autosave",
            Page::Cache => "Media Cache",
            Page::Timeline => "Timeline",
            Page::Playback => "Playback",
            Page::Proxies => "Proxies",
            Page::Speech => "Speech Recognition",
            Page::Claude => "Claude (Text AI)",
            Page::AiControl => "AI Control",
            Page::Appearance => "Appearance",
            Page::Language => "Language",
            Page::Keyboard => "Keyboard Shortcuts",
        }
    }
}

/// The cache's size as last measured, and the question before Clear Cache.
#[derive(Default)]
pub struct PageState {
    pub cache: Option<(u64, usize)>,
    measuring: Option<Receiver<(u64, usize)>>,
    pub confirm_clear: bool,
}

fn cache_of(s: &Shell) -> crate::files::cache::Cache {
    let limit = (number(&s.doc.settings, "cacheLimitGB").max(1.0) * 1024.0 * 1024.0 * 1024.0) as u64;
    crate::files::cache::Cache::new(s.doc.home.cache.clone(), limit)
}

/// Measures the cache on a thread (it walks the folder).
pub fn measure(s: &mut Shell) {
    let cache = cache_of(s);
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(cache.info());
    });
    s.features.prefs.page.measuring = Some(rx);
}

fn row(ui: &mut egui::Ui, label: &str, add: impl FnOnce(&mut egui::Ui)) {
    ui.label(tr(label));
    ui.horizontal(add);
    ui.end_row();
}

fn note(ui: &mut egui::Ui, s: &Shell, text: &str) {
    ui.label(RichText::new(tr(text)).color(s.palette.gray[8]).size(12.0));
}

/// A number field saved as the setting `key` when it changes, kept in `lo..=hi`.
fn field(s: &mut Shell, ui: &mut egui::Ui, key: &str, lo: f64, hi: f64, step: f64) -> bool {
    let mut v = number(&s.doc.settings, key);
    let whole = step >= 0.2;
    let r = ui.add(egui::DragValue::new(&mut v).range(lo..=hi).speed(step).max_decimals(if whole { 0 } else { 2 }));
    if r.changed() {
        set(s, key, if v.fract() == 0.0 { json!(v as i64) } else { json!(v) });
        return true;
    }
    false
}

fn choice(s: &mut Shell, ui: &mut egui::Ui, key: &str, options: &[(f64, &str)]) {
    let v = number(&s.doc.settings, key);
    for (value, label) in options {
        if ui.selectable_label(v == *value, tr(label)).clicked() && v != *value {
            set(s, key, json!(value));
        }
    }
}

fn check(s: &mut Shell, ui: &mut egui::Ui, key: &str, label: &str) {
    let mut on = flag(&s.doc.settings, key);
    if ui.checkbox(&mut on, tr(label)).changed() {
        set(s, key, json!(on));
    }
}

fn body(s: &mut Shell, ui: &mut egui::Ui, ctx: &egui::Context, page: Page) {
    ui.heading(tr(page.title()));
    ui.add_space(8.0);
    egui::Grid::new(("cut-prefs", page.title())).num_columns(2).spacing([12.0, 10.0]).max_col_width(330.0).show(
        ui,
        |ui| match page {
            Page::Autosave => {
                row(ui, "Keep a copy every:", |ui| {
                    field(s, ui, "autosaveMinutes", 1.0, 120.0, 0.2);
                    ui.label(tr("minutes (1 – 120)"));
                });
                row(ui, "Copies to keep:", |ui| {
                    field(s, ui, "autosaveKeep", 1.0, 100.0, 0.2);
                    ui.label("1 – 100");
                });
            }
            Page::Cache => {
                row(ui, "Cache limit:", |ui| {
                    field(s, ui, "cacheLimitGB", 1.0, 2000.0, 0.5);
                    ui.label(tr("GB; the least recently used files go first"));
                });
                row(ui, "In use:", |ui| {
                    let size = match s.features.prefs.page.cache {
                        Some((bytes, n)) => trf(
                            "{size} in {n} files",
                            &[("size", &crate::export::format_bytes(bytes)), ("n", &n.to_string())],
                        ),
                        None => tr("Measuring…").into_owned(),
                    };
                    ui.label(size);
                    if ui.button(tr("Clear Cache")).clicked() {
                        s.features.prefs.page.confirm_clear = true;
                    }
                });
            }
            Page::Timeline => {
                let mut changed = false;
                row(ui, "Default transition length:", |ui| {
                    changed |= field(s, ui, "transitionSeconds", 0.1, 60.0, 0.05);
                    ui.label(tr("seconds"));
                });
                row(ui, "Default still image length:", |ui| {
                    changed |= field(s, ui, "stillSeconds", 0.1, 3600.0, 0.1);
                    ui.label(tr("seconds"));
                });
                if changed {
                    super::apply_durations(s);
                }
            }
            Page::Playback => {
                row(ui, "Playback quality:", |ui| {
                    choice(s, ui, "quality", &[(1.0, "Full"), (0.5, "1/2"), (0.25, "1/4")])
                });
            }
            Page::Proxies => {
                ui.label("");
                check(s, ui, "proxy", "Play proxies in the monitors");
                ui.end_row();
                ui.label("");
                check(s, ui, "proxyOffer", "Offer proxies when importing 4K, HEVC or long-GOP video");
                ui.end_row();
                row(ui, "Proxy size:", |ui| {
                    choice(s, ui, "proxyHeight", &[(540.0, "540p"), (720.0, "720p"), (1080.0, "1080p")]);
                    ui.label(tr("H.264, a keyframe every 15 frames"));
                });
            }
            Page::Speech => {
                crate::speech::settings::rows(s, ui);
                crate::voice::settings_rows(s, ui);
            }
            Page::Claude => crate::ai::notice::settings_section(s, ui),
            Page::AiControl => crate::control::panel::rows(s, ui),
            Page::Appearance => {
                row(ui, "Appearance", |ui| {
                    if ui.selectable_label(!s.palette.light(), tr("Dark")).clicked() {
                        s.set_theme(ctx, ThemeKind::Dark);
                    }
                    if ui.selectable_label(s.palette.light(), tr("Light")).clicked() {
                        s.set_theme(ctx, ThemeKind::Light);
                    }
                });
            }
            Page::Language => {
                row(ui, "Language", |ui| {
                    if ui.selectable_label(lang() == Lang::Ko, "한국어").clicked() {
                        s.set_lang(Lang::Ko);
                    }
                    if ui.selectable_label(lang() == Lang::En, "English").clicked() {
                        s.set_lang(Lang::En);
                    }
                });
            }
            Page::Keyboard => {
                row(ui, "Keyboard Layout Preset", |ui| {
                    for p in [Preset::Premiere, Preset::Classic] {
                        if ui.selectable_label(s.preset == p, tr(p.title())).clicked() {
                            s.preset = p;
                            s.doc.set_setting("keyPreset", p.code());
                        }
                    }
                });
                row(ui, "Keyboard Shortcuts", |ui| {
                    if ui.button(tr("Edit Shortcuts…")).clicked() {
                        s.features.prefs.screen = Some(Screen::Shortcuts(super::keymap::Draft::new(s.preset)));
                    }
                });
                row(ui, "Folder", |ui| {
                    ui.label(RichText::new(s.doc.home.home.to_string_lossy()).monospace().size(11.0));
                });
            }
        },
    );
    ui.add_space(6.0);
    match page {
        Page::Autosave => {
            note(ui, s, "The latest changes are also saved for recovery 2 seconds after you stop editing.");
        }
        Page::Cache => note(
            ui,
            s,
            "Thumbnails, waveforms and proxies. A cleared proxy is made again on request; until then the original plays.",
        ),
        Page::Timeline => note(ui, s, "New projects take these, and the open project changes to them."),
        Page::Playback => note(ui, s, "while playing; a paused frame is always full quality"),
        Page::Proxies => note(ui, s, "Export always reads the original media."),
        Page::Speech => note(ui, s, crate::speech::settings::NOTE),
        _ => {}
    }
}

/// The Preferences window, each frame while it is open.
pub fn show(s: &mut Shell, ctx: &egui::Context) {
    let mut page = match &s.features.prefs.screen {
        Some(Screen::Settings(p)) => *p,
        _ => return,
    };
    if let Some(rx) = &s.features.prefs.page.measuring
        && let Ok(v) = rx.try_recv()
    {
        s.features.prefs.page.cache = Some(v);
        s.features.prefs.page.measuring = None;
    }
    if page == Page::Cache && s.features.prefs.page.cache.is_none() && s.features.prefs.page.measuring.is_none() {
        measure(s);
    }
    let mut close = false;
    let modal = egui::Modal::new(egui::Id::unique("cut-prefs")).show(ctx, |ui| {
        ui.set_width(640.0);
        ui.horizontal_top(|ui| {
            ui.vertical(|ui| {
                ui.set_width(150.0);
                ui.label(RichText::new(tr("Video Editor")).strong());
                ui.add_space(4.0);
                for p in Page::ALL {
                    if ui.selectable_label(page == p, tr(p.title())).clicked() {
                        page = p;
                    }
                }
            });
            ui.add_space(12.0);
            ui.vertical(|ui| {
                ui.set_min_height(300.0);
                body(s, ui, ctx, page);
            });
        });
        ui.separator();
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button(tr("Close")).clicked() {
                close = true;
            }
        });
    });
    if s.features.prefs.page.confirm_clear {
        confirm_clear(s, ctx);
    } else if modal.should_close() {
        close = true;
    }
    if matches!(s.features.prefs.screen, Some(Screen::Settings(_))) {
        s.features.prefs.screen = if close { None } else { Some(Screen::Settings(page)) };
    }
}

/// The question before Clear Cache; yes empties the cache folder and measures it again.
fn confirm_clear(s: &mut Shell, ctx: &egui::Context) {
    let mut answer = None;
    egui::Modal::new(egui::Id::unique("cut-prefs-clear")).show(ctx, |ui| {
        ui.set_width(380.0);
        ui.heading(tr("Clear Cache"));
        ui.label(tr("Delete the thumbnails, waveforms and proxies in the cache? They are made again when needed."));
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            if ui.button(tr("Clear Cache")).clicked() {
                answer = Some(true);
            }
            if ui.button(tr("Cancel")).clicked() {
                answer = Some(false);
            }
        });
    });
    let Some(yes) = answer else { return };
    s.features.prefs.page.confirm_clear = false;
    if yes {
        if let Err(e) = cache_of(s).clear() {
            s.app.report(trf("The cache could not be cleared: {error}", &[("error", &e)]));
        }
        s.features.prefs.page.cache = None;
        measure(s);
    }
}
