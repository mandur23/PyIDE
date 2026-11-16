//! What the timeline and the Project panel mark on media (`ui-proxy.js`'s `state` and `proxyBadge`, `ui-project.js`'s
//! offline mark, `drawClip`'s offline colour and label): offline media, and the proxy of each video, copied from the
//! shell's state once a frame so the timeline, which gets only the [`crate::state::App`], can draw them.

use std::collections::{HashMap, HashSet};

use cut_model::{Clip, Id, Media};
use eframe::egui::{Color32, CornerRadius, FontId, Painter, Rect, pos2, vec2};

use crate::i18n::{tr, trf};
use crate::prefs::proxy::JobState;
use crate::shell::Shell;

/// A media item's proxy (`state`).
#[derive(Debug, Clone, PartialEq)]
pub enum ProxyMark {
    Waiting,
    /// Being made: the part done.
    Running(f64),
    /// Waiting to start while a monitor plays.
    Paused,
    Ready,
    /// The media has a proxy whose file is gone: the original plays.
    Missing,
    Failed(String),
}

impl ProxyMark {
    /// The badge's text (`P`, `P 40%`).
    pub fn label(&self) -> String {
        match self {
            ProxyMark::Running(f) => format!("P {}%", (f * 100.0).floor()),
            _ => "P".to_owned(),
        }
    }

    /// The badge's hover text (`PROXY_TEXT`).
    pub fn text(&self) -> String {
        match self {
            ProxyMark::Waiting => tr("Proxy queued").into_owned(),
            ProxyMark::Running(f) => trf("Making proxy {pct}%", &[("pct", &(f * 100.0).floor().to_string())]),
            ProxyMark::Paused => tr("Proxy waits while playing").into_owned(),
            ProxyMark::Ready => tr("Has a proxy").into_owned(),
            ProxyMark::Missing => tr("Proxy file missing: the original plays").into_owned(),
            ProxyMark::Failed(e) => trf("The proxy could not be made: {error}", &[("error", &tr(e))]),
        }
    }

    /// The badge's colour: green when ready, amber while it is made, red when it failed or its file is gone.
    pub fn color(&self) -> Color32 {
        match self {
            ProxyMark::Ready => Color32::from_rgb(0x3f, 0xa3, 0x5b),
            ProxyMark::Missing | ProxyMark::Failed(_) => Color32::from_rgb(0xc0, 0x44, 0x44),
            _ => Color32::from_rgb(0xd9, 0x96, 0x2e),
        }
    }
}

/// The marks of the open project.
#[derive(Debug, Default)]
pub struct Marks {
    /// Media whose file was not there at the last check.
    pub offline: HashSet<Id>,
    pub proxies: HashMap<Id, ProxyMark>,
    /// The clip menu's Automation items that can run now.
    pub auto: HashMap<&'static str, bool>,
    /// Whether each proxy file is there, as of a project revision (a file check per frame would be wasted).
    files: (Option<u64>, HashMap<String, bool>),
    /// The project's media items, as of a project revision.
    known: (Option<u64>, HashSet<Id>),
}

impl Marks {
    /// Whether a clip shows offline media (`offline` of `drawClip`): its media item is gone or its file is.
    pub fn offline_clip(&self, c: &Clip) -> bool {
        c.media_id().is_some_and(|m| !self.known.1.contains(&m) || self.offline.contains(&m))
    }
}

/// A media item's proxy now (`state`): its job's, else whether it has one and its file is there.
pub fn proxy_of(s: &Shell, m: &Media, files: &HashMap<String, bool>) -> Option<ProxyMark> {
    let jobs = &s.features.prefs.proxy.jobs;
    let job = jobs
        .iter()
        .find(|j| j.media == m.id && matches!(j.state, JobState::Waiting | JobState::Running))
        .or_else(|| jobs.iter().find(|j| j.media == m.id && j.state == JobState::Failed));
    if let Some(j) = job {
        return Some(match j.state {
            JobState::Waiting | JobState::Running if j.paused => ProxyMark::Paused,
            JobState::Waiting => ProxyMark::Waiting,
            JobState::Running => ProxyMark::Running(j.fraction()),
            _ => ProxyMark::Failed(j.error.clone().unwrap_or_default()),
        });
    }
    let p = m.proxy.as_ref()?;
    Some(if files.get(&p.path).copied().unwrap_or(true) { ProxyMark::Ready } else { ProxyMark::Missing })
}

/// Copies the marks from the shell (each frame). -> whether the clip menu just got its Automation items (it needs
/// another frame to show them).
pub fn refresh(s: &mut Shell) -> bool {
    let revision = s.app.history.revision();
    let mut files = std::mem::take(&mut s.timeline.direct.marks.files);
    if files.0 != Some(revision) {
        let have = s.app.project().media.iter().filter_map(|m| m.proxy.as_ref()).map(|p| {
            let there = std::path::Path::new(&p.path).is_file();
            (p.path.clone(), there)
        });
        files = (Some(revision), have.collect());
    }
    if s.timeline.direct.marks.known.0 != Some(revision) {
        let ids = s.app.project().media.iter().map(|m| m.id).collect();
        s.timeline.direct.marks.known = (Some(revision), ids);
    }
    let proxies = s.app.project().media.iter().filter_map(|m| Some((m.id, proxy_of(s, m, &files.1)?))).collect();
    // asked only while the clip menu shows them: some of them look at every clip of the sequence
    let auto = if s.timeline.clip_menu_open() {
        menu_ids().iter().map(|id| (*id, s.action_enabled(id))).collect()
    } else {
        HashMap::new()
    };
    let marks = &mut s.timeline.direct.marks;
    let opened = marks.auto.is_empty() && !auto.is_empty();
    marks.files = files;
    marks.proxies = proxies;
    marks.auto = auto;
    marks.offline.clone_from(&s.features.prefs.relink.offline);
    opened
}

fn menu_ids() -> &'static [&'static str] {
    &["auto.loudness", "auto.clipLoudness", "auto.silence", "auto.scenes", "auto.beats", "auto.duck", "auto.color"]
}

/// The proxy badge at the top right of a clip's bar (the Project panel's `cut-proxy-badge`, which the JavaScript's
/// timeline does not draw) -> the width it takes from the name.
pub fn clip(p: &Painter, marks: &Marks, c: &Clip, r: Rect) -> f32 {
    let Some(mark) = c.media_id().and_then(|m| marks.proxies.get(&m)) else { return 0.0 };
    let text = mark.label();
    let font = FontId::proportional(9.5);
    let g = p.layout_no_wrap(text, font, Color32::WHITE);
    let size = g.size() + vec2(6.0, 2.0);
    if r.width() < size.x + 24.0 || r.height() < 14.0 {
        return 0.0;
    }
    let at = Rect::from_min_size(pos2(r.right() - size.x - 3.0, r.top() + 2.0), size);
    p.rect_filled(at, CornerRadius::same(3), mark.color());
    p.galley(at.center() - g.size() / 2.0, g, Color32::WHITE);
    size.x + 4.0
}

/// The same badge in a Project panel row or tile, right-aligned at `right` on the line `y`.
pub fn item(p: &Painter, mark: &ProxyMark, right: f32, y: f32) -> Rect {
    let g = p.layout_no_wrap(mark.label(), FontId::proportional(10.5), Color32::WHITE);
    let r = Rect::from_min_size(pos2(right - g.size().x - 8.0, y - g.size().y / 2.0 - 1.0), g.size() + vec2(8.0, 2.0));
    p.rect_filled(r, CornerRadius::same(3), mark.color());
    p.galley(r.center() - g.size() / 2.0, g, Color32::WHITE);
    r
}
