# Multiplayer room server

Players connect over WebSocket and are placed in a room for their **region** (a metro area or state that shares one map, such as `nayarit` or `valle-de-mexico`). Each room holds up to `ROOM_CAPACITY` players. When a region's rooms are full, the next player opens a mirror room (`nayarit#2`), and empty rooms close.

The wire protocol ([`shared/protocol.js`](../shared/protocol.js)) is binary, in the spirit of RuneScape's. Every frame starts with a 1-byte opcode, and positions travel as integer centimetres.

- **One frame per tick:** each server tick (10 Hz) sends every client a single `TICK` frame.
- **Area of interest:** that frame covers only the `VIEW_MAX` nearest players within `VIEW_RADIUS`, using a 250 m grid ([`aoi.js`](aoi.js)).
- **Only changes:** within the frame, only the poses that changed since that client last heard them are sent. Parked players cost nothing.

| Message | Size |
|---|---|
| Client pose (`STATE`) | 18 bytes |
| One moved player in a `TICK` | 19 bytes |
| A full view of 64 moving players | ~1.2 KB, about 12 KB/s per client |

## Run it

```bash
cd server
npm install
npm start
```

Then open the game with `?multiplayer=1` from `localhost`. It connects to `ws://localhost:8787` on its own. Open a second tab with `&mp-name=Beto` to see each other.

| URL parameter | Meaning |
|---|---|
| `multiplayer=1` | Turn multiplayer on (off by default; single player never loads it) |
| `mp-server=wss://host/path` | Server to use. Required when the page is not served from localhost |
| `mp-region=nayarit` | Room region (defaults to this map's) |
| `mp-name=Lalo` | Display name (remembered) |

| Environment variable | Default | |
|---|---|---|
| `PORT` | 8787 | |
| `ROOM_CAPACITY` | 200 | Players per room before a mirror opens |
| `VIEW_RADIUS` | 800 | Metres within which other players are sent |
| `VIEW_MAX` | 64 | Most players sent to one client |
| `MAX_PLAYERS` | 5000 | Per server process |
| `ALLOWED_ORIGINS` | any | Comma-separated page origins allowed to connect |

`GET /health` returns the rooms, the player count, the tick cost (`tickMs`) and the bytes sent per tick.

## Test and measure

```bash
npm test
BOTS=1000 SPREAD=20000 node bench.js
```

`bench.js` drives simulated players against an in-process server. Bots and server share one Node process, so real numbers are better. On an Apple-silicon laptop:

| Bots | Area | Tick (budget 100 ms) | Per client |
|---|---|---|---|
| 200 | 2 km | 6 ms | 10 KB/s |
| 1000 | 2 km, everyone in view | 62 ms | 11.5 KB/s |
| 1000 | 20 km | 14 ms | 1 KB/s |

## Scope

The server relays poses as clients send them. It checks their shape and rate, but it runs no physics and doesn't validate movement. Anti-cheat, accounts and persistence (economy, rankings) belong in later layers.

GitHub Pages only serves the static game. This server has to run somewhere that keeps a process alive: a VPS, Fly.io, Railway, and so on.
