//! The frequency response graph above the rows of the Parametric Equalizer, Bass, Treble and the DeHummer in Effect
//! Controls (`ui-audiofx.js responseView`, `ui.effectViews`): the curve of the same filters the mixer runs
//! (`cut_audio::fx::response`) at the playhead's parameter values, on a log frequency axis from 20 Hz to 20 kHz and
//! ±24 dB, with the equalizer's bands as dots. Drawn on the UI thread; a curve is a few hundred filter evaluations.

use cut_audio::fx::{Dsp, response};
use cut_model::Id;
use cut_model::keyframes::Value;
use eframe::egui::{self, Align2, Color32, FontId, Pos2, Rect, Sense, Stroke, Vec2};

use crate::i18n::tr;
use crate::shell::Shell;

const F_LO: f64 = 20.0;
const F_HI: f64 = 20000.0;
const DB_RANGE: f64 = 24.0;
const GRID_F: [f64; 8] = [50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0];
const GRID_DB: [f64; 7] = [-18.0, -12.0, -6.0, 0.0, 6.0, 12.0, 18.0];
/// The graph's height and its margins (`.cut-ec-graph`: 96 px, 4 6 4 18).
pub const HEIGHT: f32 = 96.0;
const MARGIN: (f32, f32, f32, f32) = (4.0, 6.0, 4.0, 18.0);
/// The equalizer's bands drawn as dots: the band and its gain parameter (the cuts sit on 0 dB).
const BANDS: [(&str, Option<&str>); 7] = [
    ("ls", Some("lsGain")),
    ("b1", Some("b1Gain")),
    ("b2", Some("b2Gain")),
    ("b3", Some("b3Gain")),
    ("hs", Some("hsGain")),
    ("hp", None),
    ("lp", None),
];

/// The processor an effect type shows a graph for (`effectViews`' keys).
pub fn dsp_of(kind: &str) -> Option<Dsp> {
    match kind {
        "audio.eq" => Some(Dsp::Eq),
        "audio.bass" => Some(Dsp::Bass),
        "audio.treble" => Some(Dsp::Treble),
        "audio.dehum" => Some(Dsp::Dehum),
        _ => None,
    }
}

fn label(f: f64) -> String {
    if f >= 1000.0 { format!("{}k", f / 1000.0) } else { format!("{f}") }
}

/// What the graph shows for an effect of a clip: its processor, its resolved parameters at the playhead
/// (keyframes included) with their ids, and whether the effect is on.
pub struct Shown {
    pub dsp: Dsp,
    pub params: Vec<f64>,
    pub ids: Vec<&'static str>,
    pub on: bool,
}

/// The parameters at the playhead as the mixer reads them there (`params()`).
pub fn shown(s: &Shell, clip: Id, effect: Id) -> Option<Shown> {
    let seq = s.app.sequence()?;
    let c = seq.clip(clip)?;
    let e = c.effects.iter().find(|x| x.id == effect)?;
    let dsp = dsp_of(&e.kind)?;
    let def = cut_audio::effects::get(&e.kind)?;
    let mut params = def.resolve(&e.params);
    for (i, d) in def.params.iter().enumerate().filter(|(_, d)| d.keyframable) {
        let path = format!("effects.{}.{}", e.id.as_str(), d.id);
        if let Some(Value::Num(v)) = crate::fx::edit::value_at(seq, c, &path, s.app.t) {
            params[i] = v;
        }
    }
    Some(Shown { dsp, params, ids: def.params.iter().map(|p| p.id).collect(), on: e.on })
}

impl Shown {
    fn get(&self, id: &str) -> f64 {
        self.ids.iter().position(|x| *x == id).map_or(0.0, |i| self.params[i])
    }
}

/// The graph of `effect` of `clip`, when its type has one; nothing otherwise.
pub fn view(s: &mut Shell, ui: &mut egui::Ui, clip: Id, effect: Id) {
    let Some(g) = shown(s, clip, effect) else { return };
    let (top, right, bottom, left) = MARGIN;
    let (outer, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), HEIGHT + top + bottom), Sense::hover());
    let rect = Rect::from_min_max(outer.min + Vec2::new(left, top), outer.max - Vec2::new(right, bottom));
    s.features.controls.note(format!("graph:{}", effect.as_str()), rect);
    let pal = &s.palette;
    let p = ui.painter_at(rect);
    p.rect_filled(rect, 3.0, pal.gray[1]);
    let (w, h) = (f64::from(rect.width()), f64::from(rect.height()));
    let x_of = |f: f64| rect.left() + ((f / F_LO).log10() / (F_HI / F_LO).log10() * w) as f32;
    let y_of = |d: f64| rect.top() + (h / 2.0 - (d.clamp(-DB_RANGE, DB_RANGE) / DB_RANGE) * (h / 2.0 - 4.0)) as f32;
    let font = FontId::monospace(9.0);
    let (grid, text) = (pal.gray[4], pal.gray[8]);
    for f in GRID_F {
        let x = x_of(f).round() + 0.5;
        p.vline(x, rect.y_range(), Stroke::new(1.0, grid));
        if f != 50.0 {
            p.text(Pos2::new(x, rect.bottom() - 1.0), Align2::CENTER_BOTTOM, label(f), font.clone(), text);
        }
    }
    for d in GRID_DB {
        let y = y_of(d).round() + 0.5;
        let c = if d == 0.0 { grid } else { grid.gamma_multiply(0.6) };
        p.hline(rect.x_range(), y, Stroke::new(1.0, c));
        if d % 12.0 == 0.0 && d != 0.0 {
            let t = format!("{}{d}", if d > 0.0 { "+" } else { "" });
            p.text(Pos2::new(rect.left() + 2.0, y), Align2::LEFT_CENTER, t, font.clone(), text);
        }
    }
    let n = ((w / 2.0).round() as usize).max(32);
    let freqs: Vec<f64> = (0..=n).map(|i| F_LO * (F_HI / F_LO).powf(i as f64 / n as f64)).collect();
    let resp = response(g.dsp, &g.params, &freqs, 48000.0);
    let color: Color32 = if g.on { pal.accent } else { text };
    let line: Vec<Pos2> = freqs.iter().zip(&resp).map(|(f, d)| Pos2::new(x_of(*f), y_of(*d))).collect();
    p.add(egui::Shape::line(line, Stroke::new(1.6, color)));
    if g.dsp == Dsp::Eq {
        for (b, gain) in BANDS {
            if g.get(&format!("{b}On")) == 0.0 {
                continue;
            }
            let at = Pos2::new(x_of(g.get(&format!("{b}Freq"))), y_of(gain.map_or(0.0, |k| g.get(k))));
            p.circle_filled(at, 3.0, color);
        }
    }
    p.rect_stroke(rect, 3.0, Stroke::new(1.0, grid), egui::StrokeKind::Inside);
    // the canvas's aria-label
    let r = ui.interact(rect, ui.scope_id().with(("ec-graph", effect.as_str())), Sense::hover());
    r.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Image, true, tr("Frequency response")));
}
