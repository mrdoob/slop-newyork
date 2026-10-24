# Slop New York

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.

[Try it live](https://mrdoob.github.io/slop-newyork/)

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

## Taipei port (in progress)

This fork is being retargeted to Taipei. It currently covers a 2 km box around Taipei 101 (Xinyi and around) and a
1 km box around Lungshan Temple in Wanhua (`taipei.html?area=wanhua`): open `taipei.html` over http in a WebGPU
browser. Building footprints come from OpenStreetMap (`tools/build-taipei-geodata.mjs`, `GEO_AREA=wanhua` for the
second box). **The Wanhua box has large holes:** OSM maps roughly a third of its buildings (about 390 outlines where
Taipei's 3D city model has over 5,000), so empty blocks there are missing data, not open space.

**The Taipei skyline is partially estimated.** Where OSM gives a building's `height` or storey count, that is used;
where it gives neither (52% of buildings in the 2 km Xinyi box, 38% in Wanhua), the height is inferred from building type and
footprint area by `estimateHeight()` in `tools/geo-height.mjs`. Its parameters were checked locally against measured
heights from Taipei's 3D city models (median error about 5 m in the Xinyi box, 8 m in Wanhua); those measured heights are not
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

Geographic data: NYC Open Data and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL); Taipei map data © OpenStreetMap contributors (ODbL).

Forked from [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork) (MIT). Third-party data and dependencies retain their respective licenses.
