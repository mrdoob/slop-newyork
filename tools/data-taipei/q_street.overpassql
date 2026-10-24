[out:json][timeout:120];
(
  node["natural"="tree"](25.0249,121.5546,25.0430,121.5744);
  way["natural"="tree_row"](25.0249,121.5546,25.0430,121.5744);
  node["highway"="traffic_signals"](25.0249,121.5546,25.0430,121.5744);
  node["crossing"="traffic_signals"](25.0249,121.5546,25.0430,121.5744);
  way["leisure"~"^(park|garden)$"](25.0249,121.5546,25.0430,121.5744);
  relation["leisure"~"^(park|garden)$"](25.0249,121.5546,25.0430,121.5744);
  way["landuse"~"^(grass|forest)$"](25.0249,121.5546,25.0430,121.5744);
  way["natural"="wood"](25.0249,121.5546,25.0430,121.5744);
);
out geom;
