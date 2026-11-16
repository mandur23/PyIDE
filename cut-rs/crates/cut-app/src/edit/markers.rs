//! Markers as the Markers panel and the marker dialog see them (port of `ui-markers.js`'s `markersOf` and the
//! panel's filter): every sequence marker and every clip marker of the active sequence, in time order, filtered by
//! type, colour and a search of the name and the comment.

use cut_model::{Id, Marker, MarkerKind, Sequence};
use cut_time::Ticks;
use eframe::egui::Color32;

/// `MARKER_COLORS` and `MARKER_NAMES` of ui-timeline.js, in their order.
pub const COLORS: [(&str, &str, Color32); 8] = [
    ("green", "Green", Color32::from_rgb(0x5f, 0xb2, 0x36)),
    ("red", "Red", Color32::from_rgb(0xe0, 0x55, 0x55)),
    ("purple", "Purple", Color32::from_rgb(0xa2, 0x6b, 0xe0)),
    ("orange", "Orange", Color32::from_rgb(0xe8, 0x91, 0x3b)),
    ("yellow", "Yellow", Color32::from_rgb(0xe6, 0xc8, 0x4a)),
    ("white", "White", Color32::from_rgb(0xe8, 0xe8, 0xe8)),
    ("blue", "Blue", Color32::from_rgb(0x4a, 0x8f, 0xe6)),
    ("cyan", "Cyan", Color32::from_rgb(0x3f, 0xc1, 0xc9)),
];

/// The marker types (`KINDS`): id, English name.
pub const KINDS: [(MarkerKind, &str); 3] =
    [(MarkerKind::Comment, "Comment"), (MarkerKind::Chapter, "Chapter"), (MarkerKind::Beat, "Beat")];

/// A marker colour by its name, green for one the table does not have.
pub fn color(name: &str) -> Color32 {
    COLORS.iter().find(|c| c.0 == name).map_or(COLORS[0].2, |c| c.2)
}

pub fn kind_name(k: MarkerKind) -> &'static str {
    KINDS.iter().find(|x| x.0 == k).map_or("Comment", |x| x.1)
}

/// One marker of the list: the marker, the clip it is on (`None` for a sequence marker) and its sequence time.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub marker: Marker,
    pub clip: Option<Id>,
    pub t: Ticks,
    /// What the list names it: the marker's name, else its clip's.
    pub name: String,
}

/// Every marker of a sequence by sequence time, a sequence marker before a clip marker at the same time.
pub fn markers_of(seq: &Sequence) -> Vec<Row> {
    let mut out: Vec<Row> =
        seq.markers.iter().map(|m| Row { marker: m.clone(), clip: None, t: m.t, name: m.name.clone() }).collect();
    for c in seq.clips() {
        for m in c.markers.iter().flatten() {
            let name = if m.name.is_empty() { c.name.clone() } else { m.name.clone() };
            out.push(Row { marker: m.clone(), clip: Some(c.id), t: c.start + m.t, name });
        }
    }
    out.sort_by_key(|r| (r.t, r.clip.is_some()));
    out
}

/// The panel's filter and selection.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MarkersView {
    pub search: String,
    pub kind: Option<MarkerKind>,
    pub color: Option<&'static str>,
    pub selected: Option<Id>,
}

impl MarkersView {
    /// Whether a marker passes the filter (`refresh`'s test).
    pub fn shows(&self, m: &Marker) -> bool {
        let q = self.search.trim().to_lowercase();
        self.kind.is_none_or(|k| m.kind == k)
            && self.color.is_none_or(|c| m.color == c)
            && (q.is_empty() || format!("{}\n{}", m.name, m.note).to_lowercase().contains(&q))
    }
}
