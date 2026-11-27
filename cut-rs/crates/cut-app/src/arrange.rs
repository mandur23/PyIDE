//! A workspace's arrangement as the person made it: rows top to bottom, each a run of slots left to right, each slot
//! a set of panel tabs. The built-in tables of [`crate::workspaces`] are where each starts; a tab dragged onto another
//! slot joins it, onto a slot's edge makes a slot beside it (left, right) or a row of its own (above, below), and a
//! closed panel leaves its slot (an emptied slot and an emptied row go, their room to the neighbour).
//!
//! Sizes are shares: a row's of the window's height (percent, the first row takes what is left), a slot's of its
//! row's width (any unit, divided by the row's sum); 0 is the Tools column, fixed. This file is the model without
//! egui; [`crate::workspaces`] draws it and keeps it in the settings.

use serde_json::{Value, json};

/// One slot: its share of the row, its panels as tabs.
#[derive(Debug, Clone, PartialEq)]
pub struct Slot {
    pub size: f32,
    pub panels: Vec<&'static str>,
}

/// One row: its share of the height, its slots.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub size: f32,
    pub slots: Vec<Slot>,
}

/// A workspace's rows.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Arrangement {
    pub rows: Vec<Row>,
}

/// A built-in table: rows of `(share, slots)`, each slot `(share, panels)`.
pub type Table = [(f32, &'static [(f32, &'static [&'static str])])];

/// Where a dragged tab goes, next to the slot holding `anchor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// Into the slot, as its last tab.
    Tabs,
    Left,
    Right,
    /// A row of its own above the anchor's row.
    Above,
    Below,
}

/// The Tools column (`0` share): it never takes tabs.
fn fixed(slot: &Slot) -> bool {
    slot.size == 0.0
}

impl Arrangement {
    /// The arrangement of a built-in table: `(row share, [(slot share, panels)])`.
    pub fn of(table: &Table) -> Arrangement {
        let rows = table
            .iter()
            .map(|(size, slots)| Row {
                size: *size,
                slots: slots.iter().map(|(size, panels)| Slot { size: *size, panels: panels.to_vec() }).collect(),
            })
            .collect();
        Arrangement { rows }
    }

    /// Every panel, in the slots' order.
    pub fn panels(&self) -> Vec<&'static str> {
        self.rows.iter().flat_map(|r| r.slots.iter().flat_map(|s| s.panels.iter().copied())).collect()
    }

    pub fn contains(&self, panel: &str) -> bool {
        self.slot_of(panel).is_some()
    }

    /// The row and slot holding `panel`.
    pub fn slot_of(&self, panel: &str) -> Option<(usize, usize)> {
        self.rows
            .iter()
            .enumerate()
            .find_map(|(ri, r)| r.slots.iter().position(|s| s.panels.contains(&panel)).map(|si| (ri, si)))
    }

    pub fn slot(&self, (ri, si): (usize, usize)) -> Option<&Slot> {
        self.rows.get(ri).and_then(|r| r.slots.get(si))
    }

    /// The panels of the slot at `at` (none when there is no such slot).
    pub fn slot_panels(&self, at: (usize, usize)) -> &[&'static str] {
        self.slot(at).map_or(&[], |s| s.panels.as_slice())
    }

    /// Takes `panel` out -> whether it was there. The last panel other than Tools stays (a workspace is never
    /// empty). An emptied slot gives its share to the slot before it (else after), an emptied row to the row above
    /// (else below).
    pub fn remove(&mut self, panel: &str) -> bool {
        let Some((ri, si)) = self.slot_of(panel) else { return false };
        if panel != "tools" && self.panels().iter().filter(|p| **p != "tools").count() <= 1 {
            return false;
        }
        let row = &mut self.rows[ri];
        row.slots[si].panels.retain(|p| *p != panel);
        if row.slots[si].panels.is_empty() {
            let gone = row.slots.remove(si);
            let heir = if si > 0 { si - 1 } else { 0 };
            if let Some(h) = row.slots.get_mut(heir).filter(|h| !fixed(h)) {
                h.size += gone.size;
            } else if let Some(h) = row.slots.iter_mut().find(|h| !fixed(h)) {
                h.size += gone.size;
            }
        }
        if self.rows[ri].slots.iter().all(fixed) {
            let gone = self.rows.remove(ri);
            // a row of the Tools column alone moves it to the row it gives its share to
            let heir = if ri > 0 { ri - 1 } else { 0 };
            if let Some(h) = self.rows.get_mut(heir) {
                h.size += gone.size;
                for (k, s) in gone.slots.into_iter().enumerate() {
                    h.slots.insert(k.min(h.slots.len()), s);
                }
            }
        }
        true
    }

    /// Puts `panel` (not in the arrangement) next to the slot holding `anchor` -> whether it went in. Tools never
    /// joins a slot's tabs and no panel joins the Tools column.
    pub fn insert(&mut self, panel: &'static str, anchor: &str, side: Side) -> bool {
        if self.contains(panel) {
            return false;
        }
        let Some((ri, si)) = self.slot_of(anchor) else { return false };
        match side {
            Side::Tabs => {
                let s = &mut self.rows[ri].slots[si];
                if fixed(s) || panel == "tools" {
                    return false;
                }
                s.panels.push(panel);
            }
            Side::Left | Side::Right => {
                let row = &mut self.rows[ri];
                let share = if panel == "tools" {
                    0.0
                } else if fixed(&row.slots[si]) {
                    row.slots.iter().map(|s| s.size).sum::<f32>().max(1.0) / 4.0
                } else {
                    let half = row.slots[si].size / 2.0;
                    row.slots[si].size -= half;
                    half
                };
                let at = if side == Side::Left { si } else { si + 1 };
                row.slots.insert(at, Slot { size: share, panels: vec![panel] });
            }
            Side::Above | Side::Below => {
                if panel == "tools" {
                    return false;
                }
                let half = (self.rows[ri].size / 2.0).max(10.0);
                self.rows[ri].size = (self.rows[ri].size - half).max(10.0);
                let at = if side == Side::Above { ri } else { ri + 1 };
                self.rows.insert(at, Row { size: half, slots: vec![Slot { size: 100.0, panels: vec![panel] }] });
            }
        }
        true
    }

    /// Moves `panel` next to the slot holding `anchor` -> whether anything changed. Dropping a slot's only panel on
    /// its own slot, or a tab on its own slot's tabs, changes nothing.
    pub fn move_to(&mut self, panel: &'static str, anchor: &'static str, side: Side) -> bool {
        let (Some(from), Some(to)) = (self.slot_of(panel), self.slot_of(anchor)) else { return false };
        if from == to && (side == Side::Tabs || self.slot_panels(from).len() == 1) {
            return false;
        }
        let mut next = self.clone();
        // the anchor's slot keeps a panel to find it by once `panel` is out of it
        let anchor = if anchor == panel {
            match next.slot_panels(to).iter().find(|p| **p != panel) {
                Some(a) => *a,
                None => return false,
            }
        } else {
            anchor
        };
        if !next.remove(panel) || !next.insert(panel, anchor, side) {
            return false;
        }
        *self = next;
        true
    }

    /// Whether the two have the same slots with the same panels, whatever their shares.
    pub fn same_places(&self, other: &Arrangement) -> bool {
        let places = |a: &Arrangement| -> Vec<Vec<Vec<&'static str>>> {
            a.rows.iter().map(|r| r.slots.iter().map(|s| s.panels.clone()).collect()).collect()
        };
        places(self) == places(other)
    }

    /// The settings value: `{rows: [{size, slots: [{size, panels}]}]}`.
    pub fn to_json(&self) -> Value {
        let rows: Vec<Value> = self
            .rows
            .iter()
            .map(|r| {
                let slots: Vec<Value> = r.slots.iter().map(|s| json!({ "size": s.size, "panels": s.panels })).collect();
                json!({ "size": r.size, "slots": slots })
            })
            .collect();
        json!({ "rows": rows })
    }

    /// The arrangement a settings value holds, with the panels `known` names; `None` when it holds none (malformed,
    /// empty, or a panel twice).
    pub fn from_json(v: &Value, known: impl Fn(&str) -> Option<&'static str>) -> Option<Arrangement> {
        let num = |v: &Value| v.as_f64().filter(|x| x.is_finite() && *x >= 0.0).map(|x| x as f32);
        let mut out = Arrangement::default();
        for r in v.get("rows")?.as_array()? {
            let mut row = Row { size: num(r.get("size")?)?.max(1.0), slots: Vec::new() };
            for s in r.get("slots")?.as_array()? {
                let panels: Vec<&'static str> =
                    s.get("panels")?.as_array()?.iter().filter_map(|p| p.as_str().and_then(&known)).collect();
                if !panels.is_empty() {
                    row.slots.push(Slot { size: num(s.get("size")?)?, panels });
                }
            }
            if !row.slots.is_empty() {
                out.rows.push(row);
            }
        }
        let all = out.panels();
        let unique = all.iter().enumerate().all(|(i, p)| !all[..i].contains(p));
        (unique && all.iter().any(|p| *p != "tools")).then_some(out)
    }
}

/// Korean of the texts the arrangement's menus and dialogs show.
pub const KO: [(&str, &str); 14] = [
    ("Close Panel", "패널 닫기"),
    ("Reset to Default Layout", "기본 배치로 재설정"),
    ("Saved Layouts", "저장한 배치"),
    ("Save Layout As…", "배치를 다른 이름으로 저장…"),
    ("Delete Layout", "배치 삭제"),
    ("No saved layouts", "저장한 배치 없음"),
    ("Layout name", "배치 이름"),
    ("Save Layout", "배치 저장"),
    ("Saved the layout {name}", "{name} 배치를 저장했습니다"),
    ("Applied the layout {name}", "{name} 배치를 적용했습니다"),
    ("A workspace keeps at least one panel.", "작업 영역에는 패널이 하나 이상 있어야 합니다."),
    (
        "Drag a tab onto another panel to dock it there: the middle joins its tabs, an edge makes a place beside it.",
        "탭을 다른 패널로 끌어 놓으면 거기에 붙습니다. 가운데는 그 탭들에 더하고, 가장자리는 옆에 새 칸을 만듭니다.",
    ),
    ("Replace the layout {name}?", "{name} 배치를 바꿀까요?"),
    ("Replace", "바꾸기"),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn editing() -> Arrangement {
        Arrangement::of(&[
            (54.0, &[(45.0, &["source", "controls"]), (55.0, &["program"])]),
            (46.0, &[(28.0, &["project", "effects"]), (0.0, &["tools"]), (66.0, &["timeline"]), (6.0, &["meters"])]),
        ])
    }

    fn known(p: &str) -> Option<&'static str> {
        ["source", "controls", "program", "project", "effects", "tools", "timeline", "meters", "history"]
            .into_iter()
            .find(|k| *k == p)
    }

    #[test]
    fn a_tab_joins_another_slot_and_its_old_slot_goes_when_emptied() {
        let mut a = editing();
        assert!(a.move_to("program", "source", Side::Tabs));
        assert_eq!(a.rows[0].slots.len(), 1);
        assert_eq!(a.rows[0].slots[0].panels, ["source", "controls", "program"]);
        assert_eq!(a.rows[0].slots[0].size, 100.0, "the emptied slot's share goes to its neighbour");
        assert!(!a.move_to("program", "controls", Side::Tabs), "its own slot's tabs: nothing changes");
    }

    #[test]
    fn an_edge_makes_a_slot_beside_or_a_row_and_halves_the_room() {
        let mut a = editing();
        assert!(a.move_to("effects", "program", Side::Right));
        assert_eq!(
            a.rows[0].slots.iter().map(|s| s.panels.clone()).collect::<Vec<_>>(),
            [vec!["source", "controls"], vec!["program"], vec!["effects"]]
        );
        assert_eq!((a.rows[0].slots[1].size, a.rows[0].slots[2].size), (27.5, 27.5));
        assert!(a.move_to("controls", "timeline", Side::Below));
        assert_eq!(a.rows.len(), 3);
        assert_eq!(a.rows[2].slots[0].panels, ["controls"]);
        assert_eq!((a.rows[1].size, a.rows[2].size), (23.0, 23.0));
        // a slot's only panel onto its own slot's edge: nothing changes
        assert!(!a.move_to("controls", "controls", Side::Left));
        // a slot of two split in place
        let mut b = editing();
        assert!(b.move_to("effects", "effects", Side::Left));
        assert_eq!(b.slot_panels((1, 0)), ["effects"]);
        assert_eq!(b.slot_panels((1, 1)), ["project"]);
        assert_eq!((b.rows[1].slots[0].size, b.rows[1].slots[1].size), (14.0, 14.0));
    }

    #[test]
    fn closing_keeps_one_panel_and_tools_never_takes_tabs() {
        let mut a = editing();
        assert!(!a.insert("history", "tools", Side::Tabs));
        assert!(!a.move_to("project", "tools", Side::Tabs));
        for p in ["source", "controls", "program", "project", "effects", "timeline"] {
            assert!(a.remove(p), "{p}");
        }
        assert!(!a.remove("meters"), "the last panel stays");
        assert_eq!(a.panels(), ["tools", "meters"]);
        assert_eq!(a.rows.len(), 1, "the emptied first row went");
        assert!(a.insert("program", "meters", Side::Above));
        assert_eq!(a.rows[0].slots[0].panels, ["program"]);
    }

    #[test]
    fn an_emptied_row_gives_its_room_and_carries_the_tools_column() {
        let mut a = editing();
        assert!(a.remove("project") && a.remove("effects") && a.remove("timeline") && a.remove("meters"));
        assert_eq!(a.rows.len(), 1);
        assert_eq!(a.rows[0].size, 100.0);
        assert!(a.panels().contains(&"tools"));
    }

    #[test]
    fn the_settings_keep_it_and_refuse_what_is_broken() {
        let mut a = editing();
        a.move_to("effects", "timeline", Side::Above);
        let back = Arrangement::from_json(&a.to_json(), known).unwrap();
        assert_eq!(back, a);
        let twice = json!({ "rows": [{ "size": 100, "slots": [{ "size": 1, "panels": ["program", "program"] }] }] });
        assert_eq!(Arrangement::from_json(&twice, known), None);
        let unknown = json!({ "rows": [{ "size": 100, "slots": [{ "size": 1, "panels": ["nope", "program"] }] }] });
        assert_eq!(Arrangement::from_json(&unknown, known).unwrap().panels(), ["program"]);
        assert_eq!(Arrangement::from_json(&json!({ "rows": [] }), known), None);
        assert_eq!(Arrangement::from_json(&json!("x"), known), None);
    }
}
