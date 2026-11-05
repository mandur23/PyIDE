# Nano Studio Cut: architecture and module contracts

Cut is the third app of Nano Studio (`--mode=cut`, the chooser's third card): a video editor. What it should do is in
[video-editor-features.md](video-editor-features.md) (Korean); how to work on it is in [cut-app.md](cut-app.md)
(Korean). This document is how it is built: the files and the API every module offers the others. It describes the
code as built. When an API changes, change this document in the same edit.

Built now: the features marked **[1]** in video-editor-features.md, with the gaps listed in cut-app.md section 7.
[2] and [3] are seams only.

Everything is written here, from scratch: no FFmpeg, no mp4box.js, no npm packages for media. The browser gives us
WebCodecs (decode and encode, hardware where the GPU has it), WebGPU (compositing), Web Audio and Canvas 2D (text).

## 1. Shape

```
main process                          renderer (the Cut window, #cutHost)
main/features/cut.js  --IPC cut:*-->  renderer/features/cut/
main/cut/*.js                           index.js        loads the scripts in order, starts Cut.ui on cutReady
  files, project I/O, autosave,         time.js state.js                                   shared
  recovery, export file sink,           codecs mp4read mkvread audioread probe mp4write    formats
  cache, relink search, fonts           model keyframes commands srt                       project
                                        effects textrender media decoder compositor player thumbs   engine
                                        presets audioengine export testsrc                 sound and export
                                        ui-*.js, css/*.css                                 screen
```

- Mode wiring: main.js (`cutHome()`, `PYIDE_CUT_HOME` for tests, `--mode=cut`), main/windows.js (title "Nano Studio
  Cut", the chooser accepts `'cut'`), main/plugin-manager.js (`MODES` has `'cut'`), renderer/core/ide.js
  (`ide.appMode === 'cut'`, `body.app-cut`, event `cutReady` with `{host}`), renderer/core/styles.css (`#cutHost`
  fills the window above the status bar; the IDE chrome is hidden), renderer/chooser.html (`#chooseCut`).
- The Cut workspace `%USERPROFILE%\Nano Studio Cut` is the IDE's project (`ide.root`) in this mode. main.js creates
  and trusts it. Projects, autosaves and the cache live in it (section 7).
- `renderer/features/cut/plugin.json`: modes `["cut"]`, requiredIn `["cut"]`, main `["cut.js"]`. In cut mode the
  required plugins (diagnostics, notifications, problems, project-roots, run, settings, terminal), updater and cut
  load; Code's and Craft's plugins do not.
- `index.js` loads the scripts in the order of its `SCRIPTS` list (`async = false`) and the stylesheets
  `css/shell.css`, `css/timeline.css`, `css/panels.css`. `Cut.loaded` settles when the last script has run. On
  `cutReady` it creates `Cut.app = Cut.state.createApp()`, awaits `Cut.ui.start(host, app)` and then sets
  `window.__cutReady = true` (the app tests wait for it).

## 2. Module pattern

Every file under `renderer/features/cut/` that is not a `ui-*.js` file is a pure module usable in Node:

```js
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).NAME = api;
})(() => {
  // Not `typeof require`: Monaco's AMD loader makes require a global function in the page.
  const NODE = typeof module === 'object' && !!module.exports;
  const time = NODE ? require('./time.js') : globalThis.Cut.time;
  ...
  return { ... };
});
```

`NAME` is the file name without `.js` (`mp4read.js` -> `Cut.mp4read`). Node is detected with
`typeof module === 'object' && !!module.exports`, never with `typeof require === 'function'`: Monaco's `loader.js`
(loaded in every mode) defines a global AMD `require` in the page, and `require('./time.js')` then throws
"Check dependency list!". Modules that only need another module while a function runs use a lazy form, so load
order and reloads do not matter there:

```js
const need = (name) => (NODE ? require(`./${name}.js`) : globalThis.Cut[name]);
```

(`mod` in audioengine.js and export.js, `req(name, key)` in commands.js are the same thing.) Load order is the list in
`index.js`: a module that reads another at load time may only use modules listed before it.
`verify/cut-formats.mjs` loads `loader.js` in a vm and then the format scripts as page scripts, to keep this true.

Modules that need browser APIs (WebCodecs, WebGPU, Web Audio, OffscreenCanvas, IPC) follow the same pattern but are
only tested in the app. The pure parts (parsing, math, layout, plans) are functions the Node tests call.

`ui-*.js` files are plain IIFEs that use `ide`, `Cut` and `tr()`.

Rules from the repo (docs/development.md, docs/pitfalls.md) apply. In particular: LF line endings; no `innerHTML`
with outside values (use `ide.util.el` / `textContent`); `String.replace` with a function; all UI text through
`tr()`; CSS colors through variables (dark and light themes); no inline scripts or handlers (CSP); the renderer
cannot `fetch` the network or `file:` URLs (CSP `connect-src data:`), so every byte of a file comes through IPC. CSP
`media-src` has no `blob:`, so a `<video>` in the page cannot play exported bytes.

## 3. Time (`time.js`)

`Cut.time`: `TICKS` (254,016,000,000 a second), `MAX_TICKS`, `FRAME_RATES`, `rescale(value, scale)` (container units
-> ticks, BigInt inside, no overflow), `toScale(ticks, scale)`, `fromSeconds`, `toSeconds`, `fromMicros`, `toMicros`
(WebCodecs timestamps are microseconds), `frameTicks(fps)`, `fpsValue(fps)`, `frameAt(t, fps)`, `frameStart(frame,
fps)`, `snap(t, fps, {nearest})`, `timecode(t, fps)`, `parseTimecode(text, fps, from)`.

`rescale` and `toScale` round half away from zero, also for negative values (AAC priming, B-frame delay, MP3 encoder
delay give negative times). `FRAME_RATES` is 23.976, 24, 25, 29.97, 30, 50, 59.94 and 60 as `[num, den]`.

Every time in the project, the model and the engine is ticks (a Number). Frame rates are `[num, den]`. Convert at
the edges only: container timescales on read, microseconds at WebCodecs, seconds at Web Audio.

## 4. Shared app state (`state.js`)

`Cut.state.createApp()` returns `app` (also `Cut.app` while the editor runs). The file header lists the fields
(`history`, `path`, `sequenceId`, `t`, `playing`, `selection`, `tool`, `source`, `inOut`, `focusPanel`, the getters
`project` and `sequence`) and the events (`project`, `sequence`, `time`, `playing`, `selection`, `tool`, `source`,
`inout`, `focus`). `app.on(event, fn)` returns a remover; `app.emit` is used by the panels for their own events
(section 10). Panels never mutate the project directly: they call `app.history.do(cmd)`.

## 5. Formats

Files: `codecs.js`, `mp4read.js`, `mkvread.js`, `audioread.js`, `probe.js`, `mp4write.js`. Tests:
`verify/cut-formats.mjs` (plain Node).

A **reader** is `{ size, read(offset, length) -> Promise<Uint8Array> }`. In the app it is backed by IPC `cut:read`
(`Cut.media.ipcReader`); in tests by `Cut.codecs.bufferReader(bytes)`.

`Cut.probe.open(reader, {name}) -> Promise<Source>` sniffs the bytes and returns a Source. It never throws or rejects:
a file that cannot be used comes back with `error`.

```js
Source = {
  container: 'mp4' | 'mov' | 'webm' | 'mkv' | 'mp3' | 'wav' | 'aac' | 'image' | null,
  duration,                 // ticks; Matroska: min(Info Duration, measured end) when both exist
  tracks: [Track],          // video first, then audio; images have none
  skipped: [{ id, kind, codec, reason }],   // tracks left out: unsupported codec, encrypted, empty
  image: { mime, width, height } | null,    // png, jpeg, webp, gif, bmp, avif: decoded by the engine with createImageBitmap
  error: null | { code: 'unsupported' | 'damaged' | 'hdr' | 'noTracks', detail },
  brands,                   // MP4 only: the ftyp brands
  damaged,                  // MKV only
}
Track = {
  id, kind: 'video' | 'audio',
  codec,                    // a codec string: 'avc1.640028', 'hvc1.1.6.L120.90', 'vp09.00.40.08', 'av01.0.08M.08', 'mp4a.40.2', 'opus', 'mp3', 'flac', 'vorbis', 'pcm-s16' ...
  description,              // Uint8Array for the decoder config, or null (see below)
  width, height,            // video: the coded size
  displayWidth, displayHeight,   // pixel aspect applied (pasp, SPS SAR, tkhd size, Matroska DisplayWidth/Unit), BEFORE rotation
  rotation,                 // clockwise degrees (0/90/180/270) to show upright, from the tkhd matrix
  bitDepth,                 // video
  colorSpace,               // { primaries, transfer, matrix, fullRange } when the file says (colr, Colour, SPS VUI)
  frameRate,                // [num, den]: the nominal rate (most common sample duration), for VFR too
  vfr,                      // true when sample durations vary by more than 1%
  sampleRate, channels,     // audio
  duration,                 // ticks
  truncated,                // the file ends before the tables say
  preRoll,                  // ticks: Opus 80 ms or the WebM SeekPreRoll
  samplePrefix,             // Matroska header stripping: bytes readSample/readSamples put in front of each sample
  samples: SampleTable,
}
SampleTable = {
  count,
  offset: Float64Array,     // byte offset in the file
  size: Uint32Array,
  dts: Float64Array,        // decode time, ticks, from the track start after edit lists
  pts: Float64Array,        // presentation time, ticks
  duration: Float64Array,   // ticks
  key: Uint8Array,          // 1 for sync samples
  order: Uint32Array,       // sample indexes sorted by pts
  keys: Uint32Array,        // sync sample indexes (built on first use)
}
```

HEIF/HEIC stills give container `'image'` with error `unsupported`. HDR transfer (pq, hlg) is not an error at the
source level: the track is listed and `Cut.media` refuses it with `'hdr'`.

`description` per codec: the avcC / hvcC payload; the av1C payload for AV1 (MP4 and MKV); null for vp8, vp9, mp3 and
pcm; the OpusHead for Opus (an MP4 dOps is converted); `'fLaC'` + metadata blocks for FLAC; the Vorbis CodecPrivate as
is; the AudioSpecificConfig for AAC, built when the file has none (ADTS, A_AAC/MPEG4/LC).

PCM codec strings are `pcm-u8`, `pcm-s8`, `pcm-s16`, `pcm-s24`, `pcm-s32`, `pcm-f32`, `pcm-f64`, with a `be` suffix for
big-endian (MOV twos/in24/in32/fl32/lpcm, Matroska A_PCM/INT/BIG). Some are not WebCodecs strings, so every `pcm-*`
is decoded with `Cut.codecs.pcmToFloat(bytes, codec, channels)`, which returns one Float32Array per channel. PCM
samples are pieces of at most 1 s or 1 MB.

MP3 with a LAME/Lavc Info tag: pts are shifted by -(encoderDelay + 529) samples and the track duration leaves out the
padding. The Info/Xing/VBRI frame is not a sample. Matroska times are absolute (not shifted to 0); CodecDelay is
subtracted from that track's pts.

Also exported by `probe.js` (they work for every container):
- `sampleAtTime(track, t)` -> the index of the sample shown at presentation time `t` (last pts <= t). Before the first
  pts it returns the earliest sample (`order[0]`); -1 only for an empty table.
- `keyBefore(track, index)` -> the sync sample to start decoding from to reach sample `index`. It steps back past
  open-GOP leading pictures and by `track.preRoll`; -1 for an empty table.
- `readSample(reader, track, index)` -> `Promise<Uint8Array>`; `readSamples(reader, track, from, to)` ->
  `Promise<Uint8Array[]>` for samples `from..to-1` (half-open, like slice), in as few reads as possible. Items may be
  subarray views of one read. Both add `samplePrefix`, so read samples only through these, never by raw offset/size.
- `sniff(bytes)`.

Coverage: MP4 and MOV (moov/trak/mdia/minf/stbl: stsd avc1/avc3/hvc1/hev1/vp09/av01/mp4a/Opus/fLaC/ipcm/sowt/twos,
stts, ctts (v0 and v1 negative), stss, stsz/stz2, stsc, stco/co64, elst (an initial empty edit and a media-time start;
more complex lists: the first non-empty edit), tkhd matrix for rotation; fragmented MP4 (moof/traf/trun)). WebM and
MKV (EBML; TimestampScale; Tracks with CodecPrivate; Clusters with SimpleBlock and BlockGroup, Xiph/EBML/fixed lacing;
Cues when present, else a cluster scan; V_VP8, V_VP9, V_AV1, V_MPEG4/ISO/AVC, V_MPEGH/ISO/HEVC, A_OPUS, A_VORBIS,
A_AAC, A_FLAC, A_PCM). MP3 (frame headers, Xing/VBRI for duration, ID3v2 skipped), WAV (RIFF/RF64/BW64, PCM and
float), ADTS AAC. Images: PNG, JPEG, WebP, GIF, BMP (probe also knows AVIF by its bytes, but main does not serve
`.avif`). There is no Ogg reader and no reader for bare FLAC files, so main does not accept `.ogg`, `.oga`, `.opus` or
`.flac` (FLAC, Opus and Vorbis are read inside MP4 and Matroska).

`Cut.codecs`: parse/build avcC and hvcC (and SPS fields: profile, level, size, color info), AudioSpecificConfig,
OpusHead/dOps, FLAC STREAMINFO, vpcC, av1C, and a codec string for each; `parseCodecString`, `codecString`. Also
`FormatError`, `fail`, `readRange`, `bufferReader`, `ByteWriter`/`BitReader`/`BitWriter`, `rescale`/`toScale` (sign
safe), `ticksPer`/`unitsPer`, `colorFromCodes`/`codesFromColor`/`mergeColor`, `pcmFormat`/`pcmToFloat`,
`newTable`/`TableBuilder`/`filterTable`/`finishTrack`, `fpsFromTicks`. Used by the readers and by mp4write.

`Cut.mp4write.create({ video, audio, sink, timescale })` writes an MP4 the way players and phones expect:

```js
video = { codec /* avc1/avc3/hvc1/hev1 */, width, height, description /* avcC or hvcC from VideoEncoder metadata */, frameRate: [num, den], colorSpace? }
audio = { codec: 'mp4a.40.x' | 'opus', sampleRate, channels, description? } | null
sink  = { write(bytes, position?) -> Promise }   // position undefined = append; a number = overwrite there
writer = {
  addVideo({ data: Uint8Array, timestamp /* pts, ticks */, duration /* ticks */, key: boolean, compositionOffset? /* pts - dts, ticks */ }) -> Promise,
  addAudio({ data, timestamp, duration }) -> Promise,
  finish({ chapters? }) -> Promise<{ bytes }>,   // bytes: the file size; chapters are accepted and ignored ([2])
  position,                                       // bytes queued so far
}
```

- `create` throws for other video codecs (vp09 and av01 too), other audio codecs, a missing video `description`, or a
  missing audio `sampleRate`/`channels`.
- `timescale` is the video media timescale and the movie timescale. The default (`videoTimescale(fps)`) is
  `num * 1000` for integer rates and `num` for x/1001 rates. The audio media timescale is its sample rate.
- `addVideo`/`addAudio` return a Promise that settles when every write queued so far is done: await it for
  back-pressure. After a sink error they throw at once and `finish()` rejects. Samples of 2 MB or more go to the sink
  uncopied: keep them unchanged until that promise settles.
- Layout: ftyp (32 bytes: isom, iso2, avc1, mp41), then one mdat with a 16-byte header (size field 1 and a 64-bit size
  patched at finish: the sink's only positional write, 8 bytes at position 40), then moov at the end with stts, ctts
  when needed, stss, stsz, stsc, co64 (never stco), an edit list when a track does not start at 0 or has B-frame
  delay, `colr` when given, esds/dOps and btrt. Chunks are about half a second per track, written in time order
  across the tracks. Faststart (moov before mdat) is main's `cut:faststart`.

Tests write samples of known bytes and sizes with mp4write, read them back with probe and compare every table; the
boxes the writer never makes (ctts v1, co64 past 4 GB, stz2, elst, fragments, QuickTime PCM, Matroska lacing) are
built byte by byte. Real encoder output is checked in `verify/cut-export.mjs`.

## 6. Project model, commands, keyframes, captions

Files: `model.js`, `keyframes.js`, `commands.js`, `srt.js`. Tests: `verify/cut-model.mjs` (plain Node).

### `Cut.model`

The project JSON is video-editor-features.md §19. Exact shape, all times in ticks:

```js
Project = { format: 'ncut', version: 1, settings: Settings, media: [Media], bins: [Bin], sequences: [Sequence], nextId }
Settings = { fit: 'fit' | 'fill' | 'original', stillDuration, transitionDuration, freezeDuration, textStyles? }
Media = { id, path, name, kind: 'video' | 'audio' | 'image', size, mtime, duration,
          video: {w, h, fps, codec, vfr, rotation} | null, audio: {rate, channels, codec} | null,
          interpret: null | { fps }, proxy: null | { path } }
Bin = { id, name, parent: binId | null, items: [mediaId | sequenceId] }
Sequence = { id, name, w, h, fps: [num, den] /* one of time.FRAME_RATES */, rate: 48000, background: '#000000',
             masterGain: 0 /* dB on the mix */, tracks: [Track], clips: [Clip], transitions: [Transition],
             markers: [Marker], captions: [CaptionTrack] }
Track = { id, kind: 'video' | 'audio', name, locked, syncLock, height, visible /* video */, mute, solo, volume /* dB */, pan /* audio */ }
Clip = { id, track, start, in, out,           // timeline position, source in/out (source ticks)
         source: { media } | { media, freeze: true } | { generator: 'text' | 'solid' | 'adjustment', ...params },
         speed: 1, reverse: false, enabled: true, link: linkId | null, group: null, name, label,
         props: { position: [x, y] /* px from center */, scale: [sx, sy] /* % */, rotation /* deg */, anchor: [x, y], opacity /* % */,
                  crop: [top, right, bottom, left] /* % */ }  |  { volume /* dB */, pan }   // video | audio clip
         keyframes: { [path]: [Keyframe] },
         effects: [Effect], fadeIn: 0, fadeOut: 0 /* ticks, audio */, markers?: [Marker] /* t from the clip start */ }
Effect = { id, type, on: true, params: {} }   // params only where they differ from the registry's defaults
Keyframe = { t /* from clip start */, v /* number or array */, ease: 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bezier', h?: [x1, y1, x2, y2] }
Transition = { id, track, at /* edit point ticks */, type, duration, align: 'center' | 'start' | 'end', params: {} }
Marker = { id, t, duration: 0, name, note, kind: 'comment' | 'chapter', color }
CaptionTrack = { id, lang, name, style: {...}, syncLock: true, items: [{ id, start, end, text }] }
```

A text clip is `source: { generator: 'text', layers: [TextLayer] }`; TextLayer = `{ id, text, font, size, weight,
italic, tracking, leading, align, fill, stroke: {color, width} | null, shadow: {color, blur, x, y} | null,
box: {color, padding, radius} | null, position: [x, y] }`. Solid: `{ generator: 'solid', color }`. A freeze frame
(`{ media, freeze: true }`) is a still showing the frame at `clip.in`. `settings.textStyles` entries are
`{ id: 'ts<n>', name, style: {font, size, weight, italic, tracking, leading, align, fill, stroke, shadow, box} }`.

Ids: track ids (V1, A2) are unique within their sequence; effect and text layer ids within their clip; every other id
(media, bins, sequences, clips, transitions, markers, caption tracks and items, links) is project-wide
(`newId(project, prefix)` = prefix + `nextId`). A link has two or more clips of one sequence.

`clipDuration(clip)` is `(out - in) / speed` rounded to `model.QUANTUM` (2,116,800 ticks, the gcd of every offered
frame length), not to whole ticks: at speeds other than 1, in/out are not whole ticks and the float error would push
durations off the frame grid. That is why sequences accept only `time.FRAME_RATES` (`validFps`). Always use
`clipDuration`/`clipEnd`, never `(out - in) / speed`.

Exports: `VERSION`, `QUANTUM`, `EASES`, `GENERATORS`, `VIDEO_PROPS`, `AUDIO_PROPS`, `MARKER_KINDS`, `ALIGNS`; `clone`,
`newId`, `defaultSettings`, `createProject(opts)`, `createSequence(opts)` (default tracks V1, V2, A1, A2),
`createTrack`, `createClip`, `createTextLayer`, `defaultCaptionStyle`, `videoProps`, `audioProps`;
`validate(project) -> { ok, errors: [string] }` (shapes, ids unique, references resolve, no overlapping clips on a
track, times frame-aligned to the sequence), `validPropPath(clip, kind, path)`, `validFps(fps)`,
`migrate(json) -> project` (fills missing fields with defaults, snaps keyframe, marker and caption times to frames;
throws `code: 'notProject'` or `'newer'`); `clipDuration`, `clipEnd`, `sequenceDuration(seq)`,
`clipsAt(seq, t, {kind})` (enabled clips under t, V1 first), `sourceTime(clip, t)` (the source time a timeline time
shows: speed, reverse and freeze included), `trackIndex(seq, id)` (the index among tracks of the same kind: V1 = 0,
A1 = 0), `trackOf`, `linkedClips(seq, clip)`, `mediaOf(project, clip)`, `isGenerator`, `isStill`.

Engine and export map timeline time to source time only with `sourceTime(clip, t)`.

### `Cut.keyframes`

`valueAt(keyframes, t, fallback)` (numbers and arrays; hold, linear, eased, cubic bezier by handles; before the first
keyframe the first value, after the last the last), `propValue(clip, path, t, fallback)` (`t` in clip time, reads
`clip.keyframes[path]` or the static value), `staticValue`, `insert(keyframes, kf)`, `remove(keyframes, t)`,
`next(keyframes, t)`, `prev(keyframes, t)`, `bezier`, `eased`, `mix`.

Ease names have the CSS meaning: `easeIn` starts slowly, `easeOut` arrives slowly. A keyframe's ease shapes the
segment that leaves it. Keyframable paths are the props (`'opacity'`, `'position'`...), `effects.<id>.<param>` and
`layers.<id>.<field>`. A text layer's `opacity` (0..100) and `reveal` (0..1, typewriter) exist only as keyframes.

### `Cut.commands`

`createHistory(project, { limit = 1000 })` -> `history`. It throws `code: 'damaged'` for a project that does not
validate. Opened files go through `createHistory(Cut.model.migrate(text))`.

- `history.project` (the current project; read-only), `do(command)` -> result | throws (nothing changes then),
  `undo()` / `redo()` -> boolean, `canUndo`, `canRedo`, `dirty`, `markSaved()`.
- `begin(label)` / `commit()` / `cancel()` group several `do` into one undo step (slider drags, live trims). Nested
  pairs join the outer group; `cancel()` takes back everything since the outer begin. `grouping` is true inside one.
- `list()` -> `[{ label, done }]`, oldest first: the steps that can be undone, then those that can be redone.
- `onChange(fn)` (fn(reason) with 'do' | 'undo' | 'redo'; returns a remover), `dispose()`, `serialize()` -> JSON text.

A command is a plain object `{ type, ... }` built by helpers on `Cut.commands`, so a test or a panel writes
`history.do(Cut.commands.split(seqId, t))`. Each command records the inverse of every change, so undo is exact.
After every command the project must still `validate()` (else `invalidResult`). Labels are English
(`Cut.commands.label(cmd)`, `LABELS`), shown through `tr()`.

Options are nested, never spread to the top level. The builders:

- media: `importMedia(mediaList, binId?)`, `removeMedia(ids)`, `relinkMedia(id, {path, size, mtime})`,
  `addBin(name, parent?)`, `removeBin(id)`, `renameItem(id, name)`, `moveToBin(ids, binId)`,
  `setProxy(mediaId, {path} | null)`
- project: `setSettings({fit, stillDuration, transitionDuration, freezeDuration, textStyles})`
- sequences: `addSequence(opts)` (`{from: seqId}` duplicates), `removeSequence(id)`,
  `setSequence(id, patch)` (name, w, h, fps, background, masterGain)
- tracks: `addTrack(seqId, kind, index?, {name})`, `removeTrack(seqId, trackId)`, `setTrack(seqId, trackId, patch)`
- placing: `place(seqId, { source, in, out, at, video: trackId | null, audio: trackId | null, mode: 'insert' | 'overwrite' })`
  (linked video and audio clips), `placeRange(seqId, { source, in, out, range: {in, out}, video, audio, mode })`
  (three-point edit with the sequence In/Out; with all four points the source In/Out is used),
  `paste(seqId, clips, { at, video, audio, mode })` (copied Clip objects, best with a `kind` field)
- moving: `move(seqId, clipIds, { delta, trackDelta, insert, linked })`; `trackDelta` is a number or `{video, audio}`
- trimming: `trim(seqId, clipId, { edge: 'start' | 'end', delta, mode: 'normal' | 'ripple' | 'roll', linked })`
  -> `{ applied, clamped: 'source' | 'neighbour' | 'length' | null }` (`'length'`: the clip would get shorter than
  one frame)
- cutting: `split(seqId, t, { clipIds, trackIds, allTracks, linked })` (no option: every unlocked track),
  `remove(seqId, clipIds, { ripple, linked })`, `rippleToPlayhead(seqId, t, 'before' | 'after', { trackIds })` (Q and
  W), `closeGap(seqId, trackId, t)`, `lift(seqId, in, out, trackIds | null)`, `extract(seqId, in, out, trackIds | null)`
- clip settings: `setClip(seqId, clipId, patch, { linked })` (props, speed or duration (the speed that fits the
  source; not both), ripple, reverse, enabled, name, label, fadeIn, fadeOut), `setKeyframes(seqId, clipId, path,
  keyframes | null)`, `link(seqId, ids)`, `unlink(seqId, ids)`
- effects: `addEffect(seqId, clipId, type, index?, params?)`, `removeEffect(seqId, clipId, effectId)`,
  `setEffect(seqId, clipId, effectId, { on, params })`, `moveEffect(seqId, clipId, effectId, index)`
- transitions: `addTransition(seqId, { track, at, type, duration, align })`, `removeTransition(seqId, id)`,
  `setTransition(seqId, id, patch)`
- text and generators: `addGenerated(seqId, { track, at, duration, source })`, `freezeFrame(seqId, clipId, t,
  duration?)`, `setGenerator(seqId, clipId, {color} | {layers})`, `setLayer(seqId, clipId, layerId, patch)`,
  `addLayer(seqId, clipId, layer, index?)`, `removeLayer(seqId, clipId, layerId)`
- markers: `addMarker(seqId, marker, { clipId })` (a clip marker with `clipId`), `setMarker(seqId, id, patch)`,
  `removeMarker(seqId, id)`
- captions: `addCaptionTrack(seqId, opts)`, `setCaptionTrack(seqId, trackId, {lang, name, style, syncLock})`,
  `removeCaptionTrack(seqId, trackId)`, `setCaptions(seqId, trackId, items)`, `addCaption(seqId, trackId, item)`,
  `setCaption(seqId, trackId, itemId, patch)`, `removeCaption(seqId, trackId, itemId)`

Results of `history.do`: `{ids}` for place, paste and split; `{id}` for the add commands; `{applied, clamped}` for
trim; `{range}` for Q/W, gaps, lift and extract.

Editing rules every command follows (the commands.js header has them too):
- Times are snapped to the sequence's frames: absolute times to the start of their frame, lengths and deltas to the
  nearest whole frame. Snapping to clip edges is the timeline's job, before it builds the command.
- Linked clips move, trim, split, change speed and are removed together, unless the command says `linked: false`
  (Alt in the timeline).
- A ripple (insert, ripple delete, ripple trim, extract, Q/W, speed with ripple) applies the same time change to the
  targeted tracks and every sync-locked track: time inserted at p splits what crosses p and pushes the rest; a range
  removed on a sync-locked track takes what is in it and pulls the rest. Locked tracks never change. Caption tracks
  with `syncLock` do the same. Sequence markers follow only when every unlocked track does. `closeGap` refuses
  (`gapBlocked`) when a sync-locked track or caption track has content in the gap.
- Transitions follow the clip edge a command moves. One left off every clip edge, or a second one at the same point,
  is removed. A link left with one clip is cleared.

Errors a person can cause throw an Error whose message is a fixed English sentence (shown with `tr(err.message)`)
and `err.code`, sometimes `err.detail`: `locked`, `noTrack`, `noTarget`, `tooShort`, `noRange`, `noGap`,
`gapBlocked`, `noEdge`, `noFrame`, `noRoom`, `notOnClip`, `overlap`, `linkOne`, `speed`, `gain`, `fps`, `size`,
`binLoop`, `invalidResult`, `damaged`, `notFound` (unknown ids). `migrate` adds `newer` and `notProject`.

### `Cut.srt`

`parse(text) -> [{start, end, text}]` (SRT), `write(items) -> text` (CRLF), `parseVtt`, `writeVtt` (LF),
`parseAny(text, name)`, `isVtt(text, name)`, `formatTime`, `decode(bytes) -> text` (UTF-8 with or without BOM,
UTF-16 LE/BE by BOM, else CP949 when it is not valid UTF-8; the CP949 extension is computed when the runtime's
`euc-kr` decoder lacks it, as Node's does).

## 7. Main process

Files: `main/features/cut.js` (registers the `cut:*` channels; `module.exports = { register, cutHome }`) and helpers
in `main/cut/`: `paths.js` (path checks), `limits.js` (sizes), `project.js` (projects, autosave, sessions,
recovery), `sink.js` (export sink), `faststart.js`, `cache.js`, `find.js` (findMedia, listMedia), `fonts.js`,
`runs.js` (which run wrote a marker). Tests: `verify/cut-main.mjs` (plain Node with Electron stubbed).

Folders: `<home>` is the Cut workspace (`PYIDE_CUT_HOME`, else `%USERPROFILE%\Nano Studio Cut`); projects =
`<home>\Projects`, autosave = `<home>\Autosave` (session markers in `<autosave>\.sessions`), cache = `<home>\Cache`.
Export sink journals are in `<userData>\cut-exports`.

Paths from the renderer go through `paths.js`: local regular files only, checked on the real path (realpath), the
extension checked on both the given name and the real one. Network paths (`\\host\share`, `\\?\UNC\...`, a link whose
target is one) are refused before anything touches them (NTLM leak, pitfalls); `\\?\C:\...` is read as `C:\...`;
`\\.\` device paths are refused. A mapped drive letter works. Failures are values `{ error, code }` with code
`badArgs`, `network`, `missing`, `notFile`, `extension`, `outside`, `io`, `tooLarge`.

Channels (the renderer calls `ide.api.invoke('cut:...', ...)`; results are values, never throws for expected cases):
- `cut:home()` -> `{ home, projects, autosave, cache }` (folders created).
- `cut:stat(path)` -> `{ size, mtime, isFile, path /* real */ }` | `{ missing: true }`.
- `cut:read(path, offset, length)` -> `Uint8Array` | `{ error, code }` (test with `r instanceof Uint8Array`). Up to
  64 MB a read. Extensions: mp4 m4v mov mkv webm 3gp, mp3 wav m4a aac, png jpg jpeg webp gif bmp,
  ncut srt vtt cube.
- Dialogs, with the UI text from the renderer (English when missing): `cut:pickMedia({multi, title, filterName,
  allName, defaultPath})` -> paths | null, `cut:pickFolder({title})` -> path | null, `cut:pickProject({title,
  filterName})` -> path | null, `cut:saveAs({defaultPath, filters, title})` -> path | null (the first filter's
  extension is added when the name has none). `PYIDE_CUT_DIALOG` (tests) names a JSON file
  `{pickMedia, pickFolder, pickProject, saveAs}`; each dialog returns that value (missing = cancelled) without
  showing anything.
- `cut:projectRead(path)` -> `{ text, path, mtime }` | `{ missing }` | `{ error, code }`;
  `cut:projectWrite(path, text)` -> `{ ok, path, bak }` | `{ error }`. Only `.ncut`, the text must be a JSON
  object, the folder must exist. Temp file then rename; the previous file is kept as `.ncut.bak` when the format
  version changes.
- `cut:autosave(key, text)` (key: the project path, or `untitled-<id>`) -> `{ ok, file }`: writes
  `<autosave>\<name>-<hash>-<stamp>.ncut` and keeps the 20 newest per key. `cut:sessionStart(key)` (also clears an
  ended offer of the same key), `cut:sessionEnd(key)`, `cut:recovery()` -> `[{ key, file, time }]` for sessions that
  never ended (the run is gone or the window's renderer crashed) whose newest autosave is newer than the session's
  start and its last save. `cut:recoveryDismiss(key)` -> `{ ok }` removes an offer the user declined.
- Export sink: `cut:writeOpen(path)` -> `{ id, part }` (writes `<path>.part`; extensions mp4 m4a mov webm wav png
  jpg jpeg srt vtt txt; the folder must exist), `cut:writeAt(id, bytes, position?)` -> `{ ok, end }` (up to 256 MB a
  call; writes of one sink run in the order sent), `cut:writeClose(id, { commit })` -> `{ ok, path, bytes }`
  (renames over the final name) or, with `commit: false`, `{ ok: true, path: null, bytes: 0, aborted: true }`.
  A sink belongs to the window that opened it; its part files are removed when the window closes, and parts of a
  crashed run at the next start.
- `cut:faststart(path)` -> `{ ok, moved, bytes, path }` | `{ ok, already: true }`: moves moov in front of the first
  mdat through a temp file, adding the moov size to every co64 and stco entry (an stco that overflows becomes co64;
  co64 stays co64), and keeps the mdat header form.
- Cache: `cut:cacheGet(key)` -> `Uint8Array | null`, `cut:cachePut(key, bytes)` (up to 512 MB), `cut:cacheInfo()` ->
  `{ bytes, files, limit, dir }`, `cut:cacheClear()`. Least recently used files go first above the limit (setting
  `cut.cacheLimitGB`, default 10). Other files under the cache folder (a proxy an export sink wrote there) count too.
- `cut:findMedia(folder, wanted: [{ name, size }])` -> `{ [name]: path }` and `cut:listMedia(folder)` ->
  `{ files: [{ path, rel, size, mtime }], truncated }` (folder import; bins come from `rel`). Both go breadth first,
  8 folders deep, 50,000 entries at most, and do not follow junctions or links.
- `cut:fonts()` -> `[{ family, localName, styles: [{ style, weight, italic, file, index }] }]` from
  `C:\Windows\Fonts` and the user's fonts folder (`PYIDE_CUT_FONT_DIRS`, a JSON list of folders, replaces them in
  tests), read from the files' name, OS/2 and head tables (TTF, OTF, TTC, OTC); `localName` is the Korean family name
  (맑은 고딕) or null. `cut:fontData(file, index)` -> Uint8Array: a standalone font for one TTC face, for `new
  FontFace(name, data)`.
- `cut:reveal(path)` shows the file in Explorer.

## 8. Engine

Files: `effects.js`, `textrender.js`, `media.js`, `decoder.js`, `compositor.js`, `player.js`, `thumbs.js`. Tests:
`verify/cut-engine-core.mjs` (Node) and `verify/cut-engine.mjs` (app, port 9753).

### `Cut.effects`

The registry: `list()`, `get(type)`, `defaults(type)`, `resolve(type, params)`, `transitions()`,
`defaultTransition(kind)`, `categories(kind)`, `whiteBalance(linearRgb) -> {temperature, tint}`, `srgbToLinear`,
`linearToSrgb`, `hexToLinear`, `LUMA`, and `wgsl`/`cpu` helpers for the compositor and the tests.

A def: `{ type, name /* English, shown through tr() */, category, kind: 'video' | 'audio', params: [{ id, name, type:
'number' | 'angle' | 'percent' | 'color' | 'bool' | 'choice' | 'point', min, max, step, default, choices?
/* [[id, English label]] */, keyframable }], gpu, cpu, canvas2d }`. `gpu.wgsl` is the body, `gpu.code` the complete
WGSL. A video effect's `gpu.uniforms(params, {width, height, pxScale, quality})` returns a list of passes (each at most
16 floats; `[]` means nothing to do); a transition's `gpu.uniforms(params, progress)` returns one array. `cpu` is the
reference the tests compare with, `canvas2d` a hint for the 2D back end. Audio effects have
`gain(params, tSeconds, lengthSeconds)` -> linear gain; `crossfade.power` has `gains(progress)` -> `[outgoing, incoming]`.

Type ids. Video: `flip.horizontal`, `flip.vertical`, `crop`, `edge.extend`, `blur.gaussian`, `blur.directional`,
`mosaic`, `color.bw`, `color.tint`, `color.brightnessContrast`, `color.basic` (temperature, tint, exposure, contrast,
highlights, shadows, whites, blacks, saturation, vibrance), `vignette`. Audio: `audio.gain`, `audio.fade`.
Transitions: `dissolve`, `dip.black`, `dip.white`, `push`, `wipe`; audio `crossfade.power`.

### `Cut.textrender`

`draw(ctx2d, layers, { w, h, t, clip, scale })` (synchronous; call `prepare(layers)` first so the fonts are loaded),
`drawCaptions(ctx, items, style, {w, h, scale})`, `measure(layer, ctx?) -> {lines, width, height, lineHeight, box}`,
`resolveLayer`, `prepare`, `loadFont`, `fontList`, `fontString`. A layer's `position` is the center of its block of
lines; `align` places the lines inside that block. `animations = { list(), make(id, opts), apply(clip, layerId, id,
{out, length, frame, perChar, distance}) }` for the motion presets `fade`, `rise`, `typewriter`; `apply` returns
`{ path: keyframes }` ready for `commands.setKeyframes`.

### `Cut.media`

- `reader(path)` -> Promise of a reader (it needs `cut:stat` for the size); `ipcReader(path, size)`, `stat(path)`.
- `importFiles(paths, {onProgress})` -> one entry per path, in order: a Media entry without an id, ready for
  `commands.importMedia`, or `{ path, name, error: {code, detail} }` with code `missing` | `unsupported` | `damaged` |
  `hdr` | `noTracks` | `io`. `video.w/h` is the size the picture is shown at (pixel aspect and rotation applied);
  `rotation` is the clockwise turn the frames need. Images get `video {w, h, fps: null, codec: mime}`.
- `open(project, mediaId, {proxy})` never rejects and returns `{ path, size, mtime, reader, source, video (track),
  audio (track), image, width, height, rotation, duration, error, mediaId, media, proxy }`, cached per path.
  `openPath(path)`, `forget(path)` (after a relink or a replaced file).
- `videoConfig(track, hardware)` (passes the track's `colorSpace`, since WebCodecs ignores the container's colr),
  `audioConfig`, `usable`, `shownSize`.

### `Cut.decoder`

`createFrameSource(opened, track, { hardware, cacheFrames, cacheBytes })` -> `{ frameAt(sourceTicks) ->
Promise<VideoFrame>, sampleAt(t), prefetch(fromTicks, toTicks), release(frame), close(), hardware, stats() }`.
Frames returned are clones the caller owns until `release(frame)`. One VideoDecoder per source, fed in decode order
from `keyBefore`; chunks carry the sample's presentation rank as timestamp, so an output maps back to its sample.
Decoded frames stay in a cache limited by count (8 with hardware, 48 in software) and bytes, evicting those farthest
from the playhead, behind it first; prefetch counts the frames still inside the decoder and feeds one at a time.
Configs are tried in order prefer-hardware, prefer-software, no-preference (`hardware: false` skips hardware). A seek
the run cannot reach restarts at `keyBefore`. Every VideoFrame is counted and closed exactly once.

`decoder.stats()` -> `{ open, sources, decoders, cacheBytes, live, budget }`; `decoder.setBudget(bytes)` sets the
memory all frame caches share (default 1.5 GB; WebGPU does not report VRAM). `decodeAudio(opened, track)` ->
`Promise<{ rate, channels, data: [Float32Array] }>`: the whole track from source time 0 at the decoder's output rate
(the decodeAudioData fallback is 48 kHz), kept in an LRU of 1.5 GB. Also `assemble`, `forgetAudio`.

### `Cut.compositor`

`create(canvas | OffscreenCanvas | null, { width, height, backend: 'webgpu' | '2d', hardware, powerPreference })`
-> `Promise<Compositor>`. WebGPU when there is an adapter (`powerPreference` default `'high-performance'`), else (or
with `backend: '2d'`) a Canvas 2D fallback; `compositor.backend` says which.

- `render(project, seqId, t, { quality: 1 | 0.5 | 0.25, captions: true (first track) | trackId | [ids], overlays:
  ['safe' | fn(ctx2d, {w, h, scale})], proxy })` draws the sequence frame at t, letterboxed into the canvas: video
  tracks bottom to top (V1 first), each clip's source frame (or image, text, solid) through its effects in its own
  frame, then crop, anchor, scale, rotation, position, opacity (keyframed values at t), transitions between clips,
  captions on top when asked. Renders on one compositor never overlap.
- `renderMedia(project, mediaId, t, opts)`, `renderSequence(project, seqObject, t, opts)`, `prefetch(project, seqId,
  from, to)`, `idle()` (resolves once frames are back with their decoders: call it before `destroy()`),
  `readPixels() -> Promise<Uint8Array RGBA>`, `videoFrame(init)` (a VideoFrame of the canvas), `resize`, `stats`,
  `info`, `errors`, `lost` (WebGPU device loss, reported, not recovered), `width`, `height`.
- Units: position and anchor in sequence pixels; anchor from the center of the fitted clip before scaling; rotation in
  degrees clockwise; crop `[top, right, bottom, left]` % in the clip's own frame. Text and solid clips are full-frame
  layers with the same transforms. Each clip on screen gets its own frame source.
- WebGPU: intermediate pictures are rgba16float, linear light, premultiplied; sRGB / Rec.709 out. The 2D fallback does
  transforms, opacity, crop, text, the transitions and colors through CSS `filter` (mixed in sRGB values; vignette is a
  radial gradient; wipes have a hard edge; edge extend is not drawn). Missing media draws a red "Media Offline" frame.
- Pure helpers: `plan`, `planItem`, `fitScale`, `transitionRange`, `extendedSourceTime`, `missingHandles(project,
  seq, transition) -> {a, b}` (missing handle ticks, for the striped warning), `captionsAt`, `mediaSequence`.

### `Cut.player`

`create({ app, canvas, audio /* Cut.audioengine instance or null */, mode: 'program' | 'source', backend, hardware,
captions, overlays, proxy, size })` -> `{ play(rate = 1), pause(), seek(t), playing, rate, quality, setQuality(q),
dropped, setProxy(on), ready /* Promise of the compositor */, compositor, render(), frameRect() /* the frame in CSS
pixels */, stats() /* {shown, dropped, fps, renderMs, renderMaxMs} */, on(fn) /* frame, play, pause, error */,
destroy() }`. It renders `app.t` whenever the time, the project or the sequence changes; while playing it follows the
audio clock (only at rate 1 in program mode) or `performance.now()`, updates `app.setTime`, prefetches ahead, counts
dropped frames and pauses `Cut.thumbs`. `RATES` are the J/K/L shuttle rates (-8..8). Source mode reads and writes
`app.source.t`.

### `Cut.thumbs`

`strip(project, mediaId, { from, to, count, height }) -> Promise<[ImageBitmap]>` (shared bitmaps: callers must not
close them), `peaks(project, mediaId, { samplesPerPeak })` -> min/max pairs at the track's own sample rate, all
channels together; both cached through `cut:cacheGet/Put`. Also `computePeaks`, `pause(on)`, `paused`, `queued`.

## 9. Sound and export

Files: `presets.js`, `audioengine.js`, `export.js`, `testsrc.js`. Tests: `verify/cut-export-core.mjs` (Node) and
`verify/cut-export.mjs` (app, port 9754).

### `Cut.presets`

`list()`, `get(id)`, `sequences()`, `EXPORT`, `SEQUENCE`. Export presets: `youtube-1080p`, `youtube-4k`, `shorts`
(1080x1920), `720p`, `audio-m4a`. Sequence presets: YouTube 1080p30, YouTube 4K30, Shorts 1080x1920, Square 1080x1080.
- `resolve(preset, seq, overrides)` -> `{ id, name, kind, ext, width, height, fps, video: { family, codec, bitrate,
  mode, keyInterval } | null, audio: { codec: 'mp4a.40.2', rate: 48000, channels: 2, bitrate }, loudness }`. The frame
  rate is always the sequence's; the codec string carries the H.264 or HEVC level that fits.
- `validate(settings)` -> `[English sentences]`, `estimate(preset | settings, ticks, {fps})` -> bytes,
  `estimateSeconds(preset | settings, ticks, {fps, speed})` (speed defaults to `Cut.export.speed()`),
  `sequenceFor(media)` -> `{w, h, fps}`, `avcLevel`/`avcCodec`/`hevcLevel`/`hevcCodec`.
- `LOUDNESS` (YouTube -14, Broadcast -24 LUFS), `AUDIO_RATE` 48000, `AUDIO_BITRATES` `[128000, 160000, 192000]`: the
  AAC encoder WebCodecs uses on Windows (Media Foundation) takes 96, 128, 160 and 192 kbps only.

### `Cut.audioengine`

One mixer computes the sequence's audio for both the preview and the export: every audio clip with its volume and
volume keyframes, pan, fade handles, audio crossfades, track volume, pan, mute and solo, `seq.masterGain`, speed with
the pitch kept (WSOLA time stretch), reverse, and audio effects. Pan is a balance law (center leaves both channels at
full level; mono is copied to both). Fade handles are linear in amplitude. Audio transitions use the registry's
`gains(progress)`, else constant power.

- `create(app, { getAudio, rate })` -> `{ start(t, rate = 1) -> Promise, stop(), now() /* sequence ticks heard */,
  meters() -> { master, masterChannels: [l, r], tracks: {id: dB} } /* dBFS peaks, -Infinity when silent */,
  setMasterGain(db), close(), playing, rate, masterGain, context, mixer }`. Rates 0.25 to 4 play forward like tape;
  other rates are silent while the clock runs. No panel shows `meters()` yet.
- `renderOffline(project, seqId, from, to, rate = 48000, {masterGain, getAudio})` -> AudioBuffer (holds the whole
  mix: about 1.4 GB an hour). `measure(project, seqId, from, to, {rate, masterGain, onProgress, signal})` streams the
  mix through a meter and returns the loudness without keeping it.
- `loudness(buffer)` -> `{ integrated /* LUFS, BS.1770-4 gated */, truePeak /* dBTP */, samplePeak, momentaryMax,
  shortTermMax }`, `createMeter`, `normalizeGain(peaks, target = -1)` -> dB, `matchGain(measured, target, {ceiling =
  -1})` -> dB.
- Also `createMixer`, `transitionRange`, `resample`, `stretch`, `kFilters`, `dbToGain`, `gainToDb`, `makeBuffer`,
  `decodeTrack(reader, track)`, `fileReader(path)`, `defaultGetAudio` (used when `Cut.decoder` is missing).

### `Cut.export`

`run({ project, seqId, path, preset, settings, overrides, range: {in, out} | null, captions: 'burn' | 'srt' | 'both' |
null, captionTrack, onProgress, signal, hardware: 'auto' | 'hardware' | 'software', backend, masterGain, verify,
getAudio, compositor })`:

- Renders each frame with a compositor on an OffscreenCanvas at the export size and encodes it with VideoEncoder
  (H.264 High at the preset bitrate, keyframe interval from the preset; HEVC only with a hardware encoder). `'auto'`
  tries the hardware encoder first, then software; a hardware encoder that fails on the way gets one more try in
  software. For a compositor that is not WebGPU, each frame is copied into a GPU-backed canvas first: Chromium's
  encoders turn frames from CPU memory into full-range YUV that decodes too dark. Export stops with code
  `'compositor'` when the compositor reports GPU errors, instead of writing black video.
- Mixes the sound with the audio engine's mixer and encodes AAC-LC 48 kHz stereo at the chosen bitrate, falling back
  to the next lower one that works (the error arrives in the encode callback, not from configure). The AAC priming
  delay is measured once per configuration (`aacDelay`) and the audio is shifted by it.
- Muxes with `Cut.mp4write` into the `cut:writeOpen` sink (the `.part` file is renamed on success, deleted on cancel
  or failure), writes SRT sidecars when asked, runs `cut:faststart`, then verifies: re-opens the file with probe,
  checks frame count and track durations, decodes the first and last frames.
- The path's extension is replaced with the preset's (`mp4` or `m4a`).
- Success: `{ ok, path, bytes, seconds, speed /* x realtime */, frames, range, verified: { ok, frames,
  expectedFrames, duration, audioDuration, firstFrame, lastFrame, problems: [{ code, message /* English, for
  tr(message, params) */, params }] }, encoder: { codec, hardware }, audioDelay, audioBitrate, loudnessGain /* dB the loudness target added */, sidecars: [paths] }`.
- Failure: `{ ok: false, code, error }` with code `cancelled`, `noSequence`, `settings`, `empty`, `noEncoder`,
  `encode`, `audio`, `compositor`, `faststart`, `io` and the sink's codes.
- Progress events: `{ phase: 'audio' | 'video' | 'finish' | 'verify', done, total, fraction, elapsed, eta, speed }`.
- A numeric `settings.loudness` (LUFS) makes `run` measure the mix first (`audioengine.measure`, progress phase
  `audio`) and add `audioengine.matchGain(measured, target)` (true peak kept under -1 dBTP) to `seq.masterGain` and
  `opts.masterGain`. `presets.resolve(..., {loudness: null})` turns the target off; a missing key keeps the preset's.

Also: `exportFrame(project, seqId, t, path, {backend})` -> PNG (through a VideoFrame of the compositor canvas),
`chapters(seq, {firstName = 'Intro', range})` -> YouTube chapter text, `chapterProblems(seq)`,
`preflight(project, seqId, range)` -> `{ offline: [{id, name, path}], empty }`, `saveBytes(path, bytes | text)`,
`openSink`, `encodeAudio(planes, rate, {bitrate})`, `aacDelay`, `verifyFile`, `decodeRange`, `speed()` (pixels a
second of the last export, kept in localStorage `cut.exportSpeed`), `framePlan`, `captionsInRange`, `captionsAt`,
`sidecarPath`, `withExt`, `psnr`.

### `Cut.testsrc`

Test media made in the page, no copyrighted media: `make(opts)` -> bytes; `build(opts)` -> `{ bytes, schedule, codec,
hardware, audioDelay }`; `write(path, opts)` -> `{ ok, path, bytes, schedule }`; `schedule({seconds, fps, beepEvery,
vfr})` -> `{ frames: [{t, duration}], beeps, flashes: Set, duration }`. Frame N shows N in big digits and as a row of
black/white blocks, read back with `readFrameNumber(rgba, w, h, region?)`; a 1 kHz beep and a white flash every
`beepEvery` seconds. Options also `w`, `h`, `codec`, `hardware`, `bitrate`, `keyEvery`, `tone` (a steady tone),
`audio: false`. Also `frameAtTime`, `paintBlocks`, `blockLayout`, `drawFrame`, `soundOf`, `memorySink`, `CELLS`,
`BITS`.

## 10. Screen

Files: `ui-base.js`, `ui-shell.js`, `ui-project.js`, `ui-monitors.js`, `ui-export.js`, `ui-captions.js`,
`ui-keys.js`, `ui-timeline.js`, `ui-controls.js`, `ui-effects.js`, `ui-text.js`, `ui-color.js`, `ui-overlay.js`;
styles `css/shell.css`, `css/timeline.css`, `css/panels.css`, plus `style.css` (tokens). Tests:
`verify/cut-shell.mjs` (app, port 9755) and `verify/cut-timeline.mjs` (app, port 9756).

### Base (`ui-base.js`)

`Cut.ui`:
- `registerPanel(id, { title: () => string, mount(el, app) -> dispose | { dispose, focus } })`, `panels`. Panel ids:
  project, source, program, timeline, controls, effects, captions, text, color, export.
- `onAction(actionId, fn(ctx) -> false to pass it on, { panels: [panelId] | null })` -> remove; `runAction(id, ctx)`,
  `hasHandler(id, panel)`. The newest handler goes first. Action ids are listed in the ui-base.js header; each is
  also the IDE action `Cut.<id>` (ui-keys.js).
- `dnd.start(pointerdown, payload, {label})` and `dnd.target(el, { accepts, over, leave, drop(payload, e, {ctrl, alt,
  shift}) })` -> remove. Payloads: `{kind: 'media', ids, binIds}`, `{kind: 'source', mediaId, in, out, video,
  audio}`, `{kind: 'sequence', id}`, `{kind: 'bin', ids}`, `{kind: 'effect' | 'transition', type}`,
  `{kind: 'generator', source, duration?}`, `{kind: 'effectOrder', clipId, effectId}`.
- `editing = { patch: {video, audio}, snapping, targets }` with `setPatch(app, p)`, `setSnapping(app, on)`,
  `patchFor(app)`; `setTargets(app, ids | null)` (ui-timeline.js; null = every track).
- Widgets: `el`, `icon`, `icons`, `button`, `slider`, `numberField`, `timecodeField`, `select`, `menu`, `dialog`,
  `row`, `confirm`. Helpers: `exec(app, cmd)` (runs `history.do`, shows the error, returns null on failure),
  `report`, `errorText`, `toast`, `notify`, `isTyping`, `typing` (set while a text layer is being edited), `fpsOf`,
  `formatDuration`, `formatBytes`, `basename`.

### Shell (`ui-shell.js`)

`Cut.ui.start(host, app)`, `workspaces`, `setWorkspace(id)`, `workspace` (getter), `showPanel(id)`,
`focusPanel(id)`, `mountedPanel(id)`. Workspaces: `editing`, `color`, `captions` (Captions and Graphics), `export`;
each is a fixed grid of rows and slots, a slot shows its panels as tabs, splitter sizes are kept, and the last one is
setting `cut.workspace`. Panels are mounted once and moved between workspaces.

`Cut.ui.lifecycle = { newProject, open, openPath, save, saveAs, askToSave, autosaveNow, offerRecovery, key, dirty,
lastAutosave, projectName }`. An untitled project at start; `cut:autosave` 2 s after edits stop (only when dirty,
not inside a history group); `cut:sessionStart/End` per key (Save As from untitled ends `untitled-<id>` and starts the
path); the recovery offer from `cut:recovery`, with `cut:recoveryDismiss` for what the user declines. The unsaved
project's close question uses a `beforeunload` guard (Electron honours it only after a user gesture); a running
export joins the IDE's close question through `window:setBusy`.

### Project panel (`ui-project.js`)

`Cut.ui.media = { importDialog, importFolder, importFolderPath, importPaths(app, paths, {binId, bins}),
importDropped, checkOffline, relinkDialog, relinkTo, offline, matchSequence(app, mediaId), describe, probeFile,
newSequenceDialog }`, `Cut.ui.offline` (the Set of offline media ids). `matchSequence` uses `Media.video.w/h` as they
are (already upright).

### Monitors (`ui-monitors.js`)

`Cut.ui.monitors = { source, program }`, each `{ el, view, canvas, player, app, seek, pause, run, fullscreen, ... }`;
`program.showTrim({left, right} | null)` shows the frames on either side of an edit point (the timeline calls it
during edge trims). The program monitor draws through `Cut.player` with the audio engine; the source monitor plays the
media through a `Cut.state` app of its own (a one-clip project at the media's size and rate, the player in program
mode). `app.source = {mediaId, in, out, t}` with In/Out in source ticks; Out is the exclusive end (playhead + 1
frame), like the sequence Out. Monitor buttons: safe margins (`overlays: ['safe']`), playback quality
(`setQuality`), Proxy (`setProxy`, setting `cut.proxy`), dropped-frame count, full screen.

### Export, captions, keys

- `Cut.ui.exportDialog = { open(app), exportFrame(app), form(app), chaptersText, running }`. It calls
  `Cut.export.run({ project, seqId, path, preset, overrides, settings: presets.resolve(...), range, captions, signal,
  onProgress })`, offers `Cut.presets.AUDIO_BITRATES` (default 192 kbps), measures loudness with
  `Cut.audioengine.measure`, passes `chapters(seq, {firstName: tr('Intro')})`, and shows `verified.problems` through
  `tr(message, params)`.
- `Cut.ui.captions = { importFile, exportFile, importDialog, exportDialog, styleDialog, trackOf }`.
- `Cut.ui.keys = { kHeld, actions, title }`. `ui-keys.js` holds the key map (features §18 [1]) as IDE actions
  `Cut.<id>` and sends each to the focused panel; keys never act while typing in a field or a text layer. Ctrl+X is
  `cut`; `pasteInsert` has a handler and no key.

### Timeline (`ui-timeline.js`) and its panels

- `Cut.ui.edit` (used by ui-controls, ui-effects, ui-text, ui-color, ui-overlay): `primaryClip(app)`, `clipTime(app,
  clip, t)`, `inClip`, `defaultOf(clip, path)`, `valueAt(app, clip, path, t)`, `keyframed`, `setStatic`, `write(app,
  clip, path, value, {t})` (a keyframe when the path is keyframed), `setKeyframing(app, clip, path, on)`,
  `toggleKeyframe`, `jumpKeyframe(app, clip, paths, dir)`, `gesture(app, label) -> {begin, end}` (one undo step per
  drag), `addText(app, {at, text, position, track}) -> clipId`.
- `Cut.ui.timeline` (a proxy to the mounted timeline; calls are null-safe): `split({allTracks})`,
  `rippleTrim('before' | 'after')`, `deleteSelection({ripple})`, `toggleEnabled`, `toggleLink`, `copy`, `cut`,
  `paste({insert})`, `selectAll`, `deselect`, `freezeFrame`, `addTransitions({video, audio, type})`, `speedDialog`,
  `addMarker`, `editPoints`, `applyEffect(clipId, type)`, `placeItems`, `zoomIn`/`zoomOut`/`zoomFit`, `setZoom(pps,
  {t, x})`, `setScroll`, `toggleSnap`, `snap`, `selectTransition`, `selectedTransition`, `gap`, `view`, `stats`,
  `xOf`/`tOf`/`hit`/`rowOf`/`clientPoint`, `invalidate`, `cancelDrag`.
- Keys: Ctrl+K cuts the selected clips under the playhead (`{clipIds, linked: false}`), else the targeted tracks;
  Ctrl+Shift+K passes `{allTracks: true}`; Q/W, paste and Ctrl+D use the targeted tracks; Alt-drag and Alt-trim pass
  `{linked: false}`. Trims are live inside a history group (begin, cancel + begin + do on each move, commit on
  release).
- `Cut.ui.overlay = { attach(viewEl, app, player) -> {detach, editText, pickColor, sample, layout, geometry, editor},
  editText(clipId, {created}), pickColor() -> Promise<[r, g, b] | null>, pickColorAt(u, v), active }`. Text editing
  sets `Cut.ui.typing` while open and is one undo group per visit.
- The color panel's eyedropper sets temperature and tint to the current values plus
  `Cut.effects.whiteBalance(the linear color seen, with saturation and contrast undone)`.
- Settings keys: `cut.defaultVideoTransition`, `cut.defaultAudioTransition`, `cut.effectFavorites`,
  `cut.export.preset`, `cut.workspace`, `cut.layout.<workspace>` (splitter sizes), `cut.proxy`,
  `cut.source.quality`, `cut.program.quality`, `cut.cacheLimitGB` (main).

### App events from the panels

Besides those of state.js: `workspace` {id}, `lifecycle` {reason: 'new' | 'open' | 'save' | 'recover', path},
`autosaved` {file, time}, `offline` {ids}, `exported` (the run result), `patch`, `snapping`, `targets` {ids},
`transitionSelection` {id, open?} (with `app.selectedTransition`), `captionSelection` {track, id}, `trimPreview`
{clipId, edge, mode, t, active}, `scrub` {active}.

## 11. Strings and styles

- Korean strings are in `renderer/features/cut/locales/ko.json` (English source -> Korean). Korean UI follows the
  IDE's Korean (PyCharm / Premiere Korean terms where they exist: 타임라인, 시퀀스, 클립, 트랙, 효과 컨트롤, 키프레임,
  전환, 내보내기, 소스 모니터, 프로그램 모니터, 리플 편집, 롤 편집, 자르기 도구). Effect, parameter, choice, preset
  and category names, command labels and errors reach `tr()` as variables, so `verify/i18n-static.mjs` does not list
  them: add them to ko.json by hand.
- Styles: `css/shell.css` (shell), `css/timeline.css` (timeline), `css/panels.css` (panels, one block per area) and
  the tokens in `style.css`. Use the IDE's variables so dark and light themes work.

## 12. Tests

| File | Kind | Port | What it covers |
| --- | --- | --- | --- |
| `verify/cut-formats.mjs` | Node | - | Readers and writer: mp4write output read back table by table; handcrafted ctts v1, co64 past 4 GB, stz2, elst, fragments, QuickTime PCM, Matroska lacing and damage, MP3 Xing/VBRI, RF64; truncated copies come back as values; a two-hour table against a clock; the scripts loading next to Monaco's AMD `require` |
| `verify/cut-model.mjs` | Node | - | Every command against the expected timeline, exact undo/redo; 2,000 random commands; sync lock, links, trim clamps, snapping; keyframe values; history grouping, dirty, limit; SRT/VTT with CP949 and UTF-16; migrate |
| `verify/cut-main.mjs` | Node | - | Every `cut:*` channel with Electron stubbed: read ranges and limits, UNC/`\\?\UNC`/`\\.\` paths, links to network paths, junctions, 8.3 names, streams; atomic project writes and .bak; autosave rotation, sessions, recovery; the sink; faststart; cache LRU; findMedia/listMedia; real fonts |
| `verify/cut-engine-core.mjs` | Node | - | Effect registry and CPU references, transitions, crossfade, the compositor's plan, fit scales, motion presets, the reader's block cache, audio assembly, peaks, dropped-frame count |
| `verify/cut-export-core.mjs` | Node | - | Presets (levels, bitrates, estimates), resampler and WSOLA, BS.1770-4 loudness and true peak, normalize and match gains, the mixer, testsrc frame numbers, export's pure parts (frame plan, chapters, captions in a range, SRT names) |
| `verify/cut-engine.mjs` | app | 9753 | Frame accuracy at 24/29.97/30/60 fps, speed and reverse; transforms and keyframes from pixels; every effect against its CPU reference; transitions; Korean text; captions; offline media; import errors; audio decode; thumbnails and peaks; 10 s 1080p30 playback with seeks and no leaked VideoFrame; the 2D fallback |
| `verify/cut-export.mjs` | app | 9754 | Test sources decode frame-exact; exported sequences re-decode with the right frames (PSNR >= 35 dB), beeps on flashes, pitch kept; hardware, software, HEVC and 2D back end; playback in `<video>`; range, captions, cancel, export frame, chapters; loudness; preview clock and meters; export speed |
| `verify/cut-shell.mjs` | app | 9755 | The frame with real mouse and keys: lifecycle, autosave, recovery, close question, import, bins, offline and relink, monitors, export dialog, captions, keys; dialogs answered through `PYIDE_CUT_DIALOG` |
| `verify/cut-timeline.mjs` | app | 9756 | Timeline gestures and keys checked in the model and undone; drops; effect controls and keyframes; effects panel; color panel and eyedropper; overlay handles and Korean IME text; 500 clips; screenshots (`CUT_TL_ONLY` picks parts) |
| `verify/app-mode.mjs` | app | 9758 (cut block) | `--mode=cut` opens the Cut window, workspace and trust, only Cut's plugins, `__cutReady`, no renderer exceptions |

- Node suites: `node verify/cut-<name>.mjs`, printing `N/M passed` and `FAIL <what>` lines.
- App suites launch with `launch({ fixture: 'core', port, name, mode: 'cut', env: { PYIDE_CUT_HOME: <a temp dir> } })`
  from `verify/lib.mjs`, wait for `window.__cutReady === true`, and check that `Cut[name]` exists for every module
  they use. Run them one at a time through `powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1
  -Out verify/out/<name>.log -TimeoutMinutes 20 node verify/<name>.mjs`.
- Test env: `PYIDE_CUT_HOME` (the workspace), `PYIDE_CUT_DIALOG` (dialog answers), `PYIDE_CUT_FONT_DIRS` (font
  folders). Media comes from `Cut.testsrc` or bytes the test builds: no downloads, no copyrighted media.
