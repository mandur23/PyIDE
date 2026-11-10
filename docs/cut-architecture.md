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
  cache, relink search, fonts           captionwords remap model keyframes masks commands srt   project
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
  back-pressure. After a sink error they throw at once and `finish()` rejects; `create`'s `onError(err)` hears the
  first sink error when it happens and `writer.error` holds it, so an export stops at the full disk, not after the
  last frame. Samples of 2 MB or more go to the sink
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

Files: `remap.js`, `model.js`, `keyframes.js`, `masks.js`, `graphic.js`, `commands.js`, `srt.js`. Tests: `verify/cut-model.mjs` and `verify/cut-mask-core.mjs` (plain Node).

### `Cut.model`

The project JSON is video-editor-features.md §19. Exact shape, all times in ticks:

```js
Project = { format: 'ncut', version: 4, settings: Settings, media: [Media], bins: [Bin], sequences: [Sequence], nextId,
            speakers? /* speaker labels: Speakers */ }
Speakers = { list: [{ id: 'sp<n>', name /* '' shows as "Speaker N" */, color: '#rrggbb' }],
             turns: { [mediaId]: [[t0, t1, speakerId]] /* source SECONDS, in order, apart */ },
             count: 0 /* Auto */ | 1..10 /* the fixed number the labels were made with */ }
Settings = { fit: 'fit' | 'fill' | 'original', stillDuration, transitionDuration, freezeDuration, textStyles?,
             speechTerms? /* speech recognition's word list: [string], at most 200 of at most 100 characters */ }
Media = { id, path, name, kind: 'video' | 'audio' | 'image', size, mtime, duration,
          video: {w, h, fps, codec, vfr, rotation} | null, audio: {rate, channels, codec} | null,
          interpret: null | { fps }, proxy: null | { path } }
Bin = { id, name, parent: binId | null, items: [mediaId | sequenceId] }
Sequence = { id, name, w, h, fps: [num, den] /* one of time.FRAME_RATES */, rate: 48000, background: '#000000',
             masterGain: 0 /* dB on the mix */, tracks: [Track], clips: [Clip], transitions: [Transition],
             markers: [Marker], captions: [CaptionTrack] }
Track = { id, kind: 'video' | 'audio', name, locked, syncLock, height, visible /* video */, mute, solo, volume /* dB */, pan /* audio */ }
Clip = { id, track, start, in, out,           // timeline position, source in/out (source ticks)
         source: { media } | { media, freeze: true } | { generator: 'text' | 'solid' | 'adjustment' | 'graphic', ...params }
               | { sequence: seqId },                // a nest clip: in/out are times of that sequence
         speed: 1, reverse: false, enabled: true, link: linkId | null, group: null, name, label,
         remap: null | Remap,                   // Time Remapping of a video clip (below); then speed 1, reverse false
         sampling: 'sample' | 'blend',          // Time Interpolation: Frame Sampling (default) or Frame Blending
         role: null | 'dialogue' | 'music' | 'effects' | 'ambience',   // what its sound is (automation)
         props: { position: [x, y] /* px from center */, scale: [sx, sy] /* % */, rotation /* deg */, anchor: [x, y], opacity /* % */,
                  crop: [top, right, bottom, left] /* % */ }  |  { volume /* dB */, pan }   // video | audio clip
         keyframes: { [path]: [Keyframe] },
         effects: [Effect], fadeIn: 0, fadeOut: 0 /* ticks, audio */, markers?: [Marker] /* t from the clip start */,
         masks?: [Mask] /* Opacity's masks, video clips only; absent when none (below) */ }
Effect = { id, type, on: true, params: {},    // params only where they differ from the registry's defaults
           masks?: [Mask] }                   // the masks that limit a video effect; absent when none
Keyframe = { t /* from clip start */, v /* number or array */, ease: 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bezier', h?: [x1, y1, x2, y2] }
Transition = { id, track, at /* edit point ticks */, type, duration, align: 'center' | 'start' | 'end', params: {} }
Marker = { id, t, duration: 0, name, note, kind: 'comment' | 'chapter' | 'beat', color }
CaptionTrack = { id, lang, name, style: {...}, syncLock: true, items: [{ id, start, end, text, doubt?, words?, speaker? }] }
// speaker: an id of project.speakers' list; the track shows its color (style.speakerColor) and name (style.speakerName)
// doubt: the words speech recognition was unsure of, [{ at /* whole ticks from the caption's start */, text, p /* 0-1 */ }]
// words: each token of the text (a run without white space, across lines) with its time, [{ t0, t1 /* whole ticks from
//   the caption's start; may lie before it or past its end */, text /* the token */ }], t0 never decreasing (Cut.captionwords)
// style: defaultCaptionStyle() plus what the track changed: font, size, weight, color, background, position, margin,
//   ref, highlight (false), highlightColor ('#ffd23f'), highlightMode ('color' | 'box')
```

A text clip is `source: { generator: 'text', layers: [TextLayer] }`; TextLayer = `{ id, text, font, size, weight,
italic, tracking, leading, align, fill, stroke: {color, width} | null, shadow: {color, blur, x, y} | null,
box: {color, padding, radius} | null, position: [x, y] }`. Solid: `{ generator: 'solid', color }`. A freeze frame
(`{ media, freeze: true }`) is a still showing the frame at `clip.in`. `settings.textStyles` entries are
`{ id: 'ts<n>', name, style: {font, size, weight, italic, tracking, leading, align, fill, stroke, shadow, box} }`.

A nest clip (`source: { sequence }`, Premiere's nested sequence; version 2 of the format, a version 1 file has none and
migrates as it is) shows and plays another sequence of the project. Its in/out are ticks of that sequence, read through
`sourceTime` like a file's (speed, reverse), so whatever later changes `sourceTime` (time remapping) applies to nests
too. Its source length is the nested sequence's duration (`sourceLength`), never less than the clip's own `out`, since
the nested sequence may get shorter after the clip was cut; past its end the clip is transparent and silent. It may sit
on a video or an audio track; no `freeze`. `validate` refuses a nest clip of a missing sequence or of its own, and any
loop of nest clips (A shows B shows A).

#### Time remapping (`remap.js`, `Cut.remap`)

Premiere's Time Remapping > Speed: a video clip's speed changes along it (ramps, reverse, holds) and its length follows.
Version 3 of the format; a version 1 or 2 file has none (`remap: null`, `sampling: 'sample'`) and reads as it is.

The shape is a **keyframed speed curve over clip time**, and source time is its integral:

```js
Remap = { at /* source ticks at clip time 0 */, speeds: [v0, ..., vn] /* 1 = 100%, 0 a hold, < 0 reverse */,
          keys: [{ t, ramp }] /* n keys, whole frames from the clip start, in order */, duration /* whole frames */ }
```

`speeds[0]` runs until `keys[0].t`; key i ramps (speed linear in time) from `speeds[i]` to `speeds[i + 1]` over
`[t, t + ramp]` (ramp 0: a jump); the last speed runs on. So the curve is made of constant pieces (source linear in
time) and ramp pieces (source quadratic in time). A speed a person sets is 1% to 10000% in size, or 0 (`setSegmentSpeed`,
the drags, `moveKey`, which limits the dragged length so the speed from whole frames stays inside); a stored curve may
hold any speed up to 10000% in size, since a cut, a head trim or an overwrite inside a ramp next to a hold starts the
new curve at the speed there (0.33% one frame in), and `valid` and `setRemap` accept it.

Why this shape and not keyframes of source time over clip time. The timeline's rubber band and Effect Controls show and
edit *speed*: dragging a segment up or down, a key splitting into a transition, a reverse or hold segment are each one
number or one key in this shape, while with source-time keys a speed change has to move every later key's source time
and a ramp has to keep its quadratic consistent with its neighbours' slopes (an invariant to keep, not a shape). Key
times are whole frames of the sequence, as every other clip time, so the frame-exact rules hold: the clip's length is
`duration`, a frame count, never a quotient. The three questions have closed forms:
- clip time -> source time (compositor, prefetch, export): find the piece (binary search on its end), evaluate
  `sr + vr x + a x^2 / 2`. `sourceAt` takes one tick off where the speed is negative, as a reversed clip shows the
  frame before its out point first.
- source time -> clip time (Match Frame's inverse, scene and beat markers through `analyze.toTimeline`): per piece a
  linear or quadratic root; the earliest in the clip wins (`clipTimeOf`).
- the duration: stored; a speed change computes the new one from the source frames the changed segment keeps.

The curve is defined at every clip time (before 0 at the first speed, after the last key at the last speed); the clip
shows `[0, duration)`. Keys past `duration` are the hidden tail, the way source past an out point is: a curve that grew
into the next clip keeps its rest there, and an end trim brings it back. A remapped clip's `in`/`out` are the lowest and
highest source time the curve reaches over the clip (`range(r)`; a tick apart for a clip that only holds one frame),
kept by every command, so each existing source clamp, range and `sourceLength` check holds unchanged. Its `speed` is 1
and `reverse` false: the curve has both. A curve without keys is a constant speed, so the commands store it as one
(`speed`, `reverse`, `remap: null`): Speed/Duration works on it again.

`Cut.remap`: `MIN`, `MAX`, `MAX_KEYS`; reading: `pieces(r)`, `value(r, t)` (continuous source time), `speedAt(r, t)`,
`sourceAt(r, t)` (the frame's), `bounds(r, a, b)`, `range(r)`, `clipTimeOf(r, s, a = 0, b = duration)`, `stay(r, from,
dir, lo, hi)` (how far from `from` the curve stays inside a source range: trim room and length limits), `segmentSpan`,
`segmentAt(r, t) -> {index} | {ramp}`, `valid(r, f)`, `isConstant`; edits, each returning a new curve: `constant(at,
speed, duration)`, `shift(r, d)` (seen from clip time d: a trimmed head or the right part of a cut, a ramp across d
keeping its rest), `withDuration`, `setSegmentSpeed(r, i, v, f)` (the segment's constant part keeps its source frames, so
its length changes and later keys and the end move), `addKey(r, t)` (null inside a ramp or on a key), `removeKey(r, i,
f)` (the speed before it goes on), `splitKey(r, i, 'left' | 'right', x, f)`, `moveKey(r, i, dt, f, { keepSpeeds })`
(keepSpeeds: Alt; otherwise the key keeps its source frame and the segment before it changes speed; a hold before it
gets longer), `insertReverse(r, i, len)` and `reverseRoom` (Ctrl-drag: back `len` at the arriving speed, forward `len`
to the key's frame), `insertFreeze(r, i, len)` (Ctrl+Alt-drag), `refit(r, fn, f)` (another frame grid).

What edits do with a remapped clip (`commands.js`): a start trim and the right part of a razor see the curve from the
new head (`shift`); an end trim, the left part, extend edit and slide change `duration`; slip moves `at` (and in/out)
by the delta in source ticks one for one; a frame rate change and a paste into another rate move keys and length to the
new grid (`refit`, the length kept inside the source); copy and paste carry the curve on a video track; nest clips are
remapped the same way (their source is their sequence's time). Speed/Duration, Reverse Speed and the Rate Stretch tool
refuse a remapped clip (`remap`), as Premiere greys them out. Frame Hold Segment cuts it like any clip.

#### Graphic clips (`graphic.js`, `Cut.graphic`)

Motion graphics drawn from data: `source: { generator: 'graphic', layers: [GraphicLayer] }`. Version 5 of the format; a
version 1 to 4 file has none and reads as it is, and an app that reads version 4 calls a version 5 file newer. A layer
is `{ id, kind, ...fields }` with kind rect, ellipse, polygon, star, line, path (SVG path data without arcs), text,
group or particles; `graphic.FIELDS` lists every field with its type, default and range, and which kinds have it. The
commands store layers normalized (every field of the kind), `graphic.validate` is part of `model.validate`, and the
edit commands `addGenerated`, `setGenerator {layers}`, `setLayer`, `addLayer` and `removeLayer` check a graphic's
whole list before they change it (unique ids, a parent is a group earlier in the list, a layer keeps its kind).

Coordinates are sequence pixels from the frame's center, y down. A layer's transform is position, rotation, scale
about its anchor, under the transforms of its parent groups; opacity multiplies down the groups. Layers draw in order
into a Canvas 2D context (`graphic.draw`), which the compositor uploads like a text clip's canvas, so the program
monitor, the GPU and CPU back ends and the export draw the same picture; the canvas is kept while the resolved layers
stay the same (particles change every frame). Each layer draws its fill (a color or a gradient), then a stroke that
`trimStart`, `trimEnd` and `trimOffset` cut along the outline's length (outlines are flattened to polylines, curves
by their length at the drawn size), with its shadow, blur, blend mode, and `repeatCount` copies. Text layers use the
fonts textrender.js loads; `{value}` shows the `value` field, formatted with `decimals`. Particles are a stream or a
burst from an emitter area, from a seeded hash of (particle, cycle), so a frame always draws the same.

Keyframes: `layers.<layer id>.<field>` of the clip, for every number, pair and color field (`graphic.ANIMATED`);
`graphic.resolve` gives a layer's values at a clip time (whole numbers rounded, values out of range ignored). The
control API's `add_graphic` and `set_graphic` (`control-graphic.js`) make and change graphics; `set_keyframes` animates
them. There is no panel for a graphic's layers yet: the clip has the usual Motion, effects, masks and transitions.

#### Masks (`masks.js`, `Cut.masks`)

Premiere's masks of Opacity and of the video effects. Version 4 of the format; a version 1 to 3 file has none and reads
as it is.

```js
Mask = { id /* 'm<n>', unique across the clip's lists */, mode: 'add' | 'subtract' | 'intersect' | 'difference' | 'none',
         inverted: false, path: [x, y, inX, inY, outX, outY, ...] /* 3 to 256 vertices */, feather: 10 /* 0..1000 */,
         opacity: 100 /* % */, expansion: 0 /* -2000..2000 */ }
```

The path is one flat list, six numbers a vertex: the vertex and its in and out bezier handles relative to it, all as
fractions of the clip's picture (its fitted frame, a nest's fitted sequence, a text or solid clip's full frame), so a
mask follows the clip's motion and survives a change of sequence size or fit. A corner has both handles 0. Edge i is the
cubic (v_i, v_i + out_i, v_i+1 + in_i+1, v_i+1), the last back to the first: masks are always closed (the pen keeps its
points in the screen until the path is closed). Feather and expansion are sequence pixels, scaled by `pxScale` as every
pixel-sized effect parameter. Why a flat list: Mask Path is keyframed as one value, and `keyframes.mix` already
interpolates two arrays of the same length element by element and holds the earlier one when the lengths differ, which
is the rule: **Mask Path keyframes interpolate vertex by vertex (each vertex and its handles, with the keyframe's ease)
when the vertex counts match, and hold the earlier path until the next keyframe when they do not.** Adding or deleting
a vertex on a keyframed path does it on every keyframe (`mapKeyframes`), so the counts stay equal.

Keyframable paths: `masks.<id>.<field>` (Opacity's) and `effects.<id>.masks.<id>.<field>` for `path`, `feather`,
`opacity`, `expansion` (`FIELDS`); `inverted` and `mode` are not keyframed. `keyframes.staticValue` reads both shapes.
Keyframe times are clip time like every other keyframe, also on a time-remapped clip.

Coverage at a pixel center (CPU `coverage`, WGSL `WGSL`, the same arithmetic): the path flattened (`FLATTEN` 16
segments a curved edge, one a straight edge); d = the distance to the segments, positive inside (even-odd); the shape's
coverage is smoothstep(-w/2, w/2, d + expansion) with w = max(feather, 1); Inverted takes 1 - it; Mask Opacity
multiplies it. The masks of a list combine top to bottom: the total starts at 0, or 1 when the first mask that is not
None subtracts or intersects; Add a + m - am, Subtract a(1 - m), Intersect am, Difference a + m - 2am; None masks are
left out, and a list of None masks only is no mask. Opacity's masks multiply the clip's picture after all its effects;
an effect's masks mix its output over its input (`cutCpu`, `mixCpu` are the CPU references).

`Cut.masks`: `MODES`, `FIELDS`, `DEFAULTS`, `RANGES`, `MAX_MASKS` (16 a list), `MAX_POINTS`, `MIN_POINTS` (3), `FLATTEN`,
`KAPPA`, `SIGMA`; `count`, `validPath`, `validField`, `valid`, `problem` (why not), `full` (defaults filled), `lists(clip)`
(`[{effectId, prefix, list}]`), `prefixOf(effectId)`, `nextId(clip)`, `parsePath(prop)` -> `{effectId, maskId, field}`;
shapes `ellipse(w, h, {cx, cy, r})` (Create Ellipse Mask: a circle of a quarter of the shorter side, four smooth
vertices), `polygon(w, h, {cx, cy, s})` (Create 4-point Polygon Mask: a centered square half the shorter side across),
`fromPoints([{x, y, hx, hy}])` (the pen); geometry `flatten`, `signedDistance`, `contains`, `edge`, `cubic`, `vertex`,
`isCorner`, `outline(path, w, h, d)` (the guide lines), `topPoint`; coverage `prepare`, `coverage`, `coverageAt`,
`cutCpu`, `mixCpu`, `at(clip, prefix, list, local)` (the values at clip time, null when none counts), `gpuData`,
`canvasCoverage`, `path2d`; edits `translate`, `moveVertex`, `setHandle(path, i, 'in' | 'out', hu, hv, w, h, {broken})`,
`toggleSmooth`, `insertVertex(path, edge, t)` (de Casteljau, the shape kept), `removeVertex`, `nearestVertex`,
`nearestEdge`, `mapKeyframes`.

Commands: `addMask(seqId, clipId, mask, { effectId })` (label Add Mask; the mask's fields over `DEFAULTS`, the next id;
refused `notVideo` off a video track, `noMasks` for an effect whose def says `masks: false` (Edge Extend) or an audio
effect, `tooMany` past 16, `invalid` -> `{id}`), `setMask(seqId, clipId, maskId, patch, { effectId })` (label Mask; mode,
inverted, path, feather, opacity, expansion; `invalid`), `removeMask(seqId, clipId, maskId, { effectId })` (label Remove
Mask; its keyframes go too; the list goes when it is empty). Razor, paste (on a video track), freeze frame, nest and
copy carry masks and their keyframes; `removeEffect` removes its masks' keyframes with its own. `validate` checks every
mask (shape, ranges, ids unique across the clip, 1 to 16 a list, none on an audio track) and every mask keyframe's
value; `migrate` fills a mask's missing fields and drops a damaged mask (with its keyframes), keyframes of a mask that is
not there, and keyframe values that are not values of their field.

Ids: track ids (V1, A2) are unique within their sequence; effect and text layer ids within their clip; every other id
(media, bins, sequences, clips, transitions, markers, caption tracks and items, links) is project-wide
(`newId(project, prefix)` = prefix + `nextId`). A link has two or more clips of one sequence.

`clipDuration(clip)` is `(out - in) / speed` rounded to `model.QUANTUM` (2,116,800 ticks, the gcd of every offered
frame length), not to whole ticks: at speeds other than 1, in/out are not whole ticks and the float error would push
durations off the frame grid. That is why sequences accept only `time.FRAME_RATES` (`validFps`). Always use
`clipDuration`/`clipEnd`, never `(out - in) / speed`.

Exports: `VERSION`, `QUANTUM`, `SAMPLINGS`, `EASES`, `GENERATORS`, `VIDEO_PROPS`, `AUDIO_PROPS`, `MARKER_KINDS`, `ROLES`, `ALIGNS`; `clone`,
`newId`, `defaultSettings`, `createProject(opts)`, `createSequence(opts)` (default tracks V1, V2, A1, A2),
`createTrack`, `createClip`, `createTextLayer`, `defaultCaptionStyle`, `videoProps`, `audioProps`;
`validate(project) -> { ok, errors: [string] }` (shapes, ids unique, references resolve, no overlapping clips on a
track, times frame-aligned to the sequence), `validPropPath(clip, kind, path)`, `validFps(fps)`,
`migrate(json) -> project` (fills missing fields with defaults, snaps keyframe, marker and caption times to frames;
throws `code: 'notProject'` or `'newer'`; a missing or unknown clip `role` becomes null); `clipDuration`, `clipEnd`, `sequenceDuration(seq)`,
`clipsAt(seq, t, {kind})` (enabled clips under t, V1 first), `sourceTime(clip, t)` (the source time a timeline time
shows: speed, reverse, freeze and time remapping included), `timelineTime(clip, src)` (the inverse: the first timeline
time that shows src, clamped to the clip's edges outside it; null for a freeze), `sourceSpan(clip, a, b) -> [lo, hi]`
(the source a timeline range shows, what to decode ahead), `sourceRoom(project, clip) -> {head, tail}` (timeline ticks
the source lets the clip grow at each end), `remapOf(clip)` (its curve, or its constant speed as one), `trackIndex(seq, id)` (the index among tracks of the same kind: V1 = 0,
A1 = 0), `trackOf`, `linkedClips(seq, clip)`, `mediaOf(project, clip)`, `isGenerator`, `isStill`; nests: `isNest(clip)`,
`nestOf(project, clip)` (its sequence or null), `sourceLength(project, clip)` (the media's duration, or the nested
sequence's, at least `clip.out`; every source clamp uses it), `nestedIds(seq)` (the sequences its nest clips show),
`reaches(project, fromId, toId)` (through nest clips, any depth), `nestLoop(project, outerId, innerId)` (placing a nest
of inner in outer would loop), `nestUses(project, seqId)` (`[{seq, clips}]` that show it), `nestKinds(project, seqId)`
(`{video, audio}`: whether it has clips on tracks of each kind, so what a nest clip of it places).

Engine and export map timeline time to source time only with `sourceTime(clip, t)`.

### `Cut.keyframes`

`valueAt(keyframes, t, fallback)` (numbers and arrays; hold, linear, eased, cubic bezier by handles; before the first
keyframe the first value, after the last the last), `propValue(clip, path, t, fallback)` (`t` in clip time, reads
`clip.keyframes[path]` or the static value), `staticValue`, `insert(keyframes, kf)`, `remove(keyframes, t)`,
`next(keyframes, t)`, `prev(keyframes, t)`, `bezier`, `eased`, `mix`, `handles(keyframe | ease)` (the bezier handles that
draw a segment as it is now: the preset's for the eases, `[1/3, 1/3, 2/3, 2/3]` for linear, its own for bezier, null for
hold; turning a keyframe into bezier with them keeps its values), `DEFAULT_HANDLES`.

Ease names have the CSS meaning: `easeIn` starts slowly, `easeOut` arrives slowly. A keyframe's ease shapes the
segment that leaves it. Keyframable paths are the props (`'opacity'`, `'position'`...), `effects.<id>.<param>`, the masks' fields (`masks.<id>.<field>`, `effects.<id>.masks.<id>.<field>`) and
`layers.<id>.<field>`. A text layer's `opacity` (0..100) and `reveal` (0..1, typewriter) exist only as keyframes.

### `Cut.commands`

`createHistory(project, { limit = 1000 })` -> `history`. It throws `code: 'damaged'` for a project that does not
validate. Opened files go through `createHistory(Cut.model.migrate(text))`.

- `history.project` (the current project; read-only), `do(command)` -> result | throws (nothing changes then),
  `undo()` / `redo()` -> boolean, `canUndo`, `canRedo`, `dirty`, `mark()` and `markSaved(mark = mark())`: a save
  takes `mark()` before `serialize()` and passes it to `markSaved` once the file is written, so an edit or amend made
  while it is written stays unsaved; a mark taken inside a group with edits in it (a save during a drag) is no step, so
  the project stays dirty until the next save.
- `amend(command)` -> result | throws: a change that is no edit of the person's (a finished proxy job linking its
  file): applied, validated and saved with the project like `do`, but no step. The steps, what can be redone and an AI
  turn's `squash` are left as they were, undo and redo never take it back, and `dirty` is true until the next save.
  Only for changes no step undoes or redoes (`setProxy`). Listeners hear 'amend'.
- `begin(label)` / `commit()` / `cancel()` group several `do` into one undo step (slider drags, live trims). Nested
  pairs join the outer group; `cancel()` takes back everything since the outer begin. `grouping` is true inside one.
- `list()` -> `[{ label, done }]`, oldest first: the steps that can be undone, then those that can be redone.
  `position` is how many are done; `goTo(position)` undoes or redoes until that many are done, in one go with one
  change event (an open group is committed first) -> true when it moved (the history panel).
- `squash(position, label)` joins the steps done after `position` into one step named `label` (an AI assistant's turn:
  each edit is a step while the turn runs, then the turn is one); the project does not change, the list does
  ('commit'); an open group is committed first; -> true when there was a step to name.
- `onChange(fn)` (fn(reason) with 'do' | 'undo' | 'redo' | 'commit' | 'amend'; 'commit' when a group became a step: the list
  changed, the project did not; returns a remover), `dispose()`, `serialize()` -> JSON text.

A command is a plain object `{ type, ... }` built by helpers on `Cut.commands`, so a test or a panel writes
`history.do(Cut.commands.split(seqId, t))`. Each command records the inverse of every change, so undo is exact.
After every command the project must still `validate()` (else `invalidResult`). Labels are English
(`Cut.commands.label(cmd)`, `LABELS`), shown through `tr()`.

Options are nested, never spread to the top level. The builders:

- media: `importMedia(mediaList, binId?)`, `removeMedia(ids)`, `relinkMedia(id, {path, size, mtime, duration?, video?,
  audio?})` -> `{ trimmed, removed }` (clip ids: with a shorter `duration` the clips past the new end end at its last
  whole frame, a reversed one loses its head; one with no frame left, a freeze frame of a later time or a remapped clip
  past the end is removed, all in the same step),
  `addBin(name, parent?)`, `removeBin(id)`, `renameItem(id, name)`, `moveToBin(ids, binId)`,
  `setProxy(mediaId, {path} | null)`
- project: `setSettings({fit, stillDuration, transitionDuration, freezeDuration, textStyles, speechTerms})`,
  `setSpeakers({list?, turns? /* {mediaId: turns | null} merged into the old */, count?} | null)` (label Speakers; the
  result is checked by `validate`: every turn's speaker in the list, turns in order; `null` removes the labels),
  `addLut({id, entry})` (label Load LUT; `Cut.lumetri.store`'s result into `project.luts`; the same id again changes
  nothing; a bad entry is refused with code `invalid`). `project.luts` (optional) is `{ 'lut-<16 hex>': { name, title,
  size, min, max, data /* base64 float32 rgb */ } }`; `validate` checks every entry, `migrate` drops the ones no
  effect's `lut` names and the damaged ones (`model.lutsInUse(project)`)
- sequences: `addSequence(opts)` (`{from: seqId}` duplicates), `removeSequence(id)` (its nest clips in other sequences
  go too),
  `setSequence(id, patch)` (name, w, h, fps, background, masterGain)
- tracks: `addTrack(seqId, kind, index?, {name})`, `removeTrack(seqId, trackId)`, `setTrack(seqId, trackId, patch)`
- placing: `place(seqId, { source, in, out, at, video: trackId | null, audio: trackId | null, mode: 'insert' | 'overwrite' })`
  (linked video and audio clips; a `{sequence}` source places a nest clip, video and audio as `nestKinds` says, its
  whole length by default, unnamed; refused with `nestLoop` when it would loop and `emptySequence` for an empty one;
  `paste` refuses a loop the same way), `placeRange(seqId, { source, in, out, range: {in, out}, video, audio, mode })`
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
  source; not both), ripple, reverse, enabled, name, label, role, fadeIn, fadeOut, sampling (label Time
  Interpolation)), `setKeyframes(seqId, clipId, path, keyframes | null)`, `setRemap(seqId, clipId, remap | null)` (label
  Time Remapping; a video clip with source frames plays the curve, null a constant speed again (the speed at its start).
  Only the clip changes: its linked audio keeps its speed (time remapping is video only, as in Premiere). As in
  Premiere it does not push later clips: a longer curve grows the clip up to the next clip (`clamped: 'neighbour'`)
  and the rest waits past its end; it also stops where the curve leaves the source (`'source'`). A transition at its
  end moves with the end. -> `{ duration, clamped }`), `link(seqId, ids)`, `unlink(seqId, ids)`, `setRole(seqId, clipIds, role, { linked })` (linked
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
  `setCaption(seqId, trackId, itemId, patch)`, `removeCaption(seqId, trackId, itemId)`. A caption item may carry
  `doubt`; `setCaption` drops it when the patch changes the text, unless the patch names `doubt` itself (`null`: none,
  Mark as Checked; the old one: Claude's polish, which did not hear the speech). An item's `words` go through
  `Cut.captionwords.realign` in every command that takes an item (fitted to its text, dropped when they cannot be);
  `setCaption` fits them to a changed text, keeps them relative for a move (start and end by the same time) and in
  place for a trimmed start, and takes `words` itself (`null`: none). An item's `speaker` (`sp<n>`) stays through
  every edit; `setCaption` sets it (`null`: none). Ripples, the split of a caption across an insert
  and a frame rate change carry them with their sound (`captionwords.remap`).
- masks: `addMask(seqId, clipId, mask, { effectId })`, `setMask(seqId, clipId, maskId, patch, { effectId })`,
  `removeMask(seqId, clipId, maskId, { effectId })` (Masks above)
- nesting: `nest(seqId, clipIds, { name, linked })` (label Nest, Premiere's Clip > Nest): the clips, with what links
  to them and the rest of their groups unless `linked: false`, move into a new sequence (this one's size, rate,
  background and number of tracks of each kind; each inner track hidden, muted and soloed as its outer one, its volume
  and pan less those of the audio track the nest clip lands on, which apply to the nest clip, so the nest sounds and
  looks as the tracks did; a balance pan composes exactly only when that landing track is centered), each on the track
  at the same place among its kind, at its time from
  the earliest of them, keyframes, effects and clip markers unchanged; a transition moves along when every clip at its
  edit point does; a link not moved whole is dropped from the moved side. One nest clip spans [earliest start, latest
  end): video on the lowest of their video tracks, audio on the lowest audio track, linked, overwriting the rest of
  that span there. The sequence joins the bin of this one. -> `{ id /* the new sequence */, ids /* the nest clips */ }`;
  `noClips` for an empty list, `locked` for a clip on a locked track
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
`speed`, `gain`, `fps`, `size`, `nestLoop`, `noClips`, `emptySequence`, `remap` (a speed edit of a remapped clip, or
remapping an audio clip), `source` (a curve that starts outside its source),
`binLoop`, `invalidResult`, `damaged`, `notFound` (unknown ids). `migrate` adds `newer` and `notProject`.

### `Cut.srt`

`parse(text) -> [{start, end, text}]` (SRT), `write(items) -> text` (CRLF), `parseVtt`, `writeVtt` (LF),
`parseAny(text, name)`, `isVtt(text, name)`, `formatTime`, `decode(bytes) -> text` (UTF-8 with or without BOM,
UTF-16 LE/BE by BOM, else CP949 when it is not valid UTF-8; the CP949 extension is computed when the runtime's
`euc-kr` decoder lacks it, as Node's does).

### `Cut.captionwords`

A caption's word timings, for the word-by-word highlight (`captionwords.js`, pure, loaded before model.js; tests in
`verify/cut-model.mjs`). `tokens(text)`, `spans(line) -> [[from, to]]`, `valid(words, text)` (one word per token, in
order, whole ticks, t0 never decreasing: what `model.validate` asks), `realign(words, text, {frame, duration}) -> words
| null` (the tokens matched to the old words by the longest common run, compared without case and punctuation, keep
their times; a run of new tokens takes the time of the old words it replaces, else the pause between its neighbours
(or 0 and `duration` at the ends), split evenly on frames; null when a run has less than a frame a word, when no
token matches, or for anything that is not words), `remap(words, from, to, fn(x, isEnd))` (each absolute time through
fn, relative to `to`), `remapDoubt(doubt, from, to, fn, length)` (a caption's `doubt` the same way, each `at` as a
word start; only those within `[0, length]` stay, so a doubt marks the caption that holds its word's start), `lit(words, rel) -> index | -1` (the last word begun, until the next begins; the last one until
it ends; a word of no length never), `litAt(item, t)` (-1 when the words do not fit the text), `MODES`.

## 7. Main process

Files: `main/features/cut.js` (registers the `cut:*` channels; `module.exports = { register, cutHome }`) and helpers
in `main/cut/`: `paths.js` (path checks), `limits.js` (sizes), `project.js` (projects, autosave, sessions,
recovery), `sink.js` (export sink), `faststart.js`, `cache.js`, `find.js` (findMedia, listMedia), `fonts.js`,
`runs.js` (which run wrote a marker), `whisper.js` and `speech-words.js` (speech recognition, below), `ai.js` (text AI
through Claude Code, below), `control.js` and `agent.js` (the control API's MCP server and the AI assistant's turns,
below and docs/cut-ai-control.md). Tests: `verify/cut-main.mjs` (plain Node with Electron stubbed); `verify/cut-speech.mjs`
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
  filterName})` -> path | null, `cut:pickLut({title, filterName, allName})` -> one `.cube` path | null (Lumetri
  Color's Look; the renderer reads it with `cut:read`), `cut:saveAs({defaultPath, filters, title})` -> path | null (the
  first filter's extension is added when the name has none). `PYIDE_CUT_DIALOG` (tests) names a JSON file
  `{pickMedia, pickFolder, pickProject, pickLut, saveAs}`, read at each call; each dialog returns that value (missing = cancelled) without
  showing anything.
- `cut:projectRead(path)` -> `{ text, path, mtime, autosave? }` | `{ missing }` | `{ error, code }` (`autosave: true`
  for a file in the Autosave folder: the editor opens it as an unsaved project, since the cleanup deletes files there by
  name; `cut:projectWrite` refuses that folder with code `autosave`);
  `cut:projectWrite(path, text, { mtime? })` -> `{ ok, path, bak, kept, mtime }` | `{ error, code }`. With `mtime`
  (the time `cut:projectRead` or the last write gave) a file whose time differs now (another window or program saved
  it) is not written: `{ code: 'changed', mtime }`; the editor asks before it writes without the time (Overwrite).
  There is no lock across app instances. Only `.ncut`, the text must be a JSON
  object, the folder must exist. Temp file, flushed to the disk (fsync), then rename; every save keeps the file it
  replaces as `.ncut.bak` (`bak`), and when the format version changes also as `.ncut.v<old version>.bak` (`kept`),
  which later saves leave alone.
- `cut:autosave(key, text, {latest, keep})` (key: the project path, or `untitled-<id>`) -> `{ ok, file }`: a copy
  `<autosave>\<name>-<hash>-<stamp>.ncut`, the newest `keep` (1 to 100, default 20) copies kept per key, or with
  `latest: true` the latest state `<stamp>.latest.ncut`, only the newest kept; neither kind pushes out the other.
  `cut:autosaves(key)` -> `[{ file, time, latest }]`, newest first (File > Restore Autosave). `cut:sessionStart(key)` (also clears an
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
  co64 stays co64), and keeps the mdat header form. The temp file is a full copy: with less free space than it needs
  (plus 64 MB) it returns `{ error, code: 'diskFull' }` without writing, and while it exists it is in the sink's
  journal, so a crash leaves no `.faststart.tmp` after the next start. The file is whole either way.
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
    Models: `whisper-small` (`openai/whisper-small`) and `whisper-large-v3-turbo` (`openai/whisper-large-v3-turbo`,
    the default: 128 mel bins and its own alignment heads, both read from its repo); installed means
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
    terms /* the word list */, request })` -> `{ words: [[t0, t1, text, p]] /* seconds from offset; p: Whisper's
    confidence */, end /* where Whisper's text stops, s; null: no text */, language, ms }` | `{ cancelled: true }` |
    `{ error, code: 'notInstalled' | 'model' | ... }`; `cut:speechCancel(request)` (seen between generated tokens).
    The sidecar loads the model from the cache only (`HF_HUB_OFFLINE=1`), writes no words for a window quieter than
    -50 dBFS (Whisper writes text into silence), detects the language with one encoder pass for `auto`, decodes a
    window again at a higher temperature when its tokens repeat (zlib ratio over 1.35) or their average
    log-probability is under -1 (`FALLBACK`, temperatures 0 to 1.0, seeded so the transcript is the same every
    run) and skips one it is unsure of whose no-speech probability is over 0.6 (small: lyrics under a music intro;
    large-v3 turbo's stays near 1e-11, so it never skips), and reads each of Whisper's segments with its own token
    times (the joined sequence restarts the times of a segment begun anew at the window's end), each word kept
    inside its segment's start and end. A word's `p` is the lowest probability of its tokens (punctuation left out),
    from the kept decode's scores times its temperature (the scores of a sampled decode are the logits divided by it;
    a wrapper on `_need_fallback` records the temperature of the last decode, the one kept). `terms` (strings only,
    tidied, at most 200 of 100 characters: `whisper.termsOf`) goes to Whisper as the text before the window
    (`prompt_ids` of "term, term, …", as many terms as fit in 200 tokens, the first ones kept). `speech-words.refine(samples, words)` then narrows each word to its sound: the span is
    split into runs at quiet gaps of 0.25 s; a segment's first word is its last run (Whisper starts it before the
    pause ahead, at a window's start even over speech it did not write out), any other word its longest run.
  - `cut:speechConfigure({ idleMinutes })`, `cut:speechTestConfig({ delay, load, unload, stopAfter })` (fake only: the
    time per window, the time the next model load takes, the model unloaded as after idle, and a first window whose
    text stops after `stopAfter` seconds with its `end`, as Whisper does under music; the fake reports `loading` and
    `ready` like the sidecar).
  - `PYIDE_WHISPER_BACKEND=fake`: no Python; `speech-words.fakeWords` gives one word per burst of sound above -35 dBFS
    (testsrc beeps, tone stretches), its text from `FAKE_WORDS` by the burst's half second in the file and its p from
    `FAKE_P` (자막을/we 0.31 and 편집이/is 0.42 are uncertain); with a word list, 자막을/we is heard as its first term
    (p 0.99).
    `PYIDE_WHISPER_FAKE_SETUP=ok | offline | disk | noPython`: the runtime and the models start missing and the setup
    pretends to download (progress in ten steps), then succeeds or fails with that code.
- Speaker labels (`main/cut/speakers.js`, `createSpeakers({ script, speech, log, env })`): one speaker embedding per
  window of speech from WeSpeaker ResNet34-LM (`Wespeaker/wespeaker-voxceleb-resnet34-LM`: `voxceleb_resnet34_LM.onnx`,
  26.5 MB, and `config.yaml`) through onnxruntime on the CPU, in the sidecar `main/ai/speaker_server.py` inside the
  same shared AI environment (no torch needed; idle unload after `ai.idleUnloadMinutes`). It reads the 16 kHz temp
  files of speech recognition (`speech.sound(owner, id)` of `createSpeech`, after their writes), so the renderer
  streams a media file's sound with `cut:speechOpen`/`cut:speechWrite` and closes it with `cut:speechClose`.
  - `cut:speakersStatus()` -> `{ backend: 'wespeaker' | 'fake', runtime /* python, onnxruntime, numpy and
    huggingface_hub importable */, runtimeBytes, model: { name, repo, bytes, installed /* both files in the Hugging
    Face cache; HF_HUB_CACHE moves it */ }, engine: { state }, stats: { setups, embeds, windows, cancelled } }`.
  - `cut:speakersSetup()` -> `{ ok }` | `{ ok: false, code, error, log? }` (codes as `cut:speechSetup`, by its
    `classify`), only after Download: the free space, `ensureVenv` (no torch), the missing packages, then
    `snapshot_download(repo, allow_patterns=[the two files])`. Progress: `cut:speakersProgress` `{ phase: 'runtime' |
    'download' | 'done', fraction /* null while unknown */, bytes, text }`. `cut:speakersCancelSetup()`.
  - `cut:speakersEmbed(fileId, { windows: [[offset, length]] /* samples, at most 30 s each, 20,000 at most */,
    request })` -> `{ dim: 256, data: Uint8Array /* float32 LE, dim per window */, ms }` | `{ cancelled: true }` |
    `{ error, code: 'notInstalled' | 'notFound' | 'badArgs' | 'model' }`; `cut:speakersCancel(request)` (seen between
    batches of 32); a window that closes cancels its embeddings (`ownerGone`, before speech's deletes their sound). The features are Kaldi fbank as WeSpeaker trained on them (80 mel bins, 25 ms frames every 10 ms,
    Hamming window, no dither, samples scaled to 16 bit, each window's mean taken away), computed in numpy step for step
    as `torchaudio.compliance.kaldi.fbank` (torchaudio is not in the environment). Windows of one length run together.
  - `cut:speakersConfigure({ idleMinutes })`, `cut:speakersTestConfig({ delay })` (fake only: ms per window).
  - `PYIDE_SPEAKERS_BACKEND=fake`: no Python; a window's embedding is its energy at 24 log-spaced frequencies (Goertzel,
    `fakeEmbedding`), so tones of different pitch are different speakers. `PYIDE_SPEAKERS_FAKE_SETUP=ok | offline |
    disk | noPython`: the model starts missing and the setup pretends to download it, then ends with that code.
- Voice isolation (`main/cut/voice.js`, `createVoice({ script, mediaDir, cacheDir, tmpDir, onCached, log, env })`): the vocals
  stem of HTDemucs (`adefossez/HTDemucs`, one 84 MB safetensors file named by `htdemucs.yaml`) on the CPU, in the sidecar
  `main/ai/voice_server.py` inside the same shared AI environment (idle unload after `ai.idleUnloadMinutes`).
  - `cut:voiceStatus()` -> `{ backend: 'demucs' | 'fake', runtime, runtimeBytes, model: { id, name, repo, bytes, installed },
    engine: { state }, stats: { setups, separations, cancelled, last }, open /* temp files */ }`. The runtime is ready
    when the environment has a usable torch and demucs, einops, julius, safetensors, soundfile, tqdm and numpy; the model
    when the yaml and the weight files it names are in the Hugging Face cache (`HF_HUB_CACHE` moves it; an empty folder
    gives the missing state).
  - `cut:voiceSetup()` -> `{ ok }` | `{ ok: false, code, error, log? }` (codes as `cut:speechSetup`), only after Download:
    the free space, `ensureVenv(..., { torch: true })`, torch when missing, `pip install --no-deps demucs` (its
    dependencies would bring sphn, lameenc and pyyaml), then einops, julius, safetensors, soundfile, tqdm, numpy and
    huggingface_hub, then `snapshot_download('adefossez/HTDemucs')`. Progress: `cut:voiceSetupProgress` `{ phase:
    'runtime' | 'download' | 'done', fraction, text }`. `cut:voiceCancelSetup()`.
  - Sound: `cut:voiceOpen({ channels: 1 | 2 })` -> `{ id }` (`%TEMP%\nano-studio-voice\<pid>-<id>.f32`),
    `cut:voiceWrite(id, bytes)` (float32 LE, 44.1 kHz, interleaved; whole frames, 16 MB a call, 4 GB a file),
    `cut:voiceClose(id)`. Files belong to their window; files of a process that is gone are removed at start.
  - `cut:voiceFind({ name, key })` -> `{ path, place }` | `{ missing }`: a WAV made before, in the media folder first.
  - `cut:voiceSeparate(id, { request, name, key /* 8-32 hex */, place: 'media' | 'cache', frames })` -> `{ ok, path, place,
    frames, ms }` | `{ cancelled: true }` | `{ error, code: 'notInstalled' | 'disk' | 'model' | 'io' | ... }`. The WAV is
    `<place>\<name> voice <key>.wav` ('media' = `<home>\Media`, outside the cache's LRU; 'cache' = `<home>\Cache`, indexed
    by it), 16-bit, 44.1 kHz, the input's channels, at least `frames` long (silence after the sound), written as `.part`
    and renamed when complete; a cancel or a failure deletes the `.part`. Progress: `cut:voiceProgress` `{ request,
    fraction }`; the model's state: `cut:voiceState`. `cut:voiceCancel(request)` (seen between segments). The sidecar
    builds the model from the safetensors metadata (`klass` must be `demucs.htdemucs.HTDemucs`; `kwargs` with `segment` as
    a fraction), takes the input's offset out (a 1 s moving average; HTDemucs adds each segment's mean back to every stem,
    which filled the vocals' pauses), scales by the whole sound's deviation (as `demucs.separate` does), and runs one
    7.8 s segment at a time with a quarter of overlap and `demucs.apply`'s triangular cross-fade, writing each finished
    part at once, so its memory is the same for any length.
  - `cut:voiceConfigure({ idleMinutes })`, `cut:voiceTestConfig({ delay })` (fake only: ms per second of sound).
  - `PYIDE_VOICE_BACKEND=fake`: no Python, the vocals are the sound itself. `PYIDE_VOICE_FAKE_SETUP=ok | offline | disk |
    noPython`: the runtime and the model start missing and the setup pretends to download, then ends with that code.
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
  - `main/ai/claude.js` also exports `launch(bin, args, {env})` (the CLI in its empty folder; a `.cmd` shim runs
    through cmd.exe, so an argument with a quote, a percent sign or a line break is refused), `classify(message)` ->
    `'auth' | 'quota' | 'cli'` (a usage or rate limit is `quota`), `killTree`, `systemPromptFile`, `WORK_DIR`.
- Control API (`main/cut/control.js`, `createControl({ configFile, log, version })`; docs/cut-ai-control.md): an MCP
  server (Streamable HTTP, JSON answers, no event stream) on 127.0.0.1, `POST /mcp`. `start()` -> port (the one in
  `<userData>\cut-control.json` when free), `setTools(definitions, instructions)` (from the page), `issue(turn,
  owner)` -> a chat turn's token, `revoke(token)`, `setExternal(on)` -> `{ on, url, token }` (the external token,
  kept in the config file with the port; off drops it), `disconnect()` (a new external token, its sessions ended),
  `connected()` -> `[{ name, since }]` of the external sessions seen in the last 10 minutes, `onClients(fn)`,
  `answer(msg)`, `abandon()` (pending calls end as errors), `close()`. A request needs `Authorization: Bearer
  <token>` (compared in constant time; else 401), no `Origin` and a `Host` of `127.0.0.1:<port>` or
  `localhost:<port>` (else 403), and at most 1 MB (413). `tools/call` of a listed tool goes to the page
  (`cut:controlCall { id, name, args, client: { kind: 'chat', turn } | { kind: 'external' } }`) and the page's answer
  (`cut:controlResult { id, result: { content, isError } }`) is the reply. Channels: `cut:controlTools(definitions,
  instructions)` (the page that answers is the one that listed the tools last), `cut:controlExternal(on)`,
  `cut:controlDisconnect()`, `cut:controlClients()`; event `cut:controlClients { external }`.
- AI assistant turns (`main/cut/agent.js`, `createAgent({ control, log, find, launch, kill, timeoutMs = 20 min })`):
  `cut:agentRun({ turn /* [\w.-]{1,64} */, system, prompt, model })` runs the CLI with `--tools "" --strict-mcp-config
  --mcp-config <a file with this turn's token> --allowedTools mcp__cut__<each tool> --permission-mode dontAsk
  --no-session-persistence --disable-slash-commands --max-turns 80` (and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`), sends
  its stream-json as `cut:agentEvent { turn, type: 'text' | 'tool' | 'result' | 'done', ... }` and answers `{ ok,
  text }` or `{ ok: false, code: 'not-installed' | 'auth' | 'quota' | 'cli' | 'cancelled' | 'timeout' | 'badArgs',
  error }`; the token is revoked and the file deleted when the turn ends. `cut:agentStop(turn)`; a window that goes
  stops its turns.

## 8. Engine

Files: `lumetri.js`, `effects.js`, `scopes.js`, `textrender.js`, `media.js`, `decoder.js`, `compositor.js`, `player.js`, `thumbs.js`. Tests:
`verify/cut-engine-core.mjs` (Node) and `verify/cut-engine.mjs` (app, port 9753).

### `Cut.effects`

The registry: `list()`, `get(type)`, `defaults(type)`, `resolve(type, params)`, `transitions()`,
`defaultTransition(kind)`, `categories(kind)`, `whiteBalance(linearRgb) -> {temperature, tint}`, `srgbToLinear`,
`linearToSrgb`, `hexToLinear`, `LUMA`, and `wgsl`/`cpu` helpers for the compositor and the tests (`cpu.basicPlan(params)`
-> the color.basic gains and settings, `cpu.basicPixel(linearRgb, plan)`; Cut.analyze's auto color uses them, so the
color math stays here).

A def: `{ type, name /* English, shown through tr() */, category, kind: 'video' | 'audio', params: [{ id, name, type:
'number' | 'angle' | 'percent' | 'color' | 'bool' | 'choice' | 'point' | 'curve' /* [x0, y0, x1, y1...], keyframed as
a whole */ | 'lut' /* an id of project.luts */, min, max, step, default, choices? /* [[id, English label]] */,
keyframable, group? /* Lumetri Color's section, shown by Effect Controls */ }], gpu, cpu, canvas2d, assets?, masks? /* false: takes no masks (Edge Extend) */ }`. `gpu.wgsl` is the body, `gpu.code` the complete
WGSL. A video effect's `gpu.uniforms(params, {width, height, pxScale, quality, frame})` returns a list of passes (each
at most 16 floats; `[]` means nothing to do); a transition's `gpu.uniforms(params, progress)` returns one array.
`cpu(image, params, info)` is the reference the tests compare with, `canvas2d(params, info)` a hint for the 2D back end
(a CSS `filter`, `flipX`/`flipY`, `crop`, `mosaic`, `vignette`, `extend`), or `{ skip: true }` when 2D cannot do the
effect and draws the picture without it. Transitions have no hint: the 2D back end draws push and wipe itself and a
cross dissolve for the others. `info.frame` is the clip-local frame (`compositor.planItem` gives it), so what looks
random (grain, glitch) is a hash of integers, the pixel and the frame (`cpu.hash3(x, y, z)` and the WGSL `hash3`, a
PCG hash in u32 arithmetic, the same bits on both), and every render of a frame agrees. In WGSL an effect reads its
pass's input with `tap(uv)` and the effect's own input with `tapOrig(uv)` (binding 3, the same texture in the first
pass), which sharpen and glow use after a separable blur; `texel(uv)`, `toSrgb`, `toLinear` and `hash3` are shared
helpers. Audio effects have `gain(params, tSeconds, lengthSeconds)` -> linear gain, or `dsp`, the name of a processor
in `Cut.audiofx.processors` (section 9); `crossfade.power` has `gains(progress)` -> `[outgoing, incoming]`.

Type ids. Video: `flip.horizontal`, `flip.vertical`, `crop`, `edge.extend`, `blur.gaussian`, `blur.directional`,
`sharpen` (amount, radius = sigma, threshold), `mosaic`, `color.bw`, `color.tint`, `color.brightnessContrast`,
`color.basic` (Lumetri Color: the basic correction's temperature, tint, exposure, contrast, highlights, shadows,
whites, blacks, saturation, vibrance; the Creative Look `lut` (an id of project.luts) and `lutIntensity`; the curves
`curveMaster`, `curveRed`, `curveGreen`, `curveBlue`; the HSL secondary's `hslHue`, `hslHueRange`, `hslHueSoft`,
`hslSatLow/High/Soft`, `hslLumLow/High/Soft`, `hslMask` and its correction `hslTemperature`, `hslTint`, `hslContrast`,
`hslSaturation`, `hslHueShift`; one pass per section that changes something, in Lumetri's order, `u.p[3].w` naming
the stage; the math is `Cut.lumetri`'s),
`color.invert` (in sRGB values), `color.hue` (CSS hue-rotate matrix on linear light), `vignette`, `glow` (a bright
pass, then a two-pass blur added onto the input), `posterize` (sRGB steps), `chromatic` (radial or linear),
`glitch` (bands of `bandHeight` moved by a hash of the band and `floor(frame / hold)`), `distort.lens` (center + d (1 +
curvature / 200 r^2)), `key.chroma` (CbCr distance in Rec. 709 Y'CbCr of the sRGB values; similarity, smoothness, spill,
output composite or matte), `noise.grain` (value noise with cells `size` pixels across, added to the sRGB values).
Audio: `audio.gain`, `audio.fade`; processors `audio.eq` (hpOn/hpFreq/hpSlope '12'|'24'|'48', lsOn/lsFreq/lsGain,
b1..b3 On/Freq/Gain/Q, hsOn/hsFreq/hsGain, lpOn/lpFreq/lpSlope, output), `audio.bass` and `audio.treble` (boost),
`audio.compressor` (threshold, ratio, attack, release, knee, makeup), `audio.limiter` (ceiling, release, truePeak),
`audio.gate` (threshold, attack, hold, release, range), `audio.dehum` (frequency '50'|'60', harmonics, reduction, Q).
Transitions: `dissolve`, `dip.black`, `dip.white`, `push`, `slide`, `wipe`,
`iris.round` (open or close, feather), `zoom.cross` (zoom amount); audio `crossfade.power`.

### `Cut.lumetri`

The math of Lumetri Color's sections after the basic correction (pure; effects.js reads it when used, so a page that
loads effects.js alone still works). Curves, the LUT and the qualifier work on the sRGB values shown (0..1); the
corrections inside the qualifier work in linear light.

- Curves: `points(flat)` (clamped, sorted, points closer than `MIN_GAP` dropped, 2 to `MAX_POINTS` 16; anything
  unusable is the straight line), `sanitize`, `flatten`, `slopes`/`evalCurve` (a monotone cubic, Fritsch-Carlson, flat
  beyond the ends), `isIdentityCurve`, `curvesIdentity(params)`, `curvesTable(params)` (`TABLE` 1024 entries x master,
  red, green, blue, cached by `curveKey`), `curvesPixel(linearRgb, table)` (master on every channel, then each channel's
  own, linear between table entries as the shader reads them).
- LUTs: `parseCube(text)` -> `{ title, size, min, max, data: Float32Array }` or throws an Error with `code: 'lut'`, an
  English message template and `params` (line numbers, counts): not text, no LUT_3D_SIZE, a 1D LUT, a size outside 2..65,
  a data line without three numbers, a bad number, too few or too many lines, an upside-down domain, two sizes.
  Keywords are upper-case words (others ignored); `#` starts a comment anywhere. `store(lut, name)` -> `{ id, entry }`
  (id `lut-` + a 64-bit FNV-1a of size, domain and numbers), `validEntry`, `decode(entry, id)` (cached per entry
  object), `lutOf(project, id)`, `sampleLut(lut, srgb)` (trilinear, domain-normalized and clamped), `lutPixel(rgb, lut,
  k)` (mixed in sRGB values), `identityCube(n, {min, max})`, `toBase64`/`fromBase64`, `toHalf`, `lutHalf`, `curvesHalf`
  (the rgba16float data for the GPU).
- HSL secondary: `hueOf(srgb)`, `hslPlan(params)` (`active` when it changes anything), `hslMask(rgb, plan)`,
  `hslPixel(rgb, plan)` (Show Mask: the keyed pixels in their color, the rest `MID_GRAY`, sRGB 128), `qualifierFor([r,
  g, b] 0..255)` (the eyedropper's key: 50 degrees of hue, 30 soft, saturation and luma around the color),
  `HSL_PARAMS`.

### `Cut.scopes`

The Lumetri Scopes' counts (pure). `layout(cols = 256, size = 256)` -> offsets of one u32 array: `wave` (level x
column), `parade` (three planes), `vector` (size x size, Cb right, Cr up, +-`RANGE` 0.6), `hist` (red, green, blue,
luma x 256). `frameRect(width, height, seqW, seqH)` (the frame's box in a letterboxed output), `stepFor(rect)` (every
`step`-th pixel across and down, about `BUDGET` 262,144 pixels), `analyze(rgba, width, height, rect, {cols, size,
step})` -> `{ bins, layout }`, `WGSL`, `uniforms`, `dispatch` (the compute pass the compositor runs), `views(bins,
layout)`, `peaks(plane, cols)`, `vectorPeak(vector, size)`, `vectorBin`, `vectorAt`, `angleAt`, `chroma`,
`targets(size)` (75% and 100% bars), `SKIN_DEGREES` (123). All integer math on the 8-bit values: Y' = (13933 R + 46871
G + 4732 B + 32768) >> 16, Cb = (-7509 R - 25259 G + 32768 B) >> 7, Cr = (32768 R - 29763 G - 3005 B) >> 7 (Rec. 709),
so the GPU's and the CPU's bins agree exactly.

### `Cut.textrender`

`draw(ctx2d, layers, { w, h, t, clip, scale })` (synchronous; call `prepare(layers)` first so the fonts are loaded),
`drawCaptions(ctx, items, style, {w, h, scale, t})` (the style's `size` is in pixels of a picture whose shorter side is
`style.ref`, 1080; it is drawn at `size * min(w, h) / ref` sequence pixels; `model.migrate` converts a size saved
without `ref` other than the default 54 by `1080 / min(w, h)`; with `style.highlight` and `t`, the token
`captionwords.litAt(item, t)` is drawn in `highlightColor`, or for `highlightMode: 'box'` on a rounded box of it in
black or white, also in `'color'` mode for a line whose color is within 150 ("redmean" RGB distance) of the highlight,
such as the yellow and orange speaker colors: the line is drawn whole twice, clipped to the word and to the rest, so the glyphs never move), `measure(layer, ctx?) -> {lines, width, height, lineHeight, box}`,
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
  captions on top when asked. Renders on one compositor never overlap. It resolves to `{ failed: [{ clip, name, media,
  missing, error }] }`: the items drawn as a red "Media Offline" or "Media Cannot Be Shown" frame instead (a nest's
  clips too; `missing` when the file is not there), so the export can tell a slate it was asked for from one it was not.
- `renderMedia(project, mediaId, t, opts)`, `renderSequence(project, seqObject, t, opts)`, `prefetch(project, seqId,
  from, to)`, `idle()` (resolves once frames are back with their decoders: call it before `destroy()`),
  `readPixels() -> Promise<Uint8Array RGBA>`, `videoFrame(init)` (a VideoFrame of the canvas), `resize`, `stats`,
  `info`, `errors`, `lost` (WebGPU device loss, reported, not recovered; null on the 2D back end), `width`, `height`.
- `scopes({ cols = 256, size = 256 })` -> `Promise<{ bins, layout, rect, step, width, height, backend } | null>`: the
  Lumetri Scopes' counts (`Cut.scopes`) of what the canvas shows now. WebGPU runs `Cut.scopes.WGSL` as a compute pass
  over its rgba8unorm output (the frame's box only, `scopes.frameRect`), the histograms gathered per workgroup, and
  reads the bins back (one count at a time; null while one is under way); the 2D back end counts its canvas's pixels
  on the CPU (`scopes.analyze`). Both count the same integers, so the GPU's bins equal the CPU's over `readPixels()`
  exactly. It waits for a render in progress, not for the read back, so playback does not wait for it.
- Effects that read tables (`gpu.bindings`, Lumetri Color's LUT and curves) get them at bindings 4 and up:
  `gpu.textures(params, info)` names each by a key and gives its rgba16float data; the compositor makes one texture per
  key (the last 24 kept beyond those a frame uses) and binds a small dummy for an empty one. `planItem` gives each
  effect `assets` (`def.assets(project, params)`: the LUT of project.luts), passed on as `info.assets`.
- Units: position and anchor in sequence pixels; anchor from the center of the fitted clip before scaling; rotation in
  degrees clockwise; crop `[top, right, bottom, left]` % in the clip's own frame. Text and solid clips are full-frame
  layers with the same transforms. Each clip on screen gets its own frame source. An effect pass binds its input
  (binding 0) and the effect's input (binding 3, `orig`).
- WebGPU: intermediate pictures are rgba16float, linear light, premultiplied; sRGB / Rec.709 out. The 2D fallback does
  transforms, opacity, crop, text, the transitions and colors through CSS `filter` (mixed in sRGB values; vignette is a
  radial gradient; wipes have a hard edge; edge extend and the effects whose hint is `{ skip: true }` are not drawn;
  slide, iris round and cross zoom are drawn as a cross dissolve). Missing media draws a red "Media Offline" frame.
- Nests: `planItem` of a nest clip is `{ kind: 'nest', sequence, srcT /* its time in that sequence */, layers /* plan(project,
  sequence, srcT) */, ...the clip's own effects and motion }`. Every item carries `key` (the ids of the nest clips above
  it and its own, `'c12/c4'`, so a clip shown through two nests at once gets two frame sources and text canvases) and
  `seqW`/`seqH` (the sequence it is placed in). Back ends draw a nest's layers into a transparent picture of its
  sequence's size fitted to the outer one (`fitScale`, like a video frame of that size; the nested sequence's
  background is not drawn, as in Premiere), then run the nest clip's effects on it and place it with its crop, motion
  and opacity. `prefetch` follows nests to the frames they show. Later features (masks, time remapping) change the nest
  item as they change any item (its masks and effects, its `srcT` through `sourceTime`), never its `layers`.
- Masks (`Cut.masks`): every item carries `masks` (Opacity's, `masks.at` at its clip time; null when none counts) and
  each of its effects `masks` (null likewise; never for a def with `masks: false`). They work in the item's own frame,
  before its crop and motion, so they follow the clip. WebGPU: after an effect's last pass, a mask pass (`masks.WGSL`:
  binding 0 the effect's output, 1 its input, 2 the uniforms, 3 a read-only storage buffer of `masks.gpuData`, all of a
  frame's lists in one buffer at 256-byte offsets) mixes the output over the input by the coverage; after all effects
  another pass multiplies the picture by Opacity's masks' coverage (binding 1 then weighs 0). An effect with no passes
  (neutral parameters) gets no mask pass. Canvas 2D: `masks.canvasCoverage` draws the coverage as a canvas's alpha
  (the modes are canvas compositing: source-over, destination-out, destination-in and xor are exactly Add, Subtract,
  Intersect and Difference; expansion is a round-joined stroke of twice its size, exact; the feather is approximated by
  a Gaussian blur of sigma = feather / 3.76, the smoothstep's slope at the edge, within about 0.03 of coverage along the
  ramp); Opacity's masks are a destination-in of it, and an item with a masked effect draws its effects one at a time,
  a masked one mixed over its input (destination-out and destination-in, added with 'lighter'). A nest item's masks
  apply to the nested picture; the clips inside keep theirs in its `layers`.
- Time remapping: a remapped clip's item is an ordinary item; its `srcT` is `model.sourceTime` (the curve) and its
  `frameIndex` stays the clip-local frame (grain and glitch still change through a hold). `extendedSourceTime` reads
  the curve past the clip's ends for transitions, `missingHandles` divides by the speed there, `prefetch` decodes
  `model.sourceSpan` (a reverse part's range too). Frame Blending (`clip.sampling === 'blend'`, a media file of constant
  rate): the item carries `blend: { srcT /* the next source frame */, w /* 0..1, how far past the frame before */ }`
  (null on a frame and for Frame Sampling); `fetchSources` decodes that frame too (`frameB`, released with the first);
  WebGPU draws it over the first with weight w (`decodeExternal` with `rot.y = w`, blended OVER, in linear light), 2D
  with `globalAlpha`. A nest item is not blended (its sequence has no frames to mix).
- Pure helpers: `plan(project, seq, t, scope = '')`, `planItem` (with `blend` and `masks`), `fitScale`, `transitionRange`, `extendedSourceTime`, `missingHandles(project,
  seq, transition) -> {a, b}` (missing handle ticks, for the striped warning), `captionsAt(seq, t, which) -> [{style,
  t, items}]` (`t` at the start of its frame, so a playing monitor and export light the same word), `mediaSequence`.

### `Cut.player`

`create({ app, canvas, audio /* Cut.audioengine instance or null */, mode: 'program' | 'source', backend, hardware,
captions /* true | a track id | a function giving one, asked at each draw */, overlays, proxy, size })` -> `{ play(rate = 1), pause(), seek(t), playing, rate, quality, setQuality(q),
dropped, setProxy(on), ready /* Promise of the compositor */, compositor, audio /* the audio engine given */, render(), frameRect() /* the frame in CSS
pixels */, stats() /* {shown, dropped, fps, renderMs, renderMaxMs} */, on(fn) /* frame, play, pause, error */,
destroy() }`. It renders `app.t` whenever the time, the project, the sequence or the shown caption track (`captionTrack`) changes; while playing it follows the
audio clock (only at rate 1 in program mode; one that stands still 2.5 s gives way to the wall clock) or
`performance.now()`, moves `app.setTime` with the clock even while a slow frame is still drawing, prefetches ahead,
counts dropped frames and pauses `Cut.thumbs`. `RATES` are the J/K/L shuttle rates (-8..8). Source mode reads and writes
`app.source.t`.

### `Cut.thumbs`

`strip(project, mediaId, { from, to, count, height, wanted }) -> Promise<[ImageBitmap]>` (shared bitmaps: callers must not
close them; `wanted() === false` stops its decoding, before its turn or between frames, and gives what is made: the
timeline and the project panel pass "this project is still open"), `peaks(project, mediaId, { samplesPerPeak })` -> min/max pairs at the track's own sample rate, all
channels together; both cached through `cut:cacheGet/Put`. A strip whose thumbnails are further apart than twice the
distance to their sync sample shows that sync sample (one decoded frame each, through `decoder.keyFrames`); closer
ones show their exact frame. Peaks are computed about ten seconds at a time through `decoder.audioReader`, at 256
samples a peak; a multiple of that is merged from them (`coarsen(peaks, k)`), so the panel (512), the timeline (256)
and the monitor (1024) share one decode. Thumbnails and peaks run in two queues, so a long file's peaks never hold
back thumbnails. Also `computePeaks`, `pause(on)` (holds both, also between the exact frames of
a strip and the blocks of peaks already under way: the player pauses them while it plays), `paused`, `queued`.

## 9. Sound and export

Files: `presets.js`, `audiofx.js`, `audioengine.js`, `export.js`, `testsrc.js`, and `analyze.js` (the automation's
measurements). Tests: `verify/cut-export-core.mjs`, `verify/cut-audiofx-core.mjs` and `verify/cut-analyze.mjs` (Node),
`verify/cut-export.mjs` (app, port 9754), `verify/cut-auto.mjs` (app, port 9757) and `verify/cut-mixer.mjs` (app, port
9778).

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

A clip whose effects include a processor (`dsp`) runs all its enabled audio effects in order as one chain
(`audiofx.createChain`; gain effects become stages in their place) over its source sound, before its volume, fades
and pan. The chain runs in segments of 32,768 samples counted from the clip's first audible sample, each from a
warm-up of the stages' summed `memory()` (at least 32 samples, at most `audiofx.MAX_MEMORY` = 4 s) before it, or the
clip's start, with fresh state, and on 512 samples past its end, which cross-fade linearly into the next segment's
start; the stages' `latency()` is taken out. Segments are kept (96, LRU) under a key of the clip's source range,
place, transitions, effects and their keyframes; a segment whose input blocks are not read counts the clip as
`missing`, and `load` reads the warm-up and the tail too. Effect parameters and the clip's gains are read on a
32-sample grid from the same first sample. So a sample of the mix does not depend on the block it is mixed in or on
where playback started: the preview and the export give the same samples (`verify/cut-audiofx-core.mjs`,
`verify/cut-mixer.mjs`).

- `create(app, { getAudio, rate })` -> `{ start(t, rate = 1) -> Promise, stop(), now() /* sequence ticks heard */,
  meters() -> { master, masterChannels: [l, r], masterRms: [l, r], tracks: {id: dB}, trackChannels: {id: [l, r]} }
  /* dBFS of the block being heard (about 43 ms): peaks, RMS; a track's after its fader and pan; -Infinity when
  silent */, setMasterGain(db), close(), playing, rate, masterGain, context, mixer }`. Rates 0.25 to 4 play forward
  like tape; other rates are silent while the clock runs. The Audio Meters panel (ui-meters.js) and the Audio Track
  Mixer (ui-mixer.js) read `meters()` of the program player's engine (`player.audio`). `mix()` also returns
  `rms: [l, r]` of the master. `opts.onBlock(sample, [L, R], missing)` sees every block the preview schedules (tests).
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
  48 blocks kept, least recently used dropped, except the blocks a `load` (or a block read for `mix`) in progress
  reads: they are pinned until it is done, so clips of one mix far apart in one file no longer push out each other's
  blocks. Blocks are resampled from windows aligned to an output sample with the filter's reach on both sides, so they
  join without a seam. `load` reads at most 120 s of the source from the start of its range per clip; `mix` counts a
  clip whose blocks are not read yet as `missing`, lists it in `missed: [{clip, media}]` (media null for a nest) and
  asks for them; a source with no sound is not missing. The preview reads 15 s ahead of what it schedules; the export,
  `measure` and `renderOffline` go through `mixLoaded`. `failures()` -> `[{media, error}]` of the sources that could
  not be read (a nest's too), `held()` -> `{blocks, segments}` bytes in memory.
- A clip at another speed is one stream: its source range (reversed when it plays backwards) through the WSOLA stretch
  (or, with the pitch not kept, the resampler) made in segments of at most 10 s of output and about 40 s of source
  (`stretchPart`, `resamplePart`), 32 kept (LRU). The stretch's frame path starts afresh at each segment (that frame
  at its nominal place), so a segment needs only its own window of the source and the first one equals stretching the
  whole range; only the source of segments not made yet is read. A 2-hour source at 8x holds about 250 MB (it held the
  whole range and a copy of it, 7.7 GB). A fresh frame (a clip's first) reads the input from its nominal place from
  its middle on: one placed at `outPos / factor` read silence before the clip's first sample, so every sped-up clip
  began with 10 ms of nothing and a 10 ms fade.
- A nest clip on an audio track is a source like a file: a store of 10 s blocks whose reader `read(from, to)` is the
  nested sequence's `mix` (after `load`) over those samples, so its tracks' volume, pan, mute and solo and its
  `masterGain` are in it, and the nest clip's speed, reverse, effects, volume, pan and fades apply on top. The store's
  key is `nest:<seqId>:<hash>`, the hash of the JSON of that sequence, the sequences under it and their media: an edit
  inside is heard at once, and the stores of earlier contents are dropped. The key is kept per project revision
  (`model.revisionOf`: a history counts every change of its project in the symbol `model.REVISION`), so `mix` does not
  hash the nest every block; a project no history edits is hashed every time.
- Also `transitionRange`, `resample`, `stretch`, `kFilters`, `dbToGain`, `gainToDb`, `makeBuffer`,
  `decodeTrack(reader, track)`, `fileReader(path)`, `defaultGetAudio` (used when `Cut.decoder` is missing).

### `Cut.audiofx`

The clip audio effects' signal processing, pure and deterministic (double arithmetic, no clock, no randomness).

- `processors.{eq, bass, treble, dehum, compressor, limiter, gate}`: `{ latency(rate) -> samples, memory(params, rate)
  -> seconds after which the state no longer depends on what came before (about -100 dB), create(rate) -> state,
  process(state, L, R, from, to, params) }` in place on Float64Arrays; the state carries over between calls, so any
  split of a signal into calls gives the same samples. Filters: RBJ Audio EQ Cookbook biquads in transposed direct
  form II (`design(type, f0, gainDb, Q, fs)` -> `[b0, b1, b2, a1, a2]`; types lowpass, highpass, peaking, lowshelf,
  highshelf, notch and `cut` = 1 - (1 - g) BP for the hum notches, whose bandwidth stays Q at any depth), high- and
  low-pass as Butterworth sections (`BUTTERWORTH`), coefficients recomputed only when the parameters change, a 0 dB
  band skipped (bit-exact pass-through), subnormal states flushed. Compressor: feed-forward, stereo linked, the
  soft-knee static curve (`compressCurve`) smoothed in dB with the attack while the reduction grows and the release
  while it shrinks. Limiter: 1.5 ms look-ahead (latency 1.5 ms + 8 samples), the needed gain (with `truePeak`, also the
  16-tap 4x interpolated peaks either side) pulls the gain down on a straight line over the look-ahead, exponential
  release, and a final clamp that only rounding can reach. Gate: a 5 ms peak follower of the louder channel, open at
  or over the threshold and for the hold time after, attack to 1 and release to the range; it starts closed.
- `createChain(stages, rate)` -> `{ process(L, R, n, {paramsAt(k, i), secondsAt(i)}), latency }`: stages
  `{proc}` or `{gain(params, seconds)}` run in order, one `CONTROL` (32) sample block at a time; a stage's parameters
  are read at its block's start moved back by the latency before it.
- `filtersOf(dsp, params)`, `response(dsp, params, freqs, fs)` -> dB (the effect controls' graph), `magnitudeDb`,
  `ringSamples`, `processBuffer(dsp, params, [L, R], fs, {blocks})` (one processor over whole channels, the latency
  taken out; for tests), `MAX_MEMORY`, `BASS_HZ` 200, `TREBLE_HZ` 4000, `LOOKAHEAD_MS` 1.5.

### `Cut.export`

`run({ project, seqId, path, preset, settings, overrides, range: {in, out} | null, captions: 'burn' | 'srt' | 'both' |
null, captionTrack, onProgress, signal, hardware: 'auto' | 'hardware' | 'software', backend, masterGain, verify,
getAudio, compositor })`:

- Renders each frame with a compositor on an OffscreenCanvas at the export size and encodes it with VideoEncoder
  (H.264 High at the preset bitrate, keyframe interval from the preset; HEVC only with a hardware encoder). `'auto'`
  tries the hardware encoder first, then software; a hardware encoder that fails on the way gets one more try in
  software. For a compositor that is not WebGPU, each frame is copied into a GPU-backed canvas first: Chromium's
  encoders turn frames from CPU memory into full-range YUV that decodes too dark. Export stops with code
  `'compositor'` when the compositor reports GPU errors or loses its device (looked at after every frame and once
  the last one is drawn), instead of writing black video.
- Media offline when the export starts (`preflight`, the dialog warned and asked) shows as the red "Media Offline"
  picture with no sound; the result lists those clips (`offline: [clip ids]`, and a `verified.problems` entry with code
  `'offline'`). Any other item the compositor draws as a red frame, a sound clip still `missing` after `mixLoaded`, or a
  source in `failures()` stops the export with code `'media'`, its message naming the clip, the sequence time and the
  reason (`lostMedia`, `lostSound`; the result also has `clip`, `media`, `t`). It is not retried in software; the part
  file is deleted as on any failure.
- Mixes the sound with the audio engine's mixer and encodes AAC-LC 48 kHz stereo at the chosen bitrate, falling back
  to the next lower one that works (the error arrives in the encode callback, not from configure). The AAC priming
  delay is measured once per configuration (`aacDelay`) and the audio is shifted by it.
- Muxes with `Cut.mp4write` into the `cut:writeOpen` sink (the `.part` file is renamed on success, deleted on cancel
  or failure), writes SRT sidecars when asked, runs `cut:faststart`, then verifies: re-opens the file with probe,
  checks frame count and track durations, decodes the first and last frames.
- A write the sink refuses (a full disk, a removed drive) stops the export at once with the sink's code (`diskFull`,
  `io`): the frames are no longer rendered to the end. Cancel also stops a wait for an encoder's queue or flush. A
  failed faststart is not a failure: the export succeeds with `faststart: false` and a `faststart` problem in
  `verified.problems` (the file plays, but a player reads all of it before it starts).
- The path's extension is replaced with the preset's (`mp4` or `m4a`).
- Success: `{ ok, path, bytes, seconds, speed /* x realtime */, frames, range, verified: { ok, frames,
  expectedFrames, duration, audioDuration, firstFrame, lastFrame, problems: [{ code, message /* English, for
  tr(message, params) */, params }] }, encoder: { codec, hardware }, audioDelay, audioBitrate, loudnessGain /* dB the loudness target added */, sidecars: [paths] }`.
- Failure: `{ ok: false, code, error }` with code `cancelled`, `noSequence`, `settings`, `empty`, `noEncoder`,
  `encode`, `audio`, `compositor`, `media`, `decode`, `io` and the sink's codes.
- Progress events: `{ phase: 'audio' | 'video' | 'finish' | 'verify', done, total, fraction, elapsed, eta, speed }`.
- A numeric `settings.loudness` (LUFS) makes `run` measure the mix first (`audioengine.measure`, progress phase
  `audio`) and add `audioengine.matchGain(measured, target)` (true peak kept under -1 dBTP) to `seq.masterGain` and
  `opts.masterGain`. `presets.resolve(..., {loudness: null})` turns the target off; a missing key keeps the preset's.

Also: `exportFrame(project, seqId, t, path, {backend})` -> PNG (through a VideoFrame of the compositor canvas),
`framePng(project, seqId, t, {width, captionTrack})` -> `{ ok, bytes, width, height }` (the same PNG in memory, at most
`width` wide, the captions of `captionTrack` burned in; the control API's `get_frame`),
`chapters(seq, {firstName = 'Intro', range})` -> YouTube chapter text, `chapterProblems(seq)`,
`preflight(project, seqId, range)` -> `{ offline: [{id, name, path}], empty }` (inside nests too, over the part a nest
clip shows), `saveBytes(path, bytes | text)`,
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
`{ t0, t1, text, p? }` (seconds per media file; ticks on the timeline, with `clip` and `src`, the word's index in its
transcript; `p` Whisper's confidence, 0-1, absent in transcripts cached before it was kept).

- Windows: `nextWindow(from, to, stop /* s into the window, or null */, { total, again = true })` -> `{ next /* samples,
  null after the last */, until? }`: the next window starts 5 s before this one ends, or at `stop` when Whisper's
  text stopped there with more than 6 s of the window left (`until` = `stop`; not for a window that itself began at a
  stop, `again: false`); `textStop(words, end, { pause = 2.5 })`: the end of the first word followed by 2.5 s without
  words, else the sidecar's `end`; `windows(total, { size = 30 s, overlap = 5 s })` -> `[[from, to]]` (the walk when
  no window stops early); `mergeWindows(results /* [{ from, to, until?, words: [[t0, t1, text, p?]] }] */, { edge = 1.5 })`
  -> words in seconds: a window's words count up to `edge` seconds before its end (or up to `until`; the last
  window's all), the next window's from the last one counted on; `dedupe(words)` drops a word
  heard twice (the same text within 0.5 s, or overlapping by half).
- Timeline: `clipWords(clip, words)` (the words whose middle the clip shows, through `analyze.toTimeline`: in, speed,
  reverse; none for a freeze frame), `joinClips(lists)` (a word two overlapping clips hold kept once), `wordAt(words, t)`.
- Captions: `captions(words, { maxChars /* 0: 18 for Korean text, else 42 */, maxLines = 2, maxDuration = 6, pause = 0.6,
  linger = 0.3, minDuration = 0.8, frame })` -> `[{ start, end, text /* lines joined with \n */, words /* each word's
  t0, t1 from the caption's start, on frames */, doubt? }]`: a new caption at a
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
- Confidence: `UNCERTAIN` (0.5), `isUncertain(word, threshold = UNCERTAIN)` (p under it; never without p, and p 1 is a
  word the person corrected); `captions(..., { uncertain })` gives a caption the `doubt` of its uncertain words. The
  measure and the threshold come from the speech benchmark (8 conditions, 3,161 words, 321 wrong): the lowest token
  probability of a word found the wrong words best (average precision 0.67, against 0.62 for the geometric mean, 0.58
  for the mean and 0.57 for the first token). Below 0.5: precision 0.67, recall 0.57, 8.7% of the words marked (clean
  speech: 1 of 421); below 0.3: 0.85 and 0.32 (3.8%); below 0.7: 0.45 and 0.76 (17.4%). Music hallucinations are
  confident and seldom marked (recall 0.13 in music10).
- Word list: `parseTerms(text)` (one a line or between commas, tidied, each once, at most `TERMS.count` 200 of
  `TERMS.chars` 100), `termsKey(terms)` (FNV-1a fingerprint, '' for none), `dropEcho(words, terms)` (two or more list
  terms in a row with the list's commas: Whisper reading the list back where nobody speaks, dropped). Measured with
  the passages' names: Korean white and pink noise +0.9 to +1.5 points (names heard 9-16 -> 19-21 of 22), clean
  +0.1, the English music-intro file -5.7 (a phrase made up in the room noise after the speech); an irrelevant list
  left clean speech as it was, lost 0.8 in white noise, and was read back after the speech until `dropEcho` (93.1 ->
  97.2 Korean, 87.5 -> 91.3 English, on the stored outputs).

### `Cut.speakers`

Who speaks when, from speaker embeddings of the speech recognition found (`speakers.js`, pure; tests
`verify/cut-speakers-core.mjs`). Words are a transcript's `{ t0, t1 }` in source seconds; `DEFAULTS` holds the tuned
options (`gap` 0.3, `sentences` true, `short` 4, `size` 3, `hop` 1.5, `min` 1, `trust` 0.8, `threshold` 0.5,
`minSpeech` 2.5, `spare` 3, `minRun` 1, `limit` 1500; benchmark below).

- Windows: `segments(words, { gap, sentences })` -> `[[first, last]]` word indexes without a pause of `gap` s, also
  split after a word that ends a sentence (. ? ! and a closing quote: in noise Whisper's refined times lose the pause
  between two speakers, and a window across the change is neither of them);
  `windowsOf(words, opts)` -> `[{ t0, t1, seg, speech }]`: a segment up to `short` s is one window, a longer one
  `size` s windows every about `hop` s from its start to its end; a window under `min` s takes the silence around it
  (at most half of each pause, the part one side cannot take goes to the other).
- Clusters: `tree(unitVectors)` -> `[{ a, b, sim }]` merges, most similar first (average linkage on cosine, NN-chain,
  O(n²)); `cut(n, merges, { threshold } | { count })` -> a root per item; `cluster(embeddings, speech, { count, threshold,
  trust, minSpeech, limit })` -> a speaker index per window (0, 1, … by first appearance; -1 without an embedding).
  Windows with less than `trust` s of speech stay out of the tree (all of them when none has enough), at most `limit`
  evenly spread windows go in. Clusters with less than `minSpeech` s (or 15% of all the speech, whichever is less) are
  strays. Auto (`count` null or 0) cuts at `threshold` and leaves the strays out; a count cuts `spare` clusters finer,
  leaves strays out while more than `count` remain, then joins the two most alike centroids until `count` are left
  (cutting the tree at the count itself kept one odd 1 s window as a speaker and joined two real speakers: 71.5% of
  the words right on the noisy 3-speaker case, 100% this way). Every window then takes the nearest kept centroid.
  At most `MAX` (10).
- Words: `wordLabels(words, windows, labels, { minRun })`: each word takes the label its windows vote for (overlap
  times `min(1, length / size)`); inside a segment a run shorter than `minRun` s joins the longer neighbouring run.
  `turnsOf(words, ids)` -> `[[t0, t1, id]]` (a speaker's words joined; the silence between two speakers split in its
  middle; milliseconds; overlapping word times, as at a window seam, never give overlapping turns: a turn starts where
  the one kept before it ends, one left empty is dropped and its neighbours join when they are one speaker's); `at(turns, t, reach = 1)` -> the id at source second t (or the nearest turn within reach);
  `assign(turns, a, b, id)` -> the turns with [a, b) given to `id` (split around, joined with neighbours of `id`).
- Labels made again: `match(oldTurns, newTurns, newIds)` -> `Map(newLabel -> oldId)` by shared time, largest first;
  `listFor(count, before, matched, taken)` -> `{ list, ids }`: matched speakers keep their entry (name, color), new ones
  get the next `sp<n>` above every id of the list and of `taken` and a `PALETTE` color not used yet; `inUse(project)`
  -> the list's ids and every caption's `speaker` in every sequence (`taken`: a caption keeps its id after its speaker
  leaves the list, so that id never goes to someone else).
- Names and captions: `nameOf(speakers, id, tr)` (its name, else `tr('Speaker {n}')` by its place), `colorOf`,
  `runsOf(words)` (runs of one `speaker`), `shown(speakers, style, item, tr)` -> `{ prefix /* 'Name: ' with
  style.speakerName */, color /* with style.speakerColor */ }`, `decorate(project, captionsAt, tr)` (each item with
  `prefix` and `color` for `textrender.drawCaptions`, which draws the prefix before the first line, never lit by the
  word highlight, and the item in that color), `written(project, track, items, tr)` (names in the text, for SRT and
  VTT files).

Benchmark (scratchpad `speakerbench`, not in the repository): Korean and English dialogues of 2 and 3 speakers
(67 to 91 s, 18 or 19 turns, pauses of 0.25 to 0.9 s, no overlap) made with Windows SAPI. This PC has one voice per
language (Heami, Zira), so the speakers are that voice played 1.2 times faster and 0.84 times slower (pitch and formants
move together, like a shorter or longer vocal tract) at their own SAPI rates; one clean and one noisy copy each (white
noise at 20 dB SNR, or synthetic music 12 dB under the speech). The words are Whisper small's through the app's own
windows and refine; the score maps the labels to the script's speakers in the best way. Results with the defaults
(one run; the embeddings are the same every run):

| Case | Speakers | Auto found | Words right (Auto) | Speech time right (Auto) | Words right (count given) |
| --- | --- | --- | --- | --- | --- |
| ko2 clean | 2 | 2 | 99.3% | 99.0% | 99.3% |
| ko2 music | 2 | 2 | 100% | 98.4% | 100% |
| ko3 clean | 3 | 3 | 99.2% | 98.9% | 99.2% |
| ko3 noise | 3 | 3 | 100% | 99.8% | 100% |
| en2 clean | 2 | 2 | 99.1% | 98.7% | 99.1% |
| en2 noise | 2 | 2 | 100% | 99.2% | 100% |
| en3 clean | 3 | 3 | 100% | 100% | 100% |
| en3 music | 3 | 3 | 100% | 99.9% | 100% |

Auto finds the number of speakers in 8 of 8 cases for a threshold anywhere from 0.45 to 0.55 (English alone: 0.35 to
0.65, so a choice made on English carries to Korean). Without the sentence splits the best threshold found the count
in 7 of 8 (96.9% of the words), and 2 s or 1.5 s windows were less stable than 3 s ones. The embeddings take a median
of 0.63 s per minute of sound (0.49 to 0.83 s, 12 runs over four cases, about 20 ms a window, so the time follows the
number of windows) after a 0.6 s load, on a Ryzen 7 4800H; clustering takes under 5 ms. The speakers are one voice
changed in speed, with no overlap, one room and level and clean turn-taking. Real people (two similar voices, phone
sound, crosstalk) are harder, so these numbers are an upper bound; the threshold was also tuned on the same eight
cases it is scored on.

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
`ui-keys.js`, `ui-timeline.js`, `ui-controls.js`, `ui-effects.js`, `ui-text.js`, `ui-color.js`, `ui-overlay.js`, `ui-masks.js`, `ui-auto.js`,
`ui-history.js`, `ui-meters.js`, `ui-markers.js`, `ui-speech.js`, `ui-ai.js`, `ui-assistant.js`, `ui-shortcuts.js`, `ui-settings.js`,
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

`Cut.ui.lifecycle = { newProject, open, openPath, save, saveAs, saveCopy, askToSave, autosaveNow, autosaveCopy, offerRecovery, restoreAutosave,
key, dirty, lastAutosave, lastCopy, projectName }`. An untitled project at start (with `Cut.ui.projectDefaults()`);
`cut:autosave(..., {latest: true})` 2 s after edits stop (only when dirty, not inside a history group) and
`autosaveCopy()` every `cut.autosave.minutes` (copies kept: `cut.autosave.keep`) while dirty with edits the last copy
lacks; `cut:sessionStart/End` per key (Save As from untitled ends `untitled-<id>` and starts the
path); the recovery offer from `cut:recovery`, with `cut:recoveryDismiss` for what the user declines;
`restoreAutosave()` (File > Restore Autosave…) lists `cut:autosaves(key)` and opens the chosen one in place of the
project, unsaved, under the same path and session. A file from the Autosave folder opens untitled and modified. The unsaved
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
the rest the name alone with a probed duration within one frame. A file found or located is probed before it is
used: another kind or another set of streams (sound where there was none, or none where there was) is refused with
the reason; a shorter one is asked about (the lengths and how many clips use the part past its end) and relinked with
its duration, so `relinkMedia` cuts those clips in the same step. Import calls `Cut.ui.proxy.offer`. `matchSequence` uses `Media.video.w/h` as they
are (already upright).

### Monitors (`ui-monitors.js`)

`Cut.ui.monitors = { source, program }`, each `{ el, view, canvas, player, app, seek, pause, run, fullscreen, ... }`;
`program.showTrim({left, right} | null)` shows the frames on either side of an edit point (the timeline calls it
during edge trims). The program monitor draws through `Cut.player` with the audio engine; the source monitor plays the
media through a `Cut.state` app of its own (a one-clip project at the media's size and rate, the player in program
mode). A sequence opened there (the project panel's Open in Source Monitor) is a copy of the editor's project whose
first sequence holds one nest clip of it, rebuilt at each change of the project; Insert and Overwrite then place a nest
clip and its drag handles give `{kind: 'source', sequenceId, in, out, video, audio}`. `app.source = {mediaId, in, out,
t}` or `{sequenceId, in, out, t}`, with In/Out in source ticks; Out is the exclusive end (playhead + 1
frame), like the sequence Out. Monitor buttons: safe margins (`overlays: ['safe']`), playback quality
(`setQuality`), Proxy (`setProxy`, setting `cut.proxy`), dropped-frame count, full screen.

### Export, captions, keys

- `Cut.ui.exportDialog = { open(app), exportFrame(app), form(app), chaptersText, running }`. It calls
  `Cut.export.run({ project /* a JSON copy of app.project made when Export is pressed: commands change the project in
  place, so edits during the export went into the rest of the file */, seqId, path, preset, overrides, settings:
  presets.resolve(...), range, captions, signal, onProgress })`, offers `Cut.presets.AUDIO_BITRATES` (default 192 kbps), measures loudness with
  `Cut.audioengine.measure`, passes `chapters(seq, {firstName: tr('Intro')})`, and shows `verified.problems` through
  `tr(message, params)`.
- The form's `enqueue()` (Add to Queue in the dialog and the Export Settings panel) runs the same checks as `start()`
  and hands `Cut.ui.exportQueue.add({ project: a JSON copy of app.project, seqId, seqName, fps, path, settings (the
  resolved settings), range, captions, captionTrack, presetName })`. `Cut.ui.syncBusy()` sends `window:setBusy` with the dialog's
  export and the queue's live jobs; `start()` refuses while the queue runs and calls `exportQueue.kick()` when done.
- `Cut.ui.captions = { importFile, exportFile, importDialog, exportDialog, styleDialog, trackOf, reveal(app, t) }`. A
  caption with a `doubt` is `.uncertain` (a yellow edge) with its words under the text (`.cut-cap-doubt-word`, the
  confidence in percent; a click seeks to the word) and a check mark (`.cut-cap-doubt-ok`, `setCaption` with
  `doubt: null`); the foot counts them; `cut.speech.markUncertain` off hides it all. The style dialog
  (`#cutCaptionStyle`) also has the highlight (`.cut-cap-hl`, `.cut-cap-hl-color`, `.cut-cap-hl-mode`) and says how many
  of the track's captions have word timings (`.cut-cap-hl-note`). The track shown (`trackOf(app)`: the one chosen in `.cut-cap-track`, the
  first until then) is also the one the program monitor's player draws (`captions: () => trackOf(app)?.id`) and export
  burns in (the form's `captionTrack`, also on queued jobs; `.cut-export-burn-track` names it when the sequence has
  several tracks); a change emits `captionTrack` {id}.
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
  `Cut.ui.auto.clipMenuItems` (Audio Role, Automation). `nest()` opens the Nested Sequence Name dialog
  (`#cutNestDialog`, the first free "Nested Sequence N") for the selection and runs `nest` with the timeline's linked
  selection; the clip menu, Clip > Nest… and the action `Cut.nest` call it. A drop of `{kind: 'sequence', id}` (the
  project panel) or of a source with `sequenceId` places a nest clip; one that would loop, or of an empty sequence, is
  refused with its message before anything changes. A double-click on a nest clip opens its sequence (a timeline tab)
  at `sourceTime` of the playhead (clamped into the clip). Nest clips are drawn in `--cut-clip-nest` with a two-frame
  mark and the sequence's name (`c.name` first).
- Time Remapping on the clip's line (Premiere's rubber band). A video clip has an fx badge (yellow with effects) whose
  menu, like Clip > Show Clip Keyframes, picks what the line shows: Opacity or Time Remapping > Speed (`view.band`,
  per clip id, not saved; a remapped clip shows its speed until another choice). The speed line is a log scale (10% at
  the bottom, 100% in the middle, 1000% at the top), a transition's span shaded, reverse parts red and holds blue on the
  bottom; each key is two halves on the line and a tab above it. Hit parts: `rband` (the line), `rkey` with `half`
  (`left`, `right`, `tab`) and `keyIndex`, `fx` (the badge). Ctrl+click on the line, or a click with the Pen, adds a key
  (`remap.addKey`); dragging the line sets that segment's speed (`setSegmentSpeed`, Shift steps of 5%, a tooltip with
  the speed and the clip's new length); dragging a half splits the key into a transition (`splitKey`); dragging the tab
  moves the key keeping its source frame (`moveKey`), Alt keeps the speeds instead; Ctrl-drag makes a reverse segment
  of the dragged length (`insertReverse`, then forward again), Ctrl+Alt-drag a hold (`insertFreeze`). Each drag is one
  `setRemap` step through `liveEdit`. A key's context menu has Join Speed Transition and Delete Keyframe. Clip >
  Video Options > Time Interpolation and the clip menu's Time Interpolation set Frame Sampling or Frame Blending
  (`setSampling(id)` on the selected video clips). Speed/Duration on a remapped clip shows the reason instead of the
  dialog, and the clip menu's Speed submenu is off. `remapPoint(clipId, t, {index, half} | null)` gives the client point
  of the line or a key (tests). A remapped clip's name ends in "(Time Remapping)"; its thumbnails show the frame the
  curve reaches under each tile.
- Effect Controls of a video clip with source frames has Time Remapping > Speed after Opacity (`[data-section=
  "remap:<clipId>"]`, row `[data-path="remap.speed"]`): the speed at the playhead (at the start off the clip); typing
  sets the segment under the playhead; the stopwatch adds a key at the playhead (curve on) or removes the curve (a
  constant speed at its first speed); the arrows go to the keys; the diamond adds or removes the key at the playhead.
  The lane draws the speed (the same log scale) and each key, a split one as two with its transition shaded. Cut's own
  Speed section (speed and reverse, later clips moving along) stays at the end for clips without a curve; a remapped
  clip has none.
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
- `Cut.ui.overlay = { attach(viewEl, app, player) -> {detach, editText, pickColor, sample, layout, placement, geometry, editor},
  editText(clipId, {created}), pickColor() -> Promise<[r, g, b] | null>, pickColorAt(u, v), active }`. Text editing
  sets `Cut.ui.typing` while open and is one undo group per visit.
- Masks (`ui-masks.js`): `Cut.ui.masks = { selected /* {clipId, effectId, maskId} | null */, pen /* {clipId, effectId} |
  null */, select(app, sel), startPen(app, target), stopPen(app), editing(app), create(app, clip, effectId, 'ellipse' |
  'polygon'), remove(app, sel), maskOf, prefix, screen(), clientPoint(u, v) }` (each change emits the app event `mask`);
  `Cut.ui.maskOverlay.attach({ layer, app, player, frameRect, placement, toSeq })` is called by the overlay, draws on its
  layer with its geometry and returns `{ layout(clip), detach() }`; while a mask of the shown clip (or the pen) is
  active the overlay hides the motion handles. Effect Controls (`maskBlock` in ui-controls.js) puts the three mask
  buttons (`.cut-ec-maskellipse`, `.cut-ec-maskpoly`, `.cut-ec-maskpen`) and each mask (`.cut-ec-maskhead[data-mask]`,
  then the rows Mask Path, Mask Feather, Mask Opacity, Mask Expansion, Inverted, Mask Mode through the usual
  `paramRow`, keyed by the mask paths) at the top of Opacity and of every video effect whose def takes masks;
  `Cut.ui.edit.defaultOf`/`setStatic` know the mask paths (`setMask`). On the monitor, hit order: the feather and
  expansion handles, a smooth vertex's handles, a vertex (Ctrl: delete, Alt: corner/smooth), the outline (insert, then
  drag), inside (move), outside (deselect); every gesture is one `edit.gesture` (Mask Path, Mask Feather, Mask
  Expansion).
- The Lumetri Color panel (`ui-color.js`, panel `color`) edits the selected video clip's `color.basic` in sections
  (Basic Correction, Creative, Curves, HSL Secondary, Vignette, folded ones in `cut.color.collapsed`); every control
  writes through `Cut.ui.edit.write` (a keyframe at the playhead when the parameter has keyframes) inside one
  `history.begin/commit`. Its white balance eyedropper sets temperature and tint to the current values plus
  `Cut.effects.whiteBalance(the linear color seen, with saturation and contrast undone)`; its Auto button runs
  `Cut.ui.auto.autoColor`. Browse… asks `cut:pickLut`, reads the file (`cut:stat`, `cut:read`, 64 MB at most),
  `Cut.lumetri.parseCube`s it and runs `addLut` and the Look in one step (`Cut.ui.color.readLut(path)` -> `{id,
  entry}`); a refusal shows `tr(message, params)` in the section and as a notification. The curve square
  (`canvas.cut-lm-curve`, `data-pad` CSS pixels around its 0..1 area) adds, drags (one step), Ctrl+click removes, a
  double click straightens (the point its first click added is undone). The HSL eyedropper sets
  `Cut.lumetri.qualifierFor(the color seen)`.
- The Lumetri Scopes panel (`ui-scopes.js`, panel `scopes`) asks the program monitor's compositor for `scopes()` after
  each frame it draws (the player's `frame` and `pause` events), at most every 40 ms stopped and every 150 ms (WebGPU)
  or 300 ms (2D) playing (`budget` a quarter of `Cut.scopes.BUDGET` then), only while it is on screen, and draws the waveform, parade, vectorscope and histogram on 2D
  canvases (dark plots in both themes). `Cut.ui.scopes`: `last` (the counts drawn, with `at`, `t`, `renders`),
  `count`, `shown`, `refresh()`.
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

### Audio Track Mixer and Essential Sound (`ui-mixer.js`, `ui-audiofx.js`)

- Mixer (panel `mixer`): a strip per audio track of `app.sequence` (pan knob, M and S, a fader over `track.volume` in
  dB on a console scale from -inf at the bottom through 0 dB at 84% to +6 dB at the top: the timeline header's 0-200%
  is the same value, 200% being +6.02 dB and 0% -144 dB; a stereo meter; the name) and a master strip over
  `seq.masterGain`. A fader or knob drag is `history.begin('Track Volume' | 'Master Volume' | 'Track Pan')`, a
  `setTrack`/`setSequence` per move, `commit()`; Alt+click resets, a double click on the value or the knob types it.
  Strips are rebuilt only when the tracks or their names change. Meters as in the Audio Meters panel (rise at once,
  fall 30 dB/s, hold 1.5 s) from `meters().trackChannels` and `masterChannels`. `Cut.ui.mixer = { strips, running,
  fader(id) /* client geometry of the travel and the cap */, rect(id, part), posOf(db), dbOf(pos), refresh }`.
- The Audio workspace is defined in ui-shell.js (mixer, effect controls and source; program; Essential Sound; the
  timeline and the meters below); ui-mixer.js adds its own only when the shell has none.
- `Cut.ui.effectViews[type]({app, clipId, effectId}) -> {node, update()}`: the effect controls put `node` above an
  effect's rows and call `update()` with them. ui-audiofx.js registers the frequency response graph for `audio.eq`,
  `audio.bass`, `audio.treble` and `audio.dehum` (20 Hz to 20 kHz, +-24 dB, the curve from `Cut.audiofx.response` at
  the playhead's parameter values, the EQ's bands as dots; redrawn on resize and theme change).
- Essential Sound (panel `essential`): the selected audio clips (`ui.auto.soundClips`), their type (`ui.auto.setRole`)
  and actions; the effect presets are `Cut.ui.audiofx.PRESETS`, added by `addEffects(app, preset, label)` in one
  `batch`.

### Speech recognition (`ui-speech.js`)

- `Cut.ui.speech = { autoCaptions(app), removeFillers(app), ensureReady(modelId?) -> Promise<bool>, transcribe(app,
  clips, ctx, range?), timelineWords(app, clips, range?), speechClips(app, { selected }), settingsSection(host, ctx),
  status(), forget(), defaults, nextUncertain(app, dir), editTerms(app), correctWord(app, word, text), terms(app),
  marking(), percent(p) }`. `ensureReady` shows the setup dialog (`#cutSpeechSetup`: the model's and the
  runtime's sizes, "runs entirely on this PC", Download with progress, the failure explained, Try Again) when the
  model or the runtime is missing; nothing is downloaded before Download is pressed. Called without `modelId` (before a
  recognition) with the runtime there and the other model installed, it also offers Use <that model> (`.cut-speech-other`
  says so), which sets `cut.speech.model` to it and resolves true: someone with only small is not sent to a 1.6 GB
  download, or stopped offline, by the turbo default.
- The clips: audio-track clips with sound, enabled, not a freeze frame, whose role is not music, effects or ambience;
  the selected ones (with their links) when there are any; only those the In-Out range touches when it is set.
- Sound: each media file's needed source seconds (the clips' parts in the range and a second around them, less what
  its transcript covers already) are read with `Cut.decoder.audioReader` in 10 s blocks, mixed to mono, resampled to
  16 kHz with `Cut.audioengine.resample` (each block starts on an output sample and reads the filter's reach on both
  sides, so the blocks join without a seam) and streamed to `cut:speechWrite`; windows of 30 s go to
  `cut:speechTranscribe` one after another, each starting where `Cut.speech.nextWindow` says (5 s of overlap, or
  where the window before stopped early), and `mergeWindows` joins the answers. One `Cut.ui.auto.task` shows the progress (with
  "Loading the speech model…" as soon as main reports `loading`, while the first window's request waits) and Cancel,
  which also cancels the window in flight.
- Transcripts: per media file, model, language and word list (key
  `speech|v2|<path>|<size>|<mtime>|<model>|<language>` plus `|t<Cut.speech.termsKey(list)>` when the project has a
  word list, so a transcript made without one keeps its key; the `v` goes up whenever what Whisper is asked changes,
  so older transcripts are recognised again), kept in memory and in the Cut cache (`cut:cachePut`, JSON `{ v: 1,
  ranges, language, words: [[t0, t1, text, p?]] }` in source seconds; transcripts cached before confidences were kept
  have no `p`, and their words are never marked), and mapped to the timeline with `Cut.speech.clipWords` whenever they are shown, so edits need no new
  recognition. The app emits `transcripts` when new ones are made.
- Auto Captions: the dialog `#cutSpeechCaptions` (the scope, language, characters per line, the word list
  `.cut-speech-terms`, the highlight `.cut-speech-highlight` (setting `cut.speech.highlight`, false; over an existing
  "Auto Captions" track it starts from that track's `style.highlight`, and a change goes into the batch); a changed list is its own undo step `Project Settings` first), then `Cut.speech.captions`
  and one batch `Auto Captions` (`captions(..., { uncertain: UNCERTAIN })`, so each caption carries its `doubt`): `addCaptionTrack` (named "Auto Captions", in the language heard) or, when that track
  exists, `setCaptions` keeping its captions outside the range.
- Remove Filler Words: `#cutSpeechFillers` (filler words, pauses, the pause length, what to keep); the summary and
  `Cut.ui.timeline.setOverlay` follow the settings; Remove is `Cut.ui.auto.rippleRanges(..., 'Remove Filler Words')`.
  Its settings are `cut.auto.fillers`.
- Transcript panel (`transcript`; in Captions and Graphics beside Captions, in Editing's dock slot): paragraphs at
  pauses of 1.2 s with their timecode and a span per word (`.cut-tr-word`, `data-i`); the word under the playhead is
  `.current` (scrolled into view while playing); a word Whisper was unsure of (`Cut.speech.isUncertain`) is
  `.uncertain` (a wavy underline, the confidence in its tooltip), and the foot's `.cut-tr-next-uncertain` counts them
  and goes to the next; a double-click makes a word a field (`.cut-tr-edit`): Enter or leaving it stores the text in
  the media file's transcript with `p: 1` (also when unchanged: confirmed), Esc puts it back (`correctWord`; the
  transcript is not project state, so this is not an undo step); Word List… (`.cut-tr-terms`) opens `#cutSpeechTerms`; a click seeks and selects, Shift+click and a drag extend, Esc clears;
  the `delete` and `rippleDelete` actions of the panel and its Remove button run `Cut.speech.removalRanges` through
  `rippleRanges` on the words' clips (label `Delete Words`); the search marks the matches, Enter and Shift+Enter go
  through them. `Cut.ui.transcript = { words, selection, select(i, j), removeSelected(), transcribe(), refresh(), edit(i),
  reveal(t) }`
  while it is mounted.
- Next / Previous Uncertain Word (`Cut.auto.nextUncertain` Alt+], `Cut.auto.prevUncertain` Alt+[, in the Automation
  menu; F2, PyCharm's next highlighted error, is the project panel's Rename): the playhead goes to the next frame (after
  or before it) of an uncertain word: the shown caption track's doubts, or the transcript's words when the Transcript
  panel has the keyboard or no caption holds a doubt; the Transcript panel selects the word and the captions panel
  scrolls to its caption.
- Word list: the project setting `speechTerms` (it names what this video is about and travels with the project; a
  global list would bias every other project), edited in the Auto Captions dialog and Word List…, parsed by
  `Cut.speech.parseTerms` and sent with every window.
- Settings: `cut.speech.model` (`whisper-large-v3-turbo`), `cut.speech.language` (`auto`), `cut.speech.lineChars` (0),
  `cut.speech.markUncertain` (true: the marks, the doubts shown, Next Uncertain Word), in the
  Video Editor page through `settingsSection` (with the model's state and Download…). The idle unload follows
  `ai.idleUnloadMinutes` (`cut:speechConfigure`).
  `cut.speech.isolateVoice` (false; also the Auto Captions dialog's checkbox `.cut-speech-isolate`): each part to
  recognise is first `Cut.ui.voice.forSpeech` (the vocals of those source seconds, in the cache) and read from that WAV;
  the transcript key ends in `|iv`, so isolated and plain transcripts are kept apart. `Cut.ui.speech.ensureReady()`
  without a model id also asks for HTDemucs when the option is on.

### Speaker labels (`ui-speakers.js`)

- `Cut.ui.speakers = { label(app, { count }), ensureReady(), status(), rename(app, id), reassign(app, words, id | 'new'),
  wordSpeakers(app, timelineWords, speakers?), captions(app, words, make, frame), captionField(app), bar(app, api),
  paraLabel(app, id, firstWord), selectSpeaker(app, id), CAPTION_MODES, styleOf(mode), modeOf(style), forget() }`.
- Label Speakers (`Cut.auto.speakers`, the Automation menu, the Transcript panel's `.cut-spk-run`): the sequence's
  speech clips; media without a transcript are recognised first (in the same task, after Whisper's setup when it is
  missing), then each media file's transcript gives `windowsOf`, its sound goes to `cut:speechOpen`/`Write` (`Cut.ui.speech.
  writeSound`) and `cut:speakersEmbed` 64 windows at a time (progress, Cancel), all media are clustered together (one
  speaker across files), and one batch `Label Speakers`: `setSpeakers({ list, turns, count })` (matched to the speakers
  of before) plus `setCaption(..., { speaker })` for captions whose speaker changed. Embeddings are cached
  (`speakers|v1|<path>|<size>|<mtime>|<windows>|<FNV of the windows>`, `cut:cacheGet`/`Put`: dim, count, float32), so
  another count clusters again without the sound or the model.
- Transcript panel (ui-speech.js calls in): `bar(app, { words, segment, selectWords })` above the text: a chip per
  speaker (`.cut-spk-chip[data-speaker]`: dot, name, word count; click selects the words, double-click renames,
  right-click the speaker menu), the count (`.cut-spk-count`: Auto, 1 to 6; the labels' `count`, else the choice made for this history and sequence, else Auto) and `.cut-spk-run`. A paragraph breaks at a
  pause and where the speaker changes and starts with `paraLabel` (`.cut-tr-speaker`, its `--spk` color): Change Speaker
  (the list, New Speaker), Rename Speaker…, Select Words. The words a speaker chip selects are `Cut.ui.transcript.picked`
  (Delete and Remove take them; Escape or a click clears them).
- Change Speaker: the paragraph's words' source seconds per media given to the speaker (`assign`), a speaker left
  without turns leaves the list, the captions follow; one batch `Change Speaker`. Rename: `#cutSpeakerRename`, one batch
  `Rename Speaker`.
- Captions: Auto Captions makes its captions per run of one speaker (`captions(app, words, make)`, each item with its
  `speaker`, ends clipped at the next start) and, with labels, offers `.cut-spk-captions` (No speakers, Speaker colors,
  Speaker names, both; setting `cut.speakers.captions`, default colors) written to the track's style; the Caption
  Style dialog has the same choice (`.cut-cap-speakers`). The compositor draws through `Cut.speakers.decorate`;
  exported and saved SRT files get the names (`written`).
- The setup dialog `#cutSpeakersSetup` follows the speech one (what is downloaded and its size, on this PC, nothing
  before Download, progress, failures explained, Try Again).

### Voice isolation (`ui-voice.js`)

- `Cut.ui.voice = { isolate(app), isolateMedia(app, mediaIds), ensureReady(), render(app, mediaId, { from, to, place, ctx,
  onPart }) -> { path, from }, forSpeech(app, mediaId, a, b, ctx, onPart), status(), settingsSection(host, ctx), keyOf }`.
- Isolate Voice (`Cut.auto.isolateVoice`, the Automation menu and the clip menu's Automation submenu): the selected audio
  clips (a selected video clip brings its linked audio; locked tracks left out), each media file once in one
  `Cut.ui.auto.task` with progress and Cancel, then one history group `Isolate Voice`: `importMedia` of each WAV (named
  "<name> (Voice)", into the source's bin; a media of that file already in the project is used) and
  `replaceAudio(seqId, clipIds, mediaId)` (label Replace Audio: audio clips of a media file take another media's sound,
  which must reach their out; everything else of the clip stays), and in the same group `setSpeakers` copying the
  source's speaker turns to the vocals' media id. Before the group the source file's transcripts are stored under the
  vocals file's keys too (`Cut.ui.speech.carryTranscripts(from, to)`: every key in memory, and the one for the current
  settings from the disk cache), since the vocals run on the source's time: the Transcript panel, its speaker paragraphs
  and the captions' speaker ids stay, and nothing is recognised again. The project panel's item menu has Isolate Voice
  for media with sound: the import (with the turns) only, the timeline unchanged.
- `render`: `cut:voiceFind` first; else the media's sound through `Cut.decoder.audioReader` in 10 s blocks, one or two
  channels (more folded into two), resampled to 44.1 kHz with `Cut.audioengine.resample` (blocks start on output samples
  and read the filter's reach on both sides), streamed to `cut:voiceWrite`, then `cut:voiceSeparate` (a whole file is
  padded to the media's duration). The key is FNV of path, size, mtime, range and model. The setup dialog
  `#cutVoiceSetup` follows the speech one (sizes, on this PC, nothing before Download, progress, the failure explained).
- Settings: the Video Editor page's Voice Isolation section (`.cut-voice-state` with `data-ready`, `.cut-voice-download`).

### The control API (`control.js`, `Cut.control`)

The tools an AI edits with (pure; docs/cut-ai-control.md has the list, the conventions and the security model; tests
`verify/cut-control-core.mjs`). `TOOLS` (`{ name, kind: 'read' | 'edit' | 'play' | 'export', title, description,
input /* JSON schema, additionalProperties false */, run(c, args), say }`), `INSTRUCTIONS` (the server's
instructions), `PRESETS`, `check(schema, value)` -> an error sentence or '', `call(name, args, { app, services,
undoFloor })` -> `{ ok: true, value, image, edit: { seqId, at, clips } | null }` | `{ ok: false, error }` (never
throws; an edit goes through `history.do`, or a history group cancelled on failure, and through ai.js's
`validatePlan`/`planCommands` for range cuts and lifts, edits on every track, marker removal by kind and silence
removal), `definitions()` (MCP `tools/list`), `describe(name, args)` -> `[English text for tr(), params]`,
`kindOf(name)`, `names()`. `services` (the page's; stand-ins in the test): `effects`, `frame(seq, t, width)` ->
`{ ok, base64, width, height }` (`Cut.export.framePng`), `transcript(seq)` -> segments in seconds, `silence(seq,
{ threshold, minLength })`, `seek(t)`, `play()`, `stop()`, `exportAsk({ seq, preset, fileName, range, captions })`
-> `{ ok, name }` | `{ ok: false, declined }`. The module makes no file, process, network or IPC call.

### AI assistant (`ui-assistant.js`)

- At load it lists `Cut.control.definitions()` with main (`cut:controlTools`) and answers `cut:controlCall` one call
  at a time on `Cut.app`. An edit that lands brings its sequence to the front, flashes its clips
  (`Cut.ui.timeline.flash(ids, ms = 1400)`; `flashing` lists them) and moves the playhead (`program.seek`). A chat
  call of a turn that is not running, or was stopped, and an external call while `cut.control.external` is off are
  refused.
- Panel `assistant` (AI Assistant; the Window menu, the Automation menu, `Cut.window.assistant`,
  `Cut.auto.aiAssistant`): `.cut-as-log` with `.cut-as-msg.user`, `.assistant` (`.cut-as-steps` of `.cut-as-step
  [data-state=running|done|refused|stopped][data-tool]` with `.cut-as-step-error`, `.cut-as-note` for what Claude said
  between calls, `.cut-as-text` the answer, `data-result` the end code, `.cut-as-undo`) and `.external`;
  `.cut-as-input` (Enter sends, Shift+Enter a new line, not while composing), `.cut-as-send`, `.cut-as-stop`.
- `Cut.ui.assistant = { ask(request), stop(), settingsSection(host, ctx), disconnect(), running /* {id, request} */,
  external /* {info, clients} */, relist, defaults }`. A turn remembers `history.position`; at its end (done, failed or
  stopped) `history.squash(floor, request)` makes its edits one step. A turn belongs to the history it started on: a
  new, opened or recovered project (the `lifecycle` event) stops it (end code `closed`), and a call of a turn whose
  history is no longer `app.history` is refused. The prompt carries the last six requests and
  answers of this project and `get_state` plus `get_sequence` (150 clips) as JSON. Settings:
  `cut.assistant.acknowledged` (the notice), `cut.control.external` (off by default; the settings section, drawn from
  the pending value until Apply, shows the `claude mcp add` command and the JSON with Copy, and New Token).
  `.cut-as-banner` over `.cut-root` names the connected external AIs, with Disconnect. Claude Code's errors go to
  `Cut.ui.ai.explain(code)` (which now also explains `quota`).

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
  monitor plays. `setProxy` is done through `history.amend` (no undo step) when the job's history is still `app.history` and no group is open. The app
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
`autosaved` {file, time, copy?}, `mask` {selected, pen} (ui-masks.js), `offline` {ids}, `exported` (the run result), `proxies`, `exportQueue`, `transcripts`, `patch`, `snapping`, `targets` {ids},
`transitionSelection` {id, open?} (with `app.selectedTransition`), `captionSelection` {track, id}, `captionTrack` {id} (the captions panel's shown track), `trimPreview`
{clipId, edge, mode, t, active}, `scrub` {active}.

## 11. Strings and styles

- Korean strings are in `renderer/features/cut/locales/ko.json` (English source -> Korean). Korean UI follows the
  IDE's Korean (PyCharm / Premiere Korean terms where they exist: 타임라인, 시퀀스, 클립, 트랙, 효과 컨트롤, 키프레임,
  전환, 내보내기, 소스 모니터, 프로그램 모니터, 리플 편집, 롤 편집, 자르기 도구). Effect, parameter, choice, preset
  and category names, command labels and errors reach `tr()` as variables, so `verify/i18n-static.mjs` does not list
  them: add them to ko.json by hand.
- Styles: `css/shell.css` (shell), `css/timeline.css` (timeline), `css/panels.css` (panels, one block per area),
  `css/tools.css` (shortcut editor, cheat sheet, settings page, proxies, export queue), `css/speech.css` (the
  transcript panel, the speech setup dialog), `css/ai.css` (the Claude dialogs and review lists), `css/audio.css` (the
  Audio Track Mixer, Essential Sound, the EQ graph) and the tokens in
  `style.css`. Use the IDE's variables so dark and light themes work.

## 12. Tests

| File | Kind | Port | What it covers |
| --- | --- | --- | --- |
| `verify/cut-formats.mjs` | Node | - | Readers and writer: mp4write output read back table by table; handcrafted ctts v1, co64 past 4 GB, stz2, elst, fragments, QuickTime PCM, Matroska lacing and damage, MP3 Xing/VBRI, RF64; truncated copies come back as values; a two-hour table against a clock; the scripts loading next to Monaco's AMD `require` |
| `verify/cut-model.mjs` | Node | - | Every command against the expected timeline, exact undo/redo; 2,000 random commands (nests and sequence sources among them); Nest (tracks and times kept, transitions, keyframes and clip markers along, the bin, links, Alt), a nest clip's trims, slip, razor, ripple delete and speed against its sequence's length, `nestUses`/`reaches`, loops refused (direct, through a third sequence, by paste, by `validate`), locked and empty cases, save and migrate (versions 1 and 2 open as 3), deleting a nested sequence and its undo, a nest of a nest; time remapping (clip time to source time and back at frame boundaries, a 50% segment, a speed transition's exact integral, reverse and hold segments, the length and its neighbour and source limits with the linked audio unchanged, razor and trims keeping every frame's source, slip, the refusals of Speed/Duration, Reverse and Rate Stretch, turning it off, Frame Blending as a setting, copy and paste also into 24 fps, a frame rate change, save, open, a version 2 file, a damaged curve dropped, `validate`'s refusals, a remapped nest clip; remap edits among the 2,000 random commands); sync lock, links, groups, trim, slip, slide and rate stretch clamps, extend edit, snapping; keyframe values; history grouping, dirty, limit; SRT/VTT with CP949 and UTF-16; migrate; caption word timings (realign after edits, the lit word, Auto Captions' timings, edit/move/trim/ripple/insert/frame rate with exact undo, the uncertain words (`doubt`) and the speaker through ripple, insert, frame rate and a start trim, files, the random commands with timed captions) |
| `verify/cut-main.mjs` | Node | - | Every `cut:*` channel with Electron stubbed: read ranges and limits, UNC/`\\?\UNC`/`\\.\` paths, links to network paths, junctions, 8.3 names, streams; atomic project writes and .bak; autosave rotation, sessions, recovery; the sink; faststart; cache LRU; findMedia/listMedia; real fonts |
| `verify/cut-engine-core.mjs` | Node | - | Effect registry and CPU references (every effect at chosen pixels and unchanged at its neutral parameters, grain and glitch per frame, the 2D hints and skips), transitions, crossfade, the compositor's plan (with the clip-local frame; a nest clip's plan: its sequence's layers at its source time, keyed under it, its own keyframes, effects and motion, after a start trim, a razor and reverse, two levels deep; a remapped clip's source time and frameIndex through a transition and a hold, a transition reading the curve before the clip, Frame Blending's next frame and weight; a remapped nest playing its sequence back and forward), fit scales, motion presets, the caption word highlight on every speaker color (the box for a line close to the highlight), the reader's block cache, audio assembly, peaks, dropped-frame count |
| `verify/cut-analyze.mjs` | Node | - | Levels streamed in odd blocks, silences with minimum length and margins on frames, speech; click tracks at 90, 120 and 140 BPM (beats within 12 ms, bar phase on the accents); scene cuts on their frame with a flash ignored and a fade in giving one cut at most; auto color through color.basic's own math (a light picture kept light); ducking keyframes; ranges and clip time; loading as a page script |
| `verify/cut-export-core.mjs` | Node | - | Presets (levels, bitrates, estimates), resampler and WSOLA, BS.1770-4 loudness and true peak, normalize and match gains, the mixer (a nest clip sample for sample against the clips it holds, in preview and export blocks, its volume and pan on top, an edit inside heard at once, a start trim), testsrc frame numbers, export's pure parts (frame plan, chapters, captions in a range, SRT names) |
| `verify/cut-audiofx-core.mjs` | Node | - | Audio effects: each filter's response at chosen frequencies against the analog theory (Butterworth 12/24/48 dB/oct, shelves, peaking, hum notches), the graph's `response()` against the processor, the defaults bit-exact; the compressor's static curve, knee, makeup, attack and release times; the limiter's ceiling with and without true peak, a smooth gain (no clipping), transparency and recovery; the gate closed at first, opening, holding, closing to its range; processors in calls of odd lengths; the mixer in one block, in blocks of 1 to 3,000 samples and from the middle (the same samples), against one continuous run (no seam; a 2 s release drifts, never steps), effect order and the on switch (`CUT_SRC_DIR` tests a copy) |
| `verify/cut-color-core.mjs` | Node | - | Lumetri Color and Scopes math: curves (cleaning, the straight line, through every point without overshoot, master and channel at chosen pixels), `.cube` files good (TITLE, comments, CRLF, domains, input range, sizes 2/17/33/65) and bad (each refusal and its line), the LUT's id, base64 and decode, trilinear lookup exact on a channel swap, the HSL qualifier and correction at chosen pixels and Show Mask, Lumetri Color's order and nothing to do at its defaults; scopes: every 75% bar at its angle and in its target, gray in the middle, skin tone near its line, ramps as diagonals on the waveform and the parade, histograms, the frame box and step, the WGSL's integers; `addLut`, undo, a bad entry, migrate keeping and dropping LUTs, save and reopen; page scripts; the refusals translated |
| `verify/cut-color.mjs` | app | 9781 | Lumetri Color and Lumetri Scopes with real mouse events: the Color workspace's layout and sections; the scopes following the playhead over gray, red and blue solids and a ramp, a scrub along the ruler, playing a 1080p30 source (counts about every 150 ms, no frames lost, none off screen), the toggles; a curve point added and dragged (one step, the monitor and the waveform brighter), the red channel, Ctrl+click, double click, Ctrl+Z; a LUT through `PYIDE_CUT_DIALOG` pickLut (red turns cyan), intensity, two bad files refused with nothing changed, undo and redo, saved and reopened with the `.cube` deleted; the HSL eyedropper, saturation 0, Show Mask; Effect Controls' groups; screenshots (`CUT_COLOR_ONLY`) |
| `verify/cut-engine.mjs` | app | 9753 | Frame accuracy at 24/29.97/30/60 fps, speed and reverse; transforms and keyframes from pixels; every effect against its CPU reference (all registered ones, Lumetri Color's curves, Looks of 17 and 33 points kept in the project, HSL secondary and Show Mask too, grain and glitch at given frames, the same anywhere in a frame and from a new compositor); the scopes' GPU count equal to the CPU's bin for bin on 640, 800 (pillarboxed) and 1920 (step 3) wide canvases, the six 75% bars on the vectorscope, a ramp's diagonal, the 2D back end's CPU count; transitions at known points and every one against its CPU reference on two pictures; Korean text; captions; offline media; import errors; audio decode; thumbnails and peaks; 10 s 1080p30 playback with seeks and no leaked VideoFrame; the 2D fallback (a skipped effect left out, invert's filter drawn); masks: Opacity's masks (ellipse, polygon, a bezier of smooth points, inverted, expansion, the four modes, a first mask that subtracts) and every video effect but Edge Extend under an ellipse mask (untouched outside), Lumetri Color in an ellipse minus a square, a blur outside an inverted ellipse, each against the CPU reference; the Canvas 2D back end's masks against it (the feather approximated) and a masked Invert there |
| `verify/cut-export.mjs` | app | 9754 | Test sources decode frame-exact; exported sequences re-decode with the right frames (PSNR >= 35 dB), beeps on flashes, pitch kept; hardware, software, HEVC and 2D back end; playback in `<video>`; range, captions, cancel, export frame, chapters; loudness; preview clock and meters; export speed |
| `verify/cut-shell.mjs` | app | 9755 | The frame with real mouse and keys: lifecycle, autosave, recovery, close question, import, bins, offline and relink, monitors, export dialog, captions, keys; dialogs answered through `PYIDE_CUT_DIALOG` |
| `verify/cut-auto.mjs` | app | 9757 | The Automation menu, the clip menu and the color panel's Auto with real clicks: silence removal with its timeline preview, a locked track, one undo step; roles and ducking keyframes; loudness and clip loudness measured again; beat markers on a click track and a drag snapping to them; scene markers and splits, waiting while playing, Cancel; auto color seen in the rendered frame; a 10-minute file's analysis time and memory; screenshots |
| `verify/cut-timeline.mjs` | app | 9756 | Timeline gestures and keys checked in the model and undone; drops; effect controls and keyframes; effects panel (every effect and transition under its category, Chroma Key and Iris Round typed and dragged); color panel and eyedropper; overlay handles and Korean IME text; 500 clips; screenshots (`CUT_TL_ONLY` picks parts) |
| `verify/cut-edit.mjs` | app | 9759 | The [2] editing keys and tools with real keys and drags: the keys as `Cut.<id>` actions (Find Action), the tool bar; lift and extract on targeted and locked tracks; paste insert; nudge with links and a locked track; groups (select, Alt-click, drag, nudge, delete, ungroup); D; E; rate stretch; slip with the two-up frames read from pixels; slide; pen keyframes on volume and opacity; match frame to the source monitor's frame (`CUT_EDIT_ONLY` picks parts) |
| `verify/cut-panels.mjs` | app | 9762 | The History, Markers and Audio Meters panels and the Window menu with real clicks and keys: jumps through the history in one go, dimmed later steps, 1,500 steps in a virtual list; marker filters, search, click, double click and Delete; marker drags on the ruler (frames, snapping, range end) and its menu; Hold and Bezier in the lane and timeline menus, the hold step from pixels, a bezier handle drag; meters' peak, RMS, hold and clip lights from a 1080p30 source, read from the canvas; dropped frames with and without the meters (`CUT_PANELS_ONLY` picks parts) |
| `verify/cut-mixer.mjs` | app | 9778 | The Audio workspace; the Audio Track Mixer with real drags and clicks: a fader drag (the track volume, the header's percent, one undo step, Ctrl+Z, +6 dB at the top, Alt+click), the master fader, the pan knob, M and S, the strips' meters while playing (two tracks, a mute, canvas pixels); the EQ's parameters and graph in the effect controls, a typed value; Essential Sound (one step, the audio type); an exported EQ cut at 1 kHz measured; the preview's and the export's samples compared; screenshots (`CUT_MIXER_ONLY` picks parts) |
| `verify/cut-nest.mjs` | app | 9784 | Nested sequences in Korean with real mouse events and keys: Clip > 중첩… on clicked clips (two linked pairs with a dissolve and a text clip), the name dialog, one undo step, the nest clips on V1 and A1, the new sequence in the project panel, the nest color from the timeline's pixels, Ctrl+Z and Ctrl+Shift+Z, Find Action with a typed name; the program monitor's picture with the nest equal to the clips' at five times (frame numbers and pixels, the dissolve, keyframed opacity and the text included), the same on the Canvas 2D back end, the nest clip's opacity on top; double-click into the nested sequence's tab at the shown frame and its picture; a sequence dragged from the project panel onto another timeline; Open in Source Monitor and Overwrite (.); loops refused in Korean with nothing changed (the drop, a sequence on its own timeline, the command); Delete of a nested sequence asking with where it is used, Cancel, Delete, Edit > Undo; an export over the nest against an export of the nested sequence (frames, pixels, samples); screenshots (`CUT_NEST_ONLY`) |
| `verify/cut-mask-core.mjs` | Node | - | Masks: coverage at chosen pixels against numbers worked out in the test (an ellipse against the true circle, a 4-point polygon and a pen triangle exactly, smooth bezier points against their cubics sampled densely), feather, expansion both ways, Mask Opacity, Inverted, the five modes of two masks and a first mask that subtracts or intersects, None, the edits that keep the shape (a vertex on a curve, corner and smooth), the mirrored and broken handle, the GPU data; Mask Path keyframes vertex by vertex with the ease, held for other counts, a vertex added on every keyframe; the commands, refusals (audio clip, Edge Extend, too many, bad values) leaving the project as it was, removeMask and removeEffect with their keyframes, exact undo, razor, paste and freeze frame; save and open (version 4), a version 3 file, a version 5 file refused, migrate dropping damaged masks and keyframes, validate's refusals; the plans of a masked nest (its own masks and Lumetri Color's, the inner clip's in its layers) and of a masked remapped clip (source through the curve, mask keyframes at clip time); the page script; the Korean names |
| `verify/cut-mask.mjs` | app | 9764 | Masks with real mouse events and keys: Create Ellipse Mask and Create 4-point Polygon Mask in Effect Controls (one step each, the mask selected, the program monitor's pixels inside and outside, Ctrl+Z and Ctrl+Shift+Z); on the program monitor a vertex dragged out, the whole mask dragged, the feather handle (a softer edge in the pixels, the guide line), the expansion handle, Alt+click, Ctrl+click, a click and a Ctrl+click on the outline, a click outside; the mask following the clip's position; the pen (corners and a dragged smooth point, closed on the first point, Escape); Invert limited to an ellipse and Lumetri Color outside an inverted one; the Mask Path stopwatch, a keyframe made by a drag at frame 20, the path half way at frame 10 in the pixels; an export's frames equal to the program monitor's; screenshots (`CUT_MASK_ONLY`) |
| `verify/cut-remap.mjs` | app | 9785 | Time Remapping with real mouse events and keys: the fx badge's Time Remapping > Speed, Ctrl+click adding a key, the line dragged to 50% (the tooltip, a 5 s clip in one step, the next clip and the linked audio unchanged, the program monitor's frame numbers), Ctrl+Z and Ctrl+Shift+Z, 20% stopping at the next clip; a key's half dragged into a 10-frame transition (tooltip, frames); Alt and plain drags of the tab, Ctrl-drag reverse and Ctrl+Alt-drag hold with their frames; Effect Controls' Time Remapping > Speed (the speed at the playhead, the stopwatch, Add/Remove Keyframe, a typed speed, turning it off); Clip > Time Interpolation > Frame Blending mixing two frames in linear light; an export's frames equal to the monitor's and the curve's; screenshots (`CUT_REMAP_ONLY`) |
| `verify/cut-tools.mjs` | app | 9765 | The convenience tools with real clicks and keys: the shortcut editor (record, use, conflict refusal, remove, reset, Reset All, the typing guard), the ? cheat sheet; the Video Editor settings page (transition length through Ctrl+D, playback quality, Clear Cache, copies kept); Select and Remove Unused with undo, Find Missing Media relinking by size and by duration; proxies (offer, 720p H.264 GOP 15 in the cache, the monitor drawing it and export the original by pixels, fallback when deleted, waiting while playing, cancel, the offer dismissed per project); the export queue (order, a later edit not leaking in, move, cancel, retry, remove, the close question); the word-by-word caption highlight from the program monitor's pixels (each word's first frame, scrubbing, every frame read back while playing), the exported frames lighting the same word, a text edit in the panel with undo and redo, a rewritten caption unlit, the box style, a second track chosen in the captions panel redrawing the stopped monitor and burned in by the export panel (which names it), saved and opened again (`CUT_TOOLS_ONLY`) |
| `verify/cut-speech.mjs` | Node | - | Speech recognition without a model: windows and their seams (squeezed end words, a half-heard start), words mapped through in, speed and reverse, two clips of one recording; caption line breaking (Korean 18 and English 42 characters, two balanced lines, 6 s, pauses, sentence ends, frames); fillers and pauses; deleting words; search; word times narrowed to their sound; Whisper's confidence through refine, the seams and the timeline, captions' doubts, the doubt in the model and `setCaption`; the word list parsed, fingerprinted, validated (project setting and main) and heard by the fake; the fake's bursts; main's temp files, windows, cancel, setup flow and error codes; loading as a page script |
| `verify/cut-speakers-core.mjs` | Node | - | Speaker labels without a model: windows from word times; the NN-chain average-linkage tree against a brute-force one, Auto and a fixed count, stray windows, numbering; each word's speaker with a flip smoothed and a short answer kept; turns (also of 2,000 random overlapping word lists, always valid), the speaker at a time, a segment reassigned, labels made again matched to the old speakers (names, colors), no id a caption still names given to a new speaker; `validate`, `setSpeakers` with undo, redo and `null`, a caption's speaker through the caption commands, save and reload; the caption prefix and color, SRT names; `main/cut/speakers.js` (the fake's embeddings, bad windows, cancel, a closed window's embeddings cancelled, an empty model cache, the fake setup); a page script |
| `verify/cut-speakers.mjs` | app | 9766 | Speaker labels with the fake backends through the real UI: Label Speakers (Auto: three speakers, paragraphs and colors, every word's speaker, one step); rename by double-clicking a chip, undo and redo; 2 speakers then Auto without recognising or embedding again, the name kept; the row's count per project (another project starts at Auto and labels with it); a chip selects all of a speaker's words; Change Speaker from a paragraph's label and its undo; Auto Captions with speaker colors and names (one speaker per caption, the speaker's color in the compositor's pixels, names in SRT text, Caption Style turns them off); save and reopen; the real backend with an empty model cache (the setup dialog, nothing downloaded); an offline pretend download in Korean; screenshots (`CUT_SPEAKERS_ONLY`) |
| `verify/cut-whisper.mjs` | app | 9768 | Speech recognition with the fake backend through the real UI: the setup dialog (sizes, on this PC, nothing before Download, Cancel, progress; with only small installed, Use Whisper small instead of the turbo download); Auto Captions on testsrc beeps over two windows, again over In-Out from the captions panel and from the cache, "Loading the speech model…" while a slow model loads, the dialog's highlight checkbox (off at first, on the new track, remembered, an existing track's state); the Transcript panel's click, highlight while playing, Shift+click, Delete across linked tracks, undo, Remove, search; the uncertain words (wavy underline and tooltip, the captions panel's marks, Alt+] and Alt+[ and the menu, Mark as Checked, an edited caption, a corrected or confirmed transcript word kept in the cache, the marks off); the word list (Auto Captions dialog, Word List…, project setting, its own transcript then the cache, one undo step); Remove Filler Words with its overlay; the settings section; the Window menu; an offline failure in Korean; screenshots (`CUT_WHISPER_ONLY`) |
| `verify/cut-ai-core.mjs` | Node | - | Text AI without Claude: JSON from answers, the retry prompt; transcripts condensed within a budget the same way every time; what each prompt sends (no paths); caption answers checked line by line; YouTube chapters fixed (0:00, 10 s, inside, at least 3), titles and tags; highlights checked (inside, lengths, frames, overlap), the shorts complement and fit/fill scale; every plan operation validated strictly (unknown operations and fields, prototype names, tracks, times, selection), described, applied as one undo step on a real project and undone exactly; ko/en/ja/zh/es line breaks and the diff; main/cut/ai.js (checks, progress, cancel, time limit, window gone); the fake CLI through main/ai/claude.js and `PYIDE_CLAUDE_PATH=none`; loading as a page script |
| `verify/cut-control-core.mjs` | Node | - | The control API: the tool list (names, descriptions, strict schemas, annotations, size, no path arguments, every tool in docs/cut-ai-control.md; `--table` prints its tables), every editing tool on a real project (one step each, valid, undo exact), refusals with the project unchanged (bad ids, times, locked tracks, unknown effects and parameters, ranges, paths for media ids, arguments, the undo floor, a declined export), no fs, child_process or page IPC while every tool runs, `history.squash`, `main/cut/control.js` over HTTP (tokens, Origin, Host, a turn's token after the turn, the external token while allowed and after Disconnect, a page that goes away), `main/cut/agent.js` with the scripted CLI (flags, events, Stop, quota, missing CLI, no file left), loading as a page script |
| `verify/cut-ai-chat.mjs` | app | 9807 | The AI assistant and external AIs in Korean with real mouse and keys: Window > AI 어시스턴트, the notice, a turn that changes the timeline while it runs (steps, flash, playhead), one Ctrl+Z for the turn, a refused step, Stop, export asking (Don't Export, Export), a usage limit, the external setting off by default, Apply, the command and JSON with Copy, tokens refused, a scripted external client editing live with the banner, Disconnect; screenshots (`CUT_CHAT_ONLY`) |
| `verify/cut-ai.mjs` | app | 9779 | Text AI against the stand-in CLI `verify/fake-claude-cut.mjs` through the real UI: the notice (Cancel sends nothing, Continue remembered); Polish with the marked review, one change unchecked, one undo step, times kept; Translate into Japanese (a new track, same times and speakers, 16-character lines); YouTube metadata (chapters fixed, Copy, chapter markers replacing the old one), from the transcript after the offer to recognise the speech (fake Whisper); Highlights (the overlapping answer refused and asked again, the review, a 1080x1920 sequence of the chosen ranges with captions, fill, undo); Edit Command by Ctrl+J (silences with the overlay, the first 10 s, the music quieter, an unknown operation refused twice, an unknown field fixed on the retry, no edits); Cancel; signed out; the settings section; Claude Code missing, in Korean; screenshots (`CUT_AI_ONLY`) |
| `verify/cut-voice-core.mjs` | Node | - | main/cut/voice.js without Python: names and keys, temp files and their window, the fake's WAV (44.1 kHz 16-bit, padded), Cancel leaving no WAV or .part, the cache's index, an empty Hugging Face cache giving a missing model and `notInstalled` |
| `verify/cut-voice.mjs` | app | 9767 | Voice isolation through the real UI: the setup dialog and its progress (fake), Isolate Voice from the Automation menu (a WAV in the workspace's Media folder, never beside the source; imported into its bin; only the audio clip changes, place, in, out and link kept; one undo step; the same file used again), Cancel leaving nothing (no WAV, .part, temp file, media or step), the project panel's Isolate Voice, isolation before recognition (the Auto Captions checkbox and the setting, the isolated sound in the cache, its own transcript); the real backend with an empty `HF_HUB_CACHE` (the setup dialog and Download… with nothing downloaded); `CUT_VOICE_REAL=1` the real HTDemucs (`CUT_VOICE_ONLY`) |
| `verify/app-mode.mjs` | app | 9758 (cut block) | `--mode=cut` opens the Cut window, workspace and trust, only Cut's plugins, `__cutReady`, no renderer exceptions |

- Node suites: `node verify/cut-<name>.mjs`, printing `N/M passed` and `FAIL <what>` lines.
- App suites launch with `launch({ fixture: 'core', port, name, mode: 'cut', env: { PYIDE_CUT_HOME: <a temp dir> } })`
  from `verify/lib.mjs`, wait for `window.__cutReady === true`, and check that `Cut[name]` exists for every module
  they use. Run them one at a time through `powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1
  -Out verify/out/<name>.log -TimeoutMinutes 20 node verify/<name>.mjs`.
- Test env: `PYIDE_CUT_HOME` (the workspace), `PYIDE_CUT_DIALOG` (dialog answers), `PYIDE_CUT_FONT_DIRS` (font
  folders), `PYIDE_WHISPER_BACKEND=fake` and `PYIDE_WHISPER_FAKE_SETUP` (speech recognition without a model),
  `PYIDE_SPEAKERS_BACKEND=fake` and `PYIDE_SPEAKERS_FAKE_SETUP` (speaker labels without a model),
  `PYIDE_VOICE_BACKEND=fake` and `PYIDE_VOICE_FAKE_SETUP` (voice isolation without a model; `HF_HUB_CACHE` at an empty
  folder for the real backend's missing model),
  `PYIDE_CLAUDE_PATH` (a stand-in Claude Code CLI, or `none`) with `FAKE_CLAUDE_DIR` (`verify/fake-claude-cut.mjs`'s
  scenario and log). Media comes from `Cut.testsrc` or bytes the test builds: no downloads, no copyrighted media.
