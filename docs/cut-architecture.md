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
                                        analyze speech ai                                  automation (signals, speech, Claude)
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
`inout`, `focus`, `history` (the list of undo steps changed)). `app.on(event, fn)` returns a remover; `app.emit` is used by the panels for their own events
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
         role: null | 'dialogue' | 'music' | 'effects' | 'ambience',   // what its sound is (automation)
         props: { position: [x, y] /* px from center */, scale: [sx, sy] /* % */, rotation /* deg */, anchor: [x, y], opacity /* % */,
                  crop: [top, right, bottom, left] /* % */ }  |  { volume /* dB */, pan }   // video | audio clip
         keyframes: { [path]: [Keyframe] },
         effects: [Effect], fadeIn: 0, fadeOut: 0 /* ticks, audio */, markers?: [Marker] /* t from the clip start */ }
Effect = { id, type, on: true, params: {} }   // params only where they differ from the registry's defaults
Keyframe = { t /* from clip start */, v /* number or array */, ease: 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bezier', h?: [x1, y1, x2, y2] }
Transition = { id, track, at /* edit point ticks */, type, duration, align: 'center' | 'start' | 'end', params: {} }
Marker = { id, t, duration: 0, name, note, kind: 'comment' | 'chapter' | 'beat', color }
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

Exports: `VERSION`, `QUANTUM`, `EASES`, `GENERATORS`, `VIDEO_PROPS`, `AUDIO_PROPS`, `MARKER_KINDS`, `ROLES`, `ALIGNS`; `clone`,
`newId`, `defaultSettings`, `createProject(opts)`, `createSequence(opts)` (default tracks V1, V2, A1, A2),
`createTrack`, `createClip`, `createTextLayer`, `defaultCaptionStyle`, `videoProps`, `audioProps`;
`validate(project) -> { ok, errors: [string] }` (shapes, ids unique, references resolve, no overlapping clips on a
track, times frame-aligned to the sequence), `validPropPath(clip, kind, path)`, `validFps(fps)`,
`migrate(json) -> project` (fills missing fields with defaults, snaps keyframe, marker and caption times to frames;
throws `code: 'notProject'` or `'newer'`; a missing or unknown clip `role` becomes null); `clipDuration`, `clipEnd`, `sequenceDuration(seq)`,
`clipsAt(seq, t, {kind})` (enabled clips under t, V1 first), `sourceTime(clip, t)` (the source time a timeline time
shows: speed, reverse and freeze included), `trackIndex(seq, id)` (the index among tracks of the same kind: V1 = 0,
A1 = 0), `trackOf`, `linkedClips(seq, clip)`, `mediaOf(project, clip)`, `isGenerator`, `isStill`.

Engine and export map timeline time to source time only with `sourceTime(clip, t)`.

### `Cut.keyframes`

`valueAt(keyframes, t, fallback)` (numbers and arrays; hold, linear, eased, cubic bezier by handles; before the first
keyframe the first value, after the last the last), `propValue(clip, path, t, fallback)` (`t` in clip time, reads
`clip.keyframes[path]` or the static value), `staticValue`, `insert(keyframes, kf)`, `remove(keyframes, t)`,
`next(keyframes, t)`, `prev(keyframes, t)`, `bezier`, `eased`, `mix`, `handles(keyframe | ease)` (the bezier handles that
draw a segment as it is now: the preset's for the eases, `[1/3, 1/3, 2/3, 2/3]` for linear, its own for bezier, null for
hold; turning a keyframe into bezier with them keeps its values), `DEFAULT_HANDLES`.

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
  `position` is how many are done; `goTo(position)` undoes or redoes until that many are done, in one go with one
  change event (an open group is committed first) -> true when it moved (the history panel).
- `onChange(fn)` (fn(reason) with 'do' | 'undo' | 'redo' | 'commit'; 'commit' when a group became a step: the list
  changed, the project did not; returns a remover), `dispose()`, `serialize()` -> JSON text.

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
- moving: `move(seqId, clipIds, { delta, trackDelta, insert, linked, nudge })`; `trackDelta` is a number or
  `{video, audio}`; the group members of the clips move too unless `linked: false`; `nudge: true` only names the step
  "Nudge" (Alt+Left/Right)
- trimming: `trim(seqId, clipId, { edge: 'start' | 'end', delta, mode: 'normal' | 'ripple' | 'roll', linked })`
  -> `{ applied, clamped: 'source' | 'neighbour' | 'length' | null }` (`'length'`: the clip would get shorter than
  one frame)
- edit tools (each -> `{ applied, clamped }`, `applied` in whole frames):
  `slip(seqId, clipId, { delta, linked })` (in and out move by `delta` timeline frames times the speed, later source
  for a positive delta; place and length kept; linked clips too; `'source'` at the source ends; a still is refused
  with `still`), `slide(seqId, clipId, { delta, linked })` (the clip moves with its content; the clip that ends at its
  start and the one that starts at its end trim those ends, so the track's length stays; with no clip touching a side
  it slides into the gap up to the next clip, `'neighbour'`; `'length'` when a neighbour would get shorter than a
  frame, `'source'` when one has no source left; linked clips of the same span slide along),
  `stretch(seqId, clipId, { edge, delta, linked })` (rate stretch: the edge moves and the speed becomes
  `(out - in) / new length`, in and out kept, keyframes stay on their source frames; `'neighbour'`, `'length'`,
  `'speed'` at 1% and 10000%; a still is trimmed instead; -> also `{speed}`),
  `extendEdit(seqId, t, { clipIds, trackIds, linked })` (the edit point nearest t, not at t, among the edges of
  `clipIds`, else of the clips on `trackIds` (null: every unlocked track), moves to t: a roll where a clip touches it
  on the other side, else a trim of that end; one clip per track there, the one ending there first; `noEdit` when
  there is none; -> `{at, applied, clamped}`)
- cutting: `split(seqId, t, { clipIds, trackIds, allTracks, linked })` (no option: every unlocked track),
  `remove(seqId, clipIds, { ripple, linked })`, `rippleToPlayhead(seqId, t, 'before' | 'after', { trackIds })` (Q and
  W), `closeGap(seqId, trackId, t)`, `lift(seqId, in, out, trackIds | null)`, `extract(seqId, in, out, trackIds | null)`
- clip settings: `setClip(seqId, clipId, patch, { linked })` (props, speed or duration (the speed that fits the
  source; not both), ripple, reverse, enabled, name, label, role, fadeIn, fadeOut), `setKeyframes(seqId, clipId, path,
  keyframes | null)`, `link(seqId, ids)`, `unlink(seqId, ids)`, `setRole(seqId, clipIds, role, { linked })` (linked
  clips too unless `linked: false`; refused on a locked track), `group(seqId, ids)` (two or more clips get one new
  `clip.group` id `G<n>`, else `groupOne`; -> `{group}`), `ungroup(seqId, ids)` (every member of their groups;
  -> `{groups}`)
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
- several as one: `batch(label, [commands])` runs them in order on one recording, so it is one undo step with that
  label (the automation's labels are part of `LABELS`); a part that fails takes back the others; the project is
  validated once, at the end; a batch inside a batch is refused. -> `{ results: [each result] }`

Results of `history.do`: `{ids}` for place, paste and split; `{id}` for the add commands; `{applied, clamped}` for
trim; `{range}` for Q/W, gaps, lift and extract.

Editing rules every command follows (the commands.js header has them too):
- Times are snapped to the sequence's frames: absolute times to the start of their frame, lengths and deltas to the
  nearest whole frame. Snapping to clip edges is the timeline's job, before it builds the command.
- Linked clips move, trim, split, change speed and are removed together, unless the command says `linked: false`
  (Alt in the timeline). Grouped clips (the same `group`) are moved and removed together (with what they link to),
  and nothing else; paste and duplicating a sequence give copied members a new group.
- A ripple (insert, ripple delete, ripple trim, extract, Q/W, speed with ripple) applies the same time change to the
  targeted tracks and every sync-locked track: time inserted at p splits what crosses p and pushes the rest; a range
  removed on a sync-locked track takes what is in it and pulls the rest. Locked tracks never change. Caption tracks
  with `syncLock` do the same. Sequence markers follow only when every unlocked track does. `closeGap` refuses
  (`gapBlocked`) when a sync-locked track or caption track has content in the gap.
- Transitions follow the clip edge a command moves. One left off every clip edge, or a second one at the same point,
  is removed. A link or a group left with one clip is cleared.

Errors a person can cause throw an Error whose message is a fixed English sentence (shown with `tr(err.message)`)
and `err.code`, sometimes `err.detail`: `locked`, `noTrack`, `noTarget`, `tooShort`, `noRange`, `noGap`,
`gapBlocked`, `noEdge`, `noFrame`, `noRoom`, `notOnClip`, `overlap`, `linkOne`, `groupOne`, `noEdit`, `still`,
`speed`, `gain`, `fps`, `size`,
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
`runs.js` (which run wrote a marker), `whisper.js` and `speech-words.js` (speech recognition, below), `ai.js` (text AI
through Claude Code, below). Tests: `verify/cut-main.mjs` (plain Node with Electron stubbed); `verify/cut-speech.mjs`
for the speech recognition side; `verify/cut-ai-core.mjs` for the text AI side.

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
- `cut:autosave(key, text, {latest, keep})` (key: the project path, or `untitled-<id>`) -> `{ ok, file }`: a copy
  `<autosave>\<name>-<hash>-<stamp>.ncut`, the newest `keep` (1 to 100, default 20) copies kept per key, or with
  `latest: true` the latest state `<stamp>.latest.ncut`, only the newest kept; neither kind pushes out the other. `cut:sessionStart(key)` (also clears an
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
- Speech recognition (`main/cut/whisper.js`, `createSpeech({ script, tmpDir, log, env })`): Whisper through
  transformers on the CPU, in the sidecar `main/ai/whisper_server.py` inside the shared AI environment of
  `main/ai/runtime.js` (`~\.pyide\semantic\venv`, its JSON-lines client, idle unload after
  `ai.idleUnloadMinutes`, default 10). Cut mode loads no installer or ai-* plugin, so its setup is here.
  - `cut:speechStatus()` -> `{ backend: 'whisper' | 'fake', runtime, runtimeBytes, models: [{ id, name, repo, bytes,
    installed }], engine: { state: 'idle' | 'loading' | 'ready', model }, stats: { setups, windows, cancelled } }`.
    Models: `whisper-small` (`openai/whisper-small`, the default) and `whisper-large-v3-turbo`; installed means
    `model.safetensors`, `preprocessor_config.json` and `tokenizer.json` are in the Hugging Face cache. The runtime
    is ready when the environment imports torch 2.6 or later (its own or the interpreter's, read from dist-info),
    transformers, numpy and huggingface_hub (`runtime.importable`, `runtime.torchOnDisk`).
  - `cut:speechSetup({ model })` -> `{ ok }` | `{ ok: false, code, error, log? }`, called only after the person pressed
    Download: the free space first (code `disk`), `runtime.ensureVenv(..., { torch: true })`, torch when missing, the
    missing packages, then `snapshot_download(repo, allow_patterns=['*.json', '*.txt', 'model.safetensors'])`.
    Progress goes to the asking window as `cut:speechProgress` `{ model, phase: 'runtime' | 'download' | 'done',
    fraction (download: the repo's blobs over the model's size), text (the last log line) }`. Codes: `noPython`,
    `noTorch`, `disk`, `offline`, `busy`, `cancelled`, `failed` (`classify(text)` reads the error and the log's end).
    `cut:speechCancelSetup()`.
  - Sound: `cut:speechOpen()` -> `{ id }` (a temp file `%TEMP%\nano-studio-speech\<pid>-<id>.f32`),
    `cut:speechWrite(id, bytes)` (float32 LE, 16 kHz mono, appended; 16 MB a call, 2 GB a file), `cut:speechClose(id)`
    (deletes it). Files belong to their window and go with it; files of a process that is gone are removed at start.
  - `cut:speechTranscribe(id, { offset, length /* samples, at most 31 s */, language: 'auto' | 'ko' | 'en', model,
    request })` -> `{ words: [[t0, t1, text]] /* seconds from offset */, language, ms }` | `{ cancelled: true }` |
    `{ error, code: 'notInstalled' | 'model' | ... }`; `cut:speechCancel(request)` (seen between generated tokens).
    The sidecar loads the model from the cache only (`HF_HUB_OFFLINE=1`), writes no words for a window quieter than
    -50 dBFS (Whisper writes text into silence), detects the language with one encoder pass for `auto`, and reads
    each of Whisper's segments with its own token times (the joined sequence restarts the times of a segment begun
    anew at the window's end). `speech-words.refine(samples, words)` then narrows each word to its sound: the span is
    split into runs at quiet gaps of 0.25 s; a segment's first word is its last run (Whisper starts it before the
    pause ahead, at a window's start even over speech it did not write out), any other word its longest run.
  - `cut:speechConfigure({ idleMinutes })`, `cut:speechTestConfig({ delay, load, unload })` (fake only: the time per
    window, the time the next model load takes, and the model unloaded as after idle; the fake reports `loading` and
    `ready` like the sidecar).
  - `PYIDE_WHISPER_BACKEND=fake`: no Python; `speech-words.fakeWords` gives one word per burst of sound above -35 dBFS
    (testsrc beeps, tone stretches), its text from `FAKE_WORDS` by the burst's half second in the file.
    `PYIDE_WHISPER_FAKE_SETUP=ok | offline | disk | noPython`: the runtime and the models start missing and the setup
    pretends to download (progress in ten steps), then succeeds or fails with that code.
- Text AI (`main/cut/ai.js`, `createAi({ log, complete, find, timeoutMs = 180 s })`): one Claude request per call through
  `main/ai/claude.js` (`complete({ system, prompt, model, signal, onText })`: the Claude Code CLI, no tools, no session,
  an empty working folder). Cut mode does not load the ai-* plugins, so the channels are here. The renderer builds the
  prompt from text only (`Cut.ai`); main reads no file for it.
  - `cut:aiStatus()` -> `{ installed /* findClaude() found the CLI */, stats: { requests, cancelled, running } }`.
  - `cut:aiComplete({ request /* [\w.-]{1,64} */, task, system /* <= 20,000 chars */, prompt /* <= 200,000 */, model:
    'haiku' | 'sonnet' | 'opus' })` -> `{ ok: true, text, ms }` | `{ ok: false, code: 'not-installed' | 'auth' | 'cli' |
    'cancelled' | 'timeout' | 'badArgs', error }`, never a throw. While the answer streams, the asking window gets
    `cut:aiProgress` `{ request, chars }` at most every 100 ms. A request id runs once at a time per window.
  - `cut:aiCancel(request)` aborts it (the CLI's process tree is killed); a window that goes aborts its requests.
  - `PYIDE_CLAUDE_PATH` points at another CLI (tests: `verify/fake-claude-cut.mjs` through a `claude.cmd`); `none`
    behaves as if Claude Code were not installed.

## 8. Engine

Files: `effects.js`, `textrender.js`, `media.js`, `decoder.js`, `compositor.js`, `player.js`, `thumbs.js`. Tests:
`verify/cut-engine-core.mjs` (Node) and `verify/cut-engine.mjs` (app, port 9753).

### `Cut.effects`

The registry: `list()`, `get(type)`, `defaults(type)`, `resolve(type, params)`, `transitions()`,
`defaultTransition(kind)`, `categories(kind)`, `whiteBalance(linearRgb) -> {temperature, tint}`, `srgbToLinear`,
`linearToSrgb`, `hexToLinear`, `LUMA`, and `wgsl`/`cpu` helpers for the compositor and the tests (`cpu.basicPlan(params)`
-> the color.basic gains and settings, `cpu.basicPixel(linearRgb, plan)`; Cut.analyze's auto color uses them, so the
color math stays here).

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
`drawCaptions(ctx, items, style, {w, h, scale})` (the style's `size` is in pixels of a picture whose shorter side is
`style.ref`, 1080; it is drawn at `size * min(w, h) / ref` sequence pixels; `model.migrate` converts a size saved
without `ref` other than the default 54 by `1080 / min(w, h)`), `measure(layer, ctx?) -> {lines, width, height, lineHeight, box}`,
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
  audio (track), image, width, height, rotation, duration, error, mediaId, media, proxy }`, cached per path. With
  `proxy` and a media `proxy.path`, the proxy file is checked at most every 2 s (`cut:stat`) and opened; when it is
  gone or cannot be opened the original is returned (`proxy: false`) and `proxyMissing(path)` is true until it is back
  (the app's `proxies` event tells the panels). The compositor also falls back when a proxy's frames cannot be read.
  `openPath(path)`, `forget(path)` (after a relink or a replaced file).
- `videoConfig(track, hardware)` (passes the track's `colorSpace`, since WebCodecs ignores the container's colr),
  `audioConfig`, `usable`, `shownSize`.

### `Cut.decoder`

`createFrameSource(opened, track, { hardware, cacheFrames, cacheBytes })` -> `{ frameAt(sourceTicks) ->
Promise<VideoFrame>, sampleAt(t), prefetch(fromTicks, toTicks), release(frame), close(), hardware, stats() }`.
Frames returned are clones the caller owns until `release(frame)`. One VideoDecoder per source, fed in decode order
from `keyBefore`; chunks carry the sample's presentation rank as timestamp, so an output maps back to its sample.
Decoded frames stay in a cache limited by count (8 for a hardware decoder, 48 for a software one: the decoder in use
decides) and bytes (384 MB a source, and the shared budget), evicting those farthest from the playhead, behind it
first; prefetch counts the frames still inside the decoder, feeds one at a time and stops at what the cache holds by
the tightest of the three limits (`stats().capacity`: 31 frames of 4K, not 48), since a frame decoded ahead and evicted
before it is shown restarts the run at a sync sample. Up to 1920x1088 configs are tried in order prefer-software,
prefer-hardware, no-preference, and above that hardware first (`hardware: false` skips hardware): a hardware decoder
holds back about twenty B-frame-reordered frames from a pool of about ten, which an 8-frame cache cannot ride. A seek
the run cannot reach restarts at `keyBefore`; a `frameAt` outside the prefetch window drops that window, so a playhead
moved while paused does not pull the decoder back to where it was. Every VideoFrame is counted and closed exactly once.

`decoder.stats()` -> `{ open, sources, decoders, cacheBytes, live, budget }`; `decoder.setBudget(bytes)` sets the
memory all frame caches share (default 1.5 GB; WebGPU does not report VRAM). `decodeAudio(opened, track)` ->
`Promise<{ rate, channels, data: [Float32Array] }>`: the whole track from source time 0 at the decoder's output rate
(the decodeAudioData fallback is 48 kHz), kept in an LRU of 1.5 GB. `audioReader(opened, track)` ->
`Promise<{ rate, channels, length, read(from, to) -> Promise<[Float32Array]> }>` reads a part of the track at the
decoder's output rate, decoding 12 packets before it and dropping them (AAC overlap, MP3 bit reservoir); raw PCM reads
its bytes, and a format AudioDecoder does not take is decoded whole once and sliced. The mixer and the waveform read
through it, so a long file is never all in memory. `keyFrames(opened, track, indices, draw)` decodes sync samples one
at a time, each flushed out alone, for thumbnails. Also `assemble`, `forgetAudio`.

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
dropped, setProxy(on), ready /* Promise of the compositor */, compositor, audio /* the audio engine given */, render(), frameRect() /* the frame in CSS
pixels */, stats() /* {shown, dropped, fps, renderMs, renderMaxMs} */, on(fn) /* frame, play, pause, error */,
destroy() }`. It renders `app.t` whenever the time, the project or the sequence changes; while playing it follows the
audio clock (only at rate 1 in program mode; one that stands still 2.5 s gives way to the wall clock) or
`performance.now()`, moves `app.setTime` with the clock even while a slow frame is still drawing, prefetches ahead,
counts dropped frames and pauses `Cut.thumbs`. `RATES` are the J/K/L shuttle rates (-8..8). Source mode reads and writes
`app.source.t`.

### `Cut.thumbs`

`strip(project, mediaId, { from, to, count, height }) -> Promise<[ImageBitmap]>` (shared bitmaps: callers must not
close them), `peaks(project, mediaId, { samplesPerPeak })` -> min/max pairs at the track's own sample rate, all
channels together; both cached through `cut:cacheGet/Put`. A strip whose thumbnails are further apart than twice the
distance to their sync sample shows that sync sample (one decoded frame each, through `decoder.keyFrames`); closer
ones show their exact frame. Peaks are computed about ten seconds at a time through `decoder.audioReader`, at 256
samples a peak; a multiple of that is merged from them (`coarsen(peaks, k)`), so the panel (512), the timeline (256)
and the monitor (1024) share one decode. Thumbnails and peaks run in two queues, so a long file's peaks never hold
back thumbnails. Also `computePeaks`, `pause(on)` (holds both, also between the exact frames of
a strip and the blocks of peaks already under way: the player pauses them while it plays), `paused`, `queued`.

## 9. Sound and export

Files: `presets.js`, `audioengine.js`, `export.js`, `testsrc.js`, and `analyze.js` (the automation's measurements).
Tests: `verify/cut-export-core.mjs` and `verify/cut-analyze.mjs` (Node), `verify/cut-export.mjs` (app, port 9754) and
`verify/cut-auto.mjs` (app, port 9757).

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
  meters() -> { master, masterChannels: [l, r], masterRms: [l, r], tracks: {id: dB} } /* dBFS of the block being heard
  (about 43 ms): peaks, RMS; -Infinity when silent */, setMasterGain(db), close(), playing, rate, masterGain, context,
  mixer }`. Rates 0.25 to 4 play forward like tape; other rates are silent while the clock runs. The Audio Meters
  panel (ui-meters.js) reads `meters()` of the program player's engine (`player.audio`). `mix()` also returns
  `rms: [l, r]` of the master.
- `renderOffline(project, seqId, from, to, rate = 48000, {masterGain, getAudio})` -> AudioBuffer (holds the whole
  mix: about 1.4 GB an hour). `measure(project, seqId, from, to, {rate, masterGain, onProgress, signal})` streams the
  mix through a meter and returns the loudness without keeping it.
- `loudness(buffer)` -> `{ integrated /* LUFS, BS.1770-4 gated */, truePeak /* dBTP */, samplePeak, momentaryMax,
  shortTermMax }`, `createMeter`, `normalizeGain(peaks, target = -1)` -> dB, `matchGain(measured, target, {ceiling =
  -1})` -> dB.
- `createMixer({ rate, getAudio })` -> `{ rate, load(project, seqId, from, to), mix(project, seqId, s0, n, {masterGain}),
  mixLoaded(...) /* mix once the samples and 15 s after them are read */, sources, forget() }`. A source's sound is
  kept in 10 s blocks at the mixer's rate: one block of all of it when `getAudio` gives the whole track
  (`{rate, data}`), else read on demand from the reader it gives (`{rate, length, read}`, the default) with at most
  48 blocks kept, least recently used dropped. Blocks are resampled from windows aligned to an output sample with the
  filter's reach on both sides, so they join without a seam. `load` reads at most 120 s of its range; `mix` counts a
  clip whose blocks are not read yet as `missing` and asks for them. The preview reads 15 s ahead of what it
  schedules; the export, `measure` and `renderOffline` go through `mixLoaded`.
- Also `transitionRange`, `resample`, `stretch`, `kFilters`, `dbToGain`, `gainToDb`, `makeBuffer`,
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
`toneLevel`, `toneGaps` (`[[from, to]]` seconds of silence in the tone), `background` (`#rrggbb`), `scenes` (seconds where
the background cuts to the next of `SCENE_COLORS`), `audio: false`. Also `frameAtTime`, `paintBlocks`, `blockLayout`,
`drawFrame`, `backgroundAt`, `soundOf`, `memorySink`, `CELLS`, `BITS`, `SCENE_COLORS`.

### `Cut.analyze`

Signal analysis for the automation (`analyze.js`, pure; tests `verify/cut-analyze.mjs`). Seconds for what it measures,
ticks for timeline ranges; ranges are `[a, b]` pairs.

- Ranges: `union(list)`, `subtract(spans, cuts)`, `intersect(a, b)`, `total(list)`. Clips: `sourceSpan(clip)` ->
  `[lo, hi]` source ticks, `toTimeline(clip, src)` (the inverse of `model.sourceTime`; speed and reverse; null for a
  freeze frame), `rangesToTimeline(clip, ranges)`.
- Levels: `levelMeter(rate, windowSec = 0.01)` -> `{ push(planes), levels() /* Float32Array dBFS */, step, size }`
  (RMS of the louder channel per window; streamed in any block sizes; digital silence is `QUIET`, -200),
  `levels(planes, rate, windowSec)`, `loudRanges(levels, step, threshold)` -> seconds,
  `silenceRanges(spans, loud, { minLength, margin, frame })` (what of `spans` `loud` misses, at least `minLength`,
  less `margin` at both ends, inside whole frames), `speechRanges(spans, loud, { hold })` (spans less silences of `hold`
  or more).
- Onsets and beats: `createFft(n)`, `createFlux(rate, { size = 1024, hop = 512 })` -> `{ push(mono), envelope(),
  timeOf(i), hopSeconds }` (Hann window, log magnitude, summed rises), `mono(planes)`, `onsetStrength(env,
  hopSeconds)`, `tempo(strength, hopSeconds, { min = 60, max = 200 })` -> `{ bpm, period, confidence }`
  (autocorrelation weighted toward 120 BPM), `trackBeats(strength, period, { tightness = 100 })` (dynamic
  programming, Ellis 2007), `barPhase(strength, beats, per = 4)`, `beats(flux, env)` -> `{ bpm /* slope of the beats */,
  beats: [seconds], phase, confidence }`.
- Pictures: `histogram(rgba, w, h, bins = 8)` (joint RGB, sums to 1), `histDistance(a, b)` (half L1, 0..1),
  `detectScenes(r0, r1, histAt(rank) -> Promise<histogram>, { threshold = 0.35, step = 2, onProgress, signal })` ->
  ranks of the first frames of new scenes (every `step`-th frame compared, a hit narrowed to its first frame, a
  picture that returns `step` frames later is a flash, not a cut, and one still far from the hit `step` frames later
  is a fade or a dissolve, so a fade gives at most one cut, where it settles; `code: 'cancelled'` when the signal
  aborts).
- `autoColor([{ rgba, w, h }])` -> `{ temperature, tint, exposure }` for color.basic: the average linear colour of the
  pixels that are neither clipped nor black through `Cut.effects.whiteBalance`, then the exposure that brings the
  log-average luminance (through `cpu.basicPlan`'s gains) to 0.18, no higher than keeps the 99th percentile at 1 and
  no lower than keeps it at 0.8 (a light, high-key picture stays light).
  Temperature and tint reach one stop each way (their range is -100..100), so a stronger cast is only partly undone.
- `duckKeyframes({ duration, speech /* clip time */, amount = -12, fade, frame })` -> keyframes for the clip's `duck`
  curve that dip by `amount` dB during speech with linear `fade` ramps (dips whose ramps meet are joined). `duck` is a
  keyframes-only path of audio clips (`model.validPropPath`) whose dB the mixer adds to the volume, so the volume
  keyframes stay the user's and Auto Ducking run again replaces its dips.

### `Cut.speech`

What is done with speech recognition's words (`speech.js`, pure; tests `verify/cut-speech.mjs`). Words are
`{ t0, t1, text }` (seconds per media file; ticks on the timeline, with `clip`).

- Windows: `windows(total, { size = 30 s, overlap = 5 s })` -> `[[from, to]]` samples; `mergeWindows(results /* [{ from,
  to, words: [[t0, t1, text]] }] */, { edge = 1.5 })` -> words in seconds: a window's words count up to `edge` seconds
  before its end (the last window's all), the next window's from the last one counted on; `dedupe(words)` drops a word
  heard twice (the same text within 0.5 s, or overlapping by half).
- Timeline: `clipWords(clip, words)` (the words whose middle the clip shows, through `analyze.toTimeline`: in, speed,
  reverse; none for a freeze frame), `joinClips(lists)` (a word two overlapping clips hold kept once), `wordAt(words, t)`.
- Captions: `captions(words, { maxChars /* 0: 18 for Korean text, else 42 */, maxLines = 2, maxDuration = 6, pause = 0.6,
  linger = 0.3, minDuration = 0.8, frame })` -> `[{ start, end, text /* lines joined with \n */ }]`: a new caption at a
  pause, past 6 s, when the words no longer fit, or after a sentence end (.?! or a Korean -다/-요/-죠/-까 before half a
  pause) once it holds half a line; `layout(texts, maxChars, maxLines)` -> balanced lines (the longest as short as it
  can be) or null.
- Fillers: `isFiller(words, i, { pause })` (Korean 음, 어, 으음, 흠 always; 그, 저, 뭐 before a pause of `pause`, a
  trailing comma or ellipsis, or the same word again; English um, uh, er, erm, ah, hmm, mm; never like),
  `fillerPlan(words, { fillers, pauses, pauseLength = 1, keep = 0.15, ext = 0.25, hesitation = 0.3, frame })` ->
  `{ fillers: [index], pauses, ranges }` (ticks on frames), `wordRange(words, i, j, { ext, keep })`,
  `removalRanges(words, indexes, { ext = 0.25, keep = 0.08, frame })` (the transcript's delete), `runs(indexes)`,
  `search(words, query)` -> `[[i, j]]`, `normalize(text)`, `isKorean(text)`.
  `layout(texts, maxChars, maxLines, sep = ' ')`: `sep` '' lays out Japanese and Chinese, whose units are characters.

### `Cut.ai`

What Cut sends to Claude and what it does with the answers (`ai.js`, pure; tests `verify/cut-ai-core.mjs`). Prompts
carry text only: transcript or caption text with times in seconds, clip, track and marker names. Each builder returns
`{ system, prompt }`; the prompt's first line is `Task: <name>`.

- Answers: `parseJson(text)` -> `{ value }` | `{ error }` (the first fenced block that parses, else the whole text,
  else from the first `{`/`[` to the last matching bracket, inside or outside the fences); `retryPrompt(prompt, answer,
  error)` (the request again with the reason and the refused answer: the one retry).
- Transcripts: `segmentsFromWords(words, { frame })` (sentence-sized segments through `Cut.speech.captions`, one line of
  120 characters, 12 s, pauses of 0.8 s), `segmentsFromCaptions(items)`, `condense(segments, { budget = 30,000,
  lineMax = 200 })` -> `{ text /* "[start-end] text" lines */, trimmed, lines, kept }`: over the budget each line is cut
  to `lineMax`, then evenly spaced lines are kept (the first and the last always), the same every time.
- Captions: `polishPrompt(lines /* [{ i, text }] */, { lang })`, `translatePrompt(lines, { from, to })`,
  `validateLines(value, lines)` -> `{ value: Map(i -> text) }` (every caption once, none empty or far longer),
  `chunks(list, 60)`, `lineBreak(text, lang)` (the caption rules: two balanced lines of 18 characters for ko, 16 for ja
  and zh without spaces and with closing marks kept on their line, 42 otherwise; longer text wraps on),
  `keepLines(before, after, lang)` (a polished caption keeps its breaks when it still fits them), `diffChars(a, b)` ->
  `[{ op: '=' | '-' | '+', s }]`. `LANGS` = ko, en, ja, zh, es.
- YouTube: `metadataPrompt({ name, duration, transcript, markers })`, `validateMetadata(value, { duration, intro })` ->
  `{ value: { titles /* 1-5, <= 100 chars */, description /* <= 5,000 */, chapters, tags, fixed /* English notes */ } }`;
  `fixChapters(list, seconds, { intro })` (whole seconds, inside the video, sorted, the first at 0:00 (moved there when
  under 10 s, else an intro added), each at least 10 s long including the last; fewer than 3 is an error when the video
  is 30 s or longer, none under 30 s), `cleanTags(list)` (no #, commas or duplicates, 500 characters in all),
  `chapterText(chapters)` ("0:00 Title" lines), `clock(seconds)` (0:00, 1:02:03), `clockFine(seconds)` (0:10.0).
- Highlights: `highlightsPrompt({ duration, transcript, count, min, max })`, `validateHighlights(value, { duration,
  count, min, max, frame })` -> ranges `{ start, end, title, reason }` on frames by start (inside the sequence within
  0.5 s, lengths within 0.5 s of min-max, no overlap, at most `count`); `complement(keep, duration)` (the ranges a shorts
  copy extracts, latest first); `shortsEdits(project, seq, { mode: 'fill' | 'fit' })` -> commands that multiply each
  video or image clip's scale by `fitScale(mode) / fitScale(project fit)` and centre it (position keyframes dropped).
- Edit commands: `OPS`, the whitelist: `cut {from, to}`, `lift {from, to}`, `split {at}`, `marker {at, name?, kind?:
  comment | chapter}`, `removeMarkers {kind: comment | chapter | beat | all}`, `clipVolume {clips: all | selected |
  dialogue | music | effects | ambience | [clip ids], db}`, `trackVolume {track, db}`, `masterGain {db}`,
  `removeSilence {longerThan, threshold?}` (seconds and dB; times on the timeline before the plan).
  `sequenceSummary(project, seq, { selection, maxClips = 150 })`, `commandPrompt({ request, summary, transcript })`,
  `validatePlan(value, { duration, tracks, clips, selection })` -> `{ value: { ops, message } }` | `{ error }`: an
  unknown operation or field (own properties only, so `constructor` or `__proto__` never pass), a missing field, a
  string for a number, a time outside the sequence (a hair past the end is clamped), an empty range, a gain beyond
  40 dB, a track that is not an audio track, `selected` without a selection, a clip id that does not exist, more than
  200 operations. `describePlan(ops, { seq, selection, silence })` -> `[{ text /* English for tr() */, params }]`;
  `planCommands(ops, { seq, selection, silence /* [k]: { ranges, tracks } for ops[k] */ })` -> `Cut.commands`: gains
  (`setSequence`, `setTrack`, `setClip` and volume keyframes with `linked: false`, clamped to -60..24 dB), marker
  removals, new markers, `split`, `lift`, then every `extract` (cuts on every track, silences on their tracks) from the
  latest back, so all times stay those of the timeline before the plan. `volumeClips(seq, which, selection)`.

## 10. Screen

Files: `ui-base.js`, `ui-shell.js`, `ui-project.js`, `ui-monitors.js`, `ui-export.js`, `ui-captions.js`,
`ui-keys.js`, `ui-timeline.js`, `ui-controls.js`, `ui-effects.js`, `ui-text.js`, `ui-color.js`, `ui-overlay.js`, `ui-auto.js`,
`ui-history.js`, `ui-meters.js`, `ui-markers.js`, `ui-speech.js`, `ui-ai.js`, `ui-shortcuts.js`, `ui-settings.js`,
`ui-proxy.js`, `ui-queue.js`; styles `css/shell.css`, `css/timeline.css`, `css/panels.css`, `css/tools.css`,
`css/speech.css`, `css/ai.css`, plus `style.css` (tokens). Tests:
`verify/cut-shell.mjs` (app, port 9755), `verify/cut-timeline.mjs` (app, port 9756), `verify/cut-edit.mjs` (app, port 9759)
`verify/cut-panels.mjs` (app, port 9762), `verify/cut-tools.mjs` (app, port 9765), `verify/cut-whisper.mjs` (app,
port 9768) and `verify/cut-ai.mjs` (app, port 9779).

### Base (`ui-base.js`)

`Cut.ui`:
- `registerPanel(id, { title: () => string, mount(el, app) -> dispose | { dispose, focus } })`, `panels`. Panel ids:
  project, source, program, timeline, controls, effects, captions, text, color, export, history, meters, markers.
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
  `row`, `confirm`, `virtualList({rowHeight, cls, render(i) -> row}) -> {el, count, setCount, refresh, drawNow,
  scrollTo(i), indexAt(clientY), dispose}` (only the rows in view are in the DOM). Helpers: `exec(app, cmd)` (runs `history.do`, shows the error, returns null on failure),
  `report`, `errorText`, `toast`, `notify`, `isTyping`, `typing` (set while a text layer is being edited), `fpsOf`,
  `formatDuration`, `formatBytes`, `basename`.

### Shell (`ui-shell.js`)

`Cut.ui.start(host, app)`, `workspaces`, `setWorkspace(id)`, `workspace` (getter), `showPanel(id)` (switches to the
first workspace that has it when this one does not), `openPanel(id)` (the Window menu: this workspace's tab, or a new
tab in its `dock` slot), `windowMenuItems()`, `focusPanel(id)`, `mountedPanel(id)`. Workspaces: `editing`, `color`,
`captions` (Captions and Graphics), `export`; each is a fixed grid of rows and slots, a slot shows its panels as tabs,
splitter sizes are kept, and the last one is setting `cut.workspace`. Panels are mounted once and moved between
workspaces. Panels added from the Window menu are kept per workspace in `cut.addedPanels` (`{ws: [{panel, slot:
'row:slot'}]}`) and have a close mark on their tab. Every panel is also the IDE action `Cut.window.<id>`.

`Cut.ui.lifecycle = { newProject, open, openPath, save, saveAs, askToSave, autosaveNow, autosaveCopy, offerRecovery,
key, dirty, lastAutosave, lastCopy, projectName }`. An untitled project at start (with `Cut.ui.projectDefaults()`);
`cut:autosave(..., {latest: true})` 2 s after edits stop (only when dirty, not inside a history group) and
`autosaveCopy()` every `cut.autosave.minutes` (copies kept: `cut.autosave.keep`) while dirty with edits the last copy
lacks; `cut:sessionStart/End` per key (Save As from untitled ends `untitled-<id>` and starts the
path); the recovery offer from `cut:recovery`, with `cut:recoveryDismiss` for what the user declines. The unsaved
project's close question uses a `beforeunload` guard (Electron honours it only after a user gesture); a running
export joins the IDE's close question through `window:setBusy`.

### Project panel (`ui-project.js`)

`Cut.ui.media = { importDialog, importFolder, importFolderPath, importPaths(app, paths, {binId, bins}),
importDropped(app, paths) -> new media ids, mediaForPaths(app, paths) -> media ids in the order dropped (a file
already in the project reused, the rest imported; the timeline's Explorer drop), checkOffline, relinkDialog, relinkTo,
findInFolder(folder, media) -> {paths}, offline,
matchSequence(app, mediaId), describe, probeFile, newSequenceDialog, unusedIds(project), removeUnused(app),
findMissing(app) }` and, while the panel is mounted, `selected()`, `selectUnused()`, `filter()` (null or 'unused');
`Cut.ui.offline` (the Set of offline media ids). Relinking matches the file name and size (`cut:findMedia`), then for
the rest the name alone with a probed duration within one frame. Import calls `Cut.ui.proxy.offer`. `matchSequence` uses `Media.video.w/h` as they
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
- The form's `enqueue()` (Add to Queue in the dialog and the Export Settings panel) runs the same checks as `start()`
  and hands `Cut.ui.exportQueue.add({ project: a JSON copy of app.project, seqId, seqName, fps, path, settings (the
  resolved settings), range, captions, presetName })`. `Cut.ui.syncBusy()` sends `window:setBusy` with the dialog's
  export and the queue's live jobs; `start()` refuses while the queue runs and calls `exportQueue.kick()` when done.
- `Cut.ui.captions = { importFile, exportFile, importDialog, exportDialog, styleDialog, trackOf }`.
- `Cut.ui.keys = { kHeld, actions, title }`. `ui-keys.js` holds the key map (features §18 [1]) as IDE actions
  `Cut.<id>` and sends each to the focused panel; keys never act while typing in a field or a text layer. Ctrl+X is
  `cut`. The [2] editing keys: `;` lift, `'` extract, Ctrl+Shift+V `pasteInsert`, Alt+Left/Right `nudgeLeft`/
  `nudgeRight` (with Shift `nudgeLeft5`/`nudgeRight5`), Ctrl+G `group`, Ctrl+Shift+G `ungroup`, D
  `selectAtPlayhead`, F `matchFrame`, E `extendEdit`, R/Y/U/P `tool.rate`/`tool.slip`/`tool.slide`/`tool.pen`. In
  the Cut window Alt+Left/Right are also the code editor's Previous/Next Tab and Ctrl+G its Go to Line; Cut has no
  code editor and its actions are registered later, so they win while the timeline has the keyboard.

### Timeline (`ui-timeline.js`) and its panels

- `Cut.ui.edit` (used by ui-controls, ui-effects, ui-text, ui-color, ui-overlay): `primaryClip(app)`, `clipTime(app,
  clip, t)`, `inClip`, `defaultOf(clip, path)`, `valueAt(app, clip, path, t)`, `keyframed`, `setStatic`, `write(app,
  clip, path, value, {t})` (a keyframe when the path is keyframed), `setKeyframing(app, clip, path, on)`,
  `toggleKeyframe`, `jumpKeyframe(app, clip, paths, dir)`, `gesture(app, label) -> {begin, end}` (one undo step per
  drag), `addText(app, {at, text, position, track}) -> clipId`.
- `Cut.ui.timeline` (a proxy to the mounted timeline; calls are null-safe): `split({allTracks})`,
  `rippleTrim('before' | 'after')`, `deleteSelection({ripple})`, `toggleEnabled`, `toggleLink`, `copy`, `cut`,
  `paste({insert})`, `selectAll`, `deselect`, `freezeFrame`, `addTransitions({video, audio, type})`, `speedDialog`,
  `addMarker`, `liftRange('lift' | 'extract')` (the sequence In to Out, a missing point being the start or the end,
  off the targeted tracks; then the playhead goes to the In and In/Out is cleared), `nudge(frames)` (the selection,
  `move` with `{linked: false, nudge: true}`), `group`, `ungroup`, `selectAtPlayhead` (clips under the playhead on the
  targeted tracks, with their groups and, under linked selection, links), `matchFrame` (the selected clip under the
  playhead, else the top video clip on the targeted tracks, else the first with a source: `app.setSource({mediaId,
  in, out, t})` at `model.sourceTime`, the source panel shown and sought there), `extendEdit` (`extendEdit` with the
  selection's ids, else the targeted tracks), `editPoints`, `applyEffect(clipId, type)`, `placeItems`,
  `zoomIn`/`zoomOut`/`zoomFit`, `setZoom(pps,
  {t, x})`, `setScroll`, `toggleSnap`, `snap`, `selectTransition`, `selectedTransition`, `gap`, `view`, `stats`,
  `xOf`/`tOf`/`hit`/`rowOf`/`clientPoint`, `invalidate`, `cancelDrag`, `setOverlay({ ranges, tracks } | null)` and
  `overlay` (time ranges drawn over the given tracks, all when `tracks` is null: the silence preview). The ruler draws
  `beat` markers as thin ticks (a bar marker, one with a name, a little thicker). The clip menu ends with
  `Cut.ui.auto.clipMenuItems` (Audio Role, Automation).
- Keys: Ctrl+K cuts the selected clips under the playhead (`{clipIds, linked: false}`), else the targeted tracks;
  Ctrl+Shift+K passes `{allTracks: true}`; Q/W, paste and Ctrl+D use the targeted tracks; Alt-drag and Alt-trim pass
  `{linked: false}`. Trims are live inside a history group (begin, cancel + begin + do on each move, commit on
  release).
- Tools (`app.tool`, the tool bar in the design table's order): `rate` drags an edge with `stretch` (the tip shows
  the speed), `slip` drags inside a clip with `slip` (dragging right shows earlier source; the program monitor's
  two-up view shows the clip's first and last frames, `program.trimTimes`, `program.readTrim()` -> `[{px, w, h}]`),
  `slide` with `slide` (the two-up view shows the frames on either side of the new start), `pen` adds a keyframe of
  the clip's line (opacity on video, volume on audio) where it is clicked in the keyframe area (on the line: the
  line's value; elsewhere: the value of that height) and drags it on; on a keyframe it drags that keyframe. All are
  live inside one history group, Alt leaves the linked clips. A click selects a clip with its group members (always)
  and their links (linked selection); Alt-click selects the clip alone. Grouped clips have a dashed outline.
- `Cut.ui.overlay = { attach(viewEl, app, player) -> {detach, editText, pickColor, sample, layout, geometry, editor},
  editText(clipId, {created}), pickColor() -> Promise<[r, g, b] | null>, pickColorAt(u, v), active }`. Text editing
  sets `Cut.ui.typing` while open and is one undo group per visit.
- The color panel's eyedropper sets temperature and tint to the current values plus
  `Cut.effects.whiteBalance(the linear color seen, with saturation and contrast undone)`. Its Auto button runs
  `Cut.ui.auto.autoColor`.
- `Cut.ui.auto` (`ui-auto.js`): `removeSilence(app)`, `detectScenes(app, {action})`, `detectBeats(app, {every})`,
  `matchLoudness(app)`, `matchClipLoudness(app)`, `autoDuck(app)`, `autoColor(app)`, `setRole(app, role)` (the
  selection), `menuItems(app)`, `clipMenuItems(app, clip)`, `topBarButton()` (ui-shell.js puts it in the top bar),
  `task(app, title, fn(ctx), {video})` (the progress box with Cancel; `ctx.step()` throws when cancelled and, for a task
  that decodes video, waits while `app.playing`; one task at a time), `running`, `cancel()`, `forget()` (drops the sound
  levels kept for the session), `soundClips`, `pictureClips`, `rippleTracks(seq, clips)` -> `{ tracks, changed }` and
  `rippleRanges(app, ranges, tracks, label)` (the ripple delete that Remove Silence, Remove Filler Words and the
  transcript share: `extract` of each range, the last first, in one batch). Sound is read with `Cut.decoder.audioReader` in 10 s
  blocks, frames through a frame source drawn 64 px wide; every result is one `Cut.commands.batch`. The settings each
  dialog last used are `cut.auto.<silence | scenes | beats | loudness | clipLoudness | duck>`. IDE actions
  `Cut.auto.<silence | scenes | beats | captions | fillers | aiPolish | aiTranslate | aiMetadata | aiHighlights |
  aiCommand | loudness | clipLoudness | duck | color>` reach them from Find Action (`captions` and `fillers` run
  `Cut.ui.speech`, the `ai*` ones `Cut.ui.ai`); only `aiCommand` has a key (Ctrl+J). `silencePlan(app, { threshold,
  minLength, margin })` -> `{ ranges, tracks, changed }` measures the silences of the speech without the dialog (clips
  whose role is music, effects or ambience do not count unless selected) for an edit command.
- Settings keys: `cut.defaultVideoTransition`, `cut.defaultAudioTransition`, `cut.effectFavorites`,
  `cut.export.preset`, `cut.workspace`, `cut.layout.<workspace>` (splitter sizes), `cut.proxy`,
  `cut.source.quality`, `cut.program.quality`, `cut.auto.*` (the automation dialogs), `cut.cacheLimitGB` (main).

### History, audio meters, markers (`ui-history.js`, `ui-meters.js`, `ui-markers.js`)

- History panel: `history.list()` under a "Start" row in a `virtualList`; the row of `history.position` is current,
  later rows `.undone`; a click is `history.goTo(row)`, Up/Down/Home/End too. It redraws on the app's `history` event
  (state.js emits it for every history change, a committed group included, and on `setHistory`). `Cut.ui.history =
  { rows, position, rowRect(i), refresh }`.
- Audio meters: requestAnimationFrame while `app.playing` or a level is still falling, and only while its canvas is in
  view; reads `Cut.ui.monitors.program.player.audio.meters()`. Bars rise at once and fall 30 dB/s; the hold stays
  1.5 s and falls 20 dB/s; a channel at 0 dBFS or more lights its clip button until a click resets both. Colours are
  `--cut-meter-low/mid/high/bg` on `.cut-meters`. `Cut.ui.meters = { state, running, geometry(), canvas, reset }`.
- Markers: `Cut.ui.markers = { edit(app, markerId) /* the marker dialog, also the ruler's */, markersOf(seq) /* [{m,
  clip, t}] by sequence time */, panel }`; `panel = { items, selected, rowRect(id), refresh }` while mounted. Delete
  and M are the `delete` and `addMarker` actions for the panel `markers`. The ruler's marker drag draws the marker
  where it lands (`v.markerDrag`) and commits one `setMarker` on release; a range marker's end handle drags
  `duration`.
- Keyframe interpolation: `Cut.ui.edit.EASES` (the menu: linear, ease in, ease out, ease in and out, bezier, hold) and
  `edit.easeList(list, times, ease)` (bezier gets `keyframes.handles` of the old shape), used by the effect controls
  lane and the timeline's keyframe menu. The lane draws segment i from the value's start to its end (up or down with
  the value): hold a step, the others `bezierCurveTo` through their handles; bezier segments at least 16 px wide show
  their handles, dragged live in one history group. `Cut.ui.controls.lanePoint(path, t, which?)` gives a keyframe's
  (or handle's) client point for tests.

### Speech recognition (`ui-speech.js`)

- `Cut.ui.speech = { autoCaptions(app), removeFillers(app), ensureReady(modelId?) -> Promise<bool>, transcribe(app,
  clips, ctx, range?), timelineWords(app, clips, range?), speechClips(app, { selected }), settingsSection(host, ctx),
  status(), forget(), defaults }`. `ensureReady` shows the setup dialog (`#cutSpeechSetup`: the model's and the
  runtime's sizes, "runs entirely on this PC", Download with progress, the failure explained, Try Again) when the
  model or the runtime is missing; nothing is downloaded before Download is pressed.
- The clips: audio-track clips with sound, enabled, not a freeze frame, whose role is not music, effects or ambience;
  the selected ones (with their links) when there are any; only those the In-Out range touches when it is set.
- Sound: each media file's needed source seconds (the clips' parts in the range and a second around them, less what
  its transcript covers already) are read with `Cut.decoder.audioReader` in 10 s blocks, mixed to mono, resampled to
  16 kHz with `Cut.audioengine.resample` (each block starts on an output sample and reads the filter's reach on both
  sides, so the blocks join without a seam) and streamed to `cut:speechWrite`; `Cut.speech.windows` splits them for
  `cut:speechTranscribe` and `mergeWindows` joins the answers. One `Cut.ui.auto.task` shows the progress (with
  "Loading the speech model…" as soon as main reports `loading`, while the first window's request waits) and Cancel,
  which also cancels the window in flight.
- Transcripts: per media file, model and language (key `speech|v1|<path>|<size>|<mtime>|<model>|<language>`), kept in
  memory and in the Cut cache (`cut:cachePut`, JSON `{ v: 1, ranges, language, words: [[t0, t1, text]] }` in source
  seconds), and mapped to the timeline with `Cut.speech.clipWords` whenever they are shown, so edits need no new
  recognition. The app emits `transcripts` when new ones are made.
- Auto Captions: the dialog `#cutSpeechCaptions` (the scope, language, characters per line), then `Cut.speech.captions`
  and one batch `Auto Captions`: `addCaptionTrack` (named "Auto Captions", in the language heard) or, when that track
  exists, `setCaptions` keeping its captions outside the range.
- Remove Filler Words: `#cutSpeechFillers` (filler words, pauses, the pause length, what to keep); the summary and
  `Cut.ui.timeline.setOverlay` follow the settings; Remove is `Cut.ui.auto.rippleRanges(..., 'Remove Filler Words')`.
  Its settings are `cut.auto.fillers`.
- Transcript panel (`transcript`; in Captions and Graphics beside Captions, in Editing's dock slot): paragraphs at
  pauses of 1.2 s with their timecode and a span per word (`.cut-tr-word`, `data-i`); the word under the playhead is
  `.current` (scrolled into view while playing); a click seeks and selects, Shift+click and a drag extend, Esc clears;
  the `delete` and `rippleDelete` actions of the panel and its Remove button run `Cut.speech.removalRanges` through
  `rippleRanges` on the words' clips (label `Delete Words`); the search marks the matches, Enter and Shift+Enter go
  through them. `Cut.ui.transcript = { words, selection, select(i, j), removeSelected(), transcribe(), refresh() }`
  while it is mounted.
- Settings: `cut.speech.model` (`whisper-small`), `cut.speech.language` (`auto`), `cut.speech.lineChars` (0), in the
  Video Editor page through `settingsSection` (with the model's state and Download…). The idle unload follows
  `ai.idleUnloadMinutes` (`cut:speechConfigure`).

### Text AI through Claude (`ui-ai.js`)

- `Cut.ui.ai = { polishCaptions(app), translateCaptions(app), youtubeMetadata(app), highlights(app), editCommand(app),
  createShorts(app, ranges, mode), addChapters(app, chapters), settingsSection(host, ctx), defaults }`, all reachable
  from the Automation menu; polish and translate also from the captions panel's Claude button.
- Before a request: the notice `#cutAiNotice` (what is sent; Continue sets `cut.ai.acknowledged`), then `cut:aiStatus`;
  without Claude Code, or when a request ends with `auth`, the explanation `#cutAiMissing` (`data-code`) says how to
  install it and sign in. Other failures (`timeout`, `cli`, an answer refused twice: `invalid`) show `#cutAiError`.
- A request runs inside `Cut.ui.auto.task` (progress from `cut:aiProgress`, Cancel -> `cut:aiCancel`). `ask` parses
  and validates each answer with `Cut.ai`, asks once more with `retryPrompt` when it does not validate, then fails.
- The words: the transcripts of the sequence's speech clips (`Cut.ui.speech.loadCached`, `timelineWords`), else the
  shown caption track; with neither, an offer to recognise the speech first (`ensureReady`, `transcribe`). A note says
  when `condense` trimmed them.
- Polish: `#cutAiPolish` (track, every caption / In to Out / the caption selected in the timeline), chunks of 60, then
  `#cutAiPolishReview` (each change with `del`/`ins` marks and a checkbox) -> batch `Polish Captions` of `setCaption`
  (text only). Translate: `#cutAiTranslate` (track, ko/en/ja/zh/es) -> batch `Translate Captions` of one
  `addCaptionTrack` (same times and style, `lang`, lines from `lineBreak`).
- YouTube: `#cutAiMetadata` (titles, the editable description, chapters and the fixes made, tags; Copy buttons through
  `clipboard:writeText`; Add as Chapter Markers -> batch `Add Chapter Markers`, replacing the chapter markers).
- Highlights: `#cutAiHighlights` (count 1-10, shortest, longest; `cut.ai.highlights`), `#cutAiHighlightsReview`
  (checkboxes, fill or fit: `cut.ai.shortsFit`) -> `createShorts`: one history group `Create Shorts Sequence`:
  `addSequence({ from })`, tracks unlocked and caption tracks sync-locked in the copy, 1080x1920, `extract` of
  everything outside the ranges (captions and markers follow), `shortsEdits`; the new sequence opens, and an undo that
  takes it away shows the original again.
- Edit command: `#cutAiCommand` (Ctrl+J or the menu; Enter asks) -> `validatePlan` -> `silencePlan` for each
  `removeSilence` -> `#cutAiPlan` (the steps as sentences, the time to go drawn with `Cut.ui.timeline.setOverlay`) ->
  Apply checks the plan again against the sequence as it is and runs `planCommands` as batch `Edit Command`. A plan
  without operations shows Claude's message.
- Settings: `cut.ai.model` (`sonnet`; haiku, opus), `cut.ai.acknowledged`, in the Video Editor page's Claude section
  (with whether Claude Code is installed).

### Convenience tools (`ui-shortcuts.js`, `ui-settings.js`, `ui-proxy.js`, `ui-queue.js`)

- Shortcuts: `Cut.ui.shortcuts = { apply(), open() -> {dialog, draft, render, recording}, sheet() (toggles the cheat
  sheet), closeSheet(), sheetOpen, editor, builtin(id), current(id) }`. The user's keys are the setting `cut.keys`
  (`{actionId: [keys]}`, only actions whose keys differ from the ones they were registered with; checked with
  `ide.keymap.parse`). `apply()` (on load, after `Cut.ui.start` registers the Window actions, and when `cut.keys`
  changes) remembers each `Cut.*` action's built-in keys, sets its `defaultKeys` and, unless the IDE's
  `keymap.overrides` names it, its `keys`, then emits `keymapChanged`; actions outside ui-keys.js get a `when` that is
  false while typing. Keys are recorded with `ide.keymap.comboOf` from a capture listener added before the dialog's.
  `Cut.ui.keys.kinds` (`[{id, title()}]`) and `kindOf(id)` group the actions; ui-keys.js also lists `keyHelp`
  (Shift+/), `keyboardShortcuts`, `settings`, `selectUnused`, `removeUnused`, `findMissing` and `createProxy`.
- Settings: an `ide.settingsPages` entry `{id: 'cut', cut: true, index: false, defaults}` (the settings plugin shows
  `cut: true` pages in Cut mode). `Cut.ui.settingsButton()` (the top bar's menu), `Cut.ui.projectDefaults()` (`{
  transitionDuration, stillDuration }` for `createProject`), `Cut.ui.settingDefaults`. A change of
  `cut.transitionSeconds`/`cut.stillSeconds` runs `setSettings` on the open project; `cut.quality` sets
  `cut.program.quality` and `cut.source.quality`, which the monitors follow (as they follow `cut.proxy`). The shell's
  interval copies read `cut.autosave.minutes` and `cut.autosave.keep` (`Cut.ui.lifecycle.autosaveCopy()`).
- Proxies: `Cut.ui.proxy = { create(app, mediaIds), cancel(mediaId), remove(app, mediaIds), state(media) -> {state:
  'none' | 'waiting' | 'running' | 'paused' | 'ready' | 'missing' | 'failed', fraction, error}, needs(media) -> ['4k',
  'hevc', 'gop'], offer(app, mediaIds), offerBanner(app), dismiss(), sizeOf(media, height), pathOf(media, height),
  jobs(), running }`. A job builds a one-clip project (sequence at the proxy size and `nearestRate(fps)`, no audio
  track) and runs `Cut.export.run({ settings: presets.resolve('720p', ...) with audio null, keyInterval 15, gate })`
  into `<cache>\proxy-<FNV of path|size|mtime|height>-<height>p.mp4`; the gate waits while `app.playing` or the source
  monitor plays. `setProxy` is done when the job's history is still `app.history` and no group is open. The app
  emits `proxies` when a job or a proxy's presence changes. Dismissed offers: setting `cut.proxy.dismissed` (lower-case
  session keys, at most 200; a first save carries the untitled key's answer to the path).
- Export queue: `Cut.ui.exportQueue = { add(spec) -> job, cancel(id), remove(id), retry(id), move(id, ±1),
  openFolder(id), clearFinished(), kick(), jobs(), busy, writes(path), busyLabels() }`; the panel `queue` (Export
  workspace). The app emits `exportQueue` on every change and on progress; rows are rebuilt only when jobs or their
  states change.
- `Cut.export.run` takes `settings.audio = null` (video only) and `gate` (awaited before each frame);
  `presets.validate` accepts `audio: null`. `compositor.prefetch(project, seqId, from, to, {proxy})`.

### App events from the panels

Besides those of state.js: `workspace` {id}, `lifecycle` {reason: 'new' | 'open' | 'save' | 'recover', path},
`autosaved` {file, time, copy?}, `offline` {ids}, `exported` (the run result), `proxies`, `exportQueue`, `transcripts`, `patch`, `snapping`, `targets` {ids},
`transitionSelection` {id, open?} (with `app.selectedTransition`), `captionSelection` {track, id}, `trimPreview`
{clipId, edge, mode, t, active}, `scrub` {active}.

## 11. Strings and styles

- Korean strings are in `renderer/features/cut/locales/ko.json` (English source -> Korean). Korean UI follows the
  IDE's Korean (PyCharm / Premiere Korean terms where they exist: 타임라인, 시퀀스, 클립, 트랙, 효과 컨트롤, 키프레임,
  전환, 내보내기, 소스 모니터, 프로그램 모니터, 리플 편집, 롤 편집, 자르기 도구). Effect, parameter, choice, preset
  and category names, command labels and errors reach `tr()` as variables, so `verify/i18n-static.mjs` does not list
  them: add them to ko.json by hand.
- Styles: `css/shell.css` (shell), `css/timeline.css` (timeline), `css/panels.css` (panels, one block per area),
  `css/tools.css` (shortcut editor, cheat sheet, settings page, proxies, export queue), `css/speech.css` (the
  transcript panel, the speech setup dialog), `css/ai.css` (the Claude dialogs and review lists) and the tokens in
  `style.css`. Use the IDE's variables so dark and light themes work.

## 12. Tests

| File | Kind | Port | What it covers |
| --- | --- | --- | --- |
| `verify/cut-formats.mjs` | Node | - | Readers and writer: mp4write output read back table by table; handcrafted ctts v1, co64 past 4 GB, stz2, elst, fragments, QuickTime PCM, Matroska lacing and damage, MP3 Xing/VBRI, RF64; truncated copies come back as values; a two-hour table against a clock; the scripts loading next to Monaco's AMD `require` |
| `verify/cut-model.mjs` | Node | - | Every command against the expected timeline, exact undo/redo; 2,000 random commands; sync lock, links, groups, trim, slip, slide and rate stretch clamps, extend edit, snapping; keyframe values; history grouping, dirty, limit; SRT/VTT with CP949 and UTF-16; migrate |
| `verify/cut-main.mjs` | Node | - | Every `cut:*` channel with Electron stubbed: read ranges and limits, UNC/`\\?\UNC`/`\\.\` paths, links to network paths, junctions, 8.3 names, streams; atomic project writes and .bak; autosave rotation, sessions, recovery; the sink; faststart; cache LRU; findMedia/listMedia; real fonts |
| `verify/cut-engine-core.mjs` | Node | - | Effect registry and CPU references, transitions, crossfade, the compositor's plan, fit scales, motion presets, the reader's block cache, audio assembly, peaks, dropped-frame count |
| `verify/cut-analyze.mjs` | Node | - | Levels streamed in odd blocks, silences with minimum length and margins on frames, speech; click tracks at 90, 120 and 140 BPM (beats within 12 ms, bar phase on the accents); scene cuts on their frame with a flash ignored and a fade in giving one cut at most; auto color through color.basic's own math (a light picture kept light); ducking keyframes; ranges and clip time; loading as a page script |
| `verify/cut-export-core.mjs` | Node | - | Presets (levels, bitrates, estimates), resampler and WSOLA, BS.1770-4 loudness and true peak, normalize and match gains, the mixer, testsrc frame numbers, export's pure parts (frame plan, chapters, captions in a range, SRT names) |
| `verify/cut-engine.mjs` | app | 9753 | Frame accuracy at 24/29.97/30/60 fps, speed and reverse; transforms and keyframes from pixels; every effect against its CPU reference; transitions; Korean text; captions; offline media; import errors; audio decode; thumbnails and peaks; 10 s 1080p30 playback with seeks and no leaked VideoFrame; the 2D fallback |
| `verify/cut-export.mjs` | app | 9754 | Test sources decode frame-exact; exported sequences re-decode with the right frames (PSNR >= 35 dB), beeps on flashes, pitch kept; hardware, software, HEVC and 2D back end; playback in `<video>`; range, captions, cancel, export frame, chapters; loudness; preview clock and meters; export speed |
| `verify/cut-shell.mjs` | app | 9755 | The frame with real mouse and keys: lifecycle, autosave, recovery, close question, import, bins, offline and relink, monitors, export dialog, captions, keys; dialogs answered through `PYIDE_CUT_DIALOG` |
| `verify/cut-auto.mjs` | app | 9757 | The Automation menu, the clip menu and the color panel's Auto with real clicks: silence removal with its timeline preview, a locked track, one undo step; roles and ducking keyframes; loudness and clip loudness measured again; beat markers on a click track and a drag snapping to them; scene markers and splits, waiting while playing, Cancel; auto color seen in the rendered frame; a 10-minute file's analysis time and memory; screenshots |
| `verify/cut-timeline.mjs` | app | 9756 | Timeline gestures and keys checked in the model and undone; drops; effect controls and keyframes; effects panel; color panel and eyedropper; overlay handles and Korean IME text; 500 clips; screenshots (`CUT_TL_ONLY` picks parts) |
| `verify/cut-edit.mjs` | app | 9759 | The [2] editing keys and tools with real keys and drags: the keys as `Cut.<id>` actions (Find Action), the tool bar; lift and extract on targeted and locked tracks; paste insert; nudge with links and a locked track; groups (select, Alt-click, drag, nudge, delete, ungroup); D; E; rate stretch; slip with the two-up frames read from pixels; slide; pen keyframes on volume and opacity; match frame to the source monitor's frame (`CUT_EDIT_ONLY` picks parts) |
| `verify/cut-panels.mjs` | app | 9762 | The History, Markers and Audio Meters panels and the Window menu with real clicks and keys: jumps through the history in one go, dimmed later steps, 1,500 steps in a virtual list; marker filters, search, click, double click and Delete; marker drags on the ruler (frames, snapping, range end) and its menu; Hold and Bezier in the lane and timeline menus, the hold step from pixels, a bezier handle drag; meters' peak, RMS, hold and clip lights from a 1080p30 source, read from the canvas; dropped frames with and without the meters (`CUT_PANELS_ONLY` picks parts) |
| `verify/cut-tools.mjs` | app | 9765 | The convenience tools with real clicks and keys: the shortcut editor (record, use, conflict refusal, remove, reset, Reset All, the typing guard), the ? cheat sheet; the Video Editor settings page (transition length through Ctrl+D, playback quality, Clear Cache, copies kept); Select and Remove Unused with undo, Find Missing Media relinking by size and by duration; proxies (offer, 720p H.264 GOP 15 in the cache, the monitor drawing it and export the original by pixels, fallback when deleted, waiting while playing, cancel, the offer dismissed per project); the export queue (order, a later edit not leaking in, move, cancel, retry, remove, the close question) (`CUT_TOOLS_ONLY`) |
| `verify/cut-speech.mjs` | Node | - | Speech recognition without a model: windows and their seams (squeezed end words, a half-heard start), words mapped through in, speed and reverse, two clips of one recording; caption line breaking (Korean 18 and English 42 characters, two balanced lines, 6 s, pauses, sentence ends, frames); fillers and pauses; deleting words; search; word times narrowed to their sound; the fake's bursts; main's temp files, windows, cancel, setup flow and error codes; loading as a page script |
| `verify/cut-whisper.mjs` | app | 9768 | Speech recognition with the fake backend through the real UI: the setup dialog (sizes, on this PC, nothing before Download, Cancel, progress); Auto Captions on testsrc beeps over two windows, again over In-Out from the captions panel and from the cache, "Loading the speech model…" while a slow model loads; the Transcript panel's click, highlight while playing, Shift+click, Delete across linked tracks, undo, Remove, search; Remove Filler Words with its overlay; the settings section; the Window menu; an offline failure in Korean; screenshots (`CUT_WHISPER_ONLY`) |
| `verify/cut-ai-core.mjs` | Node | - | Text AI without Claude: JSON from answers, the retry prompt; transcripts condensed within a budget the same way every time; what each prompt sends (no paths); caption answers checked line by line; YouTube chapters fixed (0:00, 10 s, inside, at least 3), titles and tags; highlights checked (inside, lengths, frames, overlap), the shorts complement and fit/fill scale; every plan operation validated strictly (unknown operations and fields, prototype names, tracks, times, selection), described, applied as one undo step on a real project and undone exactly; ko/en/ja/zh/es line breaks and the diff; main/cut/ai.js (checks, progress, cancel, time limit, window gone); the fake CLI through main/ai/claude.js and `PYIDE_CLAUDE_PATH=none`; loading as a page script |
| `verify/cut-ai.mjs` | app | 9779 | Text AI against the stand-in CLI `verify/fake-claude-cut.mjs` through the real UI: the notice (Cancel sends nothing, Continue remembered); Polish with the marked review, one change unchecked, one undo step, times kept; Translate into Japanese (a new track, same times, 16-character lines); YouTube metadata (chapters fixed, Copy, chapter markers replacing the old one), from the transcript after the offer to recognise the speech (fake Whisper); Highlights (the overlapping answer refused and asked again, the review, a 1080x1920 sequence of the chosen ranges with captions, fill, undo); Edit Command by Ctrl+J (silences with the overlay, the first 10 s, the music quieter, an unknown operation refused twice, an unknown field fixed on the retry, no edits); Cancel; signed out; the settings section; Claude Code missing, in Korean; screenshots (`CUT_AI_ONLY`) |
| `verify/app-mode.mjs` | app | 9758 (cut block) | `--mode=cut` opens the Cut window, workspace and trust, only Cut's plugins, `__cutReady`, no renderer exceptions |

- Node suites: `node verify/cut-<name>.mjs`, printing `N/M passed` and `FAIL <what>` lines.
- App suites launch with `launch({ fixture: 'core', port, name, mode: 'cut', env: { PYIDE_CUT_HOME: <a temp dir> } })`
  from `verify/lib.mjs`, wait for `window.__cutReady === true`, and check that `Cut[name]` exists for every module
  they use. Run them one at a time through `powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1
  -Out verify/out/<name>.log -TimeoutMinutes 20 node verify/<name>.mjs`.
- Test env: `PYIDE_CUT_HOME` (the workspace), `PYIDE_CUT_DIALOG` (dialog answers), `PYIDE_CUT_FONT_DIRS` (font
  folders), `PYIDE_WHISPER_BACKEND=fake` and `PYIDE_WHISPER_FAKE_SETUP` (speech recognition without a model),
  `PYIDE_CLAUDE_PATH` (a stand-in Claude Code CLI, or `none`) with `FAKE_CLAUDE_DIR` (`verify/fake-claude-cut.mjs`'s
  scenario and log). Media comes from `Cut.testsrc` or bytes the test builds: no downloads, no copyrighted media.
