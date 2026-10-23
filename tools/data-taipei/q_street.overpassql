[out:json][timeout:120];
(
  node["natural"="tree"](25.029,121.559,25.039,121.570);
  way["natural"="tree_row"](25.029,121.559,25.039,121.570);
  node["highway"="traffic_signals"](25.029,121.559,25.039,121.570);
  node["crossing"="traffic_signals"](25.029,121.559,25.039,121.570);
  way["leisure"~"^(park|garden)$"](25.029,121.559,25.039,121.570);
  relation["leisure"~"^(park|garden)$"](25.029,121.559,25.039,121.570);
  way["landuse"~"^(grass|forest)$"](25.029,121.559,25.039,121.570);
  way["natural"="wood"](25.029,121.559,25.039,121.570);
);
out geom;
