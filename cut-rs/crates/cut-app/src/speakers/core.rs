//! Speaker labels' pure half, the port of `speakers.js`: who speaks when, from speaker embeddings of the speech that
//! recognition found. Every function answers as the JavaScript's does (`tests/speakers_oracle.rs`).
//!
//! - Windows: a transcript's words split at pauses and after sentence ends into segments; a short segment is one
//!   window (widened into the silence around it when shorter than `min`), a long one is covered by `size` s windows
//!   every `hop` s.
//! - Clusters: agglomerative, average linkage on cosine similarity (NN-chain), cut at `threshold` (Auto) or reached
//!   at a fixed count from a finer cut; short windows and small clusters join the nearest speaker.
//! - Words take the speaker their windows vote for; a short flip inside a segment joins the longer side.
//! - Turns `[t0, t1, id]` per media file, what `project.speakers` keeps and what a person changes by hand.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

/// A word of a transcript (source seconds) or of the timeline (ticks, with its clip): speech recognition's.
pub use crate::speech::text::Word;

/// Readable on the caption background and on both themes' panels.
pub const PALETTE: [&str; 10] =
    ["#4fc3f7", "#ffb74d", "#81c784", "#f06292", "#ba68c8", "#fff176", "#4db6ac", "#e57373", "#90a4ae", "#a1887f"];
/// The most speakers labels have.
pub const MAX: usize = 10;

/// A window of speech to embed: source seconds, its segment, and the seconds of words inside.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Window {
    pub t0: f64,
    pub t1: f64,
    pub seg: usize,
    pub speech: f64,
}

/// A merge of the average-linkage tree: the clusters named by their first items, and their similarity.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Merge {
    pub a: usize,
    pub b: usize,
    pub sim: f64,
}

/// A turn: `[t0, t1, id]` source seconds and the speaker.
pub type Turn = (f64, f64, String);

/// A speaker of the project's list (`name` empty: shown as "Speaker N").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Speaker {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub color: String,
}

/// `project.speakers`: the list, the turns of each media file, and the fixed count the labels were made with (0 Auto).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Labels {
    pub list: Vec<Speaker>,
    pub turns: BTreeMap<String, Vec<Turn>>,
    #[serde(default)]
    pub count: u32,
}

impl Labels {
    /// The project's labels, when it has valid ones.
    pub fn of(project: &cut_model::Project) -> Option<Labels> {
        project.speakers.as_ref().and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    /// The speaker with `id`.
    pub fn get(&self, id: &str) -> Option<&Speaker> {
        self.list.iter().find(|s| s.id == id)
    }
}

/// The tunings (`DEFAULTS`, tuned on the JavaScript's speaker benchmark).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Opts {
    pub gap: f64,
    pub sentences: bool,
    pub short: f64,
    pub size: f64,
    pub hop: f64,
    pub min: f64,
    pub trust: f64,
    pub threshold: f64,
    #[serde(rename = "minSpeech")]
    pub min_speech: f64,
    pub spare: f64,
    #[serde(rename = "minRun")]
    pub min_run: f64,
    pub limit: f64,
    /// A fixed number of speakers; `None` (or 0) is Auto.
    pub count: Option<f64>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            gap: 0.3,
            sentences: true,
            short: 4.0,
            size: 3.0,
            hop: 1.5,
            min: 1.0,
            trust: 0.8,
            threshold: 0.5,
            min_speech: 2.5,
            spare: 3.0,
            min_run: 1.0,
            limit: 1500.0,
            count: None,
        }
    }
}

/// `Math.round(x * 1000) / 1000`.
fn round(x: f64) -> f64 {
    cut_audio::util::js_round(x * 1000.0) / 1000.0
}

// ---- windows ----

/// Whether a word's text ends a sentence (`/[.?!。？！…]["'”’)\]]*$/`).
fn ends_sentence(text: &str) -> bool {
    let t = text.trim_end_matches(['"', '\'', '”', '’', ')', ']']);
    t.ends_with(['.', '?', '!', '。', '？', '！', '…'])
}

/// The runs of words without a pause of `gap` s, also split after a sentence's end -> `[first, last]` indexes.
pub fn segments(words: &[Word], o: &Opts) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (i, w) in words.iter().enumerate() {
        if let Some(last) = out.last_mut() {
            let prev = &words[last.1];
            if w.t0 - prev.t1 < o.gap && !(o.sentences && ends_sentence(&prev.text)) {
                last.1 = i;
                continue;
            }
        }
        out.push((i, i));
    }
    out
}

/// The windows to embed (seconds) for words in time order.
pub fn windows_of(words: &[Word], o: &Opts) -> Vec<Window> {
    let segs = segments(words, o);
    let mut out = Vec::new();
    for (s, &(i, j)) in segs.iter().enumerate() {
        let (a, b) = (words[i].t0, words[j].t1);
        let len = b - a;
        if len <= o.short {
            let (mut x, mut y) = (a, b);
            if len < o.min {
                let before = if s > 0 { (a - words[segs[s - 1].1].t1) / 2.0 } else { f64::INFINITY };
                let after = if s + 1 < segs.len() { (words[segs[s + 1].0].t0 - b) / 2.0 } else { f64::INFINITY };
                // half of what is missing on each side; what one side cannot take goes to the other
                let room0 = before.min(a);
                let want = (o.min - len) / 2.0;
                let left = want.min(room0);
                let right = after.min(o.min - len - left);
                x = a - room0.min(o.min - len - right);
                y = b + right;
            }
            out.push(Window { t0: x, t1: y, seg: s, speech: len });
            continue;
        }
        let n = ((len - o.size) / o.hop).ceil() + 1.0;
        let step = (len - o.size) / (n - 1.0);
        let mut k = 0.0;
        while k < n {
            out.push(Window { t0: a + k * step, t1: a + k * step + o.size, seg: s, speech: o.size });
            k += 1.0;
        }
    }
    out
}

// ---- clustering ----

fn unit<T: Copy + Into<f64>>(v: &[T]) -> Vec<f64> {
    let mut n = 0.0;
    for x in v {
        let x: f64 = (*x).into();
        n += x * x;
    }
    let n = n.sqrt();
    // `Math.sqrt(n) || 1`: zero and NaN divide by one
    let n = if n == 0.0 || n.is_nan() { 1.0 } else { n };
    v.iter().map(|x| (*x).into() / n).collect()
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut s = 0.0;
    for (i, x) in a.iter().enumerate() {
        s += x * b.get(i).copied().unwrap_or(f64::NAN);
    }
    s
}

/// The average-linkage tree of unit vectors: `n - 1` merges, most similar first (NN-chain).
pub fn tree(vecs: &[Vec<f64>]) -> Vec<Merge> {
    let n = vecs.len();
    let mut sum = vec![0.0; n * n];
    for i in 0..n {
        for j in i..n {
            let s = dot(&vecs[i], &vecs[j]);
            sum[i * n + j] = s;
            sum[j * n + i] = s;
        }
    }
    let mut size = vec![1.0_f64; n];
    let mut alive = vec![true; n];
    let mut merges = Vec::new();
    let mut chain: Vec<usize> = Vec::new();
    let mut left = n;
    while left > 1 {
        if chain.is_empty() {
            let Some(first) = alive.iter().position(|a| *a) else { break };
            chain.push(first);
        }
        let a = chain[chain.len() - 1];
        let prev = (chain.len() > 1).then(|| chain[chain.len() - 2]);
        let avg = |sum: &[f64], i: usize, j: usize| sum[i * n + j] / (size[i] * size[j]);
        let mut best = prev;
        let mut best_sim = prev.map_or(f64::NEG_INFINITY, |p| avg(&sum, a, p));
        for (j, _) in alive.iter().enumerate().filter(|(j, live)| **live && *j != a && Some(*j) != prev) {
            let s = avg(&sum, a, j);
            if s > best_sim {
                best_sim = s;
                best = Some(j);
            }
        }
        let Some(b) = best else { break };
        if Some(b) == prev {
            chain.pop();
            chain.pop();
            let (keep, drop) = if a < b { (a, b) } else { (b, a) };
            merges.push(Merge { a: keep, b: drop, sim: best_sim });
            for j in 0..n {
                if !alive[j] || j == keep || j == drop {
                    continue;
                }
                let s = sum[keep * n + j] + sum[drop * n + j];
                sum[keep * n + j] = s;
                sum[j * n + keep] = s;
            }
            size[keep] += size[drop];
            alive[drop] = false;
            left -= 1;
        } else {
            chain.push(b);
        }
    }
    merges.sort_by(|x, y| y.sim.partial_cmp(&x.sim).unwrap_or(std::cmp::Ordering::Equal));
    merges
}

/// Where to cut the tree.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cut {
    /// Merges at least this similar are made.
    Threshold(f64),
    /// Merges are made until this many clusters are left.
    Count(f64),
}

/// The cluster (a root item) of each of `n` items after the merges the cut allows.
pub fn cut(n: usize, merges: &[Merge], at: Cut) -> Vec<usize> {
    let mut parent: Vec<usize> = (0..n).collect();
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut groups = n as f64;
    for m in merges {
        let stop = match at {
            Cut::Count(c) => groups <= c,
            Cut::Threshold(t) => m.sim < t,
        };
        if stop {
            break;
        }
        if m.a >= n || m.b >= n {
            continue;
        }
        let (ra, rb) = (root(&mut parent, m.a), root(&mut parent, m.b));
        if ra != rb {
            parent[rb] = ra;
            groups -= 1.0;
        }
    }
    (0..n).map(|i| root(&mut parent, i)).collect()
}

struct Group {
    sum: Vec<f64>,
    speech: f64,
}

/// A speaker index per window (0, 1, ... by first appearance; -1 without an embedding) from one embedding per window
/// (`None` or empty: none) and the windows' speech seconds.
pub fn cluster<T: Copy + Into<f64>>(embeddings: &[Option<&[T]>], speech: &[f64], o: &Opts) -> Vec<i32> {
    let vecs: Vec<Option<Vec<f64>>> = embeddings.iter().map(|e| e.filter(|e| !e.is_empty()).map(|e| unit(e))).collect();
    let usable: Vec<usize> = (0..vecs.len()).filter(|i| vecs[*i].is_some()).collect();
    let mut out = vec![-1; vecs.len()];
    if usable.is_empty() {
        return out;
    }
    let sp = |i: usize| speech.get(i).copied().unwrap_or(f64::NAN);
    let vec_of = |i: usize| vecs[i].as_deref().unwrap_or(&[]);
    // the tree is made of the trusted windows (all of them when none is long enough), at most `limit`, evenly spread
    let mut core: Vec<usize> = usable.iter().copied().filter(|i| sp(*i) >= o.trust).collect();
    if core.is_empty() {
        core = usable.clone();
    }
    if core.len() as f64 > o.limit {
        let limit = o.limit.max(0.0) as usize;
        core = (0..limit).map(|k| core[(k as f64 * core.len() as f64 / o.limit).floor() as usize]).collect();
    }
    let merges = tree(&core.iter().map(|i| vec_of(*i).to_vec()).collect::<Vec<_>>());
    let want = o.count.filter(|c| *c > 0.0).map(|c| (MAX as f64).min(cut_audio::util::js_round(c)));
    let groups_of = |roots: &[usize]| -> Vec<Group> {
        let mut order: Vec<usize> = Vec::new();
        let mut groups: HashMap<usize, Group> = HashMap::new();
        for (k, r) in roots.iter().enumerate() {
            let i = core[k];
            let v = vec_of(i);
            let g = groups.entry(*r).or_insert_with(|| {
                order.push(*r);
                Group { sum: vec![0.0; v.len()], speech: 0.0 }
            });
            for (d, s) in g.sum.iter_mut().enumerate() {
                *s += v.get(d).copied().unwrap_or(f64::NAN);
            }
            g.speech += sp(i);
        }
        order.iter().filter_map(|r| groups.remove(r)).collect()
    };
    // clusters with too little speech are strays (in a short recording 15% of the speech is enough)
    let total = core.iter().fold(0.0, |n, i| n + sp(*i));
    let enough = o.min_speech.min(0.15 * total);
    let mut big: Vec<Group> = match want {
        None => {
            let mut groups = groups_of(&cut(core.len(), &merges, Cut::Threshold(o.threshold)));
            let kept: Vec<usize> = (0..groups.len()).filter(|k| groups[*k].speech >= enough).collect();
            if kept.is_empty() {
                let mut most = 0;
                for k in 1..groups.len() {
                    if groups[k].speech > groups[most].speech {
                        most = k;
                    }
                }
                vec![groups.swap_remove(most)]
            } else {
                let mut all: Vec<Option<Group>> = groups.into_iter().map(Some).collect();
                kept.iter().filter_map(|k| all[*k].take()).collect()
            }
        }
        Some(want) => {
            // the tree cut `spare` clusters finer, the strays left out, then the two most alike joined until `want`
            let count = (core.len() as f64).min(want + o.spare);
            let mut big = groups_of(&cut(core.len(), &merges, Cut::Count(count)));
            big.sort_by(|x, y| y.speech.partial_cmp(&x.speech).unwrap_or(std::cmp::Ordering::Equal));
            while big.len() as f64 > want && big.last().is_some_and(|g| g.speech < enough) {
                big.pop();
            }
            while big.len() as f64 > want && big.len() > 1 {
                let (mut px, mut py, mut most) = (0, 1, f64::NEG_INFINITY);
                for x in 0..big.len() {
                    for y in x + 1..big.len() {
                        let s = dot(&unit(&big[x].sum), &unit(&big[y].sum));
                        if s > most {
                            most = s;
                            (px, py) = (x, y);
                        }
                    }
                }
                let gy = big.remove(py);
                let gx = &mut big[px];
                for (d, s) in gx.sum.iter_mut().enumerate() {
                    *s += gy.sum.get(d).copied().unwrap_or(f64::NAN);
                }
                gx.speech += gy.speech;
            }
            big
        }
    };
    big.truncate(MAX);
    let cents: Vec<Vec<f64>> = big.iter().map(|g| unit(&g.sum)).collect();
    for &i in &usable {
        let (mut best, mut best_sim) = (0, f64::NEG_INFINITY);
        for (k, c) in cents.iter().enumerate() {
            let s = dot(vec_of(i), c);
            if s > best_sim {
                best_sim = s;
                best = k;
            }
        }
        out[i] = best as i32;
    }
    // numbered by first appearance
    let mut order: Vec<i32> = Vec::new();
    for k in &out {
        if *k >= 0 && !order.contains(k) {
            order.push(*k);
        }
    }
    out.iter().map(|k| if *k >= 0 { order.iter().position(|x| x == k).unwrap_or(0) as i32 } else { -1 }).collect()
}

// ---- words and turns ----

/// A speaker index per word from the windows' indexes (-1 where no window says); inside a segment runs shorter than
/// `min_run` s join the longer neighbouring run.
pub fn word_labels(words: &[Word], windows: &[Window], labels: &[i32], o: &Opts) -> Vec<i32> {
    let mut votes: Vec<Vec<(i32, f64)>> = vec![Vec::new(); words.len()];
    let mut start = 0;
    for (k, win) in windows.iter().enumerate() {
        let Some(&lab) = labels.get(k).filter(|l| **l >= 0) else { continue };
        let weight = 1.0_f64.min((win.t1 - win.t0) / o.size);
        while start < words.len() && words[start].t1 <= win.t0 - o.size {
            start += 1;
        }
        let mut i = start;
        while i < words.len() && words[i].t0 < win.t1 {
            let w = &words[i];
            let ov = w.t1.min(win.t1) - w.t0.max(win.t0);
            if ov > 0.0 || (w.t1 <= w.t0 && w.t0 >= win.t0 && w.t0 < win.t1) {
                let add = weight * ov.max(1e-3);
                match votes[i].iter_mut().find(|v| v.0 == lab) {
                    Some(v) => v.1 += add,
                    None => votes[i].push((lab, add)),
                }
            }
            i += 1;
        }
    }
    let mut out: Vec<i32> = votes
        .iter()
        .map(|v| {
            let (mut best, mut most) = (-1, 0.0);
            for (lab, n) in v {
                if *n > most {
                    most = *n;
                    best = *lab;
                }
            }
            best
        })
        .collect();
    for (i, j) in segments(words, o) {
        smooth_runs(words, &mut out, i, j, o.min_run);
    }
    out
}

#[derive(Clone, Copy)]
struct Run {
    lab: i32,
    i: usize,
    j: usize,
}

fn smooth_runs(words: &[Word], labels: &mut [i32], i: usize, j: usize, min_run: f64) {
    for _ in 0..4 {
        let mut runs: Vec<Run> = Vec::new();
        for (k, lab) in labels.iter().enumerate().take(j + 1).skip(i) {
            match runs.last_mut() {
                Some(last) if *lab == last.lab => last.j = k,
                _ => runs.push(Run { lab: *lab, i: k, j: k }),
            }
        }
        if runs.len() < 2 {
            return;
        }
        let len = |r: &Run| words[r.j].t1 - words[r.i].t0;
        let mut changed = false;
        for k in 0..runs.len() {
            let r = runs[k];
            if len(&r) >= min_run {
                continue;
            }
            let before = k.checked_sub(1).map(|b| runs[b]);
            let after = runs.get(k + 1).copied();
            let into = match (before, after) {
                (None, a) => a,
                (b, None) => b,
                (Some(b), Some(a)) => Some(if len(&b) >= len(&a) { b } else { a }),
            };
            let Some(into) = into else { continue };
            if into.lab == r.lab || len(&into) < len(&r) {
                continue;
            }
            labels[r.i..=r.j].fill(into.lab);
            changed = true;
        }
        if !changed {
            return;
        }
    }
}

/// Words and their speaker ids (`None`: none) -> turns: a turn runs from its first word to its last, the silence
/// between two speakers split in the middle, overlapping word times trimmed, neighbours of one speaker joined.
pub fn turns_of(words: &[Word], ids: &[Option<&str>]) -> Vec<Turn> {
    let mut runs: Vec<(f64, f64, &str)> = Vec::new();
    for (i, w) in words.iter().enumerate() {
        let Some(id) = ids.get(i).copied().flatten() else { continue };
        match runs.last_mut() {
            Some(last) if last.2 == id => last.1 = last.1.max(w.t1),
            _ => runs.push((w.t0, w.t1.max(w.t0 + 0.01), id)),
        }
    }
    let mut kept: Vec<(f64, f64, &str)> = Vec::new();
    for (t0, t1, id) in runs {
        if let Some(last) = kept.last_mut()
            && last.2 == id
        {
            last.1 = last.1.max(t1);
            continue;
        }
        let mut a = t0;
        if let Some(last) = kept.last_mut() {
            if a > last.1 {
                a = (last.1 + a) / 2.0;
                last.1 = a;
            } else {
                a = last.1;
            }
        }
        if t1 > a {
            kept.push((a, t1, id));
        }
    }
    let mut out: Vec<Turn> = Vec::new();
    for (t0, t1, id) in kept {
        let a = round(t0).max(out.last().map_or(f64::NEG_INFINITY, |l| l.1));
        let b = round(t1);
        if b <= a {
            continue;
        }
        match out.last_mut() {
            Some(last) if last.2 == id => last.1 = last.1.max(b),
            _ => out.push((a, b, id.to_owned())),
        }
    }
    out
}

/// The speaker at source second `t`: the turn holding it, else the nearest turn within `reach` s.
pub fn at(turns: &[Turn], t: f64, reach: f64) -> Option<&str> {
    if turns.is_empty() {
        return None;
    }
    let (mut lo, mut hi) = (0usize, turns.len() - 1);
    while lo < hi {
        let m = (lo + hi).div_ceil(2);
        if turns[m].0 <= t {
            lo = m;
        } else {
            hi = m - 1;
        }
    }
    let a = &turns[lo];
    if a.0 <= t && t < a.1 {
        return Some(&a.2);
    }
    let (mut best, mut d) = (None, reach);
    for k in [lo.checked_sub(1), Some(lo), Some(lo + 1)].into_iter().flatten() {
        let Some(x) = turns.get(k) else { continue };
        let dist = if t < x.0 { x.0 - t } else { t - x.1 };
        if dist <= d {
            d = dist;
            best = Some(x.2.as_str());
        }
    }
    best
}

/// Turns with `[a, b)` given to speaker `id` (the turns around it trimmed or split, neighbours of one speaker joined).
pub fn assign(turns: &[Turn], a: f64, b: f64, id: &str) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    for (x, y, s) in turns {
        if *y <= a || *x >= b {
            out.push((*x, *y, s.clone()));
            continue;
        }
        if *x < a {
            out.push((*x, a, s.clone()));
        }
        if *y > b {
            out.push((b, *y, s.clone()));
        }
    }
    out.push((a, b, id.to_owned()));
    out.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut joined: Vec<Turn> = Vec::new();
    for t in out {
        match joined.last_mut() {
            Some(last) if last.2 == t.2 && t.0 - last.1 < 1e-6 => last.1 = t.1,
            _ => joined.push(t),
        }
    }
    joined.into_iter().map(|(x, y, s)| (round(x), round(y), s)).collect()
}

/// New labels matched to the speakers of before by the time they share, most first -> new label -> old id.
pub fn match_labels(
    old: &BTreeMap<String, Vec<Turn>>,
    new: &BTreeMap<String, Vec<Turn>>,
    new_ids: &[String],
) -> Vec<(String, String)> {
    let mut shared: Vec<((String, String), f64)> = Vec::new();
    for (media, list) in new {
        let Some(before) = old.get(media) else { continue };
        for (a, b, n) in list {
            for (x, y, o) in before {
                let ov = b.min(*y) - a.max(*x);
                if ov > 0.0 {
                    match shared.iter_mut().find(|(k, _)| k.0 == *n && k.1 == *o) {
                        Some(e) => e.1 += ov,
                        None => shared.push(((n.clone(), o.clone()), ov)),
                    }
                }
            }
        }
    }
    shared.sort_by(|p, q| q.1.partial_cmp(&p.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<(String, String)> = Vec::new();
    for ((n, o), _) in shared {
        if out.iter().any(|(x, y)| *x == n || *y == o) || !new_ids.contains(&n) {
            continue;
        }
        out.push((n, o));
    }
    out
}

/// The number of an id `sp<digits>` (0 for any other).
fn number_of(id: &str) -> f64 {
    id.strip_prefix("sp")
        .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0)
}

/// The speaker list for `count` labels: matched speakers of before keep their entry; new ones get the next free id
/// (never one of `taken`) and a colour not used yet -> `(list, id of each label)`.
pub fn list_for(
    count: usize,
    before: &[Speaker],
    matched: &[(String, String)],
    taken: &[String],
) -> (Vec<Speaker>, Vec<String>) {
    let mut list: Vec<Option<Speaker>> = vec![None; count];
    let mut used: Vec<String> = Vec::new();
    for (k, slot) in list.iter_mut().enumerate() {
        let key = k.to_string();
        let Some(o) = matched.iter().find(|(n, _)| *n == key).map(|(_, o)| o) else { continue };
        if let Some(prev) = before.iter().find(|s| s.id == *o) {
            *slot = Some(prev.clone());
            used.push(prev.color.clone());
        }
    }
    let mut next = before.iter().map(|s| s.id.as_str()).chain(taken.iter().map(String::as_str)).fold(0.0, |m, id| {
        let n = number_of(id);
        if n > m { n } else { m }
    }) + 1.0;
    for (k, slot) in list.iter_mut().enumerate() {
        if slot.is_some() {
            continue;
        }
        let id = format!("sp{next}");
        next += 1.0;
        let color = PALETTE.iter().find(|c| !used.iter().any(|u| u == *c)).unwrap_or(&PALETTE[k % PALETTE.len()]);
        used.push((*color).to_owned());
        *slot = Some(Speaker { id, name: String::new(), color: (*color).to_owned() });
    }
    let list: Vec<Speaker> = list.into_iter().flatten().collect();
    let ids = list.iter().map(|s| s.id.clone()).collect();
    (list, ids)
}

/// Every speaker id the project names: its list and the captions of every sequence.
pub fn in_use(project: &cut_model::Project) -> Vec<String> {
    let mut ids: Vec<String> =
        Labels::of(project).map(|l| l.list.into_iter().map(|s| s.id).collect()).unwrap_or_default();
    for seq in &project.sequences {
        for ct in &seq.captions {
            for it in &ct.items {
                if let Some(s) = it.speaker.as_ref().filter(|s| !s.is_empty() && !ids.contains(s)) {
                    ids.push(s.clone());
                }
            }
        }
    }
    ids
}

// ---- names ----

/// The name shown for a speaker: its own, else `unnamed` ("Speaker {n}", translated) with its place in the list;
/// empty when the list does not have it.
pub fn name_of(list: &[Speaker], id: &str, unnamed: &str) -> String {
    match list.iter().position(|s| s.id == id) {
        None => String::new(),
        Some(i) if list[i].name.is_empty() => unnamed.replacen("{n}", &(i + 1).to_string(), 1),
        Some(i) => list[i].name.clone(),
    }
}
