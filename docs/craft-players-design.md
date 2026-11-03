# Server player admin: design

Goal: a Players tab on a server that the app runs, in Code and Craft modes. It shows who is on, keeps a per-player log,
shows inventories and player state, and lets the owner act on players through buttons. It works through the server's own
console and files, and installs nothing unless the owner turns on detailed logging on a Paper or Purpur server.

Phases 1 to 4 are built. Phase 4 is the NanoBridge plugin: see Detailed logging.

## Boundaries

- Only servers this app started. External servers and RCON are out of scope.
- A proxy (Velocity) has no players' entities: its Players tab says so and shows nothing else.
- Never accept the EULA, never start the real game or launcher, never run a real Minecraft server in tests.
- All logic lives in main, so logging continues while no window shows the tab.

## Data flow

`minecraft:start` passes a `filter` to `startProcess` (main.js). The filter hands complete lines to a per-server session
and returns the text for the console, without the lines of queries the session made itself. Commands from the session
go to the process's stdin. A session starts with the process and ends at its exit.

Log lines come in differing prefixes: vanilla `[12:00:00] [Server thread/INFO]: `, Paper the same or `[12:00:00 INFO]: `,
Forge `[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: `, Fabric `[12:00:00] [Server thread/INFO] (Minecraft) `.
On 26.3, what the server tells its console follows this prefix behind `System chat: `, which is the answers to commands and
every broadcast (joins, deaths, advancements). Chat has its own logger and does not have it. 1.20.1 has neither.

## Files

| File | Owns |
|---|---|
| `main/minecraft/players/logparse.js` | `parseLine(line)` -> an event or null. Pure. |
| `main/minecraft/players/nbt.js` | Binary gzip NBT reader for `playerdata/<uuid>.dat`, and an SNBT parser. Pure. |
| `main/minecraft/players/session.js` | One running server: the tap, the roster, `query(command)`, polling. |
| `main/minecraft/players/store.js` | `<server>/.nano/players/`: `index.json`, `<uuid>.jsonl`, `admin.jsonl`, pruning. |
| `main/minecraft/players/actions.js` | action -> console command lines, per game version. Pure. |
| `main/minecraft/players/items.js` | Item catalog: ids, English and Korean names, icons. |
| `main/minecraft/players/bridge.js` | The plugin from main: parsing its lines, tailing its files, install and removal. |
| `main/minecraft/players/NanoBridge.jar` | The built plugin, so that installing it needs no Gradle. Made by `tools/nano-bridge/build.mjs`. |
| `tools/nano-bridge/` | The plugin's Java source, `plugin.yml`, its tests and the build script. |
| `renderer/features/minecraft/players.js` | The Players tab. It loads the two files below itself. |
| `renderer/features/minecraft/players-drag.js` | Dragging in the inventory. |
| `renderer/features/minecraft/players-bridge.js` | The offer of detailed logging, and applying it to other servers. |

## Shapes

```
Event  {t: ISO time, type: 'join'|'leave'|'chat'|'death'|'advancement'|'command'|'server', name, uuid|null, text, x?, y?, z?}
       plugin types: 'break'|'place'|'ignite'|'bucket'|'sign'|'open'|'take'|'put'|'pickup'|'drop'|'hit'|'hurt'|'kill'|'pvp'|'cmd',
       with {time: when it happened, world, x, y, z, n, id?, other?, weapon?, amount?, at?: [[x, y, z]]}. t is when it arrived.
Player {uuid, name, online, firstSeen, lastSeen, playTimeMs, op, opLevel, whitelisted, banned, pos: {x,y,z,dimension}|null}
Slot   {slot, id, count, name|null, enchantments: [{id, level}], damage|null, print: sha1 of the whole stack but its slot, raw}
Detail {source: 'live'|'file', health, food, xpLevel, gamemode, pos, inventory: [Slot], armor: [Slot], offhand: Slot|null,
        ender: [Slot], selected, stats: {playTimeTicks, deaths, mobKills, jumps}, advancements: n}
Action {type, target: name, ...fields}
Item   {id, name, ko|null, icon: data URL|null, mod|null}
```

`slot` numbers are the game's: 0-8 hotbar, 9-35 main, 100-103 armor, -106 offhand, and 200-226 the ender chest where one
number has to name any slot (a Detail's `ender` keeps 0-26).

## IPC

Every channel takes `(root, dir, ...)` and calls `guard(root)`. Results come back as values for conditions the UI
branches on, because Electron passes only the message of a thrown error.

- `players:list(root, dir)` -> `{running, state: 'starting'|'running'|'stopping'|'stopped', proxy, players: [Player]}`
- `players:timeline(root, dir, uuid, {before, limit, types, q})` -> `{events: [Event], more}`
- `players:search(root, dir, {q, types, limit})` -> `[Event]`, across players
- `players:detail(root, dir, uuid)` -> Detail, live while online, else from files
- `players:action(root, dir, action)` -> `{ok, text, commands}`
- `players:items(root, dir, query)` -> `{items: [Item], reason, reasonCode, skipped, coverage}`, at most 200 items. Not an
  array with extra properties: those do not cross the context bridge.
- `players:icons(root, dir, ids)` -> `{id: Item}`, for what an inventory shows
- `players:names(root, dir)` -> `{enchantments: [{id, name, ko}], effects: [{id, name, ko}], reason?, reasonCode?}`, from the
  same language files as items. Without them, the ids known to the app, named after themselves, with `ko: null` and a reason.
- `players:adminLog(root, dir, {limit})` -> `[{t, action, commands, ok, text, code?, changed?}]`, `code` being the result's and
  `changed` a mismatched move's `[{slot, name, before, after}]`: every slot that differs, as the game printed it
- `players:watch(root, dir, on)` -> `true`, a 30 s lease on position polling, which the tab repeats every 10 s while it shows
- `players:bridge(root, dir)` -> `{code: why not, or null; installed: 'none'|'current'|'other'; running; active; stats}`
- `players:bridgeInstall(root, dir)`, `players:bridgeRemove(root, dir)` -> `{ok, code?, restart}`, each in the admin log
- `players:bridgeServers(root)` -> the same status for every server of the project, with its name, dir, kind and version
- push `minecraft:players` `{dir, kind: 'roster'|'event'|'position'}`, so the tab refreshes without polling

## Polling

- Roster: from join and leave lines, reconciled by uuid with `list uuids` every 60 s.
- Position: `data get entity <name> Pos` and `Dimension`, one player per second in turn, only while the tab is open.
- Inventory: only when opened or refreshed.
- No poll while the server is starting or stopping, or when nobody is on.

## Actions

Give, clear all, clear one item, replace a slot, teleport to player or coordinates, gamemode, heal, feed, effect,
whisper, kick, ban, pardon, op, deop, whitelist add and remove. Clear, kick, ban and op need a confirmation in the UI.
Every action is written to `admin.jsonl` with its commands and the server's answer.

Game versions differ. Below 1.20.5 item data is `{tag}` NBT, from 1.20.5 it is `[components]`, and 1.21.5 changed some
component forms. Check these against the Minecraft Wiki's pages, not third-party generators, and pick the form from the
server's version. Only item data refuses on a version newer than `CHECKED_THROUGH`, because it is the one form that has
changed: every other action works on any version from its floor up, so a new release does not switch off kick or ban.

An action's answer is the first line of the shapes `actions.js` lists for it, success or refusal, from `en_us.json` of
1.20.1 and 26.3. Any other line in the wait is no answer: it stays in the console, and an action nothing answered reports
`ok: true, code: 'noAnswer'` with no text. A wording not in the table therefore reads as unanswered, not as success.

## Moving items

One action, `moveItem`: `{target, op: 'move'|'clear'|'place', from, to, item, count, shown: {from, to}}`. `shown` holds the
print of what the tab shows in each slot. Main does the rest, so the tab cannot get it wrong: `index.js` reads the player,
refuses (`changed`) if a slot is not what the tab showed, picks a temporary slot for a swap from that read, sends the lines
and a last `data get` as one stdin write, and compares. The answer comes from that read and not from the lines' answers, and
nothing is sent twice. Results: `changed`, `offline`, `busy`, `noRoom`, `armorFit`, `notMoved` (the slots are as they were),
`mismatch` (they are not what they should be, or the player's stacks do not add up), `unconfirmed` (no read came back). On a
mismatch the admin log gets every slot that differs before and after, as the game printed it, so a lost stack can be put back
by hand. Text in it goes through `lineOf` like any stored line, so an address in a book is masked there too.

The forms, from `ItemCommands` of 1.20.1 and 26.3: `item replace entity <name> <slot> from entity <name> <slot>` and
`... with minecraft:air`, whose answer is `Replaced a slot on <name> with [x]` on 1.20.1 and `Replaced 1 slot(s) on <name> with
[x]` on 26.3. `enderchest.N` is in `SlotArgument` of 1.20.1 and `SlotRanges` of 26.3, so the ender chest takes part.

A failed line does not stop the lines after it: they are already in the write. A refused copy followed by a plain clear
deletes the item it did not copy, and what a line leaves in a slot proves nothing, because another stack with the same id and
count can land there by itself. So a step records its own success in the command storage `nano:move`, and the next starts from
that record:

```
data modify storage nano:move ok set value {}
execute <tests> store success storage nano:move ok.<step> byte 1 run item replace ...
execute if data storage nano:move {ok:{<step>:1b}} <tests> store success ... run item replace ...
data remove storage nano:move ok
data get entity <name>
```

A test that fails stores nothing, so each step has its own key: one shared byte would still say 1 from the step before. A
thrown command stores 0, through `onCommandComplete(ctx, false, 0)` in `CommandDispatcher` of 1.20.1 and in `ContextChain.runExecutable`
of 26.3 (Brigadier 1.3.11, `ExecutionCommandSource.resultConsumer`). `store success storage <id> <path> byte <scale>` is in
`ExecuteCommand.wrapStores` of both jars, and a path that is only `{...}` is `NbtPathArgument$MatchRootObjectNode`. One move at a
time per server (`moving`) keeps the entry to one user. It is no datapack: the world only gains an empty `command_storage_nano.dat`.

A move to an empty slot: copy (`copied`), wipe the source (`wiped`), and if the source changed after the copy, wipe the copy. A
swap, x in `from` and y in `to`: copy y to temp (`saved`), copy x to `to` (`moved`), then one of two ways. If `moved` failed, temp
is a spare copy and is wiped. If it worked, y goes from temp to `from` (`placed`); if that fails because `from` changed, y goes
back to `to`, also as `placed`. Temp is wiped only after `placed`. With neither slot as it was, temp keeps the only y, the read
shows it there and the result is `mismatch`. A click on `to` after `moved` does not stop `placed`, because `from` can still take y.

A clear or a place on a filled slot overwrites a stack with no step before it to rest on, so its test holds the whole stack as
the read printed it (`printOfStack` in `nbt.js`: parsing loses the number types). A raw line break of 1.20.1 cannot go on a
console line, so such a stack keeps id and count. Only chest, legs and feet refuse an item (`createEquipmentSlotAccess`):
`needFit` in `actions.js` refuses by id what they would, and a swap writes its armor slot first. The temporary slot is the last
free one, as a player's pickups take the first.

The tab holds a detail that arrives during a drag until the drag ends, and sends the move with what it showed before
showing the new one. Tiles are never replaced under a pointer.

What this cannot close: `verify/minecraft-players-actions.mjs` races a click against every move, and its numbers are worst-case
models, not rates. The real exposure is the gap between the read and the lines, the class `before`. Console lines drain
together at one point of a tick, so the class `between` needs a line to reach the queue after that drain. Before chaining,
`before` lost a stack in 119 of 14943 moves and `between` changed the stacks in 3307 of 14905. Now `before` loses and doubles
none of 14943, and none of 14991 with every stack different in its data. `between` doubles a stack in 590 of 14905 with no loss,
and with every stack different doubles in 610 of 15023 and loses in 26: a click that puts a look-alike in a slot between two
steps, which a test on id and count passes. Every one of those showed in the read.

## Detailed logging

Phase 4: `tools/nano-bridge`, a Bukkit plugin with no shaded dependencies, built against the Paper API of 1.20.1 for Java 17
with `api-version: '1.20'`, the oldest release whose `version.json` in the Gradle cache asks for Java 17. A server older than
that is refused, since it would not load the plugin. Fabric, Forge, NeoForge and Vanilla keep a reason. A plain log needs no
plugin and goes on without one.

Handlers run at MONITOR on the server thread and only read. `Coalescer` merges by player, type, thing and world for 3 s, and
a record of blocks keeps every position (up to 64, then the next record starts), which is what answers who broke a block.
`LineWriter` owns the file on a daemon thread. The queue holds 16384 lines, `offer` never waits, and lost lines are counted in
a `dropped` record. Chat is never listened to. A command is recorded by its first word: what follows can be a whisper or a
password. What was taken from a container is the difference between opening and closing it, so a hopper or a second player
counts toward whoever closes it.

`.nano/bridge/<yyyy-mm-dd>.jsonl`: `{v, time, uuid, type, world, x, y, z, n, id?, other?, weapon?, amount?, at?, text?}`, and
`{type: 'hello', plugin}` at start, `{type: 'dropped', n}` when lines were lost.

`createTail` follows the files for one session: 1.5 s, at most 4000 lines or a few MB a pass, from an offset kept in
`.nano/players/bridge-state.json`, written after the store has the lines. A torn last line waits; a later day's file means
nothing more comes to the older one, which is then deleted, so the unmasked copy does not outlive its use. So does the last
file once the jar is gone from `plugins/` and no hello came in this session, and removing the plugin from a stopped server runs
one pass for that. A file that could not be read is not deleted. A tail keeps its offsets in memory until it saves them, so a new
one runs after the `stop()` of the one before, and a second `stop()` is the first one's promise. Lines go through
`store.add`, so masking and the 30 days are the store's. A timeline reads from the file's end and the prune works line by
line, because a month of one player can run to hundreds of MB.

The file is writable by any plugin, so nothing in it is believed: see the head of `bridge.js`. It proves nothing about who
did what if a hostile plugin runs on the same server.

The app-wide default is `minecraft.detailedLogNewServers` in settings.json, off until the owner ticks it. `create()` reads it
for Paper and Purpur only. "Apply to my other servers" installs after one confirmation that names the servers, and reports
per server.

## Untrusted text

Everything a player types arrives in the same stream as the server's lines. These are the rules:

- A player's chat must never parse as a server event. Anchor every pattern on the full line prefix and the shape of the
  message: `<Bob> Steve joined the game` is chat, and so is `[Not Secure] <Bob> ...`.
- Query answers are matched only to a query in flight and to its expected player and shape, so chat cannot forge one.
- A `data get` answer holds what players wrote, and older versions print a text's line breaks raw, so a book's page can look
  like whole server lines. From the first line of an answer the stream is that answer until its SNBT ends, which quotes alone
  decide: the game breaks a line nowhere but in a text, and a player cannot end a text. This holds for a `data get` the owner
  types too. A cap ends what is kept, not the reading: the lines after a cap are what a forger would aim at. Only a stall of
  10 s gives the stream back to the parser, so that a damaged answer cannot leave the server deaf.
- Console commands are one line. Refuse a name that is not `^[A-Za-z0-9_.]{1,16}$`, an item id that is not a resource
  location, and strip `\r` and `\n` from free text such as a whisper. A value must not be able to start a second command.
- Show all of it with `textContent`, and cap stored line lengths.

## Privacy

- The join line holds the player's IP. Store it masked (`1.2.*.*`) and never in full. So does any address in any other
  field: every stored line goes through one function in `store.js`, which masks address-shaped text, chat included.
- Keep events 30 days by default, pruned at session start.
- Records stay in the server folder on this PC. `.nano` is not in client packs or share links.

## Icons and names

The server jar has no textures. Items and Korean names come from the client jar and the asset index of the server's
version, downloaded from Mojang into a shared cache on this PC with their sha1 checked, and never redistributed. Mod
items come from the jars in `mods/`. Without a cache or a network the tab still works, with ids as text.

## Tests

`verify/minecraft-players.mjs` (ports 9932-9935) starts a Node stand-in that prints real log lines per server kind and
answers commands, through the real `minecraft:start`. Pure modules get checks without a window. Fixtures are written from
the formats above. They are not captures from a real server, so report that as unverified. Command wordings and the SNBT
quoting rule were read from real jars in the Gradle cache (`en_us.json`, and classes through `javap`), which runs nothing.
`verify/minecraft-players-game.cjs` runs the lines of a move by the rules read from those classes, in the Node tests and the
stand-in. `tools/nano-bridge/build.mjs` runs the plugin's tests against the Paper API of 1.20.1 and of 26.3 with Bukkit's
real event classes around proxies of its interfaces, and checks every Bukkit method the classes call against each API.
