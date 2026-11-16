//! What Effect Controls shows for a clip, as data (the `section(...)` and `paramRow` specs of `ui-controls.js`'s
//! `build`): its sections in order, each a list of rows that say which property path they edit and with which control.
//! [`sections`] builds it from the project alone, so the layout is tested without a window; the panel draws it.

use cut_model::effects::{self, ParamKind};
use cut_model::keyframes::Value;
use cut_model::masks::{self as M, MaskMode};
use cut_model::{Clip, Generator, Id, Project, Sequence, Source, TrackKind};

use crate::fx::edit;
use crate::fx::overlay::MaskSel;
use crate::i18n::{tr, trf};

/// The control a row edits its value with.
#[derive(Debug, Clone, PartialEq)]
pub enum Ctl {
    /// `[x, y]`: two numbers.
    Point,
    /// `[v, v]` shown as one number (Scale).
    Uniform,
    Number,
    /// `#rrggbb`.
    Color,
    Bool,
    /// One of `(id, English label)`.
    Choice(Vec<(&'static str, &'static str)>),
    /// Ticks of a clip field (Fade In, Fade Out), as a timecode.
    Duration,
    /// A mask's path: edited on the Program monitor, the row says how many vertices it has.
    MaskPath,
    /// Lumetri's curves: edited in the Lumetri panel, the row says how many points.
    Curve,
    /// A LUT id: edited in the Lumetri panel, the row names it.
    Lut,
}

/// A clip field a row edits instead of a property (`spec.field`): its own value, write and reset, never keyframed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    /// The clip speed in percent (later clips move along).
    Speed,
    /// Reverse Speed.
    Reverse,
}

/// One row: what it is called, what it edits and how.
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    /// The English label (shown through `tr()`).
    pub label: &'static str,
    /// The property path (`opacity`, `effects.<id>.<param>`, `masks.<id>.feather`, `layers.<id>.size`, `fadeIn`).
    pub path: String,
    /// Crop's side: the row edits one element of the keyframed array.
    pub index: Option<usize>,
    pub ctl: Ctl,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub unit: &'static str,
    /// The slider's range, when the row has one.
    pub slider: Option<[f64; 2]>,
    /// The value shown when the path has none (an effect parameter's default).
    pub fallback: Option<Value>,
    /// False for an effect parameter the registry says is not keyframable.
    pub keyframable: bool,
    /// Decimals shown, when not those of the step.
    pub precision: Option<usize>,
    pub field: Option<Field>,
}

impl Spec {
    fn new(label: &'static str, path: impl Into<String>, ctl: Ctl) -> Spec {
        Spec {
            label,
            path: path.into(),
            index: None,
            ctl,
            min: None,
            max: None,
            step: None,
            unit: "",
            slider: None,
            fallback: None,
            keyframable: true,
            precision: None,
            field: None,
        }
    }

    fn num(label: &'static str, path: impl Into<String>, min: f64, max: f64, step: f64) -> Spec {
        Spec { min: Some(min), max: Some(max), step: Some(step), ..Spec::new(label, path, Ctl::Number) }
    }

    fn unit(self, unit: &'static str) -> Spec {
        Spec { unit, ..self }
    }

    fn slider(self, lo: f64, hi: f64) -> Spec {
        Spec { slider: Some([lo, hi]), ..self }
    }

    fn fallback(self, v: f64) -> Spec {
        Spec { fallback: Some(Value::Num(v)), ..self }
    }

    /// Whether the row's property can be animated: it has a stopwatch, the keyframe buttons and a lane (crop: only
    /// its first row, the whole array being one keyframed property).
    pub fn watch(&self) -> bool {
        let kinds = !matches!(self.ctl, Ctl::Duration | Ctl::Choice(_) | Ctl::Bool);
        let keyframable = kinds && self.keyframable && self.field.is_none();
        match self.index {
            None => keyframable,
            Some(i) => i == 0,
        }
    }

    /// The row's key in the panel (`data-path`): crop's rows by their element.
    pub fn key(&self) -> String {
        match self.index {
            Some(i) => format!("{}[{i}]", self.path),
            None => self.path.clone(),
        }
    }
}

/// One line of a section.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    /// A group's name above its rows (Lumetri Color's).
    Heading(&'static str),
    Row(Spec),
    /// The mask buttons of Opacity (`None`) or of an effect.
    MaskTools(Option<Id>),
    /// A mask's header: `Mask (n)`, a click edits it on the Program monitor.
    MaskHead {
        sel: MaskSel,
        n: usize,
    },
    /// Time Remapping > Speed.
    RemapSpeed,
}

/// What a section is, for its header's buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Motion, Opacity, Crop, Volume ...: Reset only.
    Fixed,
    /// An applied effect: on/off, Reset, Move Up/Down, Remove, its header dragged to reorder.
    Effect { id: Id, index: usize, count: usize },
}

/// A section: a header and its rows.
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    /// Its key (`motion`, `opacity`, `fx:<clip>:<effect>`, `volume:<clip>` ...): what stays folded.
    pub id: String,
    /// Its name, translated.
    pub name: String,
    pub clip: Id,
    pub kind: Kind,
    pub items: Vec<Item>,
}

impl Section {
    /// The rows (not headings or masks' headers).
    pub fn specs(&self) -> impl Iterator<Item = &Spec> {
        self.items.iter().filter_map(|i| match i {
            Item::Row(s) => Some(s),
            _ => None,
        })
    }
}

/// The English names of the mask modes (`MODE_NAMES`).
fn mode_name(m: MaskMode) -> &'static str {
    match m {
        MaskMode::Add => "Add",
        MaskMode::Subtract => "Subtract",
        MaskMode::Intersect => "Intersect",
        MaskMode::Difference => "Difference",
        MaskMode::None => "None",
    }
}

/// The selected linked audio clips shown with a video clip (`companions`).
pub fn companions<'a>(seq: &'a Sequence, selection: &std::collections::HashSet<Id>, c: &Clip) -> Vec<&'a Clip> {
    if edit::kind_of(seq, c) != TrackKind::Video {
        return Vec::new();
    }
    seq.linked_clips(c)
        .into_iter()
        .filter(|x| selection.contains(&x.id) && edit::kind_of(seq, x) == TrackKind::Audio)
        .collect()
}

/// The sections of `clip` in the panel's order (`build`).
pub fn sections(
    project: &Project,
    seq: &Sequence,
    selection: &std::collections::HashSet<Id>,
    c: &Clip,
) -> Vec<Section> {
    let mut out = Vec::new();
    let fixed = |out: &mut Vec<Section>, id: String, name: String, items: Vec<Item>| {
        out.push(Section { id, name, clip: c.id, kind: Kind::Fixed, items });
    };
    let rows = |list: Vec<Spec>| list.into_iter().map(Item::Row).collect::<Vec<_>>();
    if edit::kind_of(seq, c) == TrackKind::Video {
        let point = |label, path| Spec { step: Some(1.0), ..Spec::new(label, path, Ctl::Point) };
        let motion = vec![
            point("Position", "position"),
            Spec { ctl: Ctl::Uniform, ..Spec::num("Scale", "scale", 0.0, 10000.0, 1.0).unit("%").slider(0.0, 400.0) },
            Spec::num("Rotation", "rotation", -36000.0, 36000.0, 1.0).unit("°"),
            point("Anchor Point", "anchor"),
        ];
        fixed(&mut out, "motion".into(), tr("Motion").into(), rows(motion));
        let mut opacity = mask_block(c, None);
        opacity.push(Item::Row(Spec::num("Opacity", "opacity", 0.0, 100.0, 1.0).unit("%").slider(0.0, 100.0)));
        fixed(&mut out, "opacity".into(), tr("Opacity").into(), opacity);
        if !project.is_still(c) {
            fixed(&mut out, format!("remap:{}", c.id), tr("Time Remapping").into(), vec![Item::RemapSpeed]);
        }
        let side = |label, i| Spec {
            index: Some(i),
            ..Spec::num(label, "crop", 0.0, 100.0, 0.5).unit("%").slider(0.0, 100.0)
        };
        let crop = vec![side("Top", 0), side("Right", 1), side("Bottom", 2), side("Left", 3)];
        fixed(&mut out, "crop".into(), tr("Crop").into(), rows(crop));
        if let Source::Generator { generator: Generator::Text, layers: Some(layers), .. } = &c.source {
            for l in layers {
                let id = l.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                let text = l.get("text").and_then(|v| v.as_str()).unwrap_or_default();
                let first: String = text.split('\n').next().unwrap_or_default().chars().take(24).collect();
                let name = trf("Text: {name}", &[("name", if first.is_empty() { id } else { &first })]);
                let p = |f: &str| format!("layers.{id}.{f}");
                let list = vec![
                    Spec { step: Some(1.0), ..Spec::new("Position", p("position"), Ctl::Point) },
                    Spec::num("Size", p("size"), 1.0, 2000.0, 1.0).slider(8.0, 400.0),
                    Spec::num("Opacity", p("opacity"), 0.0, 100.0, 1.0).unit("%").slider(0.0, 100.0).fallback(100.0),
                    Spec::num("Tracking", p("tracking"), -500.0, 2000.0, 1.0),
                    Spec::num("Characters Shown", p("reveal"), 0.0, 1.0, 0.01).slider(0.0, 1.0).fallback(1.0),
                    Spec::new("Fill", p("fill"), Ctl::Color),
                ];
                fixed(&mut out, format!("text:{id}"), name, rows(list));
            }
        }
        speed(&mut out, project, c);
    } else {
        audio(&mut out, c, false);
        speed(&mut out, project, c);
    }
    let others = companions(seq, selection, c);
    for a in &others {
        audio(&mut out, a, true);
    }
    effect_sections(&mut out, seq, c);
    for a in &others {
        effect_sections(&mut out, seq, a);
    }
    out
}

fn audio(out: &mut Vec<Section>, c: &Clip, linked: bool) {
    let name = if linked { tr("Volume (linked audio)") } else { tr("Volume") };
    let level = Spec::num("Level", "volume", -96.0, 15.0, 0.1).unit("dB").slider(-60.0, 15.0);
    let items = vec![
        Item::Row(level),
        Item::Row(Spec::new("Fade In", "fadeIn", Ctl::Duration)),
        Item::Row(Spec::new("Fade Out", "fadeOut", Ctl::Duration)),
    ];
    out.push(Section { id: format!("volume:{}", c.id), name: name.into(), clip: c.id, kind: Kind::Fixed, items });
    let pan = Spec::num("Balance", "pan", -100.0, 100.0, 1.0).slider(-100.0, 100.0);
    out.push(Section {
        id: format!("panner:{}", c.id),
        name: tr("Panner").into(),
        clip: c.id,
        kind: Kind::Fixed,
        items: vec![Item::Row(pan)],
    });
}

/// Speed and Reverse of a clip with a source; a remapped clip's speed is its curve, so it has none.
fn speed(out: &mut Vec<Section>, project: &Project, c: &Clip) {
    if project.is_still(c) || c.remap.is_some() {
        return;
    }
    let speed = Spec {
        precision: Some(2),
        field: Some(Field::Speed),
        ..Spec::num("Speed", "speed", 1.0, 10000.0, 1.0).unit("%").slider(10.0, 400.0)
    };
    let reverse = Spec { field: Some(Field::Reverse), ..Spec::new("Reverse Speed", "reverse", Ctl::Bool) };
    out.push(Section {
        id: format!("speed:{}", c.id),
        name: tr("Speed").into(),
        clip: c.id,
        kind: Kind::Fixed,
        items: vec![Item::Row(speed), Item::Row(reverse)],
    });
}

fn effect_sections(out: &mut Vec<Section>, seq: &Sequence, c: &Clip) {
    let count = c.effects.len();
    for (index, e) in c.effects.iter().enumerate() {
        let def = effects::get(&e.kind);
        let mut items = Vec::new();
        if def.is_some_and(|d| d.kind == effects::Kind::Video && d.masks) && edit::kind_of(seq, c) == TrackKind::Video {
            items = mask_block_of(c.id, Some(e.id), e.masks.as_deref().unwrap_or_default());
        }
        let mut group = None;
        for p in def.map_or(&[][..], |d| d.params) {
            if p.group.is_some() && p.group != group {
                items.push(Item::Heading(p.group.unwrap_or_default()));
            }
            group = p.group;
            let ctl = match p.kind {
                ParamKind::Number | ParamKind::Percent | ParamKind::Angle => Ctl::Number,
                ParamKind::Color => Ctl::Color,
                ParamKind::Bool => Ctl::Bool,
                ParamKind::Choice => Ctl::Choice(p.choices.to_vec()),
                ParamKind::Point => Ctl::Point,
                ParamKind::Curve => Ctl::Curve,
                ParamKind::Lut => Ctl::Lut,
            };
            let unit = p.unit.unwrap_or(match p.kind {
                ParamKind::Percent => "%",
                ParamKind::Angle => "°",
                _ => "",
            });
            let slider = match (p.min, p.max) {
                (Some(lo), Some(hi)) if lo.is_finite() && hi.is_finite() && hi - lo <= 2000.0 => Some([lo, hi]),
                _ => None,
            };
            items.push(Item::Row(Spec {
                min: p.min,
                max: p.max,
                step: p.step,
                unit,
                slider,
                fallback: cut_model::keyframes::from_json(&p.default.to_json()),
                keyframable: p.keyframable,
                ..Spec::new(p.name, format!("effects.{}.{}", e.id, p.id), ctl)
            }));
        }
        out.push(Section {
            id: format!("fx:{}:{}", c.id, e.id),
            name: def.map_or_else(|| e.kind.clone(), |d| tr(d.name).into_owned()),
            clip: c.id,
            kind: Kind::Effect { id: e.id, index, count },
            items,
        });
    }
}

fn mask_block(c: &Clip, effect: Option<Id>) -> Vec<Item> {
    mask_block_of(c.id, effect, c.masks.as_deref().unwrap_or_default())
}

/// The mask buttons, then each mask's header and rows (`maskBlock`).
fn mask_block_of(clip: Id, effect: Option<Id>, masks: &[M::Mask]) -> Vec<Item> {
    let mut items = vec![Item::MaskTools(effect)];
    for (i, m) in masks.iter().enumerate() {
        let sel = MaskSel { clip, effect, mask: m.id };
        items.push(Item::MaskHead { sel, n: i + 1 });
        let p = format!("{}.{}", M::prefix_of(effect.map(|e| e.as_str())), m.id);
        let modes = M::MODES.iter().map(|m| (m.name(), mode_name(*m))).collect();
        for spec in [
            Spec::new("Mask Path", format!("{p}.path"), Ctl::MaskPath),
            Spec::num("Mask Feather", format!("{p}.feather"), 0.0, 1000.0, 0.1).slider(0.0, 200.0),
            Spec::num("Mask Opacity", format!("{p}.opacity"), 0.0, 100.0, 0.1).unit("%").slider(0.0, 100.0),
            Spec::num("Mask Expansion", format!("{p}.expansion"), -2000.0, 2000.0, 0.1).slider(-200.0, 200.0),
            Spec::new("Inverted", format!("{p}.inverted"), Ctl::Bool),
            Spec::new("Mask Mode", format!("{p}.mode"), Ctl::Choice(modes)),
        ] {
            items.push(Item::Row(spec));
        }
    }
    items
}

/// The header's title and kind line (`title`, `sub`).
pub fn title(project: &Project, seq: &Sequence, c: &Clip) -> (String, String) {
    let media = match &c.source {
        Source::Media { media, .. } => project.media(*media).map(|m| m.name.clone()),
        _ => None,
    };
    let nest = project.nest_of(c).map(|s| s.name.clone());
    let name = [Some(c.name.clone()), media, nest]
        .into_iter()
        .flatten()
        .find(|n| !n.is_empty())
        .unwrap_or_else(|| tr("Clip").into_owned());
    let kind = match (&c.source, edit::kind_of(seq, c)) {
        (_, TrackKind::Audio) => "Audio Clip",
        (Source::Generator { generator: Generator::Text, .. }, _) => "Text",
        (Source::Generator { .. }, _) => "Graphic",
        _ => "Video Clip",
    };
    (name, tr(kind).into_owned())
}
