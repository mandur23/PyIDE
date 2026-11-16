//! The installed font families for the Text panel (`cut:fonts`): each family's English name, its Korean name when
//! the font has one, and its weights and italics, read from the system's fonts on a thread of their own.

use std::sync::mpsc::{Receiver, channel};

use cosmic_text::fontdb;

/// One family as the Text panel lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Family {
    pub family: String,
    /// The name in Korean when the font has one (`localName`).
    pub local: Option<String>,
    /// (weight, italic), lightest first.
    pub styles: Vec<(u16, bool)>,
}

impl Family {
    /// `fontLabel`: `맑은 고딕 (Malgun Gothic)`, or the family.
    pub fn label(&self) -> String {
        match &self.local {
            Some(l) if *l != self.family => format!("{l} ({})", self.family),
            _ => self.family.clone(),
        }
    }
}

/// The families, sorted by label.
pub fn list() -> Vec<Family> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut out: Vec<Family> = Vec::new();
    for face in db.faces() {
        let Some((name, _)) =
            face.families.iter().find(|(_, l)| *l == fontdb::Language::English_UnitedStates).or(face.families.first())
        else {
            continue;
        };
        let local = face.families.iter().find(|(_, l)| *l == fontdb::Language::Korean_Korea).map(|(n, _)| n.clone());
        let style = (face.weight.0, face.style != fontdb::Style::Normal);
        match out.iter_mut().find(|f| f.family == *name) {
            Some(f) => {
                if !f.styles.contains(&style) {
                    f.styles.push(style);
                }
                if f.local.is_none() {
                    f.local = local;
                }
            }
            None => out.push(Family { family: name.clone(), local, styles: vec![style] }),
        }
    }
    for f in &mut out {
        f.styles.sort_unstable();
    }
    out.sort_by_cached_key(|f| f.label().to_lowercase());
    out
}

/// The families read on a thread.
pub fn load() -> Receiver<Vec<Family>> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(list());
    });
    rx
}

/// The style nearest a weight and italic (`nearest`): the same italic first, then the closest weight.
pub fn nearest(styles: &[(u16, bool)], weight: f64, italic: bool) -> Option<(u16, bool)> {
    styles.iter().copied().min_by(|a, b| {
        let key = |s: &(u16, bool)| (s.1 != italic, (f64::from(s.0) - weight).abs());
        let (ka, kb) = (key(a), key(b));
        ka.0.cmp(&kb.0).then(ka.1.total_cmp(&kb.1))
    })
}
