//! The effect and transition registry as data (port of the registry part of `effects.js`, docs/cut-architecture.md
//! section 8): each effect's type name, kind, whether it takes masks, and its parameters with their defaults and
//! ranges. The commands need it to know which effects take masks; the effect controls and the compositor read the
//! same table. The shaders and the CPU references are not here.
//!
//! [`table::ALL`] is written by `tools/gen-effects.mjs` from the JavaScript; `tests/registry.rs` checks it is current.

mod table;

use serde_json::{Map, Value as Json, json};

pub use table::ALL;

/// Whether an effect works on pictures or on sound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Video,
    Audio,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Video => "video",
            Kind::Audio => "audio",
        }
    }
}

/// What a parameter holds, as the JavaScript's `type` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamKind {
    Number,
    Percent,
    Angle,
    /// `#rrggbb` in sRGB.
    Color,
    Bool,
    /// One of [`Param::choices`].
    Choice,
    /// `[x, y]`.
    Point,
    /// Lumetri Color's curve: a flat list of points `[x0, y0, x1, y1, ...]` keyframed as a whole.
    Curve,
    /// An id of `project.luts`, or '' for none.
    Lut,
}

impl ParamKind {
    pub fn name(self) -> &'static str {
        match self {
            ParamKind::Number => "number",
            ParamKind::Percent => "percent",
            ParamKind::Angle => "angle",
            ParamKind::Color => "color",
            ParamKind::Bool => "bool",
            ParamKind::Choice => "choice",
            ParamKind::Point => "point",
            ParamKind::Curve => "curve",
            ParamKind::Lut => "lut",
        }
    }

    /// A number kept between `min` and `max`.
    pub fn numeric(self) -> bool {
        matches!(self, ParamKind::Number | ParamKind::Percent | ParamKind::Angle)
    }
}

/// A parameter's default value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Default {
    Num(f64),
    Flag(bool),
    Text(&'static str),
    List(&'static [f64]),
}

impl Default {
    pub fn to_json(self) -> Json {
        match self {
            Default::Num(x) => json!(x),
            Default::Flag(b) => json!(b),
            Default::Text(s) => json!(s),
            Default::List(l) => json!(l),
        }
    }
}

/// One parameter of an effect: what the controls panel builds its row from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Param {
    pub id: &'static str,
    /// The English label (shown through `tr()`).
    pub name: &'static str,
    pub kind: ParamKind,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub default: Default,
    pub keyframable: bool,
    /// The panel section it is shown in (Lumetri Color's).
    pub group: Option<&'static str>,
    pub unit: Option<&'static str>,
    /// `(id, label)` of each choice.
    pub choices: &'static [(&'static str, &'static str)],
}

/// One effect or transition of the registry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Def {
    /// The type name an effect stores in `type` (`blur.gaussian`).
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub kind: Kind,
    pub transition: bool,
    /// Whether the effect can be limited by masks (`masks: false` in the JavaScript says it cannot).
    pub masks: bool,
    /// Edge Extend: the compositor stretches the clip's edges while placing it (`layer.extend`).
    pub extend: bool,
    pub params: &'static [Param],
}

/// The effect or transition of a type name (`get`).
pub fn get(id: &str) -> Option<&'static Def> {
    ALL.iter().find(|d| d.id == id)
}

/// The effects, of one kind or all (`list`).
pub fn list(kind: Option<Kind>) -> impl Iterator<Item = &'static Def> {
    ALL.iter().filter(move |d| !d.transition && kind.is_none_or(|k| d.kind == k))
}

/// The transitions, of one kind or all (`transitions`).
pub fn transitions(kind: Option<Kind>) -> impl Iterator<Item = &'static Def> {
    ALL.iter().filter(move |d| d.transition && kind.is_none_or(|k| d.kind == k))
}

/// The transition a new one gets (`defaultTransition`).
pub fn default_transition(kind: Kind) -> &'static str {
    match kind {
        Kind::Video => "dissolve",
        Kind::Audio => "crossfade.power",
    }
}

/// Every parameter at its default (`defaults`); empty for a type the registry does not have.
pub fn defaults(id: &str) -> Map<String, Json> {
    get(id).map(|d| d.params.iter().map(|p| (p.id.to_owned(), p.default.to_json())).collect()).unwrap_or_default()
}

/// An effect's parameters with the defaults under the stored ones, numbers kept in range and choices valid
/// (`resolve`). A type the registry does not have keeps its parameters as they are.
pub fn resolve(id: &str, params: &Map<String, Json>) -> Map<String, Json> {
    let Some(d) = get(id) else { return params.clone() };
    let mut out = defaults(id);
    for p in d.params {
        let Some(v) = params.get(p.id).filter(|v| !v.is_null()) else { continue };
        let value = match p.kind {
            k if k.numeric() => v.as_f64().filter(|x| x.is_finite()).map(|x| {
                let x = p.max.map_or(x, |m| if x > m { m } else { x });
                json!(p.min.map_or(x, |m| if x < m { m } else { x }))
            }),
            ParamKind::Bool => Some(json!(truthy(v))),
            ParamKind::Choice => {
                Some(if p.choices.iter().any(|(c, _)| v.as_str() == Some(c)) { v.clone() } else { p.default.to_json() })
            }
            ParamKind::Color | ParamKind::Lut => v.is_string().then(|| v.clone()),
            ParamKind::Point => {
                v.as_array().filter(|a| a.len() == 2 && a.iter().all(Json::is_number)).map(|_| v.clone())
            }
            ParamKind::Curve => v.as_array().map(|a| json!(crate::lumetri::sanitize(a))),
            _ => None,
        };
        if let Some(value) = value {
            out.insert(p.id.to_owned(), value);
        }
    }
    out
}

/// Reading resolved parameters: what the engine's uniforms and CPU references ask of them.
pub trait Params {
    /// A number, 0 when missing or not a number.
    fn num(&self, id: &str) -> f64;
    /// JavaScript's `!!p[id]`.
    fn flag(&self, id: &str) -> bool;
    /// A string, '' when missing or not a string.
    fn text(&self, id: &str) -> &str;
    /// The first two numbers of a list, 0 for each missing one.
    fn pair(&self, id: &str) -> [f64; 2];
    /// The numbers of a list (others left out), empty when missing.
    fn list(&self, id: &str) -> Vec<f64>;
}

impl Params for Map<String, Json> {
    fn num(&self, id: &str) -> f64 {
        self.get(id).and_then(Json::as_f64).unwrap_or(0.0)
    }
    fn flag(&self, id: &str) -> bool {
        self.get(id).is_some_and(truthy)
    }
    fn text(&self, id: &str) -> &str {
        self.get(id).and_then(Json::as_str).unwrap_or("")
    }
    fn pair(&self, id: &str) -> [f64; 2] {
        let l = self.list(id);
        [l.first().copied().unwrap_or(0.0), l.get(1).copied().unwrap_or(0.0)]
    }
    fn list(&self, id: &str) -> Vec<f64> {
        self.get(id).and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_f64).collect()).unwrap_or_default()
    }
}

/// JavaScript's `!!v` of a JSON value.
fn truthy(v: &Json) -> bool {
    match v {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Json::String(s) => !s.is_empty(),
        _ => true,
    }
}
