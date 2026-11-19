//! Nano Studio Cut: the editor's window. Everything is in the library (`cut_app`); this starts it on the workspace
//! (`CUT_HOME`, else `%USERPROFILE%\Nano Studio Cut`), optionally opening a project given on the command line
//! (or in `CUT_OPEN`); `CUT_WINDOW=1024x720` sets the window's size.
//!
//! For looking at the app and measuring it without touching it: `CUT_THEME=light|dark`, `CUT_TIME=<seconds>` (the
//! playhead), `CUT_SOURCE=<media name>` (selected, in the Source monitor), `CUT_ICONS=1` (the Project panel as
//! thumbnails), `CUT_PLAY=1` (plays once the window is up), `CUT_PLAY_SOURCE=1` (plays the Source monitor instead), `CUT_OUTPUT_GAIN=0` (silent), and `CUT_REPORT=<file>`,
//! which gets a JSON line a second while frames are drawn (none at rest: nothing asks for frames to write it): the
//! start's milestones (`startup`), frame times (eframe's, the main window's layout, the panel windows' layout and
//! paint, the longest gap between two frames), renders and the pipelines they had to compile, the clock, dropped
//! frames, underruns, the decoders and the GPU. `CUT_ADAPTER=<part of a GPU name>` picks the GPU everything runs on (`cut_engine::gpu::pick_adapter`).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::shell::Shell;
use cut_app::theme::ThemeKind;
use eframe::egui;

/// What the environment asks for once the window is up, and the report it wants.
#[derive(Default)]
struct Launch {
    theme: Option<ThemeKind>,
    time: Option<f64>,
    source: Option<String>,
    icons: bool,
    play: bool,
    /// `CUT_PLAY_SOURCE=1`: plays the Source monitor once its clip (`CUT_SOURCE`) shows.
    play_source: bool,
    frames: u32,
    report: Option<std::fs::File>,
    /// The adapter and backend the window draws with, for the report.
    gpu: Option<String>,
    last: Option<Instant>,
    worst_ms: f32,
    sum_ms: f64,
    shell_sum_ms: f64,
    count: u64,
    /// The panel windows' layout and paint times (summed over the second) and the worst paint.
    windows_ui_ms: f64,
    windows_paint_ms: f64,
    windows_paint_worst: f32,
    /// When the frame before started, and the longest time between two frames this second.
    frame_at: Option<Instant>,
    gap_worst_ms: f32,
    startup: Startup,
    /// Whether a line with the first picture's time was written.
    picture_written: bool,
}

/// When the start's milestones were reached (ms since 1970, so a caller can subtract the process's own start).
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Startup {
    main: i64,
    shell: i64,
    first_frame_start: Option<i64>,
    first_frame_end: Option<i64>,
    monitors: Option<i64>,
    first_picture: Option<i64>,
}

impl Launch {
    fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Self {
            theme: var("CUT_THEME").map(|t| if t == "light" { ThemeKind::Light } else { ThemeKind::Dark }),
            time: var("CUT_TIME").and_then(|t| t.parse().ok()),
            source: var("CUT_SOURCE"),
            icons: var("CUT_ICONS").is_some(),
            play: var("CUT_PLAY").is_some(),
            play_source: var("CUT_PLAY_SOURCE").is_some(),
            report: var("CUT_REPORT").and_then(|p| std::fs::File::create(p).ok()),
            ..Self::default()
        }
    }

    fn after(&mut self, s: &mut Shell, ctx: &egui::Context) {
        self.frames += 1;
        let st = &mut self.startup;
        st.first_frame_end.get_or_insert_with(now_ms);
        if st.monitors.is_none() && s.monitors.is_some() {
            st.monitors = Some(now_ms());
        }
        if st.first_picture.is_none() && s.monitors.as_ref().is_some_and(|m| m.program.stats.complete) {
            st.first_picture = Some(now_ms());
        }
        if self.frames == 2 {
            if let Some(k) = self.theme {
                s.set_theme(ctx, k);
            }
            if let Some(t) = self.time {
                s.app.set_time((t * cut_time::TICKS as f64).round() as i64);
            }
            if let Some(name) = &self.source {
                let id = s.app.project().media.iter().find(|m| &m.name == name).map(|m| m.id);
                s.project.select(id);
                if let Some(id) = id {
                    s.app.edit.source.open(cut_app::edit::source::SourceClip::media(id));
                }
            }
            s.project.set_icons(self.icons);
        }
        // a moment for the first pictures and thumbnails before playing
        if self.play && self.frames > 2 && s.monitors.as_ref().is_some_and(|m| m.program.stats.complete) {
            self.play = false;
            s.run_action("playPause", ctx);
        }
        if self.play_source
            && self.frames > 4
            && s.app.edit.source.clip.is_some()
            && s.monitors.as_ref().is_some_and(|m| m.source.stats.complete)
        {
            self.play_source = false;
            s.run_action("window.source", ctx);
            s.run_action("playPause", ctx);
        }
        self.measure(s);
    }

    fn measure(&mut self, s: &mut Shell) {
        let Some(file) = &mut self.report else { return };
        self.worst_ms = self.worst_ms.max(s.frame_cpu_ms);
        self.sum_ms += f64::from(s.frame_cpu_ms);
        self.shell_sum_ms += f64::from(s.frame_ms);
        self.count += 1;
        let (ui, paint) = s.features.workspace.windows.take_times();
        let paint = paint.as_secs_f32() * 1000.0;
        self.windows_ui_ms += f64::from(ui.as_secs_f32() * 1000.0);
        self.windows_paint_ms += f64::from(paint);
        self.windows_paint_worst = self.windows_paint_worst.max(paint);
        let now = Instant::now();
        let gap = self.frame_at.map_or(0.0, |t| (now - t).as_secs_f32() * 1000.0);
        self.frame_at = Some(now);
        self.gap_worst_ms = self.gap_worst_ms.max(gap);
        let picture_new = self.startup.first_picture.is_some() && !self.picture_written;
        if self.last.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) && !picture_new {
            return;
        }
        self.picture_written = self.startup.first_picture.is_some();
        self.last = Some(Instant::now());
        let m = s.monitors.as_ref();
        let line = serde_json::json!({
            "ms": now_ms(),
            "frameNr": self.frames,
            "startup": &self.startup,
            "playing": s.transport.playing(),
            "clock": s.transport.clock(),
            "t": s.app.t as f64 / cut_time::TICKS as f64,
            "frames": self.count,
            "frameCpuMsMean": if self.count > 0 { self.sum_ms / self.count as f64 } else { 0.0 },
            "frameCpuMsMax": self.worst_ms,
            "shellMs": s.frame_ms,
            "shellMsMean": if self.count > 0 { self.shell_sum_ms / self.count as f64 } else { 0.0 },
            "windowsUiMsMean": if self.count > 0 { self.windows_ui_ms / self.count as f64 } else { 0.0 },
            "windowsPaintMsMean": if self.count > 0 { self.windows_paint_ms / self.count as f64 } else { 0.0 },
            "windowsPaintMsMax": self.windows_paint_worst,
            "frameGapMsMax": self.gap_worst_ms,
            "program": m.map(|m| serde_json::json!({
                "renders": m.program.stats.renders, "incomplete": m.program.stats.incomplete,
                "lastMs": m.program.stats.last_ms, "maxMs": m.program.stats.max_ms,
                "decoders": m.program.engine.decoders(),
                "sources": m.program.engine.source_stats(),
                "pipelinesCompiled": m.program.engine.pipelines_compiled(),
            })),
            "source": m.map(|m| serde_json::json!({
                "playing": s.app.edit.source.playing(),
                "renders": m.source.stats.renders, "incomplete": m.source.stats.incomplete,
                "sources": m.source.engine.source_stats(),
            })),
            "shown": s.play.shown,
            "dropped": s.play.dropped,
            "underruns": s.transport.underruns(),
            "soundError": s.sound_error,
            "thumbsQueued": s.thumbs.as_ref().map(|t| t.queued()),
            "gpu": self.gpu,
            "frameSharing": m.map(|m| match m.program.engine.frame_sharing() {
                Ok(a) => serde_json::json!({ "adapter": a }),
                Err(e) => serde_json::json!({ "off": e }),
            }),
        });
        let _ = writeln!(file, "{line}");
        self.worst_ms = 0.0;
        self.sum_ms = 0.0;
        self.shell_sum_ms = 0.0;
        self.count = 0;
        self.windows_ui_ms = 0.0;
        self.windows_paint_ms = 0.0;
        self.windows_paint_worst = 0.0;
        self.gap_worst_ms = 0.0;
    }
}

struct Window {
    shell: Shell,
    launch: Launch,
}

impl eframe::App for Window {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        if self.launch.startup.first_frame_start.is_none() {
            // Nano Studio's theme while this app has none of its own; `system` is the window's (Windows')
            if self.shell.doc.setting("theme").is_none()
                && let Some(k) = cut_app::studio::theme(ui.ctx().system_theme())
            {
                self.shell.palette = cut_app::theme::Palette::of(k);
            }
            cut_app::crash::test_switch();
        }
        self.launch.startup.first_frame_start.get_or_insert_with(now_ms);
        if self.launch.gpu.is_none()
            && let Some(rs) = frame.wgpu_render_state()
        {
            let i = rs.adapter.get_info();
            self.launch.gpu = Some(format!("{} ({:?})", i.name, i.backend));
        }
        eframe::App::ui(&mut self.shell, ui, frame);
        let ctx = ui.ctx().clone();
        self.launch.after(&mut self.shell, &ctx);
    }

    fn on_exit(&mut self) {
        eframe::App::on_exit(&mut self.shell);
    }
}

/// eframe's wgpu setup with the engine's adapter and device: one GPU for the window, the monitors' engines and the
/// decoders ([`cut_engine::gpu::pick_adapter`]), with the features frames shared by the decoders need.
fn wgpu_options() -> eframe::egui_wgpu::WgpuConfiguration {
    use eframe::egui_wgpu::{WgpuSetup, WgpuSetupCreateNew, wgpu};
    let mut setup = WgpuSetupCreateNew::without_display_handle();
    // Direct3D 12 only: the decoders share frames with it, and starting Vulkan and GL too loads every GPU's drivers
    // into the process (130 MB here).
    setup.instance_descriptor.backends = wgpu::Backends::from_env().unwrap_or(wgpu::Backends::DX12);
    setup.native_adapter_selector = Some(std::sync::Arc::new(|adapters, surface| {
        let usable: Vec<wgpu::Adapter> =
            adapters.iter().filter(|a| surface.is_none_or(|s| a.is_surface_supported(s))).cloned().collect();
        cut_engine::gpu::pick_adapter(&usable).ok_or_else(|| "no GPU adapter can show the window".to_string())
    }));
    setup.device_descriptor = std::sync::Arc::new(cut_engine::gpu::device_descriptor);
    eframe::egui_wgpu::WgpuConfiguration { wgpu_setup: WgpuSetup::CreateNew(setup), ..Default::default() }
}

fn main() -> eframe::Result {
    let main_at = now_ms();
    let home = Home::resolve();
    cut_app::crash::install(&home.home);
    cut_app::studio::start(&home.home, main_at);
    // a project to open is read and parsed on a thread while the window and its GPU device are made
    let loading = std::env::args_os().nth(1).or_else(|| std::env::var_os("CUT_OPEN")).map(|path| {
        let mut projects = cut_app::files::Projects::new(home.autosave.clone());
        std::thread::spawn(move || cut_app::doc::load(&mut projects, std::path::Path::new(&path)))
    });
    let mut shell = Shell::new(home);
    let (w, h) = std::env::var("CUT_WINDOW")
        .ok()
        .and_then(|s| s.split_once('x').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?))))
        .unwrap_or((1280.0, 800.0));
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Nano Studio Cut")
            .with_inner_size([w, h])
            .with_min_inner_size([960.0, 600.0])
            .with_drag_and_drop(true),
        wgpu_options: wgpu_options(),
        ..Default::default()
    };
    let mut launch = Launch::from_env();
    launch.startup = Startup { main: main_at, shell: now_ms(), ..Startup::default() };
    eframe::run_native(
        "Nano Studio Cut",
        options,
        Box::new(move |_cc| {
            if let Some(loaded) = loading.and_then(|j| j.join().ok())
                && let Err(e) = shell.doc.open_loaded(&mut shell.app, loaded, now_ms())
            {
                shell.app.report(e);
            }
            Ok(Box::new(Window { shell, launch }))
        }),
    )
}
