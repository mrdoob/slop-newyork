# CLAUDE.md

A browser GTA-style open world (three.js `WebGPURenderer` + TSL shaders, no build step) of Mexican cities at 1:1 scale, starting with Tepic, Nayarit (with Xalisco), forked from Slop New York. Plain ES modules load straight from `js/`. three.js comes from jsDelivr through the import map in `index.html`.

## Run and test

```bash
python3 -m http.server 8765          # then open http://localhost:8765
node --test tests/*.test.*           # client and tool tests (Node ≥ 22; no install needed)
(cd server && npm install && npm test)  # multiplayer server tests
```

- Load the page and look at it after any visual change. The tests don't render.
- URL switches:
  - `?live-time=<ISO date>` and `?live-weather=<clear|cloudy|overcast|rain|storm|fog>` preview the Live time of day.
  - `?multiplayer=1` joins the room server (see `server/README.md`).
  - `?slopes=0` builds the flat city of before, everything at y = 0 (the default lays the town on its real slopes, `world/ground.js`).

## Layout

`js/main.js` is the entry: it builds the scene, wires the HUD and runs the frame loop. The other modules are grouped by concern. `FOLDERS` in `tools/reorganize.mjs` is the authoritative map (see "Reorganization" below).

| Folder | What lives there |
|---|---|
| `render/` | Sky and sun light, IBL and fog (`lighting.js`), post-processing and grading, TSL materials and shared uniforms (`tsl-materials.js`), culling |
| `world/` | Map data and everything built from it: `city-config.js` (street database and frame helpers over the generated geodata), blocks and buildings, landmarks, street furniture, trees, the road graph and paint, terrain, storefronts, `weather.js` (real sun and Open-Meteo conditions) |
| `sim/` | Traffic, pedestrians and their routes, knock-downs (`mayhem.js`) |
| `actors/` | Vehicle and helicopter geometry and materials, vehicle lights |
| `player/` | The player controllers (person, car, cyclist, moto, helicopter), the car's drivetrain & crash damage, and the camera rigs |
| `input/` | Touch and gamepad controls (keyboard lives in `player/controllers.js`) |
| `ui/` | The minimap and full map (`city-map.js`) |
| `audio/` | Procedural city audio, synthesised (no audio files) |
| `net/` | Multiplayer client (`multiplayer.js`), loaded only with `?multiplayer=1` |
| `models/` | Vehicle data: `cars/` (one file per make: real sizes, engines, top speeds, rarity in traffic; `cars/README.md` says how to add one), `motos/`, and the body shapes they are drawn with (`bodies.js`) |

Outside `js/`:
- `shared/protocol.js`: the binary multiplayer protocol, imported by both the client and the server.
- `server/`: the region-room WebSocket server.
- `tools/`: geodata builders and benchmarks.
- `tests/`: `node:test` suites.

### Reorganization

`main` may still have the flat `js/*.js` layout. `node tools/reorganize.mjs` prints the plan, and `--apply` moves the modules into the folders above and rewrites every reference: imports, `index.html` preloads, test and tool paths, docs, and the import names tests stub. It is safe to re-run. After merging a branch that still adds flat `js/` files, run it again and then run the tests. A new module that `FOLDERS` doesn't list stays in `js/` and is reported, so add it to `FOLDERS`.

## Conventions

- **Preloads:** every module that `main.js` reaches through static imports has a `<link rel="modulepreload">` in `index.html`, and `tests/boot.test.cjs` checks the list and its count. Add the preload, and bump the count, when you add a module. Modules loaded on demand through dynamic `import()`, such as `net/multiplayer.js`, are not preloaded.
- **Stylesheet:** bump the `style.css?v=` query in `index.html` when you change the CSS, so returning players don't keep a stale stylesheet.
- **World frame:** 1 unit = 1 m. `x` runs east along the city's street grid, `z` runs south, and `y` is up. The grid is turned `GEO.frame.bearingDeg` degrees clockwise from true north. Real-world bearings (the sun, wind, compass) must go through it.
- **Generated data:** `city-geodata.js` says "GENERATED … do not edit by hand": it comes from `tools/build-tepic-geodata.mjs` over the OpenStreetMap / Overture data in `tools/data/tepic/` (see `README.md`). Change the builder or its data instead.
- **Tests and `loadModule`:** module tests load a source file with `tests/helpers/module.cjs`'s `loadModule`, which stubs each import by its exact specifier (`'./city-config.js'`). Moving a module or changing an import path means updating those stub keys. `tools/reorganize.mjs` does it for moves.
- **Keep Node-testable logic free of three.js imports** where you can: `weather.js` and `shared/protocol.js` are like that, so `node --test` imports them directly.
- **DOM:** the HUD uses safe DOM APIs only (`textContent`, `classList`, `addEventListener`), never `innerHTML` with data.
- **Style:** match the surrounding code. Each module opens with a `// js/<path>` comment saying what it is, and comments explain *why*: units, invariants, the real-world source of a number. UI text is English.
- **Performance:**
  - The frame loop is hot. Don't allocate per frame (reuse vectors), and spread expensive work out. For example, Live re-bakes the sky IBL only when the sun moved about 0.5° or the weather changed.
  - Check fps in the HUD, and with `tools/benchmark-pedestrians.mjs` or `server/bench.js` where they apply.
- **Attribution:** keep the credits in `README.md` when adding data sources: OpenStreetMap and Overture Maps (ODbL), Open-Meteo (CC BY 4.0).

## Multiplayer in one paragraph

`server/index.js` puts players in rooms per region (`ROOM_CAPACITY`, with mirror rooms when full). Every 10 Hz tick it sends each client one binary `TICK` frame. That frame covers only the nearest `VIEW_MAX` players within `VIEW_RADIUS`, and only the poses that changed since that client last heard them. The protocol is in `shared/protocol.js`: opcodes, integer centimetres, 18-byte poses. The client in `net/multiplayer.js` draws others 200 ms in the past, interpolated, reusing the player models. The server relays and shape-checks poses but runs no physics.
