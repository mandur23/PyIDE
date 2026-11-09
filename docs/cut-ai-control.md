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
| `renderer/features/cut/control.js` | The tools (`TOOLS`: name, kind, title, description, JSON schema, `run`), the schema check, `call(name, args, env)`, `definitions()` for MCP, `describe()` for the chat's step lines, `INSTRUCTIONS`. Pure: loads in Node and in the page. |
| `renderer/features/cut/ui-assistant.js` | Lists the tools with main, answers calls one at a time on `Cut.app` with the page's services (frame, transcript, silence, playback, the export question), shows each edit landing, the AI Assistant panel, the chat turn (undo grouping, Stop), the external AI banner and the settings section. |
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
  removing markers by kind, removing silence) go through it.
- No tool reads or writes a file, takes a path, opens anything or runs a program. Media come in only by their ids in
  the project (a path where a media id goes is refused with a sentence saying so), and `get_media` gives names, never
  paths. `control.js` has no file, process, network or IPC call; `verify/cut-control-core.mjs` checks the source and
  watches `fs`, `child_process` and the page's IPC while every tool runs.
- `export_sequence` writes only after the user says yes in a dialog that names the preset, the range and the file. The
  file is new: in the project's folder (or `Projects`), named from a plain file name (no folders), never one that
  exists or that the project uses. It is then queued in the export queue.
- Locked tracks are the user's: every tool refuses to change them, and `set_track` cannot lock or unlock.
- A chat turn's `undo` cannot go past the steps the turn made.

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
  changed, found by comparing the sequence before and after.

## 5. The tools

The table is made from `Cut.control.TOOLS` by `node verify/cut-control-core.mjs --table`; paste it again after
changing a tool. `verify/cut-control-core.mjs` fails when a tool is missing from this file.

### Reading

| Tool | Arguments (required in bold) | What it does |
| --- | --- | --- |
| `get_project` | (none) | The project's sequences (size, rate, length, clip count, which is active), its media count, the playhead and the selection. Start here. |
| `get_sequence` | sequence_id, from, to, max_clips | A sequence's tracks, clips (time on the timeline, source range, effects, links), transitions and caption tracks. from/to (seconds) keep the clips that overlap that range; long sequences are cut at max_clips. |
| `get_clip` | sequence_id, **clip_id** | Everything about one clip: properties, keyframes (times on the timeline), effects with all their parameters, masks, text layers, clip markers. |
| `get_media` | (none) | The project's media: id, name, kind, length, picture size and rate, whether it has sound, how many clips use it. No file paths. |
| `get_markers` | sequence_id | The sequence markers and the clip markers (times on the timeline). |
| `get_captions` | sequence_id, track_id, from, to, max_items | Caption tracks and their items (id, start, end, text). track_id picks one track; from/to (s) keep the items in that range; max_items caps each track (default 300). |
| `get_transcript` | sequence_id, from, to | What is said in the sequence, from speech recognition already done in Cut: segments with start, end (s) and text. Empty when the speech was not recognised yet (the user runs Auto Captions or the Transcript panel). |
| `list_effects` | kind, search | The video and audio effects and the transitions there are, with their parameters as "id: type min..max = default". kind and search narrow the list. |
| `get_frame` | sequence_id, time, width | A PNG of the program monitor's picture at a time (the playhead when left out), with the shown caption track burned in, so you can see the edit. |
| `get_state` | (none) | The playhead, whether it plays, the selected clips, the sequence In/Out and the last steps of the undo history. |

### Editing

| Tool | Arguments (required in bold) | What it does |
| --- | --- | --- |
| `place_clip` | sequence_id, media_id, nest_sequence_id, **at**, mode, video_track, audio_track, source_in, source_out, duration | Puts media (or a nest of another sequence) on the timeline at a time. mode overwrite replaces what is there; insert pushes later clips. Video goes on video_track (default V1), sound on audio_track (default A1); null leaves that part out. source_in/source_out pick part of the media (s); a picture takes duration (s). |
| `move_clips` | sequence_id, **clip_ids**, to, delta, track_delta, insert, linked | Moves clips along the timeline (to: the new start of the earliest one, or delta: seconds, negative earlier) and between tracks (track_delta: +1 one track up, -1 down). Linked and grouped clips move along unless linked is false. insert pushes clips at the destination instead of overwriting them. |
| `trim_clip` | sequence_id, **clip_id**, **edge**, to, delta, mode, linked | Moves a clip's start or end edge (to: the new edge time, or delta: seconds). mode normal leaves a gap or fills one, ripple moves later clips with the edge, roll moves the neighbouring clip's edge too. The result says where it stopped and why (source, neighbour, length). |
| `razor` | sequence_id, **at**, track_ids, clip_ids | Cuts clips in two at a time: on every unlocked track, or only on track_ids, or only clip_ids (with their linked clips). |
| `delete_clips` | sequence_id, **clip_ids**, ripple, linked | Removes clips (with their linked and grouped clips unless linked is false). ripple closes the gaps they leave on their tracks and the sync-locked ones. |
| `delete_range` | sequence_id, **from**, **to**, ripple, track_ids | Removes from..to (s) on every unlocked track, or on track_ids. ripple (default true) pulls later material earlier (Premiere's Extract: "cut the first 3 seconds"); ripple false leaves a gap (Lift). |
| `link_clips` | sequence_id, **clip_ids**, **action** | link joins clips so they move, trim and get deleted together; unlink parts them; group and ungroup do the same for a group (clips that move and delete together). |
| `set_clip` | sequence_id, **clip_id**, name, enabled, role, opacity, position, scale, rotation, anchor, crop, volume, pan, fade_in, fade_out, linked | Changes a clip's settings. Video clips: opacity (%), position ([x, y] px from the center), scale (% or [w %, h %]), rotation (deg), anchor, crop ([top, right, bottom, left] %). Audio clips: volume (dB, 0 unchanged), pan (-100..100), fade_in, fade_out (s). Both: name, enabled, role (dialogue, music, effects, ambience or null). The value is the clip's static value; set_keyframes animates it. |
| `set_speed` | sequence_id, **clip_id**, speed, reverse, ripple, linked | Speed/Duration: a clip's constant speed in % (100 normal, 50 slow motion, 200 twice as fast) and reverse. ripple (default true) moves later clips with the new length. Linked clips change too unless linked is false. |
| `set_time_remap` | sequence_id, **clip_id**, segments, off | Time Remapping of a video clip: its speed changes along it. segments in order, each {speed: % (1 to 10000), until: the timeline time (s) where the next segment starts}; the last has no until. Each segment keeps its source frames, so the clip gets longer or shorter (up to the next clip). off: true goes back to one constant speed. |
| `set_keyframes` | sequence_id, **clip_id**, **property**, **keyframes** | Animates a property of a clip: the full list of keyframes (time on the timeline in s, inside the clip; value; ease linear, hold, easeIn, easeOut or easeInOut). An empty list removes the animation. property: a clip property (opacity, position, scale, rotation, anchor, crop, volume, pan) or "effects.<effect id>.<parameter>". |
| `add_effect` | sequence_id, **clip_id**, **type**, params, index | Adds a video or audio effect (list_effects) to a clip, with parameters that differ from the defaults. The effect's kind must match the clip's track. Returns the effect id. |
| `set_effect` | sequence_id, **clip_id**, **effect_id**, on, params | Turns an effect on or off and changes its parameters (null puts one back to its default). |
| `remove_effect` | sequence_id, **clip_id**, **effect_id** | Removes an effect from a clip, with its keyframes and masks. |
| `set_color` | sequence_id, **clip_id**, temperature, tint, exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance | Lumetri Color's basic correction of a video clip: temperature, tint, contrast, highlights, shadows, whites, blacks, vibrance (-100..100), exposure (-4..4 stops), saturation (0..200 %, 100 unchanged). Uses the clip's Lumetri Color effect, adding one when it has none. |
| `add_transition` | sequence_id, **track**, **at**, type, duration, align, params | Puts a transition on an edit point of a track (where two clips meet, or a clip's start or end). type from list_effects (default: a cross dissolve, or a crossfade on audio); duration (s) defaults to the project's; align center, start or end. |
| `remove_transition` | sequence_id, **transition_id** | Removes a transition (ids from get_sequence). |
| `add_text` | sequence_id, **text**, **at**, duration, track, size, color, font, weight, position, box | Adds a text clip (a title) at a time for duration seconds (default the project's still length), on track or else on the lowest free video track above the clips there (a new track when none is free). |
| `set_text` | sequence_id, **clip_id**, layer_id, text, size, color, font, weight, position, box | Changes a text clip's text and look (its first layer, or layer_id). |
| `add_captions` | sequence_id, track_id, name, lang, **items** | Adds caption items to a caption track (track_id), or makes a new caption track (name, lang) with them. Captions are subtitles shown over the picture, not title clips. |
| `set_caption` | sequence_id, **track_id**, **caption_id**, text, start, end | Changes one caption's text or times. |
| `remove_captions` | sequence_id, **track_id**, caption_ids, whole_track | Removes captions by id, or the whole caption track (whole_track: true). |
| `add_marker` | sequence_id, **at**, name, kind, color, note, duration, clip_id | Adds a sequence marker at a time, or a clip marker (clip_id). kind comment (default), chapter (YouTube chapters) or beat; color one of green, red, purple, orange, yellow, white, blue, cyan. |
| `set_marker` | sequence_id, **marker_id**, at, name, kind, color, note | Changes a marker's time, name, kind, color or note. |
| `remove_markers` | sequence_id, marker_ids, kind | Removes markers by id, or every sequence marker of a kind (comment, chapter, beat or all). |
| `add_mask` | sequence_id, **clip_id**, effect_id, **shape**, x, y, width, height, feather, opacity, expansion, inverted, mode | Adds a mask to a video clip's Opacity (the clip shows only inside it), or to one of its effects (effect_id: the effect applies only inside). shape ellipse or rectangle, centered at x, y with width and height, all fractions 0..1 of the clip's picture. |
| `set_mask` | sequence_id, **clip_id**, **mask_id**, effect_id, feather, opacity, expansion, inverted, mode | Changes a mask's feather, opacity, expansion, inverted or mode. |
| `remove_mask` | sequence_id, **clip_id**, **mask_id**, effect_id | Removes a mask and its keyframes. |
| `nest_clips` | sequence_id, **clip_ids**, name | Moves clips (with their linked and grouped clips) into a new sequence and puts one nest clip of it in their place, as Premiere's Clip > Nest. Returns the new sequence and the nest clips. |
| `set_track` | sequence_id, **track_id**, name, visible, mute, solo, volume, pan, sync_lock | Changes a track: name; video tracks visible; audio tracks mute, solo, volume (dB, -60..24) and pan (-100..100); sync_lock. Locking and unlocking stay the user's. |
| `set_sequence` | sequence_id, name, master_gain, background | Changes the sequence's name, its master gain (dB on the whole mix, -60..24) or background color. |
| `remove_silence` | sequence_id, **longer_than**, threshold | Measures the sound on this PC and ripple-deletes every stretch quieter than threshold (dB, default -40) that lasts longer than longer_than seconds, on the speech tracks (music, effects and ambience clips do not count). |

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
| `export_sequence` | sequence_id, **preset**, file_name, from, to, captions | Exports the sequence to a new video file with a preset (youtube-1080p, youtube-4k, shorts, 720p, audio-m4a), in the project's folder. The user is asked first and may say no; an existing file is never replaced. from/to export part of it; captions burn draws the shown caption track into the picture. |

## 6. The chat turn

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

## 7. Connecting an external AI

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

## 8. Tests

- `verify/cut-control-core.mjs` (plain Node): the tool list (names, descriptions, strict schemas, annotations, size, no
  path arguments, every tool in this file); every editing tool on a real project (what changed, one step each, valid,
  undo exact); refusals with the project unchanged (bad ids, times outside the sequence, locked tracks, unknown effects
  and parameters, out-of-range values, a file path for a media id, unknown and mistyped arguments, the undo floor, a
  declined export); no disk or IPC while every tool runs; `history.squash`; the server over real HTTP (no token, a
  wrong token, Origin, Host, a turn's token after the turn, the external token only while allowed and replaced by
  Disconnect, tools/list, calls answered by a stand-in page, a page that goes away); the agent with the scripted CLI
  (flags, events, Stop, quota, a missing CLI, nothing left behind); `control.js` as a page script.
- `verify/cut-ai-chat.mjs` (app, port 9807, Korean, real mouse and keys): the panel from the Window menu, a turn that
  changes the timeline while it runs with steps, flash and playhead, one Ctrl+Z for the turn, a refused step, Stop,
  export asking, a usage limit, the external setting off by default, its connection block and Copy, tokens refused, a
  scripted external client editing live with the banner, Disconnect; screenshots in both themes.
- `verify/fake-claude-cut.mjs` with `--mcp-config` is the scripted agent both use: it connects to the server named in
  the config with the token there and calls tools as a model would (the request's words pick the script; the
  scenario's `stepMs` paces it).

## 9. Not done

- The real Claude Code CLI was not run against the server (no API calls in tests). The flags and the stream-json shape
  come from `claude --help` (2.1.318), its bundle and `main/ai/claude.js`; the scripted CLI stands in.
- Refusal sentences are English (they are written for the model). The chat shows them under the refused step as they
  are, and Claude's answer explains in the user's language.
- No tool imports media, makes or removes sequences, or changes project settings; nested sequences come only from
  `nest_clips`. Time remapping takes constant-speed segments (no ramps, holds or reverse segments).
- `get_transcript` reads transcripts already made in Cut; it does not run speech recognition.
