# grokcraft

A Minecraft **Java Edition** companion bot built on
[Mineflayer](https://github.com/PrismarineJS/mineflayer), designed to be driven
by an AI assistant (or you) from a shell, one command per decision.

- A background **daemon** owns the connection, reconnects automatically and
  runs one physical action at a time (a new action replaces the old one).
- Everything that happens goes into a durable **event inbox**
  (`~/.grokcraft/inbox.json`), so nothing is lost between commands or daemon restarts.
- `grokcraft standby` **blocks until something needs the agent**: chat from
  the owner, chat naming the bot, whispers, damage, death, an action finishing
  or failing, being kicked, the owner joining or leaving, or a Microsoft
  sign-in prompt. Idle play costs no agent turns.

Bedrock Edition (consoles, mobile, Windows "Bedrock") is **not** supported.

## Setup

Requirements: Node.js 18+ (22+ recommended, see [Node versions](#node-versions))
and a Minecraft Java server or a single-player world opened to LAN.

```sh
cd grokcraft
npm install
npm link          # optional: puts `grokcraft` on your PATH; otherwise use ./bin/grokcraft
grokcraft --help
```

### Connecting to a single-player world (Open to LAN)

1. In Minecraft Java, open your world, press Esc, choose **Open to LAN** and
   **Start LAN World**. Minecraft prints a chat line like
   `Local game hosted on port 51234`. The port changes every time.
2. Start the bot with that port and your own Minecraft name as owner:

   ```sh
   grokcraft start host=localhost port=51234 auth=microsoft username=bot-account@example.com owner=YourName
   ```

   Use the host machine's LAN IP for `host` if the bot runs on another computer.

Vanilla LAN worlds run in online mode: they verify every joining player with
Mojang. So the bot normally needs **its own** Microsoft account that owns
Java Edition (`auth=microsoft`), separate from the one you play on. An
`auth=offline` bot can join a LAN world only if a mod turns off online mode
for it (for example a "custom LAN" mod with online mode off). Otherwise it is
kicked with a "Failed to verify username" error.

### Dedicated servers

```sh
grokcraft start host=mc.example.net port=25565 username=Grok owner=YourName
```

On a server with `online-mode=false` (or a proxy that allows offline players)
the default `auth=offline` works. For a normal online-mode server the bot
needs its own Minecraft account.

### Offline vs Microsoft auth

| `auth=` | `username=` | When to use |
| --- | --- | --- |
| `offline` (default) | any bot name, e.g. `Grok` | servers with `online-mode=false`, test servers, LAN setups that allow it |
| `microsoft` | the Microsoft account email | online-mode servers; the account must own Minecraft Java |

With `auth=microsoft` the first connection needs a one-time device sign-in.
The daemon logs a line like
`Microsoft sign-in needed: open https://www.microsoft.com/link and enter code ABCD1234`,
`grokcraft status` shows it, and `standby` wakes with an `auth_required`
event. Tokens are cached in `~/.grokcraft/auth/`.

The Minecraft version is detected automatically. Pass `version=1.21.4` (or
another version) if detection fails.

Settings passed to `start` are saved in `~/.grokcraft/config.json` and reused
next time, so later you can just run `grokcraft start`. To change them, run
`grokcraft stop` and then `grokcraft start key=value ...` again.

## Commands

```text
grokcraft start [host= port= username= auth=offline|microsoft owner= version= apiPort=]
grokcraft stop | shutdown          stop the daemon and disconnect
grokcraft status                   daemon + connection summary
grokcraft state                    position, health, food, action, owner, nearby, inventory
grokcraft inventory                inventory slots, held and equipped items
grokcraft events [all=true] [limit=N]   unread events (marks them read)
grokcraft standby [timeout=SEC]    wait until something needs you (default 300 s, max 3600)
grokcraft chat text="..."          say something (also: grokcraft chat hello there)
grokcraft stop-action              stop the current physical action

grokcraft follow player=NAME [range=2]
grokcraft come [range=2]                           walk to the owner
grokcraft goto target=[x,y,z] [range=1] [dig=false]   or target=[x,z]
grokcraft farm crop=melon|wheat|carrots|potatoes|beetroots|pumpkin [radius=8]
grokcraft collect block=oak_log [count=1] [radius=48] [dig=false]
```

Arguments are `key=value`. Coordinates may be written `[120,64,-35]`,
`120,64,-35` or `"120 64 -35"`. Every command takes `--help` (for example
`grokcraft farm --help`) and `--json` for raw output.

Exit codes: `0` ok, `1` the command failed (e.g. player not visible), `2` bad
arguments, `3` the daemon is not running.

### Actions

- Physical actions (`follow`, `come`, `goto`, `farm`, `collect`) return as soon
  as they start. Their outcome arrives as an `action_finished` or
  `action_failed` event, which wakes `standby`. Replacing or stopping an
  action records a quiet `action_replaced` / `action_stopped` event.
- `chat` and the reads (`state`, `inventory`, `events`, `status`) never
  interrupt the running action.
- `follow` keeps going until replaced or stopped. It fails, and wakes you, if
  the player stays out of sight for 15 seconds.
- `farm` harvests mature crops within `radius` blocks of where the bot stands,
  picks up the drops, and replants wheat, carrots, potatoes and beetroots on
  farmland when it has seeds. Pumpkins and melons are harvested only next to a
  stem, so decorative ones are left alone, and the stems stay.
- `collect` mines the nearest blocks of a type and picks up the drops. It
  refuses up front if the block needs a tool the bot doesn't have (for example
  `iron_ore` without a stone pickaxe).
- By default the bot will not break or place blocks while it moves around
  (it's a guest in your base). Pass `dig=true` to `goto` or `collect` to allow
  tunnelling and scaffolding.

### Event-driven loop for an agent

```sh
grokcraft start owner=Steve port=51234
grokcraft standby timeout=900     # returns: "Minecraft needs you:" + events
#  ! #9 14:42:31 chat  <Steve> hey Grok come here  [owner]  [mentions you]
grokcraft chat text="Coming!"
grokcraft come
grokcraft standby timeout=900
#  ! #10 14:42:33 action_finished action #1 come range=2 (finished): {...}
grokcraft farm crop=wheat radius=10
grokcraft standby timeout=900
```

Events marked `!` are the ones that woke standby. Events that don't wake it
(other players' chat, connection changes, respawn) are still included in
standby's output, so the agent sees the context. A standby that times out
consumes nothing. Repeated hits within 1.5 s are merged into one `damaged`
event, and standby waits 300 ms after a waking event so related ones (damage,
then death) arrive together.

## How it works

```text
grokcraft <command>  --HTTP JSON-->  daemon (127.0.0.1:3017)
                                       ├─ mineflayer bot + pathfinder/collectblock/tool
                                       ├─ action manager (one physical action)
                                       └─ event inbox (~/.grokcraft/inbox.json)
```

`grokcraft start` spawns `src/daemon.cjs` detached. Files in `~/.grokcraft/`
(override with `GROKCRAFT_HOME`):

| File | Purpose |
| --- | --- |
| `config.json` | saved connection settings |
| `daemon.pid` | daemon process id |
| `daemon.log` | daemon log (connection, kicks, errors) |
| `inbox.json` | durable events and read cursor (last 500 events) |
| `token` | secret the CLI sends to the local API |
| `auth/` | cached Microsoft tokens |

The API listens only on `127.0.0.1` and requires the `x-grokcraft-token`
header from `~/.grokcraft/token`:

```text
GET  /status  /state  /inventory  /events?all=1&limit=N  /standby?timeout=SEC
POST /action {"kind":"goto","args":{"target":[1,64,2],"range":1,"dig":false}}
POST /chat {"text":"hi"}   POST /stop-action   POST /shutdown
```

When the connection drops, the daemon reconnects with backoff (2 s doubling
to 60 s). The running action fails with `disconnected`, and after death the
bot respawns automatically.

To run the daemon in the foreground for debugging: `npm run daemon` (it uses the
saved `config.json`).

## Development

```sh
npm test       # unit tests (argument parsing, event inbox); no server needed
npm run lint   # node --check on every source file
```

## Node versions

Mineflayer 4.27 and later declare Node 22+ in `engines`, and these are the
releases that support the newest Minecraft versions (up to 26.1 with the
pinned 4.39). On Node 18/20, `npm install` prints an `EBADENGINE` warning.
grokcraft was exercised on Node 20 without problems. If you hit runtime errors
on an older Node, upgrade to Node 22, or pin `mineflayer@4.25.0` (the last
release that declares Node 18), which works only with older Minecraft versions.

## Troubleshooting

- **"daemon is not running"**: run `grokcraft start`. If it exits immediately,
  the error shows the last lines of `~/.grokcraft/daemon.log`.
- **Port 3017 in use**: `grokcraft start apiPort=3018`. The CLI reads the
  port from the saved config, or from `GROKCRAFT_API_PORT`.
- **Stuck "reconnecting"**: check `grokcraft status` for the last error.
  `ECONNREFUSED` usually means a wrong port (LAN ports change each time you
  open to LAN). After `stop`, start again with `port=NEW`.
- **Kicked: "You are not whitelisted" / authentication failures**: add the bot
  to the whitelist, or use `auth=microsoft` on online-mode servers.
- **"X is online but out of sight"**: the player is beyond the server's
  entity view distance. Ask for coordinates and use `goto`.

## Credits

Design inspired by [Musecraft](https://github.com/LucasSwitz/musecraft) by Lucas Switzer (one command per decision, a controller daemon, an event inbox, and a blocking `standby`). Grokcraft is an independent implementation built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) and contains no Musecraft code.

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Mojang or Microsoft.
