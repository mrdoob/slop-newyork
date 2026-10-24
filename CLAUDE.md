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

**Expanded (owner's call) to the whole of Xinyi District** (earlier: a 2 km box `25.0249, 121.5546, 25.0430, 121.5744`;
`BOX` in `tools/geo-taipei-base.mjs` is now the district's bbox, queries select the district area). At 2 km, 52% of heights are estimates (17% in the
1 km core); SE corner is the foot of Elephant Mountain — ground is flat (no terrain yet).
Original 1 km test box (S,W,N,E): `25.029, 121.559, 25.039, 121.570`. NOTE: box computed
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
# serve over http, open index.html (Taipei; NYC: nyc.html) in WebGPU browser (Chrome/Edge recent)
python3 -m http.server 8123   # -> http://127.0.0.1:8123/ (Taipei; NYC: /nyc.html)
# run the test suite before and after each change
```
Node: not on PATH by default; use nvm Node 23.4.0 (`~/.nvm/versions/node/v23.4.0/bin`). Tests:
`node --test tests/*.test.mjs tests/*.test.cjs` (1 pre-existing NYC failure in `boot.test.cjs`, preload of
`pedestrian-routes.js`). Tests in `tests/` (`overpass.test.mjs`, `geodata.test.mjs`, `taipei-geodata.test.mjs`) encode data SHAPES
renderer expects — use as spec; update NYC expectations to Taipei while porting.

## Order of work for the 1 km milestone
1. Projection frame (above) — everything hangs on it.
2. Buildings query + render with `estimateHeight()` — DONE (`index.html`, `js/taipei-main.js`, generic
   `js/footprint-buildings.js`). Make-or-break; get height variation right here.
3. Roads from graph — DONE: `tools/geo-osm-roadgraph.mjs` (OSM ways → NYC-shaped `roadGraph` + walking `paths`),
   generic `js/graph-roads.js` (asphalt, junction discs, lane lines, zebra crossings, skywalks). Widths: `width` tag →
   `lanes` × 3.25 m → class default (untagged = estimate; e.g. Songzhi Rd lacks `lanes`, renders narrow).
4. Taipei 101 at real height; ground plane.
   Extras since (viewer `index.html`): car/plane (`js/simple-vehicles.js`), AI cars & pedestrians on the graph
   (`js/footprint-traffic.js`), signals at OSM `traffic_signals` nodes (`js/signal-control.js`, generic fixed cycle),
   trees + green areas (`js/green-areas.js` + NYC `trees.js`). NYC models reused via `js/city-uniforms.js`,
   `js/tree-material.js`, `js/tsl-noise.js` (split out of `tsl-materials.js` so Taipei never loads NYC geodata).
   Underground ways (`layer<0`, tunnels, indoor) are skipped; skywalk stairs ramp to the ground.
   Roofs (OSM roof:shape/height/colour) & facade style per building: `tools/geo-building-style.mjs` (facade = style
   hint inferred from tags, not survey). Cars yield to people on crossings; people obey signals (`walkAllowed`).
   Official heights: Taipei UDD LOD1_2025 I3S (measured `H`, scriptable) is NOT openly licensed (no redistribution) —
   don't bake into geodata without written permission. Same for 3d.taipei 3D Tiles (NLSC-schema models, measured
   `BUILD_H`, "non-value-added" use): `tools/validate-heights.mjs` uses them LOCAL-ONLY (cache + report in git-ignored
   `tools/data-local/`) to tune `ESTIMATE_TIERS` (now a piecewise [footprint m², storeys] table per type); only tuned
   parameters are committed. 2 km box: estimate median error 7.6 m (1.29× too tall: Xinyi-tuned curve vs old
   walk-ups) → 5.1 m (1.07×). Re-run for each new district before trusting estimates there. Same check lists
   ~3,275 3D-model buildings with no OSM footprint (mostly the west / south-west of the box).
   Sidewalks (`tools/geo-sidewalks.mjs`): only ~7% of street length has mapped sidewalks both sides. Default/lanes
   road widths fit to mapped sidewalks (never into buildings); missing sidewalks drawn from road `sidewalk=*` tags or
   inferred on untagged streets ≥ 6 m; paths carry source mapped/tagged/inferred. Raised 0.15 m with kerbs.
   Corners joined at junctions; no inferred sidewalk along dual-carriageway medians; kerbside footways → sidewalk.
   Street furniture (`tools/geo-furniture.mjs`, `js/street-furniture.js`): OSM nodes (bus stops, MRT, YouBike,
   hydrants…); lamps inferred along kerbs (OSM maps ~17). Taipei 101 tiers: `LANDMARKS.tiers` (shape model of the
   design on OSM footprint/heights; renderer `topScale`). Missing buildings: validate-heights.mjs lists ~667
   3D-model buildings with no OSM footprint (mostly SW of box) — map them in OSM from allowed sources; never trace
   3d.taipei. Viewer has a loading screen with build-step + shader-compile progress.
   Reference photo overlay (M, `js/basemap-overlay.js`): NLSC PHOTO2 WMTS (CORS ok), loaded at runtime only; core
   roads/footprints line up with it. Traffic sim uses a 32 m car grid; pedestrians beyond 320 m aren't animated
   (2 km: 5.3 → ~1.5 ms/frame).
   Terrain: MOI 20 m DTM (data.gov.tw 176927, OGDL v1) is on TGOS, which geo-blocks non-Taiwan IPs (this sandbox exits
   in NL) — needs a manual download from Taiwan into tools/data-local/dtm/. Open alternative: 臺北市歷年使用執照摘要 (OGDL v1, design
   heights, address-matched, post-2001 only).
5. Judge against pass/fail criteria. Fix height variation before expanding.
Then, only then: second 1 km box in OLD district (Wanhua/Datong) to stress
fallback where data sparse, then expand in stages checking looks AND framerate.
Second box — DONE as data (`GEO_AREA=wanhua`, `tools/data-taipei/wanhua/`, `js/taipei-wanhua-geodata.js`,
viewer `index.html?area=wanhua`): 1 km around Lungshan Temple (way 198401479 = origin). Areas live in `AREAS`
(`geo-taipei-base.mjs`); xinyi output unchanged. Result: FAILS no-holes — OSM 391 outlines vs 5,257 measured
buildings (3,438 missing ≥ 4 m). Heights: 10% tag, 52% levels, 38% estimate; estimate median error 8.0 m (1.13×,
n=132, too few to retune global tiers; tags/levels 0.82×). Open fill source checked: 臺北市建築執照套繪圖
(data.gov.tw 151936, OGDL v1, footprints + bud_floor) has only post-2006 permits — 92 in the Wanhua box, not a fix.
Real fix = mapping in OSM from allowed sources.
Mapping task list: `tools/gap-tasks.mjs` (after validate-heights for the area) -> git-ignored
`tools/data-local/gap-tasks[-<area>].md/.geojson`, 50 m cells busiest first with iD links. Says WHERE only; local-only
(3d.taipei-derived). Imagery OK for tracing: editor-layer-index lists NLSC EMAP5/EMAP6_OPENDATA (OGDL 1.0, maps not
photos) + iD's global Bing/Esri layers. NLSC PHOTO2 orthophoto (our M overlay) is NOT in the index (NLSC user licence,
judged ODbL-incompatible by talk-tw 2016) — view only, don't trace.
Stand-in buildings (`tools/geo-infill.mjs`, owner OK'd as labelled inference): lots 4.5–9 m wide, rows ≤ 4 deep, along
street frontage with no mapped building / open ground (`osm_open.json`: parking, schools, temples, plazas, water, rail,
dykes) / walkway / viaduct / median side (`medianSides()` in geo-sidewalks). Height = median of mapped tagged
neighbours ≤ 80 m ±1 storey. Output `GEO.infill` (same rows as buildings, kind 'infill', ids i<n>), separate mesh,
violet on E, hide with I. Per-area `infill` flag in AREAS: Wanhua on (3,270 lots; local check: 65% of unmapped
buildings covered, 14% of lots no measured building within 12 m, heights 0.88×), Xinyi off (46% would be on open
ground). validate-heights.mjs reports these numbers for the area's generated file.
Off the roads (`tools/geo-kerb.mjs` kerbClear): drawn widths are often estimates, so mapped furniture / trees inside a
drawn carriageway move straight out to the drawn kerb (per-kind margin); inferred lamps / scooters / wood trees there
are dropped; build logs counts. Estimated widths narrow (≥ 3.5 m) where > 10% of kerb samples hit buildings.
Stand-ins avoid every at-grade OSM highway way. access=no ways reopened by vehicle/motor_vehicle/motorcar tags are
drivable. Building parts on negative levels only / 0 storeys above ground are skipped (underground station hall).
Junction discs (nodes of degree ≥ 2, radius = widest link's half width, as graph-roads.js) count as road in kerbClear.
Bike-share / rack bikes are generated in the build (`expandDocks`, kinds bike_share / bike, inferred), not the renderer:
row goes to the clear side of the kiosk; bikes on roads or in buildings are left out.
Player (viewer): `js/simple-vehicles.js` modes walk / bike / car / plane (keys 2–5), `teleport(x, z)`; person & bike models
`js/player-actors.js` (NYC cyclist ported with plain materials; PersonRig walk/ride). Walker steps onto raised sidewalks.
Map: `js/footprint-map.js` (minimap + full map T, click = teleport, hover = street name). Time of day: `js/time-of-day.js`
(day/golden/dusk/night, L; NYC preset values on DirectionalLight + Hemisphere; cityUniforms.uInteriorGlow drives car
headlamps; buildings/furniture/bike `setNight(f)`: random lit windows per building, shops, lamp heads + lamp pools).
NYC lighting.js / controllers.js / nyc-map.js NOT reused: they load NYC data (tsl-materials, city-config); a test
walks taipei-main's import graph to keep it that way.
Mobile: `(any-pointer: coarse)` → no MSAA, 2048 shadow map, half traffic, pixel ratio ≤ 1.5 adapting 0.6–1.5 to frame
time (loop `adapt`). Touch: NYC `js/touch-controls.js` reused unchanged (calls vehicles.setTouchInput/clearTouchInput;
mode names mapped walk/bike→cyclist, plane→helicopter). Panels: `js/hud-panels.js` makes every [data-panel] minimizable
(state in localStorage; data-collapse-small = minimized by default on phones); `.panel-keep` credit stays visible (ODbL).
Full map pinch-zooms.
UFO (6) & rocket (7): models in `js/sky-craft.js` (saucer + beam, rocket + flame, launch pad, smoke pool), flight in
simple-vehicles (`_flyUfo` hover/strafe-free, `_flyRocket` thrust + gravity, crash -> back to pad). Pure game props.
Whole Xinyi District (owner's call): `xinyi` area = district (OSM relation 2881027; q_*.overpassql select `area(id:3602881027)`,
BOX = its bbox, GEO.frame.boundary = outline, drawn on the map). 8,679 buildings, 3,885 links; build ~8 s (point-in-
building tests via `ringIndex` — were 103 s). Local check: 18,049 measured buildings ≥ 4 m in the district, 5,585 (31%)
without an OSM footprint, scattered (most of the bbox's 16k gaps are in Da'an / Songshan / Nangang outside it);
estimates 5.0 m median error (1.11×). Stand-ins tried with skipClasses / largeClear / rows: 54–60% of lots on open
ground → Xinyi infill stays off. Permit footprints (`tools/extract-permits.mjs` → `permits.json`, OGDL v1, committed;
`geo-twd97.mjs` TWD97→WGS84): only where no OSM building, permits ≤ 2018 (measured: ≤2018 76–77% built, 2019–22 49%,
2023+ ~20%), height source 'permit' (floors × 3.2; ~0.75× measured, like OSM levels). Viewer: worldLimit from box,
fog / camera scale with area, shadow square ±1 km follows the camera focus (TimeOfDay.follow), traffic capped
(560 cars / 760 people desktop), overlay z16 for big areas, furniture in 400 m tiles culled by distance per kind.
Xinyi stand-ins: rule E (skip trunk/primary/secondary frontage, 15 m clear of > 2,500 m² buildings, minCover 0.2 = ≥ 20%
of ground within 100 m already built) → 7,511 lots, 39% on open ground (A–D 54–60%, F/G 37% but cover far less);
`infillShown: false` → hidden until I; hidden stand-ins don't collide. No open footprint source for the rest:
Microsoft ML footprints have no Taiwan tiles; Taipei 1:1000 topo buildings are fee/application, not open.
Terrain (`tools/geo-terrain.mjs`, AREA.terrain, xinyi + city): AWS Terrain Tiles terrarium z14 (Mapzen; SRTM) cached in
`tools/data-taipei/terrain/` (shared by all areas), 10 m grid, opening 140 m (buildings out), floor (5th pct) → 0. Owner:
city must NOT read as rolling terrain (SRTM roofs / canopy left 0.5–10 m bumps over 63% of the basin) → terrain only on hill
cores (connected, > 40 m above floor, ≥ 0.1 km²) + 200 m fade; basin exactly 0 (70% of Xinyi + Da'an). Exported every 20 m
as GEO.terrain (decimetres). Elephant Mt reads ~141 m (SRTM 153, survey 183).
Xinyi + Da'an (`city` area, owner's call "grow by one district"): boundary = [2881027, 2869465] (AREA.boundary may be a
list), data `tools/data-taipei/city/`, out `js/taipei-city-geodata.js` (~8.3 MB, 2.2 MB gzip), viewer `?area=city`; xinyi
area kept as baseline. 21,549 buildings (34% estimate), 10,176 links; build ~26 s after grid-indexing parts-in-outline
and furniture yawToRoad (were 82 s; output identical). Headless desktop ~33 ms/frame vs Xinyi 17. Local check: estimates
5.5 m median error (1.07×), stand-ins 35% on open ground → hidden. Memory (JS heap after GC, load): city 573 → 288 MB,
Xinyi 234 → 140 MB: footprint-buildings' returned closures shared a V8 context with `paint`, keeping every pre-merge
ExtrudeGeometry + THREE.Shape alive (now `parts = []` after merging); stand-in mesh built on first show (~1 s for city).
Watch for this pattern: a module-scope array captured by any closure lives as long as the returned API.
Permit numbers year.serial.nF: some drop the 2nd dot ("103.03018F" = 8F, was read as 3,018 floors → 9.6 km tower);
extract-permits parses digits after the 4-digit serial, caps at 101 floors.
Map (`js/footprint-map.js`): minimap + zoomed full map draw vectors from a 100 m grid index (bitmap only zoomed out; was
blurry at 0.33 px/m for big areas); stand-ins on the map follow I (were always drawn). Phones: mode buttons one
sideways-scrolling row.
Signals (`js/signal-control.js`, generic; Taiwan look via options.style from taipei-main): owner said "traffic light is
different in Taipei". Per 道路交通標誌標線號誌設置規則 arts. 203/204/220: arm heads horizontal, red-amber-green from
drivers' left (no arrow lamps: no turn phases simulated), square red countdown beside red; pole heads vertical;
pedestrian signals = 2 lenses (red standing over green walking 小綠人, animated, quicker < 10 s, flashing last 5 s) +
green countdown, on poles at both ends of each `crossing` path near a signalised cluster, facing across.
MRT (owner: "did you miss MRT station?"): `tools/geo-transit.mjs` (optional `osm_transit.json` per area, q_transit) →
GEO.rail { lines [elevated, width, pts, deck heights], stations [name, en, x, z] }. OSM has no guideway heights: deck
10 m (layer ≥ 3: 13 m) ESTIMATE, ramps 5% to 0 at portals (graph distance from tunnel / at-grade nodes). Elevated
`building=train_station` (layer ≥ 1, no min height) raised: base deck − 4, top ≥ deck + 8 (estimate); Daan &
Technology Building are already raised by OSM parts. Renderer `js/viaduct.js` (deck + parapets + piers every 32 m);
map draws track + named stations. Underground lines: entrances only.
MRT check (owner: "check mrt position and buildings"): guideway only meets station buildings/parts (expected); station
nodes 1–11 m from the track. OSM station parts (Daan, Technology Building: platform level from 9.6 m) confirm the 10 m
deck. Station rule now uses the nearest guideway's deck (`deckNear`), not layer; estimated roof = deck + 8 (Linguang had
a 35 m generic estimate). Piers placed in the build (`placePiers`, GEO.rail.piers): twin tracks share one row, none in a
carriageway or building; longest half-span 44 m.
Found doing it: (1) `fitRoadWidths` widened dual-carriageway halves symmetrically across their median (Fuxing S Rd
18–23 m per direction, median gone) → capped at gap − 2 m (`medianInfo`: opposite one-way matched on its polyline;
`medianSides` kept as before so sidewalk inference is unchanged by it). (2) `linkLine` (geo-sidewalks) read link
interior points as flat [x, z, ...] but they are [[x, z], ...] until the build flattens them → every link with a bend
(41–45%) was NaN geometry in width fitting, kerbside footways and sidewalk inference. Fixed (reads both). Xinyi:
inferred sidewalks 35 → 110 km, in buildings 7.1% → 4.8%, in carriageways 3.4% → 1.7%; mapped kerbside footways used
14 → 80. Frame time unchanged.
Renderer: `js/terrain.js` (heightAt / drape / resample / buildTerrainMesh): roads & sidewalks resampled 8 m + lifted,
green areas draped, buildings at lowest ground under outline (`ground` attribute for facades), trees / furniture /
signals / cars / people / player / UFO / rocket pad on it; collision index absolute (solidAbove for ground modes);
photo overlay draped; hillsides tinted green above ~6–30 m (look, not data).

## Honesty rule
If building heights estimated because OSM lacks them, say so in code comments
and README. City must be truthful about which parts real data vs
inferred — plausible-looking guessed skyline presented as real = failure
to avoid.
Keelung Road (owner: "keelung road is weird. Some buildings is missing"): (1) elevated roads (layer >= 1 drivable ways)
were dropped: Civic Blvd viaduct, Jianguo & Keelung Road expressways, ramps (Xinyi ~5 km, Xinyi + Da'an ~27 km). Now
`geo-osm-roadgraph` returns them apart (`elevated`), the build makes GEO.elevatedRoads { lines, piers, deckDepth } with
`tools/geo-elevated.mjs` (deckHeights: layer 1 → 9 m, 2 → 15, 3 → 21 m ESTIMATES, 6% ramps to 0 at street nodes;
placePiers shared with the MRT, which now uses it too), clipped to the district + 100 m (long ways run far outside);
drawn by `js/viaduct.js` (asphalt top); NOT driven (traffic stays on the street). (2) the Keelung underpass: tunnels
were dropped and their at-grade ramps drawn flat into dead ends. Now ramp links (same name as a drivable tunnel, from
its portal to the first junction) get `roadGraph.rampDepth` (6 m at the portal, 6% or the chain's length; tunnels whose
route rises > 3 m on the terrain are hill tunnels: no trench), no sidewalks; graph-roads sinks them with retaining
walls and a dark mouth; cars/player follow (`rampDepthAt`). The ground covers a trench, so an invisible depth-only lid
(`groundOpening`) draws after roads + cars (renderOrder -4) and before ground/terrain (-2): ground fails depth over it.
(A per-pixel shader test and a depth-clearing mesh with depthNode were tried; the latter didn't take effect.) Frame
time unchanged (median snaps to vsync 16.7/33.3: use the mean over 300 frames to compare). (3) "missing buildings":
53% of measured buildings within 150 m of Keelung Rd have no OSM footprint (old blocks along Sec. 2) — OSM gap, not a
bug; stand-ins exist (I) but Xinyi starts with them hidden.
Doors (owner: "keep fixing missing buildings"): no open footprint source left (NLSC vector e-map omits buildings; its
WMTS `BUILDX` per-building outlines and full EMAP are NOT labelled open data — only EMAP5/6_OPENDATA ≤ 1:18,000 are —
so view-only like PHOTO2; ask NLSC before deriving). Open signal used instead: 臺北市門牌位置數值資料 (data.gov.tw
155472, OGDL v1, CSV 125 MB, TWD97/TM2, all 12 districts; one row per address, floors as separate rows "91號四樓").
`tools/extract-addresses.mjs` (raw CSV in data-local; NB a 300 s curl limit truncated it once) → per-area
`addresses.json` [lon, lat, addresses, highest floor named] (committed). Build: doors → building containing them / ≤ 2 m
of its edge; `estimate` buildings with floors ≥ 2 → floors × ADDRESS_LEVEL_M 3.85 (source 'address'; local: 1.1 m error,
1.0×; levels tags 2.2–2.8 m, 0.85×). Unmatched doors (> 3 m from any mapped building) = infill `seeds`: `seedRadius`
keeps only lots that close to a door, `doorLots` gives a door no lot reached its own 6 m lot, heights from its floors.
Local results: Xinyi seedRadius 5 → 4,473 lots, 14% on open ground (was 39%), 41% of the district's 5,585 gaps under a
stand-in (54% within 4 m), heights 2.5 m off → shown by default; Wanhua seedRadius 8 → 59% gaps, 4% open, 3.7 m (was
63%, 12%, 7.6 m); Xinyi + Da'an seedRadius 5 → 12% open, 2.8 m. Estimates left: Xinyi 16% (was 53%), city 11% (was
34%); they run 1.35–1.4× tall (biased remainder: buildings without doors) — retune later. Frame: Xinyi ~27 ms mean.
Roads near Taipei 101 (owner: "fix roads near Taipei 101"): Songzhi / Songshou Rd lack `lanes`, so links sat at the
6.5 m class default except where mapped sidewalks on both sides let `fitRoadWidths` widen them (23–27 m) → the
boulevards necked down to two lanes every other block. `continueWidths` (geo-sidewalks): a class-default link takes the
median fitted width of the same-named street (same direction type) within 300 m, kerb-checked against buildings and
capped at a dual carriageway's median; width source 'same street' (WIDTH_SOURCES[4]). Xinyi 104 links, city 256,
Wanhua 36.
Objects on roads near 101 (owner: "fix objects on roads near taipei 101"): (1) signal poles were placed at load time at
fixed kerb offsets without checking other roads: 13/121 vehicle and 30/196 pedestrian poles near 101 stood in a
carriageway. `signal-control.js` takes `options.clear` (taipei-main passes tools/geo-kerb.mjs `kerbClear`, a pure module):
poles move to the nearest clear kerb (arm re-aimed to keep the head over its lanes; no arm if > reach + 4 m) or are left
out (Xinyi: 149 moved, 4 dropped). (2) Songzhi Rd's fitted 27 m covered its own east verge (tree rows, grass 10–25 m
from the centre line). Widening (fit + continuity) now stops short of mapped trees / tree rows / grass / parks /
walkways (`verge`, > 5% of samples across the surface) but NEVER narrows below the starting width — a first version did,
and squeezed Ren'ai Rd (26 → 5.5 m: its planted median is inside the road) and Keelung / Zhongxiao to 3 m. Side
effect: 3.5 m service alleys are no longer bumped to the 5.5 m two-way minimum over their own mapped footways.
