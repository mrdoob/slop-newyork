# CLAUDE.md

## Project
Browser 3D city (three.js + WebGPURenderer + TSL), forked from
`mrdoob/slop-newyork` (MIT), retargeted Manhattan → **Taipei**.
Renderer stays; geography, streets, landmarks replaced.

Owner reasons from first principles: before changing file, state NYC
assumption behind it + Taipei equivalent. No find-and-replace "nyc" →
"taipei" — understand why each constant exists.

## Current milestone (work on THIS, not the whole city)
**Render 1 km box around Taipei 101, make it look good. Expand only after.**
Smoke test for whole pipeline on city's best-mapped area (Xinyi). Bad here where
data best → worse everywhere; good → expanding = bigger bbox. Don't widen area
until 1 km render passes criteria below.

1 km test box (S,W,N,E): `25.029, 121.559, 25.039, 121.570`. NOTE: box computed
by hand from origin, not verified — paste buildings query into overpass-turbo.eu,
confirm on map it surrounds Taipei 101 + covers Xinyi core before committing;
nudge bounds visually. (At 25°N, 1° lon ≈ 101 km vs 1° lat ≈ 111 km, so E/W and
N/S spans differ per degree.)

**Pass/fail — judge against these, not vibes:**
- Skyline has believable height **variation** (not field of identical boxes).
  #1 tell; fix before expanding.
- Taipei 101 towers correctly over neighbours (508 m vs ~100–200 m). Wrong-scale
  101 fails test alone.
- Roads match real street layout vs map.
- No large holes (missing footprints / blocks).

## Invariants (don't violate; stop and flag if a task would)
1. **Keep renderer generic.** Geodata-consuming files (`buildings.js`,
   `road-network.js`, `road-paint.js`, `trees.js`, `traffic.js`, `pedestrians.js`,
   `tsl-materials.js`, `post-processing.js`, `scene-culling.js`) get NO
   Taipei-specific constants. City identity lives in data + config, passed in.
2. **Real, sourced data.** Geometry from OSM (or TW open data) via build
   pipeline — never hand-invented positions. Taipei 101 height = real 508 m,
   not guess.
3. **Estimated heights labelled as estimates.** Most Taipei footprints lack
   `height`/`building:levels`. Inferred height goes through one documented
   `estimateHeight()` function; README states skyline partially estimated.
   Never present guessed height as real data.
4. **Generated geodata = build output, not source.** Never hand-edit
   `js/*-geodata.js`; change inputs or `geo-*.mjs`, re-run `build-geodata.mjs`.
5. **Keep NYC runnable until Taipei replaces it.** Retarget feature-by-feature with
   app running; always keep working NYC render as comparison baseline.
6. **Preserve attribution.** Keep MIT `LICENSE`, credit `mrdoob/slop-newyork`.
   Taipei map data © OpenStreetMap contributors (**ODbL**) — in README and
   any credits UI.

## The core truth about this codebase
Only partly data-driven. `tools/` data pipeline swappable; but
`js/city-config.js` and `tools/geo-streets.mjs` **hardcode Manhattan's regular
grid** (named avenues, fixed cross-street positions, 29° rotation). **Taipei has
no citywide grid.** So NYC street model can't be value-swapped — streets must
be built from OSM **road graph** (`geo-roadgraph.mjs`), not named-avenue
constants. That's core task, not data edit. Xinyi (this milestone's area)
semi-gridded → gentle first test of road-graph path.

## Projection frame — DONE (`tools/geo-frame.mjs` + `tools/geo-taipei-base.mjs`)
WGS-84 math lives in shared `makeFrame()` (`tools/geo-frame.mjs`); NYC `geo-base.mjs` uses it
(output byte-identical), Taipei config in `geo-taipei-base.mjs`. Don't edit NYC frame for Taipei. Taipei values:
```js
const LAT0 = 25.033964;   // Taipei 101 = world origin (verified)
const LON0 = 121.564468;
const THETA = 0;        // no citywide grid; north-up. Delete NYC avenue calibration.
const ORIGIN = [0, 0];  // world origin = projection origin (no named-intersection dep)
```
Harbour-island seed points stay in NYC `geo-base.mjs` only (Taipei inland, no islands).

## Data queries (run via `tools/overpass.sh <out.json> <query.ql>`)
Verify each in overpass-turbo.eu before trusting counts/names.

**Buildings — the bulk of the city (no name filter), scoped to the 1 km box** (`tools/data-taipei/q_buildings.overpassql`):
```
[out:json][timeout:120];
(
  way["building"](25.029,121.559,25.039,121.570);
  relation["building"](25.029,121.559,25.039,121.570);
  way["building:part"](25.029,121.559,25.039,121.570);
  relation["building:part"](25.029,121.559,25.039,121.570);
);
out geom;
```
Use `out geom;` not `out geom tags;` — `tags` mode drops relation members (multipolygon buildings lose geometry).
Parts needed: outlines with `building:part`s inside render as parts only (Simple 3D Buildings). Taipei 101 outline is
tagged 508 m over whole podium; its parts step up to the 508 m spire.
Every footprint → extruded by height. This building mass, not landmark list,
fills view.

**Roads — feed the road graph:**
```
[out:json][timeout:120];
( way["highway"](25.029,121.559,25.039,121.570); );
out geom;
```

**Water:** likely none in box (Xinyi inland); citywide uses rivers
(`natural=water` / `waterway=riverbank`, Tamsui/Keelung), not `natural=coastline`.

**Landmarks:** special-case list, matched on `name:en` (OSM primary `name` is
Chinese). Key one for this box: Taipei 101 — real 508 m in `LANDMARKS` (`geo-taipei-base.mjs`); build fails if
rendered top differs.

## Height handling (where the render looks real or fake)
In `tools/geo-height.mjs` (`buildingHeight()` → `estimateHeight(type, area)`), in order:
1. `height` tag (m) → use directly.
2. `building:levels` → levels × ~3.2 m.
3. neither → tiered fallback, documented: by `building` type (house/retail short;
   apartments/commercial taller; office/hospital tallest) refined by footprint area
   and, later, district. Flat default for all untagged buildings NOT acceptable
   — kills skyline variation test depends on.
First check whether Taiwan open 3D-building / height dataset exists; real heights
beat any heuristic, would replace this function.

## Build / run (WebGPU needs http, not file://)
```
# fetch OSM source data for the 1 km box
bash tools/overpass.sh tools/data-taipei/osm_buildings.json tools/data-taipei/q_buildings.overpassql
bash tools/overpass.sh tools/data-taipei/osm_roads.json    tools/data-taipei/q_roads.overpassql
# generate geodata (tools/build-geodata.mjs is NYC-only)
node tools/build-taipei-geodata.mjs
# serve over http, open taipei.html (NYC: index.html) in WebGPU browser (Chrome/Edge recent)
python3 -m http.server 8123   # -> http://127.0.0.1:8123/taipei.html
# run the test suite before and after each change
```
Node: not on PATH by default; use nvm Node 23.4.0 (`~/.nvm/versions/node/v23.4.0/bin`). Tests:
`node --test tests/*.test.mjs tests/*.test.cjs` (1 pre-existing NYC failure in `boot.test.cjs`, preload of
`pedestrian-routes.js`). Tests in `tests/` (`overpass.test.mjs`, `geodata.test.mjs`, `taipei-geodata.test.mjs`) encode data SHAPES
renderer expects — use as spec; update NYC expectations to Taipei while porting.

## Order of work for the 1 km milestone
1. Projection frame (above) — everything hangs on it.
2. Buildings query + render with `estimateHeight()` — DONE (`taipei.html`, `js/taipei-main.js`, generic
   `js/footprint-buildings.js`). Make-or-break; get height variation right here.
3. Roads from graph — DONE: `tools/geo-osm-roadgraph.mjs` (OSM ways → NYC-shaped `roadGraph` + walking `paths`),
   generic `js/graph-roads.js` (asphalt, junction discs, lane lines, zebra crossings, skywalks). Widths: `width` tag →
   `lanes` × 3.25 m → class default (untagged = estimate; e.g. Songzhi Rd lacks `lanes`, renders narrow).
4. Taipei 101 at real height; ground plane.
   Extras since (viewer `taipei.html`): car/plane (`js/simple-vehicles.js`), AI cars & pedestrians on the graph
   (`js/footprint-traffic.js`), signals at OSM `traffic_signals` nodes (`js/signal-control.js`, generic fixed cycle),
   trees + green areas (`js/green-areas.js` + NYC `trees.js`). NYC models reused via `js/city-uniforms.js`,
   `js/tree-material.js`, `js/tsl-noise.js` (split out of `tsl-materials.js` so Taipei never loads NYC geodata).
   Underground ways (`layer<0`, tunnels, indoor) are skipped; skywalk stairs ramp to the ground.
   Roofs (OSM roof:shape/height/colour) & facade style per building: `tools/geo-building-style.mjs` (facade = style
   hint inferred from tags, not survey). Cars yield to people on crossings; people obey signals (`walkAllowed`).
   Official heights: Taipei UDD LOD1_2025 I3S (measured `H`, scriptable) is NOT openly licensed (no redistribution) —
   don't bake into geodata without written permission. Open alternative: 臺北市歷年使用執照摘要 (OGDL v1, design
   heights, address-matched, post-2001 only).
5. Judge against pass/fail criteria. Fix height variation before expanding.
Then, only then: second 1 km box in OLD district (Wanhua/Datong) to stress
fallback where data sparse, then expand in stages checking looks AND framerate.

## Honesty rule
If building heights estimated because OSM lacks them, say so in code comments
and README. City must be truthful about which parts real data vs
inferred — plausible-looking guessed skyline presented as real = failure
to avoid.