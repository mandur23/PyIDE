# Nano Studio Cut: the AI control API and the AI assistant

Cut offers its editing to AIs as a set of tools. Two kinds of AI use them:

- **The AI Assistant panel.** The user types a request ("앞 3초 잘라내고 제목 자막 넣어줘") and Claude, run through the
  Claude Code CLI on this PC, edits the open project with the tools while the user watches the timeline and the
  program monitor change step by step.
- **External AIs.** When the user allows it in the settings, an AI app on the same PC (Claude Code, Claude Desktop or
  another MCP client) connects to the same tools with a token and edits the same way.

The user-facing summary is FEATURES.md's "AI assistant and the control API"; the module contracts are in
[cut-architecture.md](cut-architecture.md) sections 7 and 10.

## 1. Shape

```
Claude Code CLI (a chat turn) ─┐                    main process                          page (renderer)
external MCP client            ├─ POST /mcp ─▶ main/cut/control.js ─ cut:controlCall ──▶ ui-assistant.js
  (Bearer token)              ─┘   JSON-RPC     token, Origin, Host  ◀─ cut:controlResult ─ Cut.control.call ─▶ Cut.commands
main/cut/agent.js runs a chat turn: the CLI and its stream-json ─ cut:agentEvent ─▶ the panel's steps
```

| File | What it does |
| --- | --- |
| `renderer/features/cut/control.js` | The framework and the timeline tools (`TOOLS`: name, kind, title, description, JSON schema, `run`), the schema check, `call(name, args, env)`, `definitions()` for MCP, `describe()` for the chat's step lines, `INSTRUCTIONS`, and `lib` (what the other tool files build with). Pure: loads in Node and in the page. |
| `renderer/features/cut/control-project.js` | The tools for the project and its output: import, media, bins, sequences, tracks, transitions, caption tracks, color mattes, project settings, saving, the frame and caption exports, the export queue, proxies, the shorts sequence. Pure. |
| `renderer/features/cut/control-auto.js` | `automation` (the Automation menu's jobs), `essential_sound`, `speakers`. Pure; the jobs run through `services.automation`. |
| `renderer/features/cut/control-actions.js` | The inventory (section 6) and `list_actions`/`run_action`: what each keyboard action needs, the check, the report of what changed. Pure. |
| `renderer/features/cut/ui-control.js` | The page's services for those tools (`Cut.ui.controlServices`): run_action through `Cut.ui.runAction`, the Automation jobs without their dialogs (`ui.auto.observe` for progress and Stop), import with its confirmation, save, the ask-first exports, the export queue, proxies. |
| `renderer/features/cut/ui-assistant.js` | Lists the tools with main, answers calls one at a time on `Cut.app` with the page's services (frame, transcript, silence, playback, and `ui-control.js`'s), gives each call a Stop signal and a progress function, shows each edit landing, the AI Assistant panel (a long job's progress on its step), the chat turn (undo grouping, Stop), the external AI banner and the settings section. |
| `main/cut/control.js` | The MCP server on 127.0.0.1: tokens, refusals, JSON-RPC, forwarding calls to the page, external AI sessions. |
| `main/cut/agent.js` | One chat turn: the CLI with only the Cut tools, its stream-json read into events. |
| `main/ai/claude.js` | Finding and starting the CLI (`launch`), telling sign-in and usage-limit errors apart (`classify`). |

## 2. Protocol

MCP's Streamable HTTP transport without a server-sent stream: every JSON-RPC request is a `POST /mcp` and its answer is
the response body (`application/json`).

- `initialize` answers the protocol version the client asked for, `capabilities.tools`, `serverInfo` ("Nano Studio
  Cut") and `instructions` (`Cut.control.INSTRUCTIONS`: times, ids, refusals, files), with an `Mcp-Session-Id` header.
- `tools/list` gives every tool with its `inputSchema` and `annotations` (`title`, `readOnlyHint`, `destructiveHint`).
- `tools/call` answers `{content, isError}`. `content` is one text item, the result as compact JSON or the refusal
  sentence, and for `get_frame` also an `image` item (PNG, base64).
- A notification answers 202 and `ping` answers `{}`. `GET` and `DELETE` answer 405, a body over 1 MB 413, broken JSON
  a parse error, a batch an error, and a tool that is not listed `-32602` without reaching the page.

## 3. Security model

Who may call:

- Every request needs `Authorization: Bearer <token>`, compared in constant time. A request without it, or with
  another token, gets 401.
- A chat turn has its own token, made when the turn starts and dropped when it ends or is stopped. The page also
  refuses a call of a turn that is not the running one, or that was stopped, so nothing lands after Stop.
- The external token exists only while the setting `cut.control.external` is on (off by default). It and the port are
  kept in `<userData>\cut-control.json`, so a client set up once keeps working after a restart. Turning the setting
  off refuses it at once. Disconnect (the banner) and New Token (the settings) replace it, so a client must be set up
  again.
- A request with an `Origin` header (a web page) or a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` is
  refused with 403 before the token is read, so a page in a browser cannot reach the editor through DNS rebinding.
- The server listens on 127.0.0.1 only.

What a tool can do:

- Read and edit the open project through `Cut.commands` and nothing else. Edits that are operations of the text AI's
  edit-command allowlist (`ai.js`'s `validatePlan` and `planCommands`: a range cut or lift, an edit on every track,
  removing markers by kind, removing silence) go through it. A keyboard action (`run_action`) runs the handler a key
  runs, so it follows the same rules.
- The tool files (`control*.js`) have no file, process, network or IPC call; what touches the disk or a dialog is a
  service of the page (`ui-control.js`). `verify/cut-control-core.mjs` checks the sources and watches `fs`,
  `child_process` and the page's IPC while every tool runs. No tool runs a program or deletes a file.
- Media are named by their ids (a path where a media id goes is refused with a sentence saying so), and `get_media`,
  `export_queue` and `save_project` give names, never paths.
- **Import** (`import_media`, the only tool that takes paths): an absolute path on this PC (no network share, no
  `..`). A file whose path and real path (`cut:stat`) are inside the project's folder comes in at once; any other
  only after the user says yes in a dialog that lists it, and nothing is looked at on the disk before that. No is a
  refusal of the whole call: nothing comes in. Without paths the user's own Import (or Import Folder) dialog opens.
- **Remove media** removes items from the project only, never from the disk, and refuses media that clips use.
- **Save** writes the project's own file. A project never saved opens Save As, where the user picks the place (or
  cancels: a refusal). Save As and Save a Copy are not for AI.
- **Exports** (`export_sequence`, `export_frame`, `export_captions`) write only after the user says yes in a dialog
  that names what and where. The file is new: in the project's folder (or `Projects`), named from a plain file name
  (no folders), never one that exists, that the project uses or that the queue writes. A sequence export joins the
  export queue; `wait: true` follows it with progress, and Stop cancels it.
- **Downloads**: a job that needs a model (speech recognition, speaker labels, voice isolation) calls the setup check
  first, which shows Cut's setup dialog when the model or runtime is missing. Nothing is downloaded unless the user
  presses Download there; Cancel is a refusal that says so, with nothing changed.
- Locked tracks are the user's: every tool refuses to change them, `set_track` cannot lock or unlock, and
  `remove_track` refuses a locked track.
- A chat turn's `undo` cannot go past the steps the turn made; `undo` and `redo` are not `run_action` actions.

The chat turn's CLI (`main/cut/agent.js`):

| Flag | Why |
| --- | --- |
| `--tools ""` | No built-in tool: no Bash, PowerShell, file, web or agent tool. |
| `--strict-mcp-config --mcp-config <file>` | Only the Cut server, never the user's own MCP servers. The file holds the turn's token and is deleted when the turn ends. |
| `--allowedTools mcp__cut__<name>,...` | Exactly the Cut tools run without asking. |
| `--permission-mode dontAsk` | Anything else is refused, never asked. |
| `--no-session-persistence`, `--disable-slash-commands`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, an empty working folder | No session file, no commands, no CLAUDE.md. |
| `--system-prompt-file`, `--model` (`cut.ai.model`), `--max-turns 80`, a 20-minute limit | The assistant's instructions, the model the text AI uses, an end. |

`--safe-mode` is not used: in safe mode the CLI drops the servers of `--mcp-config` (its bundle says "Configured via
--mcp-config on this host (operator-supplied); ignored" for safe mode), so the turn would have no tools.

What goes to Claude: the request, the earlier requests and answers of this conversation, a JSON description of the
editor (the state and the active sequence: track, clip, marker and caption names and times, media names), the tools'
results, and, when Claude calls `get_frame`, a PNG of the program monitor. No file path. The panel says so before the
first request (`cut.assistant.acknowledged`).

Text in the project (clip names, captions, the transcript) reaches the model as data. Words in it that read like
instructions can at worst steer the model's edits of this project: every one of them is an undo step, and nothing
outside the project (files, programs, the network) is in reach of a tool.

## 4. Conventions of the tools

- Times are **seconds on the sequence timeline**, and results give frame numbers beside them (`startFrame`,
  `atFrame`). `source_in` and `source_out` are seconds of the source media. Commands snap to whole frames.
- `sequence_id` may be left out on every tool that works on a sequence: the active one.
- Ids come from the read tools: clips `c<n>`, media `m<n>`, tracks `V1` and `A1`, markers `mk<n>`, caption tracks
  `cc<n>` and items `cap<n>`, transitions `t<n>`, effects `e<n>` (per clip), masks `m<n>` (per clip).
- Every schema is an object with `additionalProperties: false`. `check()` refuses a missing, unknown or mistyped
  argument and a value outside its range before anything runs.
- A refusal is one English sentence the model can act on: what is wrong and what to do instead ("There is no track
  V9. The tracks are V1, V2, A1, A2.", "Track A2 is locked. Locked tracks are the user's; edit other tracks, or ask
  the user to unlock it.", "Effect blur.gaussian has no parameter "radius". Its parameters: blurriness, dimensions,
  repeat."). A command's own refusal comes back as "The editor refused: <its sentence>". A refused call changes
  nothing: a single command is taken back by `history.do`, several by a history group that is cancelled.
- Results are compact: only fields that differ from the defaults (a clip's speed only when it is not 100 %, its
  opacity only when not 100 %), and `get_sequence` stops at `max_clips` (300) with a note to ask by `from` and `to`.
- Each edit tells the page where it happened (`edit: {seqId, at, clips}`, not sent to the AI): the clips whose JSON
  changed, found by comparing the sequence before and after. A tool that makes a sequence names it (`seqId`), so the
  new sequence comes to the front.
- A long job (`automation`, `proxies` create, `export_sequence` with `wait`) gets `env.signal` and
  `env.progress(fraction, text)` from the page: its progress shows on its step in the chat, and Stop (or Disconnect,
  for an external AI) aborts the signal, which cancels the job; a stopped job changes nothing and answers a refusal.
- `run_action` checks what the action needs before it runs (`NEEDS` in `control-actions.js`) and answers what changed:
  the undo step's name, the selection, the playhead, In/Out, the tool, the Source monitor, the view. An action that
  changed nothing is refused with what the editor said (its toast, heard through `Cut.ui.listen`).

## 5. The tools

The table is made from `Cut.control.TOOLS` by `node verify/cut-control-core.mjs --table`; paste it again after
changing a tool. `verify/cut-control-core.mjs` fails when a tool is missing from this file.

### Reading

| Tool | Arguments (required in bold) | What it does |
| --- | --- | --- |
| `get_project` | (none) | The project's sequences (size, rate, length, clip count, which is active), its media count, bins, LUTs, settings, whether it was saved to a file and has unsaved changes, the playhead and the selection. Start here. |
| `get_sequence` | sequence_id, from, to, max_clips | A sequence's tracks, clips (time on the timeline, source range, effects, links), transitions and caption tracks. from/to (seconds) keep the clips that overlap that range; long sequences are cut at max_clips. |
| `get_clip` | sequence_id, **clip_id** | Everything about one clip: properties, keyframes (times on the timeline), effects with all their parameters, masks, text layers, clip markers. |
| `get_media` | (none) | The project's media: id, name, kind, length, picture size and rate, whether it has sound, how many clips use it, its bin, whether it has a proxy or its file is missing (offline). No file paths. |
| `get_markers` | sequence_id | The sequence markers and the clip markers (times on the timeline). |
| `get_captions` | sequence_id, track_id, from, to, max_items | Caption tracks and their items (id, start, end, text). track_id picks one track; from/to (s) keep the items in that range; max_items caps each track (default 300). |
| `get_transcript` | sequence_id, from, to | What is said in the sequence, from speech recognition already done in Cut: segments with start, end (s) and text. Empty when the speech was not recognised yet (the user runs Auto Captions or the Transcript panel). |
| `list_effects` | kind, search | The video and audio effects and the transitions there are, with their parameters as "id: type min..max = default". kind and search narrow the list. |
| `get_frame` | sequence_id, time, width | A PNG of the program monitor's picture at a time (the playhead when left out), with the shown caption track burned in, so you can see the edit. |
| `get_state` | (none) | The playhead, whether it plays, the selected clips, the sequence In/Out and the last steps of the undo history. |
| `list_actions` | search | The editor's keyboard and menu actions that run_action runs (the ones with a tool of their own are not listed): id, what it does, what it needs, and view: true when it changes only what the user sees (no undo step). search narrows by words of the id or the text. |

### Editing

| Tool | Arguments (required in bold) | What it does |
| --- | --- | --- |
| `place_clip` | sequence_id, media_id, nest_sequence_id, **at**, mode, video_track, audio_track, source_in, source_out, duration | Puts media (or a nest of another sequence) on the timeline at a time. mode overwrite replaces what is there; insert pushes later clips. Video goes on video_track (default V1), sound on audio_track (default A1); null leaves that part out. source_in/source_out pick part of the media (s); a picture takes duration (s). |
| `move_clips` | sequence_id, **clip_ids**, to, delta, track_delta, insert, linked | Moves clips along the timeline (to: the new start of the earliest one, or delta: seconds, negative earlier) and between tracks (track_delta: +1 one track up, -1 down). Linked and grouped clips move along unless linked is false. insert pushes clips at the destination instead of overwriting them. |
| `trim_clip` | sequence_id, **clip_id**, edge, to, delta, mode, linked | Moves a clip's start or end edge (to: the new edge time, or delta: seconds). mode normal leaves a gap or fills one, ripple moves later clips with the edge, roll moves the neighbouring clip's edge too, stretch (Rate Stretch) changes the speed so the same source fills the new length. slip (delta s, no edge) shows a later (+) or earlier part of the source in place; slide (delta s, no edge) moves the clip while its neighbours trim. The result says where it stopped and why (source, neighbour, length, speed). |
| `razor` | sequence_id, **at**, track_ids, clip_ids | Cuts clips in two at a time: on every unlocked track, or only on track_ids, or only clip_ids (with their linked clips). |
| `delete_clips` | sequence_id, **clip_ids**, ripple, linked | Removes clips (with their linked and grouped clips unless linked is false). ripple closes the gaps they leave on their tracks and the sync-locked ones. |
| `delete_range` | sequence_id, **from**, **to**, ripple, track_ids | Removes from..to (s) on every unlocked track, or on track_ids. ripple (default true) pulls later material earlier (Premiere's Extract: "cut the first 3 seconds"); ripple false leaves a gap (Lift). |
| `link_clips` | sequence_id, **clip_ids**, **action** | link joins clips so they move, trim and get deleted together; unlink parts them; group and ungroup do the same for a group (clips that move and delete together). |
| `set_clip` | sequence_id, **clip_id**, name, enabled, role, label, interpolation, color, opacity, position, scale, rotation, anchor, crop, volume, pan, fade_in, fade_out, linked | Changes a clip's settings. Video clips: opacity (%), position ([x, y] px from the center), scale (% or [w %, h %]), rotation (deg), anchor, crop ([top, right, bottom, left] %), interpolation (sample or blend: Time Interpolation), color (a color matte's #rrggbb). Audio clips: volume (dB, 0 unchanged), pan (-100..100), fade_in, fade_out (s). Both: name, enabled, role (Essential Sound's audio type: dialogue, music, effects, ambience or null), label (a color label or null). The value is the clip's static value; set_keyframes animates it. |
| `set_speed` | sequence_id, **clip_id**, speed, duration, reverse, ripple, linked | Speed/Duration: a clip's constant speed in % (100 normal, 50 slow motion, 200 twice as fast), or the duration (s) that the same source should fill, and reverse. ripple (default true) moves later clips with the new length. Linked clips change too unless linked is false. |
| `set_time_remap` | sequence_id, **clip_id**, segments, off | Time Remapping of a video clip: its speed changes along it, replacing any remapping it has. segments in order: {speed: % (1 to 10000), until: timeline time (s) where it ends, as the clip plays now; ramp: seconds of speed transition into the next speed segment}, {hold: seconds of a freeze frame} or {reverse: seconds it plays backward, then forward again for as long}. A hold or reverse goes between two speed segments; the last segment is a speed with no until. Each speed segment keeps its source frames, so the clip gets longer or shorter (up to the next clip). off: true goes back to one constant speed. |
| `set_keyframes` | sequence_id, **clip_id**, **property**, **keyframes** | Animates a property of a clip: the full list of keyframes (time on the timeline in s, inside the clip; value; ease linear, hold, easeIn, easeOut or easeInOut). An empty list removes the animation. property: a clip property (opacity, position, scale, rotation, anchor, crop, volume, pan), "effects.<effect id>.<parameter>" (video and audio effects), a mask's "masks.<mask id>.<path\|feather\|opacity\|expansion>" (an effect's mask: "effects.<effect id>.masks.<mask id>.<field>"; a path value is {shape: ellipse\|rectangle, x, y, width, height} in fractions 0..1, like add_mask) or a title layer's "layers.<layer id>.<opacity\|position\|reveal\|size>" (reveal 0..1 shows the text from the start). |
| `add_effect` | sequence_id, **clip_id**, **type**, params, index | Adds a video or audio effect (list_effects) to a clip, with parameters that differ from the defaults. The effect's kind must match the clip's track. Returns the effect id. |
| `set_effect` | sequence_id, **clip_id**, **effect_id**, on, params, index | Turns an effect on or off, changes its parameters (null puts one back to its default) and moves it in the clip's effect order (index 0 is applied first). |
| `remove_effect` | sequence_id, **clip_id**, **effect_id** | Removes an effect from a clip, with its keyframes and masks. |
| `set_color` | sequence_id, **clip_id**, temperature, tint, exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance, lut, lut_intensity, curves, hsl | Lumetri Color of a video clip, every section (its Lumetri Color, added when it has none). Basic: temperature, tint, contrast, highlights, shadows, whites, blacks, vibrance (-100..100), exposure (-4..4 stops), saturation (0..200 %). Creative: lut (a LUT id from get_project, or "" for none), lut_intensity (%). curves: master, red, green, blue as flat [x0, y0, x1, y1, ...] lists 0..1 ([0, 0, 1, 1] is unchanged). hsl (HSL Secondary): the range (hue 0..360, hue_range and hue_soft in degrees; sat_low, sat_high, sat_soft, lum_low, lum_high, lum_soft %), its correction (temperature, tint, contrast, saturation %, hue_shift -180..180) and show_mask. |
| `add_transition` | sequence_id, **track**, **at**, type, duration, align, params | Puts a transition on an edit point of a track (where two clips meet, or a clip's start or end). type from list_effects (default: a cross dissolve, or a crossfade on audio); duration (s) defaults to the project's; align center, start or end. |
| `remove_transition` | sequence_id, **transition_id** | Removes a transition (ids from get_sequence). |
| `add_text` | sequence_id, **text**, **at**, duration, track, size, color, font, weight, italic, align, tracking, leading, position, box, stroke, shadow | Adds a text clip (a title) at a time for duration seconds (default the project's still length), on track or else on the lowest free video track above the clips there (a new track when none is free). |
| `set_text` | sequence_id, **clip_id**, layer_id, text, size, color, font, weight, italic, align, tracking, leading, position, box, stroke, shadow, add_layer, remove_layer, animation, animation_at | Changes a text clip: the text and look of its first layer (or layer_id); add_layer: true adds a new layer with these settings instead; remove_layer removes one. animation puts a motion preset on the layer as keyframes: fade, rise or typewriter, in (at the start, default) or out (at the end). |
| `add_captions` | sequence_id, track_id, name, lang, **items** | Adds caption items to a caption track (track_id), or makes a new caption track (name, lang) with them. Captions are subtitles shown over the picture, not title clips. |
| `set_caption` | sequence_id, **track_id**, **caption_id**, text, start, end | Changes one caption's text or times. |
| `remove_captions` | sequence_id, **track_id**, caption_ids, whole_track | Removes captions by id, or the whole caption track (whole_track: true). |
| `add_marker` | sequence_id, **at**, name, kind, color, note, duration, clip_id | Adds a sequence marker at a time, or a clip marker (clip_id). kind comment (default), chapter (YouTube chapters) or beat; color one of green, red, purple, orange, yellow, white, blue, cyan. |
| `set_marker` | sequence_id, **marker_id**, at, name, kind, color, note | Changes a marker's time, name, kind, color or note. |
| `remove_markers` | sequence_id, marker_ids, kind | Removes markers by id, or every sequence marker of a kind (comment, chapter, beat or all). |
| `add_mask` | sequence_id, **clip_id**, effect_id, **shape**, x, y, width, height, feather, opacity, expansion, inverted, mode | Adds a mask to a video clip's Opacity (the clip shows only inside it), or to one of its effects (effect_id: the effect applies only inside). shape ellipse or rectangle, centered at x, y with width and height, all fractions 0..1 of the clip's picture. |
| `set_mask` | sequence_id, **clip_id**, **mask_id**, effect_id, shape, x, y, width, height, feather, opacity, expansion, inverted, mode | Changes a mask's static feather, opacity, expansion, inverted or mode, or its shape (shape with x, y, width, height as in add_mask). set_keyframes animates masks.<mask id>.<path\|feather\|opacity\|expansion>. |
| `remove_mask` | sequence_id, **clip_id**, **mask_id**, effect_id | Removes a mask and its keyframes. |
| `nest_clips` | sequence_id, **clip_ids**, name | Moves clips (with their linked and grouped clips) into a new sequence and puts one nest clip of it in their place, as Premiere's Clip > Nest. Returns the new sequence and the nest clips. |
| `set_track` | sequence_id, **track_id**, name, visible, mute, solo, volume, pan, sync_lock | Changes a track: name; video tracks visible; audio tracks mute, solo, volume (dB, -60..24) and pan (-100..100); sync_lock. Locking and unlocking stay the user's. |
| `set_sequence` | sequence_id, name, width, height, fps, master_gain, background, active | Sequence Settings and the master track: name, frame size (width, height px, even), fps (23.976, 24, 25, 29.97, 30, 50, 59.94 or 60; every time moves to the new frames), background color, master_gain (dB on the whole mix, -60..24: the Audio Track Mixer's master). active: true brings it to the front in the timeline (not an undo step). |
| `remove_silence` | sequence_id, **longer_than**, threshold | Measures the sound on this PC and ripple-deletes every stretch quieter than threshold (dB, default -40) that lasts longer than longer_than seconds, on the speech tracks (music, effects and ambience clips do not count). |
| `import_media` | paths, folder, bin_id | Brings media files (video, sound, pictures) into the project, or caption files (.srt, .vtt) as a caption track of the sequence. paths: absolute file paths the user named; files in the project's folder come in at once, others only after the user confirms them in a dialog that lists them. Without paths the Import dialog opens for the user to pick files (folder: true picks a folder, its subfolders becoming bins). bin_id puts the media in a bin. Network shares are refused. |
| `remove_media` | media_ids, unused | Removes media from the project (never from the disk): media_ids, or unused: true for every media no sequence uses (Remove Unused). Media that clips use are refused; delete those clips first. |
| `project_items` | **action**, name, bin_id, item_id, item_ids | The Project panel's items: new_bin (name, parent bin_id), remove_bin (bin_id; its items go to its parent), rename (item_id of a media, bin or sequence, name), move (item_ids into bin_id, or to the top when bin_id is left out). |
| `add_sequence` | name, preset, width, height, fps, duplicate_of, bin_id, active | Makes a sequence: a preset (youtube-1080p30, youtube-4k30, shorts, square) or width, height (even px) and fps, or duplicate_of another sequence (Duplicate). It goes in bin_id if given, and becomes the active sequence unless active is false. |
| `remove_sequence` | **sequence_id** | Deletes a sequence from the project, with the nest clips of it in other sequences. The project keeps one sequence at least. |
| `add_track` | sequence_id, **kind**, name, index | Adds a video or audio track (on top of its kind, or at index among its kind, 0 the lowest), with a name. |
| `remove_track` | sequence_id, **track_id** | Deletes a track with its clips and transitions. Locked tracks are refused. |
| `set_transition` | sequence_id, **transition_id**, duration, align, type, params | Changes a transition: its duration (s), align (center, start or end of the edit), type (another transition of its kind, list_effects) or params. |
| `set_caption_track` | sequence_id, **track_id**, name, lang, sync_lock, shown, style | Changes a caption track: name, lang, sync_lock, and its Caption Style (font, size, weight, color, background, position, margin, highlight of the spoken word with highlight_color and highlight_mode, speakers). shown: true makes it the track the program monitor draws and an export burns in (not an undo step). |
| `add_color_matte` | sequence_id, **at**, duration, color, track, name | Adds a color matte (a full-frame solid color clip) at a time for duration seconds (default the project's still length) on a video track (default the lowest free one above the clips there). |
| `set_project_settings` | still_duration, transition_duration, freeze_duration, fit, speech_terms | The project's settings: still_duration (s, new pictures and titles), transition_duration (s, new transitions), freeze_duration (s, Insert Frame Hold), fit (fit, fill or original: how new media of another size scale), speech_terms (the word list speech recognition is told of: names and terms, as written). |
| `proxies` | action, media_ids, wait | Proxies (720p H.264 copies that play smoothly; exports always use the original): status of media_ids (or all video media), create them (waits with progress unless wait is false; Stop cancels the ones not done), or remove them (the media play their original again). |
| `create_shorts` | sequence_id, **ranges**, name, mode | Highlights to Shorts: a new 9:16 sequence (1080x1920) holding only the given ranges of this sequence, back to back, with the video scaled to fill (mode fill, default) or fit. Captions and markers in the ranges come along. Choose the ranges from get_transcript; the new sequence becomes the active one. |
| `automation` | sequence_id, **action**, clip_ids, from, to, language, chars_per_line, highlight, fillers, pauses, pause_length, keep, speakers, threshold, mode, every, target, amount, fade, time | Runs an Automation menu job on this PC as one undo step; it reports progress and ends on Stop. transcribe (speech recognition; get_transcript reads it), auto_captions (a caption track from it), remove_fillers (ripple-deletes filler words and long pauses), label_speakers, isolate_voice (the voice without music or noise), detect_scenes (markers or splits), detect_beats (beat markers of an audio clip), match_loudness (master gain for a LUFS target), match_clip_loudness (each clip's volume for it), auto_duck (music lowered under dialogue; set_clip role first), auto_color (white balance and exposure). A job that needs a model asks the user in Cut's setup dialog first; a no is a refusal. |
| `essential_sound` | sequence_id, **clip_ids**, **action** | Essential Sound's one-click repairs on audio clips (a video clip brings its linked audio): clarity (EQ and compressor for dialogue), reduce_hum_50 or reduce_hum_60 (mains hum), noise_gate, hard_limiter (-1 dB). Each adds its effects with the panel's settings, as one undo step; set_effect changes them after. The audio type is set_clip role; voice isolation, ducking and loudness are automation jobs. |
| `speakers` | action, speaker_id, name | The speaker labels of the project (made by automation label_speakers): list them (id, name, color), or rename one (speaker_id, name; an empty name goes back to "Speaker n"). Names show in the Transcript panel and in captions that show speakers. |
| `run_action` | **id**, time, clip_ids | Runs one of the editor's keyboard or menu actions as the key would (list_actions gives the ids, what they do and need). time moves the playhead first and clip_ids selects clips first, for actions that work at the playhead or on the selection. Refused when what the action needs is missing; the result says what changed (the undo step, the selection, the playhead, In/Out). |

### Selection, playhead, undo

| Tool | Arguments (required in bold) | What it does |
| --- | --- | --- |
| `select_clips` | sequence_id, **clip_ids**, add | Selects clips on the timeline (an empty list clears the selection); add keeps the selection there was. |
| `seek` | sequence_id, **time** | Moves the playhead (and the picture in the program monitor) to a time. |
| `play` | (none) | Starts playback in the program monitor from the playhead. |
| `stop` | (none) | Stops playback in the program monitor; the playhead stays where it is. |
| `undo` | (none) | Undoes the last step of the editor's history (the user's steps before your turn stay). |
| `redo` | (none) | Redoes the step of the editor history that was undone last. |

### Export

| Tool | Arguments (required in bold) | What it does |
| --- | --- | --- |
| `export_sequence` | sequence_id, **preset**, file_name, from, to, captions, width, height, codec, bitrate, bitrate_mode, key_seconds, audio_bitrate, loudness, wait | Exports the sequence to a new file in the project's folder with a preset (youtube-1080p, youtube-4k, shorts, 720p, audio-m4a) and optional overrides of the Export Settings: width, height (px, even), codec (h264 or hevc), bitrate (Mbps), bitrate_mode, key_seconds, audio_bitrate (128, 160 or 192 kbps), loudness (target LUFS, or null to leave it). The user is asked first and may say no; an existing file is never replaced. from/to export part of it; captions burn draws the shown caption track into the picture. It joins the export queue; wait: true waits until it is written, with progress (Stop cancels it). |
| `save_project` | (none) | Saves the project to its file. A project that was never saved opens the Save As dialog, where the user picks the place (or cancels). Never writes anywhere else. |
| `export_frame` | sequence_id, time, file_name | Saves the program monitor's picture at a time (default the playhead) as a new PNG in the project's folder (Export Frame). The user is asked first; an existing file is never replaced. |
| `export_captions` | sequence_id, track_id, format, file_name | Writes a caption track to a new .srt or .vtt file in the project's folder. The user is asked first; an existing file is never replaced. |
| `export_queue` | action, job_id | The export queue: list (its jobs: id, file name, state, progress, error), cancel, retry or remove a job (job_id), clear_finished. |

## 6. Every feature has an AI path

The rule: whatever a person can do in Cut, an AI can do through these tools, or the inventory says why not.
`control-actions.js` holds `INVENTORY`: every keyboard action (`ui-keys.js` `ACTIONS`), Automation item (`ui-auto.js`
`ITEMS`), menu item without an action (`ui-menubar.js`, by its English label), edit command (`commands.js`) and panel
(`Cut.ui.registerPanel`), each with the tools that cover it, a `run_action` entry (what it does, what it needs,
whether it only changes the view) or `no` with the reason. `verify/cut-control-core.mjs` reads those sources and
fails when one has no entry, when an entry names a tool that does not exist, or when an entry is left for a feature
that is gone; it also proves the check by adding a fake action, Automation item, menu item, panel and command.
When you add a feature, add its entry (and its tool or `run_action` entry), then paste the tables again with
`node verify/cut-control-core.mjs --inventory` (the test fails when a row is missing here).

Not for AI, and why, in short: full-screen playback and the panel under the mouse (the user's screen and pointer);
Save As, Save a Copy, Open and New Project (a new file at a place the user picks, or closing this project);
relinking and loading a .cube LUT (they pick files on disk); the preferences, keyboard shortcuts and the cheat
sheet (the user's own settings); the View menu's playback resolution, proxies, safe margins and tool bar (viewing
preferences); shuttling (hands-on playback; play, stop and seek do it); the Claude text features of the Automation
menu (the assistant is Claude: it reads and writes the captions, titles and chapters itself); the scopes and meters
(live measurements of the picture and the sound; get_frame and match_loudness stand in).

#### Keyboard actions (ui-keys.js)

| Feature | AI path |
| --- | --- |
| `playPause` | `play`, `stop` |
| `shuttleBack` | Not for AI: Shuttling is hands-on playback; play, stop and seek move the picture. |
| `shuttleStop` | `stop` |
| `shuttleForward` | Not for AI: Shuttling is hands-on playback; play, stop and seek move the picture. |
| `playInToOut` | run_action (needs inOut) |
| `frameBack` | run_action, `seek` |
| `frameForward` | run_action, `seek` |
| `frameBack5` | run_action, `seek` |
| `frameForward5` | run_action, `seek` |
| `prevEdit` | run_action |
| `nextEdit` | run_action |
| `prevEditAny` | run_action |
| `nextEditAny` | run_action |
| `goStart` | run_action, `seek` |
| `goEnd` | run_action, `seek` |
| `goIn` | run_action (needs in) |
| `goOut` | run_action (needs out) |
| `markIn` | run_action |
| `markOut` | run_action |
| `markClip` | run_action (needs clip) |
| `markSelection` | run_action (needs selection) |
| `clearIn` | run_action (needs in) |
| `clearOut` | run_action (needs out) |
| `clearInOut` | run_action |
| `addMarker` | run_action, `add_marker` |
| `nextMarker` | run_action (needs markers) |
| `prevMarker` | run_action (needs markers) |
| `clearMarker` | run_action (needs marker), `remove_markers` |
| `clearAllMarkers` | run_action (needs markers), `remove_markers` |
| `insert` | run_action (needs source), `place_clip` |
| `overwrite` | run_action (needs source), `place_clip` |
| `lift` | run_action (needs inOut), `delete_range` |
| `extract` | run_action (needs inOut), `delete_range` |
| `split` | run_action, `razor` |
| `splitAll` | run_action, `razor` |
| `rippleStart` | run_action (needs clip) |
| `rippleEnd` | run_action (needs clip) |
| `rippleDelete` | run_action (needs selection), `delete_clips` |
| `delete` | run_action (needs selection), `delete_clips` |
| `toggleEnabled` | run_action (needs selection), `set_clip` |
| `link` | run_action (needs selection), `link_clips` |
| `group` | run_action (needs two), `link_clips` |
| `ungroup` | run_action (needs selection), `link_clips` |
| `nest` | `nest_clips` |
| `nudgeLeft` | run_action (needs selection), `move_clips` |
| `nudgeRight` | run_action (needs selection), `move_clips` |
| `nudgeLeft5` | run_action (needs selection), `move_clips` |
| `nudgeRight5` | run_action (needs selection), `move_clips` |
| `nudgeUp` | run_action (needs selection), `move_clips` |
| `nudgeDown` | run_action (needs selection), `move_clips` |
| `selectAtPlayhead` | run_action, `select_clips` |
| `matchFrame` | run_action (needs clip) |
| `extendEdit` | run_action, `trim_clip` |
| `speed` | `set_speed` |
| `freezeFrame` | run_action (needs video), `set_time_remap` |
| `transitionVideo` | run_action, `add_transition` |
| `transitionAudio` | run_action, `add_transition` |
| `transitionBoth` | run_action (needs selection), `add_transition` |
| `cut` | run_action (needs selection) |
| `copy` | run_action (needs selection) |
| `paste` | run_action (needs clipboard) |
| `pasteInsert` | run_action (needs clipboard) |
| `selectAll` | run_action, `select_clips` |
| `deselect` | run_action, `select_clips` |
| `tool.select` | run_action |
| `tool.trackForward` | run_action |
| `tool.trackBackward` | run_action |
| `tool.ripple` | run_action |
| `tool.roll` | run_action |
| `tool.rate` | run_action |
| `tool.razor` | run_action |
| `tool.slip` | run_action |
| `tool.slide` | run_action |
| `tool.pen` | run_action |
| `tool.hand` | run_action |
| `tool.zoom` | run_action |
| `tool.text` | run_action |
| `snap` | run_action |
| `zoomIn` | run_action |
| `zoomOut` | run_action |
| `zoomFit` | run_action |
| `videoTracksTaller` | run_action |
| `videoTracksShorter` | run_action |
| `audioTracksTaller` | run_action |
| `audioTracksShorter` | run_action |
| `expandTracks` | run_action |
| `minimizeTracks` | run_action |
| `fullscreen` | Not for AI: Full-screen playback takes over the user's screen; the user starts it (Ctrl+`). |
| `maximizePanel` | run_action |
| `maximizeUnderCursor` | Not for AI: It acts on the panel under the mouse pointer, which an AI does not hold; maximizePanel does the same for the focused panel. |
| `undo` | `undo` |
| `redo` | `redo` |
| `save` | `save_project` |
| `saveAs` | Not for AI: It writes the project to a new file at a place the user picks; save_project saves it to its own file (asking for a place only when it has none). |
| `saveCopy` | Not for AI: It writes a copy of the project to a place the user picks; the user does it. |
| `open` | Not for AI: It closes this project and opens another; that is the user's call. |
| `newProject` | Not for AI: It closes this project for a new one; that is the user's call. |
| `newSequence` | `add_sequence` |
| `newBin` | run_action, `project_items` |
| `import` | `import_media` |
| `export` | `export_sequence` |
| `exportFrame` | `export_frame` |
| `workspace.editing` | run_action |
| `workspace.color` | run_action |
| `workspace.effects` | run_action |
| `workspace.audio` | run_action |
| `workspace.captions` | run_action |
| `workspace.export` | run_action |
| `workspace.reset` | run_action |
| `keyHelp` | Not for AI: A cheat sheet of keys for the person at the keyboard. |
| `keyboardShortcuts` | Not for AI: The user's own keyboard settings. |
| `settings` | Not for AI: The user's preferences (Settings > Video Editor). |
| `selectUnused` | run_action, `get_media` |
| `removeUnused` | `remove_media` |
| `findMissing` | Not for AI: Relinking picks files on disk in a dialog; the user does it (File > Find Missing Media…). get_media shows which media are offline. |
| `createProxy` | `proxies` |

#### The Automation menu (ui-auto.js)

| Feature | AI path |
| --- | --- |
| `silence` | `remove_silence` |
| `scenes` | `automation` |
| `beats` | `automation` |
| `captions` | `automation` |
| `fillers` | `automation` |
| `speakers` | `automation`, `speakers` |
| `nextUncertain` | run_action |
| `prevUncertain` | run_action |
| `aiPolish` | Not for AI: The assistant is Claude: it reads the captions (get_captions) and fixes them itself (set_caption). |
| `aiTranslate` | Not for AI: The assistant is Claude: it reads the captions (get_captions) and writes a translated track itself (add_captions). |
| `aiMetadata` | Not for AI: The assistant is Claude: it writes titles and descriptions in its answer, from get_transcript; chapters are add_marker with kind chapter. |
| `aiHighlights` | `create_shorts`, `get_transcript` |
| `aiCommand` | Not for AI: An edit command in plain words is what the assistant itself does. |
| `aiAssistant` | Not for AI: It opens this chat. |
| `loudness` | `automation` |
| `clipLoudness` | `automation` |
| `duck` | `automation` |
| `isolateVoice` | `automation` |
| `color` | `automation` |

#### Menu items without an action (ui-menubar.js)

| Feature | AI path |
| --- | --- |
| `New` | `add_sequence`, `project_items` |
| `Project…` | Not for AI: It closes this project for a new one; that is the user's call. |
| `Sequence…` | `add_sequence` |
| `Bin` | `project_items` |
| `Save As…` | Not for AI: It writes the project to a new file at a place the user picks. |
| `Save` | `save_project` |
| `Import…` | `import_media` |
| `Import Folder…` | `import_media` |
| `Export` | `export_sequence`, `export_frame`, `export_captions` |
| `Media…` | `export_sequence` |
| `Frame…` | `export_frame` |
| `Captions…` | `export_captions` |
| `Preferences…` | Not for AI: The user's preferences. |
| `Video Options` | `set_time_remap` |
| `Time Interpolation` | `set_clip` |
| `Frame Sampling` | `set_clip` |
| `Frame Blending` | `set_clip` |
| `Proxy` | `proxies` |
| `Sequence Settings…` | `set_sequence` |
| `Add Video Track` | `add_track` |
| `Add Audio Track` | `add_track` |
| `Edit Marker…` | `set_marker` |
| `New Layer` | `add_text`, `add_color_matte` |
| `Text` | `add_text` |
| `Color Matte` | `add_color_matte` |
| `Import Captions…` | `import_media` |
| `Export Captions…` | `export_captions` |
| `Caption Style…` | `set_caption_track` |
| `Playback Resolution` | Not for AI: A viewing preference of the user (how sharp the monitor draws while editing). |
| `Full` | Not for AI: A viewing preference of the user. |
| `1/2` | Not for AI: A viewing preference of the user. |
| `1/4` | Not for AI: A viewing preference of the user. |
| `Play Proxies` | Not for AI: A playback preference of the user; proxies makes and removes them. |
| `Safe Margins` | Not for AI: A viewing aid of the user. |
| `Timeline Tool Bar` | Not for AI: A layout preference of the user. |
| `Workspaces` | run_action |
| `Find Action…` | Not for AI: A search box for the person at the keyboard. |

#### Edit commands (commands.js)

| Feature | AI path |
| --- | --- |
| `importMedia` | `import_media` |
| `removeMedia` | `remove_media` |
| `relinkMedia` | Not for AI: Relinking picks a file on disk; the user does it (Find Missing Media…). |
| `addBin` | `project_items` |
| `removeBin` | `project_items` |
| `renameItem` | `project_items` |
| `moveToBin` | `project_items` |
| `addSequence` | `add_sequence`, `create_shorts` |
| `removeSequence` | `remove_sequence` |
| `setSequence` | `set_sequence` |
| `addTrack` | `add_track` |
| `removeTrack` | `remove_track` |
| `setTrack` | `set_track` |
| `place` | `place_clip` |
| `placeRange` | `place_clip` |
| `move` | `move_clips` |
| `trim` | `trim_clip` |
| `split` | `razor` |
| `remove` | `delete_clips` |
| `rippleToPlayhead` | `run_action` |
| `closeGap` | `delete_range` |
| `lift` | `delete_range` |
| `extract` | `delete_range` |
| `setClip` | `set_clip`, `set_speed` |
| `setKeyframes` | `set_keyframes` |
| `setRemap` | `set_time_remap` |
| `link` | `link_clips` |
| `unlink` | `link_clips` |
| `group` | `link_clips` |
| `ungroup` | `link_clips` |
| `nest` | `nest_clips` |
| `slip` | `trim_clip` |
| `slide` | `trim_clip` |
| `stretch` | `trim_clip` |
| `extendEdit` | `run_action` |
| `addEffect` | `add_effect`, `essential_sound`, `set_color` |
| `removeEffect` | `remove_effect` |
| `setEffect` | `set_effect`, `set_color` |
| `moveEffect` | `set_effect` |
| `addMask` | `add_mask` |
| `setMask` | `set_mask` |
| `removeMask` | `remove_mask` |
| `addTransition` | `add_transition` |
| `removeTransition` | `remove_transition` |
| `setTransition` | `set_transition` |
| `addGenerated` | `add_text`, `add_color_matte` |
| `freezeFrame` | `run_action` |
| `addMarker` | `add_marker` |
| `setMarker` | `set_marker` |
| `removeMarker` | `remove_markers` |
| `addCaptionTrack` | `add_captions` |
| `setCaptionTrack` | `set_caption_track` |
| `removeCaptionTrack` | `remove_captions` |
| `setCaptions` | `automation` |
| `addCaption` | `add_captions` |
| `setCaption` | `set_caption` |
| `removeCaption` | `remove_captions` |
| `setProxy` | `proxies` |
| `setSettings` | `set_project_settings` |
| `setSpeakers` | `speakers`, `automation` |
| `addLut` | Not for AI: Loading a .cube LUT reads a file the user picks in the Lumetri Color panel; set_color uses the LUTs the project has. |
| `paste` | `run_action` |
| `setGenerator` | `set_clip` |
| `setLayer` | `set_text` |
| `addLayer` | `set_text` |
| `removeLayer` | `set_text` |
| `setRole` | `set_clip` |
| `replaceAudio` | `automation` |
| `batch` | `remove_silence`, `essential_sound` |

#### Panels

| Feature | AI path |
| --- | --- |
| `project` | `get_media`, `import_media`, `project_items`, `remove_media`, `add_sequence`, `proxies` |
| `source` | `run_action`, `place_clip` |
| `program` | `get_frame`, `seek`, `play`, `stop` |
| `timeline` | `get_sequence`, `place_clip`, `move_clips`, `trim_clip`, `razor`, `delete_clips`, `set_track`, `add_track`, `run_action` |
| `controls` | `get_clip`, `set_clip`, `set_keyframes`, `set_effect`, `set_time_remap`, `add_mask`, `set_mask` |
| `effects` | `list_effects`, `add_effect`, `add_transition` |
| `text` | `add_text`, `set_text` |
| `color` | `set_color` |
| `scopes` | Not for AI: Scopes measure the program monitor's picture; get_frame shows the picture itself. |
| `history` | `undo`, `redo`, `get_state` |
| `meters` | Not for AI: Live levels while playing; automation match_loudness measures the loudness. |
| `markers` | `get_markers`, `add_marker`, `set_marker`, `remove_markers` |
| `mixer` | `set_track`, `set_sequence` |
| `essential` | `essential_sound`, `set_clip`, `automation` |
| `captions` | `get_captions`, `add_captions`, `set_caption`, `remove_captions`, `set_caption_track` |
| `transcript` | `get_transcript`, `automation`, `delete_range`, `speakers` |
| `export` | `export_sequence` |
| `queue` | `export_queue` |
| `tools` | `run_action` |
| `assistant` | Not for AI: It is this chat; the AI works through the tools, not through the panel. |

## 7. The chat turn

1. Send (or Enter) in the panel shows the notice the first time, then checks `cut:aiStatus` (no Claude Code: the text
   AI's explanation), then calls `cut:agentRun {turn, system, prompt, model}`. The history position is remembered as
   the turn's floor.
2. `main/cut/agent.js` starts the CLI with the flags of section 3 and reads its stream-json lines:
   - a `stream_event` with a `text_delta` becomes `{type: 'text', text}` while Claude writes;
   - an `assistant` message gives its text (`final: true`) and a `{type: 'tool', id, name, input}` for each `tool_use`
     block (the name without `mcp__cut__`);
   - a `user` message gives a `{type: 'result', id, ok, text}` for each `tool_result` block (`is_error` is a refusal);
   - the `result` line ends the turn: `{type: 'done', ok, text}` or `{type: 'done', ok: false, code, error}`
     (`error_max_turns`, an error result, an exit without a result).
3. The panel shows the text, and a step per `tool` (its line from `Cut.control.describe`, translated) that turns done,
   or refused with the reason, at its `result`.
4. Meanwhile the CLI's calls reach the page through the server. Each edit that lands brings its sequence to the front,
   flashes the changed clips on the timeline (`Cut.ui.timeline.flash(clips)`: a bright edge that fades in about 1.4 s)
   and moves the playhead to the edit (`program.seek`, not while playing). The timeline and the program monitor redraw
   from the `project` event as for any edit. Each edit is its own step in History while the turn runs.
5. At the end `history.squash(floor, request)` makes the turn's steps one undo step named after the request. Stop
   (`cut:agentStop`) kills the CLI's process tree and the page refuses the turn's calls at once; what was done is
   squashed the same way, and the project is valid since every step is a whole command.
6. Codes: `not-installed`, `auth` and `quota` open the text AI's explanation (`Cut.ui.ai.explain`); `cancelled` says it
   stopped; `timeout` and `cli` say Claude Code failed.

A follow-up request carries the last six requests and answers of the same project as text (no session file). Edits
the user makes by hand while a turn runs join the turn's undo step; between turns they are their own steps.

## 8. Connecting an external AI

1. Settings › Video Editor › AI Control: check "외부 AI가 Cut을 조작하도록 허용" and Apply.
2. Copy the command for Claude Code and run it in a terminal:

   ```
   claude mcp add --transport http nano-cut http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
   ```

   or the JSON for another MCP client:

   ```json
   { "mcpServers": { "nano-cut": { "type": "http", "url": "http://127.0.0.1:<port>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
   ```

3. While the client is connected (an `initialize` within the last 10 minutes), a banner over the editor names it, with
   Disconnect. Its edits flash and move the playhead as the assistant's do, are listed in the AI Assistant panel under
   "외부 AI", and each is one undo step.

## 9. Tests

- `verify/cut-control-core.mjs` (plain Node): the tool list (names, descriptions, strict schemas, annotations, size, no
  path arguments, every tool in this file); every editing tool on a real project (what changed, one step each, valid,
  undo exact); refusals with the project unchanged (bad ids, times outside the sequence, locked tracks, unknown effects
  and parameters, out-of-range values, a file path for a media id, unknown and mistyped arguments, the undo floor, a
  declined export); no disk or IPC while every tool runs; `history.squash`; the server over real HTTP (no token, a
  wrong token, Origin, Host, a turn's token after the turn, the external token only while allowed and replaced by
  Disconnect, tools/list, calls answered by a stand-in page, a page that goes away); the agent with the scripted CLI
  (flags, events, Stop, quota, a missing CLI, nothing left behind); `control.js` and its tool files as page scripts.
  The tools of the other files on a real project: Time Remapping with a ramp, a hold and a reverse (the source time
  the frames show), mask path, feather, opacity and expansion keyframes (an effect's mask too), Lumetri curves, LUT
  and HSL secondary, audio effect parameters and their keyframes, the mixer's track and master, Essential Sound,
  speed by duration, slip and rate stretch, color mattes, title styles, layers and motion presets, tracks,
  transitions, caption track styles, sequences, bins, unused media, project settings, the shorts sequence, speakers;
  their refusals with the project unchanged; the page's services stood in (import with network shares, relative
  and `..` paths refused and a declined confirmation, save, the frame, caption and sequence exports with their
  options, waiting and Stop, the export queue, proxies with Stop, automation's argument checks, a declined download,
  a stopped job). The inventory (section 6): every feature read from the sources has an entry, and a fake keyboard
  action, Automation item, menu item, panel and command added without one fail the check. run_action: what it needs,
  refusals before it runs, what it reports. Every tool's step line has Korean.
- `verify/cut-ai-chat.mjs` (app, port 9807, Korean, real mouse and keys): the panel from the Window menu, a turn that
  changes the timeline while it runs with steps, flash and playhead, one Ctrl+Z for the turn, a refused step, Stop,
  export asking, a usage limit, the external setting off by default, its connection block and Copy, tokens refused, a
  scripted external client editing live with the banner, Disconnect; screenshots in both themes.
- `verify/cut-ai-tools.mjs` (app, port 9808, Korean, real mouse and keys, the fake Whisper backend and its fake setup):
  run_action (In, Out, Extract, a refused Ripple Delete, a marker; one undo step); a speed ramp and hold, mask
  keyframes, Lumetri curves and HSL, the mixer (its panel shows the values); import (the dialog lists only the file
  outside the project's folder, Don't Import changes nothing, a file in the folder comes in without a question);
  auto captions (the setup dialog's Cancel is a refusal with nothing downloaded, the job's progress on its step, Stop
  ends it with nothing changed, a full run makes a caption track as one undo step); screenshots in both themes.
- `verify/fake-claude-cut.mjs` with `--mcp-config` is the scripted agent the app suites use: it connects to the server named in
  the config with the token there and calls tools as a model would (the request's words pick the script; the
  scenario's `stepMs` paces it).

## 10. Not done

- The real Claude Code CLI was not run against the server (no API calls in tests). The flags and the stream-json shape
  come from `claude --help` (2.1.318), its bundle and `main/ai/claude.js`; the scripted CLI stands in.
- Refusal sentences are English (they are written for the model). The chat shows them under the refused step as they
  are, and Claude's answer explains in the user's language.
- Tested with the scripted CLI and stand-ins only: the real Whisper, WeSpeaker and HTDemucs models were not run by
  the tools (the app suite uses the fake Whisper backend and its fake setup; label_speakers and isolate_voice run the
  same page functions as the menu, through `services.automation`, and were not run live by an AI). Proxies, Export
  Frame, caption export and `export_sequence` with `wait` were checked in Node with stand-in services, not in the app.
- Toasts an action shows (the "changed nothing" reason of run_action and of a job) come back in the user's language,
  since the editor shows them translated.
- run_action dispatches to the timeline as the menu bar does; actions of the Source monitor's own In and Out are not
  reachable (they are the sequence's). Reassigning transcript words to another speaker and the Text panel's saved
  styles have no tool.
- The tool list grew from 49 tools (40,756 characters of tools/list JSON) to 71 (about 71,000 characters); clients that
  load tools lazily (Claude Code's tool search) take less.
