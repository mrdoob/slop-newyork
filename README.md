# Slop New York

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.

[Try it live](https://mrdoob.github.io/slop-newyork/)

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

## Taipei port (in progress)

This fork is being retargeted to Taipei. It currently covers the whole of Xinyi District (信義區, about 11 km² around
Taipei 101, with the Four Beasts hills in its south-east), Xinyi together with Da'an District (大安區; about 23 km², one
world around Taipei 101, `index.html?area=city`, `GEO_AREA=city`: the city growing district by district) and a 1 km box
around Lungshan Temple in Wanhua (`index.html?area=wanhua`): open `index.html` over http in a WebGPU
browser (the original New York simulation is now `nyc.html`). Building footprints come from OpenStreetMap (`tools/build-taipei-geodata.mjs`, `GEO_AREA=wanhua` for the
second box). **The Wanhua box has large holes:** OSM maps roughly a third of its buildings (about 390 outlines where
Taipei's 3D city model has over 5,000), so empty blocks there are missing data, not open space. To keep it from
reading as wasteland, the Wanhua box adds about 3,300 **stand-in buildings** (`tools/geo-infill.mjs`): rows of narrow lots
along street frontages where OSM maps no building and no open ground, with heights from the mapped neighbours. Their
footprints and heights are both **inferred, not mapped**; they are kept apart in the data (`GEO.infill`), tinted violet
with E, and hidden with I. Checked locally against the 3D model, about 14% of them stand where no building does. The
In Xinyi District OSM maps most buildings and the remaining gaps are scattered; its stand-ins (about 7,500, limited
to built-up blocks) are less certain, about 39% standing where no building does, so they start **hidden** (I shows
them). Both areas also use **building-permit footprints** from Taipei's open
building-permit drawings (臺北市建築執照套繪圖, OGDL v1) where OSM maps no building: real outlines with floor counts
for buildings permitted up to 2018 (newer permits may not be built yet), 88 in Xinyi District and 34 in Wanhua.

**The Taipei skyline is partially estimated.** Where OSM gives a building's `height` or storey count, that is used;
where it gives neither (53% of buildings in Xinyi District, 38% in Wanhua), the height is inferred from building type and
footprint area by `estimateHeight()` in `tools/geo-height.mjs`. Its parameters were checked locally against measured
heights from Taipei's 3D city models (median error about 5 m across Xinyi District, 8 m in Wanhua); those measured heights are not
redistributed here. Estimated buildings are labelled in the data and can be
highlighted in the viewer (press E). Taipei 101 renders at its real 508 m from OSM's building parts. Streets are
drawn from the OSM road graph; road widths come from the `width` or `lanes` tags where present and otherwise from a
default per road class, adjusted to the gap between mapped sidewalks where those exist. OSM maps few sidewalks
here, so sidewalks along streets 6 m or wider are drawn from the roads' sidewalk tags or, untagged, assumed (labelled
'inferred' in the data, default widths), joined around junction corners. Street furniture (bus stops, MRT entrances,
YouBike stations, hydrants, flagpoles…) stands where OSM maps it; street lamps, which OSM barely maps here, are spaced
along kerbs and labelled inferred. Taipei 101's shaft is shaped as its documented base and eight flared modules on
OSM's footprint and heights. Press M for a reference layer of aerial photos (© 內政部國土測繪中心 NLSC, loaded from their
map service when shown) to compare roads and footprints by eye. Traffic signals stand where OSM maps them, but their timing is a generic fixed cycle. Trees are
OSM's mapped trees plus trees spaced along mapped tree rows and through mapped woods (the models are generic
broadleaf trees, not Taipei species). Cars and pedestrians are simulated, not real traffic. Roof shapes and colours
come from OSM where tagged; facade styles (curtain wall, punched windows, shopfronts) are inferred from building type,
material and height, not surveyed.

## License and data

The project code is available under the [MIT License](LICENSE).

The Taipei viewer has seven modes: orbit, walk, bike (a YouBike-style city bike), car, plane, UFO and rocket
(keys 1–7; the UFO and the rocket's launch pad are, of course, made up). Press T
for a full map (click anywhere to teleport) and L to step through day, golden hour, dusk and night. A minimap follows
the player. At night, which windows are lit and which shops are open is random, not data. On phones and tablets a joystick and
hold buttons drive the player, and the viewer lowers its resolution, shadows and traffic to keep the frame rate up.
Every panel can be minimized (the map-data credit always stays visible).

**Terrain** (Xinyi, Xinyi + Da'an): ground heights from the open AWS Terrain Tiles (Mapzen, from NASA's SRTM, ~30 m),
kept only on real hills (connected areas more than 40 m above the basin floor, with a 200 m fade around their feet); the
basin is flat at 0, since in the city that surface model measures roofs and tree canopy, not the street;
approximate (peaks read 15–50 m below their surveyed heights). Everything stands on it. Hillsides are tinted wooded green
as a look, not data.

Geographic data: NYC Open Data and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL); Taipei map data © OpenStreetMap contributors (ODbL); Taipei building-permit footprints: [臺北市建築執照套繪圖](https://data.gov.tw/dataset/151936), 臺北市建築管理工程處 (Open Government Data License v1.0); elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; SRTM, NASA).

Forked from [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork) (MIT). Third-party data and dependencies retain their respective licenses.
