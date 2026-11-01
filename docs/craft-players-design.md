# Server player admin: design

Goal: a Players tab on a server that the app runs, in Code and Craft modes. It shows who is on, keeps a per-player log,
shows inventories and player state, and lets the owner act on players through buttons. It installs nothing on the
server and works through the server's own console and files.

Scope is phases 1 to 3. Phase 4 (a bridge plugin for block and container events) is out of scope.

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
| `renderer/features/minecraft/players.js` | The Players tab. |

## Shapes

```
Event  {t: ISO time, type: 'join'|'leave'|'chat'|'death'|'advancement'|'command'|'server', name, uuid|null, text, x?, y?, z?}
Player {uuid, name, online, firstSeen, lastSeen, playTimeMs, op, opLevel, whitelisted, banned, pos: {x,y,z,dimension}|null}
Slot   {slot, id, count, name|null, enchantments: [{id, level}], damage|null, raw}
Detail {source: 'live'|'file', health, food, xpLevel, gamemode, pos, inventory: [Slot], armor: [Slot], offhand: Slot|null,
        ender: [Slot], selected, stats: {playTimeTicks, deaths, mobKills, jumps}, advancements: n}
Action {type, target: name, ...fields}
Item   {id, name, ko|null, icon: data URL|null, mod|null}
```

`slot` numbers are the game's: 0-8 hotbar, 9-35 main, 100-103 armor, -106 offhand.

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
- `players:adminLog(root, dir, {limit})` -> `[{t, action, commands, ok, text, code?}]`, `code` being the result's
- `players:watch(root, dir, on)` -> `true`, a 30 s lease on position polling, which the tab repeats every 10 s while it shows
- push `minecraft:players` `{dir, kind: 'roster'|'event'|'position'}`, so the tab refreshes without polling

## Polling

- Roster: from join and leave lines, reconciled with `list` every 60 s.
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

`verify/minecraft-players.mjs` (ports 9932-9934) starts a Node stand-in that prints real log lines per server kind and
answers commands, through the real `minecraft:start`. Pure modules get checks without a window. Fixtures are written from
the formats above. They are not captures from a real server, so report that as unverified. Command wordings and the SNBT
quoting rule were read from real jars in the Gradle cache (`en_us.json`, and classes through `javap`), which runs nothing.
