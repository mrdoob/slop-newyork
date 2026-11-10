# Porting to another city

Slop New York is built around real Manhattan data, but most of the engine doesn't care which city it draws. This guide
lists what you can keep, what reads replaceable data, and what is New York through and through, so you know where to
start when you fork it for your own city.

## The world frame

Everything is in metres on a flat plane: **x** points east along the street grid, **z** points south (north is −z),
**y** is up. The origin is the centreline crossing of 5th Avenue and 42nd Street, and the axes are turned 29.02° from
true north to follow Manhattan's grid.

The projection lives in [`tools/geo-base.mjs`](tools/geo-base.mjs) (`LAT0`, `LON0`, `THETA`, `ORIGIN`, `toWorld`).
The building and tree generators reuse it, so all data shares one frame. For your city, pick an origin near the area
you want to explore, and a bearing that lines the main streets up with the axes (or 0 if there is no dominant grid).

## Data files

All geographic data is generated ahead of time into `js/`. Each file names its generator in its first line.

| File | Generator | Source | Format |
|---|---|---|---|
| `js/building-geodata.js` + `.bin.gz` | `tools/build-buildings.py` or `tools/build-osm.mjs` | NYC building footprints (NYC Open Data) | **City-agnostic.** Footprints with courtyards, roof height (m) and construction decade, on a 0.5 m grid |
| `js/tree-geodata.js` + `.bin.gz` | `tools/build-trees.py` or `tools/build-osm.mjs` | NYC Parks tree points | **City-agnostic.** Tree positions on a 0.5 m grid |
| `js/subway-geodata.js` | `tools/build-subway-entrances.mjs` | MTA subway entrances | City-agnostic points, but the stairs and signs are styled after the NYC subway |
| `js/nyc-geodata.js` | `tools/build-geodata.mjs` | NYC street centrelines, borough boundaries, parks, plus OpenStreetMap | **Manhattan-specific.** Numbered streets, avenues, Broadway, Central Park, boroughs, piers, bridges and landmark sites |

The binary formats are documented in the generators (`pack()`), and the loaders in the generated `.js` files don't
depend on New York at all. Replacing buildings and trees with your city's data is mostly a matter of feeding the
generators a different source and projection.

### Buildings and trees from OpenStreetMap

[`tools/build-osm.mjs`](tools/build-osm.mjs) writes `js/building-geodata.js` and `js/tree-geodata.js` for any area
covered by OpenStreetMap, in the same formats, so the game loads them unchanged. It only needs Node 18 or newer:

```sh
node tools/build-osm.mjs --bbox 52.505,13.36,52.53,13.42 --bearing 0 --default-year 1900 --save /tmp/berlin.json
```

- `--bbox south,west,north,east` is the area to download from the Overpass API. Areas of a few kilometres across work
  well; much larger ones can time out on the public servers.
- `--origin lat,lon` and `--bearing degrees` set the world frame (by default the centre of the bbox, with true north
  on −z). `--nyc-frame` reuses this repository's Manhattan frame instead.
- Heights come from OSM's `height`, then `building:levels` (3.2 m per storey, `--level-height`), then a guess from the
  building type. Construction years come from `start_date`; few buildings have one, so set `--default-year` (see the
  facade styles below).
- `--save` keeps the Overpass response so you can rerun with `--input` without downloading again.

OpenStreetMap data is © OpenStreetMap contributors under the ODbL: credit it in your README.

Imported into the Manhattan frame (`--nyc-frame`), OSM's Midtown buildings land within about a metre of the NYC survey
footprints the game ships, so the projection is exact; the remaining metre is the difference between the two surveys.

`js/nyc-geodata.js` is the hard part: `js/city-config.js` and `js/city-grid.js` build the streets, blocks and
sidewalks from its numbered streets and avenues, and the road network, traffic and pedestrians are derived from what
`city-grid.js` builds.

## The runtime, module by module

### Reusable as-is

These modules know nothing about New York:

- Rendering: `main.js` (setup and frame loop), `lighting.js`, `post-processing.js`, `scene-culling.js`
- Vehicles: `vehicles.js`, `cars.js`, `bus.js`, `helicopter.js`, `vehicle-physics.js`, `vehicle-lights.js`
- People: `pedestrians.js` (characters and animation), `controllers.js` (walking, driving, cycling, flying)
- Buildings: `building-footprints.js`, `building-collision.js`, `building-details.js`, `fire-escapes.js`
- Trees: `trees.js`
- Input and audio: `cameras.js`, `touch-controls.js`, `gamepad-controls.js`, `audio-*.js`

A few of these have small New York touches: `controllers.js`, `cameras.js` and `street-details.js` import
`bryantParkLawn` from `landmarks.js`, `cameras.js` has three scenic presets aimed at Midtown landmarks, and `main.js`
wires up the landmark list and teleports from `city-config.js`.

### Generic logic that reads city data

These work for any city once their inputs exist:

- `buildings.js`: builds every surveyed building from `building-geodata.js` and streams roof details, cornices, fire
  escapes, awnings and signs around the player. It also keeps a list of landmark lots clear (`LANDMARK_RESERVE`) and
  adds Times Square billboards; both are skipped gracefully if the sites are missing.
- `road-network.js`, `traffic.js`, `road-paint.js`: the drivable road graph, traffic and road markings, derived from
  the layout `city-grid.js` builds. Traffic drives on the right (the lane offsets in `road-network.js`).
- `pedestrian-system.js`, `pedestrian-routes.js`: crowds on the generated sidewalks and crosswalks.
- `street-details.js`, `street-props.js`, `tree-placements.js`, `subway-entrances.js`: street furniture, signals,
  trees fitted to the curbs, subway stairs.
- `nyc-map.js`: the minimap and full map, drawn from the same geography.

### New York through and through

Replace or remove these:

- `city-config.js`: the street database (`streetZ`, `avenueX`, `STREETS`, `AVENUES`), Central Park bounds, island and
  borough outlines, bridges, landmark sites, teleport locations and signal timing.
- `city-grid.js`: builds Manhattan's roads, blocks, sidewalks, parks, piers and highways from the street database.
- `boroughs.js`: the surrounding boroughs, New Jersey, harbor islands, bridges and the distant skyline.
- `landmarks.js`: hand-built models of the Empire State Building, Chrysler Building, Grand Central and others.
- `tsl-materials.js`: the materials are generic, but the canyon sky occlusion (`canyonSkyAONode`) opens up over Central
  Park, and the water material reads Manhattan's island bounds and the New Jersey and Long Island shorelines.

## Things that look generic but encode New York

- **Facade styles follow construction year.** In `buildings.js`, buildings from before 1945 get masonry facades (and
  fire escapes when they are 30 m or lower), 1945–1979 a mix of masonry and glass, and 1980 onward glass curtain walls.
  Buildings with no year count as modern, so a data source without construction years gives you a city of glass
  towers: pick a sensible year for buildings that don't have one.
- **Right-hand traffic.** Lane offsets and turns assume driving on the right.
- **The spawn point.** The first stream of building details is centred on 5th Ave & 42nd St (`update(0, 62, true)` in
  `buildings.js`), and the player's last position is restored from `localStorage` (`nyc-player-state`).
- **The UI.** The teleport menu and location labels in `index.html` and `city-config.js` name New York places.
- **Tests.** Some tests pin New York data, for example the building and tree counts in
  `tests/building-geodata.test.cjs` and `tests/tree-geodata.test.cjs`, and the Manhattan geography in
  `tests/teleports.test.cjs`, `tests/controllers.test.cjs`, `tests/pedestrians.test.cjs` and
  `tests/water-material.test.cjs`. Update them alongside your data.

## A suggested order

1. **Pick your frame**: an origin and bearing (`--origin` and `--bearing` in `tools/build-osm.mjs`, or `LAT0`, `LON0`
   and `THETA` in `tools/geo-base.mjs` for the other generators).
2. **Regenerate buildings and trees**, from OpenStreetMap with `tools/build-osm.mjs` or from your city's own open data.
   Buildings alone already make the city recognisable.
3. **Remove or replace the landmarks**: `buildLandmarks()` in `main.js`, `LANDMARK_RESERVE` in `buildings.js`, the
   scenic cameras (`fifthAve`, `timesSquare`, `chryslerGCT`) in `cameras.js` and the teleports in `city-config.js` and
   `index.html`.
4. **Replace the surroundings**: `boroughs.js` and the shorelines read by the water material.
5. **Rebuild the streets**: `nyc-geodata.js`, `city-config.js` and `city-grid.js`. This is the biggest job; everything
   that moves (traffic, pedestrians, road markings) follows from it.
6. **Update the tests, the page title and the data credits** in `README.md`.

## Licenses

The code is MIT licensed. Keep the license and attribution of any data you use; OpenStreetMap data, for example, is
© OpenStreetMap contributors under the ODbL and must be credited.
