//! Importing media (port of `ui-project.js`'s `probeFile`/`importPaths` and `media.js`'s `usable`): each file is
//! probed off the UI thread (up to four at a time, as `importFiles` runs them), into either a media entry for the
//! `importMedia` command or the reason it cannot be used, with the JavaScript's codes and sentences.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use cut_formats::{Container, ErrorCode, FileReader, Kind, Media, Source, Transfer, probe};
use serde_json::{Value as Json, json};

/// What the importer accepts (`paths.js` `MEDIA`).
pub const VIDEO_EXT: [&str; 6] = ["mp4", "m4v", "mov", "mkv", "webm", "3gp"];
pub const AUDIO_EXT: [&str; 4] = ["mp3", "wav", "m4a", "aac"];
pub const IMAGE_EXT: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/// Every accepted extension, for the file dialog's filter.
pub fn media_extensions() -> Vec<&'static str> {
    VIDEO_EXT.iter().chain(&AUDIO_EXT).chain(&IMAGE_EXT).copied().collect()
}

fn ext_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Whether the extension is one the importer reads.
pub fn accepted(path: &Path) -> bool {
    media_extensions().contains(&ext_of(path).as_str())
}

/// Why a file was not imported: the code of `ui-project.js`'s `REASONS` (or a path check's code), and for a codec
/// this PC does not decode the sentence that says which (and what would add it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: String,
    pub sentence: Option<&'static str>,
}

/// The sentence the import error list shows for a refusal: the codec's own when there is one, else
/// [`reason_text`] of its code.
pub fn refusal_text(r: &Refusal) -> &'static str {
    r.sentence.unwrap_or_else(|| reason_text(r.code))
}

/// The sentence the import error list shows for a refusal (`reasonText`; translate it with `tr`).
///
/// A path check's own code (`extension`, `notFile`) has no sentence in `REASONS`, so the JavaScript falls back to
/// "The file could not be read." there; kept as it is.
pub fn reason_text(code: &str) -> &'static str {
    match code {
        "unsupported" => "The format or codec is not supported.",
        "damaged" => "The file is damaged.",
        "hdr" => "HDR video is not supported yet.",
        "noTracks" => "The file has no video or audio.",
        "codec" => "This PC cannot decode the codec.",
        "missing" => "The file is gone.",
        _ => "The file could not be read.",
    }
}

/// One file's result: a media entry for `importMedia`, or why not; and for a file imported without its sound (a
/// video with Vorbis audio), the sentence that says why.
#[derive(Debug, Clone)]
pub struct Probed {
    pub path: PathBuf,
    pub result: Result<Json, Refusal>,
    pub note: Option<&'static str>,
}

fn refuse(code: &'static str, detail: impl Into<String>) -> Result<Json, Refusal> {
    Err(Refusal { code, detail: detail.into(), sentence: None })
}

/// Whether the picture engine decodes this video codec on this PC (H.264, HEVC, VP8, VP9 and AV1 through Media
/// Foundation, when it lists a decoder): `media.js`'s `supported('video', ...)`.
pub fn decodable_video(codec: &str) -> bool {
    cut_engine::media::decodes_video(codec)
}

/// Why this PC does not show video of a codec string: the Windows extension that adds its decoder, when one does.
fn video_refusal(codec: &str) -> Option<&'static str> {
    cut_decode::Codec::of(codec).map(cut_decode::Codec::missing_decoder)
}

/// Whether the sound engine decodes this audio codec on this PC (PCM; AAC, MP3, FLAC and Opus through Media
/// Foundation): `media.js`'s `/^pcm-/` test or `supported('audio', ...)`.
pub fn decodable_audio(codec: &str) -> bool {
    cut_audio::decodes(codec)
}

/// What a probed source becomes (`usable` and the media entry of `importFiles`).
pub fn entry_of(path: &Path, size: u64, mtime: f64, src: &Source) -> Result<Json, Refusal> {
    let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let base = |kind: &str, duration: f64, video: Json, audio: Json| {
        json!({
            "path": path.to_string_lossy(), "name": name, "size": size, "mtime": mtime,
            "kind": kind, "duration": duration, "video": video, "audio": audio,
        })
    };
    if let Some(e) = &src.error {
        let code = match e.code {
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Damaged => "damaged",
            ErrorCode::Hdr => "hdr",
            ErrorCode::NoTracks => "noTracks",
        };
        return refuse(code, e.detail.to_string());
    }
    if src.container == Some(Container::Image) {
        let (w, h, mime) = src.image.as_ref().map_or((0, 0, "image"), |i| (i.width, i.height, i.mime));
        let video = json!({ "w": w, "h": h, "fps": null, "codec": mime, "vfr": false, "rotation": 0 });
        return Ok(base("image", 0.0, video, Json::Null));
    }
    let v = src.tracks.iter().find(|t| t.kind() == Kind::Video);
    let a = src.tracks.iter().find(|t| t.kind() == Kind::Audio);
    let mut video = Json::Null;
    let mut error = None;
    if let Some(t) = v
        && let Media::Video(info) = &t.media
    {
        let transfer = info.color_space.and_then(|c| c.transfer);
        if let Some(tr @ (Transfer::Pq | Transfer::Hlg)) = transfer {
            let name = if tr == Transfer::Pq { "pq" } else { "hlg" };
            error = Some(Refusal { code: "hdr", detail: format!("HDR video ({name})"), sentence: None });
        } else if decodable_video(&t.codec) {
            let fps = if info.frame_rate[0] > 0 {
                json!([info.frame_rate[0], info.frame_rate[1].max(1)])
            } else {
                Json::Null
            };
            let (w, h) = if info.rotation % 180 == 90 {
                (info.display_height, info.display_width)
            } else {
                (info.display_width, info.display_height)
            };
            video = json!({ "w": w, "h": h, "fps": fps, "codec": t.codec, "vfr": info.vfr, "rotation": info.rotation });
        } else {
            error = Some(Refusal {
                code: "unsupported",
                detail: format!("the video codec {} cannot be decoded on this PC", t.codec),
                sentence: video_refusal(&t.codec),
            });
        }
    }
    let audio = match a.map(|t| (&t.media, &t.codec)) {
        Some((Media::Audio(info), codec)) if codec == "opus" && info.channels > 2 => {
            if video.is_null() && error.is_none() {
                error = Some(Refusal {
                    code: "unsupported",
                    detail: format!("Opus with {} channels", info.channels),
                    sentence: Some(cut_decode::OPUS_SURROUND),
                });
            }
            Json::Null
        }
        Some((Media::Audio(info), codec)) if decodable_audio(codec) => {
            json!({ "rate": info.sample_rate, "channels": info.channels, "codec": codec })
        }
        Some((_, codec)) if video.is_null() && error.is_none() => {
            error = Some(Refusal {
                code: "unsupported",
                detail: format!("the audio codec {codec} cannot be decoded on this PC"),
                sentence: Some(cut_decode::audio_refusal(codec)),
            });
            Json::Null
        }
        _ => Json::Null,
    };
    // A file whose picture cannot be shown is refused even if its sound could be: the clip would be silently wrong.
    if let Some(e) = error {
        return Err(e);
    }
    if video.is_null() && audio.is_null() {
        return refuse("noTracks", "no video or audio track");
    }
    let kind = if video.is_null() { "audio" } else { "video" };
    Ok(base(kind, src.duration.max(0) as f64, video, audio))
}

/// The sentence for a file imported without its sound: its picture plays, its audio codec does not.
pub fn note_of(entry: &Json, src: &Source) -> Option<&'static str> {
    let a = src.tracks.iter().find(|t| t.kind() == Kind::Audio)?;
    let surround = matches!(&a.media, Media::Audio(i) if a.codec == "opus" && i.channels > 2);
    let sentence = if surround { cut_decode::OPUS_SURROUND } else { cut_decode::audio_refusal(&a.codec) };
    (entry["kind"] == "video" && entry["audio"].is_null()).then_some(sentence)
}

/// Probes one file (`probeFile`).
pub fn probe_file(path: &Path) -> Probed {
    let mut note = None;
    let result = (|| {
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return refuse("missing", "no such file"),
            Err(e) => return refuse("io", e.to_string()),
        };
        if !meta.is_file() {
            return refuse("notFile", "not a file");
        }
        if !accepted(path) {
            return refuse("extension", "this kind of file is not read");
        }
        let reader =
            FileReader::open(path).map_err(|e| Refusal { code: "io", detail: e.to_string(), sentence: None })?;
        let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let src = probe::open(&reader, &name);
        let mtime = crate::files::mtime_ms(&meta).unwrap_or(0.0);
        let entry = entry_of(path, meta.len(), mtime, &src)?;
        note = note_of(&entry, &src);
        Ok(entry)
    })();
    Probed { path: path.to_owned(), result, note }
}

/// Probes files on worker threads; the UI polls [`Importer::poll`] each frame.
pub struct Importer {
    tx: Sender<Probed>,
    rx: Receiver<Probed>,
    pending: usize,
    wake: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Default for Importer {
    fn default() -> Self {
        let (tx, rx) = channel();
        Importer { tx, rx, pending: 0, wake: None }
    }
}

impl Importer {
    /// `wake` is called from a worker when a result is ready (the UI asks for a repaint).
    pub fn with_wake(wake: impl Fn() + Send + Sync + 'static) -> Self {
        Importer { wake: Some(Arc::new(wake)), ..Default::default() }
    }

    /// Starts probing `paths` (four workers at most).
    pub fn start(&mut self, paths: Vec<PathBuf>) {
        if paths.is_empty() {
            return;
        }
        self.pending += paths.len();
        let queue = Arc::new(Mutex::new(paths.into_iter().enumerate().collect::<Vec<_>>()));
        let workers = queue.lock().map_or(1, |q| q.len().min(4));
        for _ in 0..workers {
            let queue = Arc::clone(&queue);
            let tx = self.tx.clone();
            let wake = self.wake.clone();
            std::thread::spawn(move || {
                loop {
                    let next = queue.lock().ok().and_then(|mut q| if q.is_empty() { None } else { Some(q.remove(0)) });
                    let Some((_, path)) = next else { break };
                    let r = probe_file(&path);
                    if tx.send(r).is_err() {
                        break;
                    }
                    if let Some(w) = &wake {
                        w();
                    }
                }
            });
        }
    }

    /// Files still being probed.
    pub fn pending(&self) -> usize {
        self.pending
    }

    /// The results that arrived since the last poll.
    pub fn poll(&mut self) -> Vec<Probed> {
        let got: Vec<Probed> = self.rx.try_iter().collect();
        self.pending = self.pending.saturating_sub(got.len());
        got
    }

    /// Waits for every pending result (tests and the command line).
    pub fn wait(&mut self) -> Vec<Probed> {
        let mut out = Vec::new();
        while self.pending > 0 {
            match self.rx.recv() {
                Ok(p) => {
                    self.pending -= 1;
                    out.push(p);
                }
                Err(_) => break,
            }
        }
        out
    }
}

/// The files of a dropped folder that the importer reads, breadth first, at most 8 folders deep and 50,000 entries
/// (`find.js` `listMedia`), with each file's folder path relative to the dropped one (the bins to make).
pub fn list_folder(root: &Path) -> Vec<(PathBuf, Vec<String>)> {
    let mut out = Vec::new();
    walk(root, |p, rel| {
        if accepted(&p) {
            out.push((p, rel.to_vec()));
        }
        true
    });
    out
}

/// The files under a folder the person chose (`find.js` `walk`): breadth first, at most 8 folders deep and 50,000
/// entries, links not followed. `visit` gets each file and its folders below the root; `false` stops the walk.
pub fn walk(root: &Path, mut visit: impl FnMut(PathBuf, &[String]) -> bool) {
    let mut queue = vec![(root.to_owned(), Vec::<String>::new())];
    let mut seen = 0usize;
    while !queue.is_empty() {
        let (dir, rel) = queue.remove(0);
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        for e in entries {
            seen += 1;
            if seen > 50_000 {
                return;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let p = e.path();
            if ft.is_dir() && rel.len() < 8 {
                let mut r = rel.clone();
                r.push(e.file_name().to_string_lossy().into_owned());
                queue.push((p, r));
            } else if ft.is_file() && !visit(p, &rel) {
                return;
            }
        }
    }
}
