[out:json][timeout:120];
(
  node["natural"="tree"](25.0328,121.4949,25.0418,121.5048);
  way["natural"="tree_row"](25.0328,121.4949,25.0418,121.5048);
  node["highway"="traffic_signals"](25.0328,121.4949,25.0418,121.5048);
  node["crossing"="traffic_signals"](25.0328,121.4949,25.0418,121.5048);
  way["leisure"~"^(park|garden)$"](25.0328,121.4949,25.0418,121.5048);
  relation["leisure"~"^(park|garden)$"](25.0328,121.4949,25.0418,121.5048);
  way["landuse"~"^(grass|forest)$"](25.0328,121.4949,25.0418,121.5048);
  way["natural"="wood"](25.0328,121.4949,25.0418,121.5048);
);
out geom;
