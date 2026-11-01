# Private server sharing in Craft: design

Goal: sharing a game server is private by default. A stranger who finds the bore.pub port learns nothing and cannot
reach the server. Friends join through Nano Studio Craft with a join code, and see the server in the game's Multiplayer
list. Sharing a plain public address stays as an advanced option.

```
friend's game -> friend's Craft (local listener) -> bore.pub -> host's Craft (gate) -> server
```

bore.pub is a third party. It must not be able to read the traffic, change it, or reuse what it saw.

## Threat model

- A scanner connects to the public port and listens: it gets silence, and nothing tells it what the port is.
- A scanner sends junk of the right size: it gets 64 bytes that look random, then a close. It never reaches the server.
- bore.pub records a whole session, replays it, or changes bytes: no access, no plaintext, the connection dies.
- bore.pub cuts a connection between records: the other side sees an error, not a clean end.
- A silent scanner holds every handshake slot: a friend still gets in, because the newcomer takes a slot from it.
- An attacker sends junk or opens many connections: bounded memory and time, and the server never sees them.
- A leaked join code: the holder can connect, and the whitelist still applies. Sharing again makes a new code. It does not
  open sessions recorded before the leak, because each one's keys come from a pair made for it and then dropped.
- Out of scope: a compromised PC of the host or a friend, and bore.pub simply refusing service.

## Protocol

`secret` is 32 random bytes from `crypto.randomBytes`, made for each share, in memory only on the host. Every connection
runs this on the stream that bore carries. Nothing on the wire names the protocol. Its version is in the labels and the
HKDF info.

1. Client sends `cn`, 32 random bytes, and `ce`, the raw public key of an X25519 pair made for this connection.
2. Host sends nothing until it has those 64 bytes. It then sends `sn` and `se`, the same two things of its own.
3. Client sends `HMAC-SHA256(secret, "nano1-client" || cn || ce || sn || se)`.
4. Host checks with `crypto.timingSafeEqual`. On failure it closes at once, with no reply. Reads stop after exactly the
   expected number of bytes.
5. Host sends `HMAC-SHA256(secret, "nano1-host" || cn || ce || sn || se)`, and the client checks it the same way.
6. Each side computes the X25519 shared secret `dh`. An all-zero result, which a low-order point forces, ends the
   connection. The host does this after step 4, so the work is spent only on a proven client. The client does it before
   step 3, so a low-order point gets no proof from it.
7. Keys: `hkdfSync('sha256', dh || secret, sn || cn, "nano1-keys", 88)`, split into two 32-byte ChaCha20-Poly1305 keys and
   two 12-byte IV bases, one of each per direction.
8. Records: a 2-byte big-endian ciphertext length, the ciphertext (at most 16384 bytes), then the 16-byte tag. The nonce
   is the direction's IV base XOR a 64-bit counter that starts at 0. The associated data is the length. A failed tag or
   an out-of-range length ends the connection. A counter is never reused, and a connection dies before it could wrap.
9. A direction ends with an empty record: a length of 0 and a tag. Only someone with the keys can write it. Bytes after it
   end the connection, and a stream that ends without it is an error that destroys the other side at once.

A fresh `sn` and `se` per connection stop replay. The client proves it holds the secret without sending it. The host's
HMAC stops a relay from posing as the host to a friend. Keys depend on `dh`, so `secret` and a recording together do not
open a session: both private keys are gone when it ends.

The proofs cover the public values, so someone who holds `secret` and sits on the path can still run the exchange with
both sides. That is the leaked-code case above, for live sessions only.

An X25519 public key is not uniform random: its top bit is always 0, and it is always a point on the curve. A scanner that
has already sent 64 bytes to this port can tell the reply is probably a key, over many tries. It is not worth Elligator.

Limits on the host: the handshake has 2 s, and at most 64 connections may be in the handshake at once. With all 64 slots
taken the newcomer is not refused, because a scanner that only holds sockets open would then lock out every friend. An
older handshake is dropped for it instead: the oldest that has sent nothing, else the oldest. A friend speaks first and at
once, so a silent scanner is dropped before it. Failures are counted, and nothing about them goes to the local server. Bore
hides the source address, so limits are per tunnel.

What a friend needs on a real link: with round trips `h` from host to bore and `f` from friend to bore, the host dials
back after 0.5 `f` + 0.5 `h`, the dial takes `h`, and the proof reaches the host `2h + f` after the dial. The limit is timed
from the end of the dial, so 2 s covers `h` = `f` = 650 ms with no packet lost. A friend much farther away than the host is
bound by `2f` instead. The stand-in bore runs on loopback and cannot delay a dial, so it charges the dial to the limit as
well: its handshakes cost `3h + f`, and `h` = `f` = 450 ms passed 5 of 5 while 500 ms, exactly 2 s, failed. `2 s` needed no
raising.

A slot lasts 64 arrivals, so a friend survives a silent scanner of `S` sockets a second if its hello reaches the host
within `64 / S` seconds, about `2h` after bore announces it. Dropping silent handshakes first is what makes that the bound:
with the oldest dropped regardless, the whole handshake has to fit. Measured with 16 slots on the stand-in with `h` = `f`, failed tries
of 10, silent first against oldest only: 50 a second at 100 ms, 0 against 10; at 150 ms, 6 against 10; at 200 ms, 10
against 10; 30 a second at 150 ms, 0 against 10. Past the bound only more slots would help. `64` is the design's number, not
a limit of the method, and a scanner that sends 64 bytes of junk is not silent, so it is dropped by age with friends.

The local server sees the connection as coming from loopback, as with public bore sharing today.

## Files

| File | Owns |
|---|---|
| `main/bore-gate.js` | The handshake and record layer above, pure over a pair of streams. No sockets of its own. |
| `main/bore-client.js` | `local` mode gains the gate. New `join` mode: a local listener that dials the relay. |
| `main/minecraft/private-join.js` | Friend side: one join process per private server, local port, lifetime. |
| `main/minecraft/serversdat.js` | Read, merge and write `servers.dat`. |

`join` mode: `bore-client.js join --to <host:port> --listen 127.0.0.1:<port>`, prints `listening at 127.0.0.1:<port>`,
binds loopback only, and each game connection dials `<host:port>` and runs the client side. The dial must not use bore's
control port, because a friend talks to the public port.

The secret reaches a child process through its environment (`PYIDE_BORE_SECRET`, base64url), never argv, because argv is
visible to other processes and is logged by the app.

## Join code

`nanostudio:join?addr=bore.pub:33862&key=<base64url secret>&name=<name>&pack=<url>`. `key` present means private. A bad
key refuses the code. A code without `key` still works as today.

A code comes from someone else, so three things it could do wait for a yes, and until then nothing changes. `launcher:join`
answers `{needsConfirm: {kind, address, name}}`, and the same request with `kind` in `confirmed` goes through. Cancel is
the dialog's default.

- `localAddress`: `addr` is this computer or its network (`127.0.0.1:6379`, `localhost:5432`, `192.168.0.1:80`, and other
  spellings such as `2130706433`). The rule is the pack's, `PRIVATE_HOST`. A typed address never asks, because LAN play is
  real. No name is resolved, so a name that points at a local address passes.
- `newKey`: the address is a saved private server with a different key. The old key stays until the yes.
- `noKey`: the address is a saved private server and the code has no key. A yes makes it public, and the next Join is in the
  clear, so it never happens silently.

A saved private server with no key left asks nothing of a code with a key: pasting the code again is how it comes back.

The key is a secret from then on: it must stay out of logs, diagnostics reports, `admin.jsonl`, and the console.
`main/diagnostics/redact.js` covers `key=`, `key:`, `"key":"..."` and percent-encoded codes. A saved private server keeps its
key with `safeStorage`, as data sources do, and never in `servers-list.json` in the clear. Without safeStorage the key is
kept in memory only, and the friend pastes the code again next time.

## Host side

`ports:share(port, {private: true})` runs the gate. Asked for a mode other than the running tunnel's, it throws: answering
with the tunnel's state would tell a caller who wanted a private share that it has one. The main process keeps the secret:
`ports:state` and `ports:changed` do not carry it. A new channel gives the code on request:
`minecraft:privateCode(root, dir)`. Stopping a share forgets the secret. Sharing again makes a new one. The server card's main
Share becomes private, and Share Publicly sits beside it as the second choice, with the existing warning and whitelist
offer. The private card shows Copy Join Code and Stop. It says friends need Craft and that the code is a key.

The Ports window knows a game server's port, because the Minecraft plugin names it before each start (`ide.ports.gamePort`).
Share there and on the announcement is private for such a port, and "Share new ports automatically" leaves it alone. A
private share ends with its server, and the port coming back must not open a public tunnel.

## Friend side

A private server's card shows it as private. Join and Play start the join process first. If a private server has no join
process when the game would start, Play stops with `privateGone` and never falls back to the public address: that server
was removed during a long sync, and the game would send its bytes across bore in the clear. The local port stays the same
for a server when it is free, and is saved. If it is taken a new one is chosen and `servers.dat` is rewritten before the
launcher opens. The join process stops when Craft quits. Say so in the UI: Craft must stay open while playing.

## Server list

`servers.dat` in the instance's game directory is uncompressed NBT: a root compound with a `servers` list of compounds,
each with `ip`, `name` and optional `icon`, `acceptTextures`, `hidden`. `main/minecraft/players/nbt.js` reads NBT. Add a
writer. Merge by address, keep every other entry and every unknown tag, write atomically, and leave the file alone when
it is damaged, with a backup. Write at join, at Play and at create. A private server's entry is `127.0.0.1:<port>`.

Instance Play now shows the list, and Join keeps Quick Play.

## Launcher already open

The launcher reads profiles only at its start. When the launcher is open and no game runs, ask it to close with
`CloseMainWindow`, never by killing it, wait up to 5 s, and start it again. If it stays open or a game runs, keep today's
message. Never close a game.

## Same-network address

A server card shows the machine's LAN address and port with a copy button, without sharing. `ports` rows already carry
`lan`. A running server only.

## Not in scope

Direct launch without the official launcher needs a Mojang-approved app, and is not part of this work.

## Tests

`verify/private-share.mjs`, plain Node, real sockets on loopback, with the existing stand-in bore server. Each attack runs
against the real code and against a copy with that one defence patched out: wrong key, a scanner that only listens,
junk of the right size, replay of a recorded session, a leaked code with a recording, low-order points in either direction,
tampered and truncated records, a connection cut between records, a forged last record, a record after the last one,
oversize length, slow handshake, connection flood, a silent scanner at 4, 10 and 50 sockets a second, a slow link, junk from
a client, a 5 MB burst, secret absent from argv and logs, and what a pasted code may do. Electron's BoringSSL is held to
the RFC 8439 and RFC 7748 vectors, and to a client written with OpenSSL. `serversdat` round trip against a fixture written
by the format, unknown tags kept, damaged file left alone. UI checks join the existing Craft suite with stand-ins. A real
run over bore.pub needs the user, because it opens a public tunnel.
