[out:json][timeout:300];
// Xinyi District (信義區, OSM relation 2881027; area id = 3600000000 + relation id)
area(id:3602881027)->.d;
(
  node["natural"="tree"](area.d);
  way["natural"="tree_row"](area.d);
  node["highway"="traffic_signals"](area.d);
  node["crossing"="traffic_signals"](area.d);
  way["leisure"~"^(park|garden)$"](area.d);
  relation["leisure"~"^(park|garden)$"](area.d);
  way["landuse"~"^(grass|forest)$"](area.d);
  way["natural"="wood"](area.d);
);
out geom;
