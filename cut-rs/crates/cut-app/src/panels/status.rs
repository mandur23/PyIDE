//! The status bar and the toasts: what is selected, the tool, snapping, the import in progress, the timeline's frame
//! time; short messages fade after three seconds, errors stay until clicked (`ui.toast`, `ui.report`).

use eframe::egui::{self, Align, Align2, Color32, Layout, RichText};

use crate::i18n::{tr, trf};
use crate::shell::Shell;

pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    ui.horizontal(|ui| {
        let seq = s.app.sequence();
        let clips = seq.map_or(0, |q| q.clip_count());
        let small = |t: String| RichText::new(t).size(12.0).color(pal.gray[8]);
        ui.label(small(tr(s.app.tool.title()).into_owned()));
        ui.separator();
        ui.label(small(trf("{n} clips", &[("n", &clips.to_string())])));
        if !s.app.selection.is_empty() {
            ui.label(small(trf("{n} selected", &[("n", &s.app.selection.len().to_string())])));
        }
        ui.separator();
        ui.label(small(if s.app.snapping { tr("Snapping on") } else { tr("Snapping off") }.into_owned()));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(small(format!("{:.2} ms", s.timeline.frame_ms))).on_hover_text(tr("Timeline"));
            if s.importer.pending() > 0 {
                ui.spinner();
                ui.label(small(tr("Importing media").into_owned()));
            }
        });
    });
}

type Toasts = Vec<(String, bool, f64)>;

/// Shows the messages the panels left in `app.notices`.
pub fn toasts(s: &mut Shell, ctx: &egui::Context) {
    let now = ctx.input(|i| i.time);
    let id = egui::Id::unique("cut-toasts");
    let mut list: Toasts = ctx.data_mut(|d| d.get_temp::<Toasts>(id)).unwrap_or_default();
    for n in s.app.notices.drain(..) {
        list.push((n.text, n.error, now));
    }
    list.retain(|(_, error, at)| *error || now - at < 3.0);
    if list.iter().any(|(_, e, _)| !e) {
        ctx.request_repaint_after(std::time::Duration::from_millis(250));
    }
    let pal = s.palette.clone();
    let mut gone = None;
    egui::Area::new(egui::Id::unique("cut-toast-area"))
        .anchor(Align2::RIGHT_BOTTOM, [-16.0, -36.0])
        .order(egui::Order::Foreground)
        .show(ctx, |ui| {
            ui.set_max_width(420.0);
            for (i, (text, error, _)) in list.iter().enumerate().rev().take(4) {
                let fill = if *error { Color32::from_rgb(0x5a, 0x24, 0x24) } else { pal.gray[3] };
                let r = egui::Frame::popup(ui.style()).fill(fill).show(ui, |ui| {
                    ui.label(RichText::new(text).color(if *error {
                        Color32::from_rgb(0xff, 0xd6, 0xd6)
                    } else {
                        pal.gray[12]
                    }));
                });
                if r.response.interact(egui::Sense::click()).clicked() {
                    gone = Some(i);
                }
            }
        });
    if let Some(i) = gone {
        list.remove(i);
    }
    ctx.data_mut(|d| d.insert_temp(id, list));
}
