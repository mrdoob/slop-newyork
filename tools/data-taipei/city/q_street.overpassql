[out:json][timeout:300];
// Xinyi (信義區, OSM relation 2881027) + Da'an (大安區, relation 2869465) districts; area id = 3600000000 + relation id
area(id:3602881027,3602869465)->.d;
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
