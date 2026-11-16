//! Auto Color (`ui-auto.js autoColor`, `analyze.js autoColor`): the basic correction's white balance and exposure
//! from small pictures of the selected video clip's source frames, at the playhead when it is inside the clip, else
//! at five places through it. The Lumetri Color panel's Auto button and the Automation menu run it.
//!
//! Threads: the pictures are drawn and read back on the analysis thread by an engine of its own on the window's GPU
//! (the JavaScript draws each frame into a 64-pixel-wide canvas), so the UI thread never waits for a decoder or the
//! GPU; the arithmetic is the JavaScript's, run on that thread too.

use cut_engine::color::{LUMA, srgb_to_linear};
use cut_engine::uniforms::{basic_plan, white_balance};
use cut_engine::{Engine, RenderOptions};
use cut_model::commands::build as C;
use cut_model::{Id, MediaKind, Project, TrackKind};
use serde_json::{Value as Json, json};

use super::{Job, Stop};
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::state::App;

/// The picture's width the analysis reads (`framesOf`'s default).
pub const WIDTH: u32 = 64;
/// How bright the brightest percent may stay when darkening (linear).
const HIGHLIGHT: f64 = 0.8;

/// The basic correction's settings Auto Color finds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Values {
    pub temperature: f64,
    pub tint: f64,
    pub exposure: f64,
}

/// One small picture: sRGB RGBA bytes.
pub struct Image {
    pub rgba: Vec<u8>,
    pub w: u32,
    pub h: u32,
}

/// Auto Color's state: the analysis running, for the clip it is for.
#[derive(Default)]
pub struct ColorUi {
    pub job: Option<Job<Option<Values>>>,
    clip: Option<Id>,
}

/// The selected video clip of a video or image file, and its media -> `(clip, media)`.
pub fn target(app: &App) -> Option<(Id, Id)> {
    let seq = app.sequence()?;
    let c = crate::fx::edit::primary_clip(app)?;
    let m = app.project().media(c.media_id()?)?;
    let picture = m.kind == MediaKind::Video || m.kind == MediaKind::Image;
    (seq.kind_of(c.track) == Some(TrackKind::Video) && picture).then_some((c.id, m.id))
}

fn js_round(x: f64) -> f64 {
    cut_audio::util::js_round(x)
}

/// White balance and exposure for the pictures (`analyze.autoColor`): the average of the pixels that are neither
/// clipped nor black made neutral, then the log-average luminance brought to mid-grey, never pushing the brightest
/// percent past white or (darkening) below [`HIGHLIGHT`].
pub fn auto_color(images: &[Image]) -> Option<Values> {
    let lut: Vec<f64> = (0..256).map(|i| srgb_to_linear(f64::from(i) / 255.0)).collect();
    let mut sum = [0.0; 3];
    let mut count = 0usize;
    let mut px: Vec<[f64; 3]> = Vec::new();
    for im in images {
        let n = (im.w * im.h) as usize;
        for p in im.rgba.as_chunks::<4>().0.iter().take(n) {
            let (r, g, b) = (p[0], p[1], p[2]);
            let c = [lut[r as usize], lut[g as usize], lut[b as usize]];
            px.push(c);
            if r.max(g).max(b) >= 250 || c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2] < 0.002 {
                continue;
            }
            for i in 0..3 {
                sum[i] += c[i];
            }
            count += 1;
        }
    }
    if px.is_empty() {
        return None;
    }
    let (temperature, tint) = if count > 0 { white_balance(sum.map(|v| v / count as f64)) } else { (0.0, 0.0) };
    let mut params = cut_model::effects::defaults("color.basic");
    params.insert("temperature".into(), json!(temperature));
    params.insert("tint".into(), json!(tint));
    params.insert("exposure".into(), json!(0));
    let gain = basic_plan(&params).gain;
    let ys: Vec<f64> =
        px.iter().map(|c| c[0] * gain[0] * LUMA[0] + c[1] * gain[1] * LUMA[1] + c[2] * gain[2] * LUMA[2]).collect();
    let log_avg = (ys.iter().fold(0.0, |a, y| a + (1e-4 + y).ln()) / ys.len() as f64).exp();
    let mut exposure = (0.18 / log_avg).log2();
    let mut sorted = ys.clone();
    sorted.sort_by(f64::total_cmp);
    let p99 = sorted[(sorted.len() - 1).min((sorted.len() as f64 * 0.99).floor() as usize)];
    if exposure > 0.0 && p99 > 0.0 {
        exposure = exposure.min((1.0 / p99).log2().max(0.0));
    }
    if exposure < 0.0 && p99 > 0.0 {
        exposure = exposure.max((HIGHLIGHT / p99).log2().min(0.0));
    }
    let ep = cut_model::effects::get("color.basic").and_then(|d| d.params.iter().find(|p| p.id == "exposure"));
    let (lo, hi) = ep.map_or((f64::NEG_INFINITY, f64::INFINITY), |p| {
        (p.min.unwrap_or(f64::NEG_INFINITY), p.max.unwrap_or(f64::INFINITY))
    });
    let exposure = js_round(exposure * 100.0) / 100.0;
    Some(Values { temperature, tint, exposure: exposure.clamp(lo, hi) })
}

/// The source times to look at: the playhead's when it is in the clip, else 10, 30, 50, 70 and 90 % through it.
pub fn times(app: &App, clip: Id) -> Vec<i64> {
    let Some(c) = app.sequence().and_then(|s| s.clip(clip)) else { return Vec::new() };
    let t = app.t;
    if t >= c.start && t < c.end() {
        return vec![c.source_time(t as f64) as i64];
    }
    let d = c.duration() as f64;
    [0.1, 0.3, 0.5, 0.7, 0.9].iter().map(|x| c.source_time((c.start as f64) + (d * x).floor()) as i64).collect()
}

/// Draws a media's frames at source `times` 64 pixels wide and reads them back (`framesOf`).
pub fn frames(
    engine: &mut Engine,
    project: &Project,
    media: Id,
    times: &[i64],
    step: &super::Step,
) -> Result<Vec<Image>, Stop> {
    let unreadable = || Ok("The clip's media cannot be read.".to_owned());
    let m = project.media(media).ok_or_else(unreadable)?;
    let (mw, mh) = m.video.as_ref().map_or((16.0, 9.0), |v| (v.w, v.h));
    let (mw, mh) = (if mw > 0.0 { mw } else { 16.0 }, if mh > 0.0 { mh } else { 9.0 });
    let w = WIDTH;
    let h = js_round(f64::from(w) * mh / mw).max(8.0) as u32;
    let opts = RenderOptions { wait: Some(std::time::Duration::from_secs(20)), ..RenderOptions::default() };
    let mut out = Vec::new();
    for &t in times {
        step.step().map_err(Err)?;
        let at = if m.kind == MediaKind::Image { 0 } else { t };
        let r = engine.render_media(project, media, at, (w, h), &opts).map_err(|_| unreadable())?;
        if !r.failed.is_empty() {
            return Err(unreadable());
        }
        out.push(Image { rgba: engine.read_pixels(), w, h });
    }
    Ok(out)
}

/// Auto (the Lumetri Color panel) or Automation > Auto Color: the analysis started for the selected clip.
pub fn start(s: &mut Shell) {
    let Some((clip, media)) = target(&s.app) else {
        s.app.toast(tr("Select a video clip first."));
        return;
    };
    let at = times(&s.app, clip);
    let project = s.app.project().clone();
    let gpu = s.monitors.as_ref().map(|m| (m.program.engine.device().clone(), m.program.engine.queue().clone()));
    let job = Job::start(tr("Analyzing the picture…").into_owned(), true, move |step| {
        let mut engine = match gpu {
            Some((d, q)) => Engine::new(d, q),
            None => Engine::headless().map_err(|e| Ok(e.to_string()))?,
        };
        let images = frames(&mut engine, &project, media, &at, step)?;
        step.progress(1.0);
        Ok(auto_color(&images))
    });
    s.features.auto.color.job = Some(job);
    s.features.auto.color.clip = Some(clip);
}

/// The commands that put `v` into the clip's basic correction (`Auto Color`'s batch): its keyframes of the three
/// settings cleared and the effect switched on, or the effect added.
pub fn commands(app: &App, clip: Id, v: Values) -> Vec<Json> {
    let Some((seq, c)) = app.sequence().and_then(|s| Some((s.id, s.clip(clip)?))) else { return Vec::new() };
    let params = json!({ "temperature": v.temperature, "tint": v.tint, "exposure": v.exposure });
    let (s, cid) = (seq.as_str(), c.id.as_str());
    match c.effects.iter().find(|e| e.kind == "color.basic") {
        Some(e) => {
            let mut cmds: Vec<Json> = ["temperature", "tint", "exposure"]
                .iter()
                .map(|k| format!("effects.{}.{k}", e.id))
                .filter(|p| c.keyframes.contains_key(p))
                .map(|p| C::set_keyframes(s, cid, &p, None))
                .collect();
            cmds.push(C::set_effect(s, cid, e.id.as_str(), json!({ "on": true, "params": params })));
            cmds
        }
        None => vec![C::add_effect(s, cid, "color.basic", None, params)],
    }
}

/// Takes in the analysis and sets the correction.
pub fn poll(s: &mut Shell, playing: bool) {
    let Some(out) = s.features.auto.color.job.as_ref().and_then(|j| j.poll(playing)) else { return };
    s.features.auto.color.job = None;
    let clip = s.features.auto.color.clip.take();
    let (Some(Some(v)), Some(clip)) = (super::ended(s, out), clip) else { return };
    let cmds = commands(&s.app, clip, v);
    if cmds.is_empty() {
        return;
    }
    if s.app.exec(&C::batch("Auto Color", cmds)).is_some() {
        s.app.toast(trf(
            "Temperature {t}, tint {m}, exposure {e}.",
            &[("t", &v.temperature.to_string()), ("m", &v.tint.to_string()), ("e", &format!("{:.2}", v.exposure))],
        ));
    }
}
