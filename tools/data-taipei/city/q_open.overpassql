[out:json][timeout:300];
// Xinyi (信義區, OSM relation 2881027) + Da'an (大安區, relation 2869465) districts; area id = 3600000000 + relation id
area(id:3602881027,3602869465)->.d;
(
  way["amenity"~"^(parking|school|university|college|kindergarten|marketplace|place_of_worship|bus_station|fuel|hospital)$"](area.d);
  relation["amenity"~"^(parking|school|university|college|kindergarten|marketplace|place_of_worship|bus_station|fuel|hospital)$"](area.d);
  way["leisure"](area.d);
  relation["leisure"](area.d);
  way["landuse"~"^(railway|construction|recreation_ground|cemetery|brownfield|greenfield|religious|grass|forest)$"](area.d);
  relation["landuse"~"^(railway|construction|recreation_ground|cemetery|brownfield|greenfield|religious)$"](area.d);
  way["highway"]["area"="yes"](area.d);
  way["area:highway"](area.d);
  way["place"="square"](area.d);
  way["natural"~"^(water|wood|scrub|grassland)$"](area.d);
  relation["natural"="water"](area.d);
  way["waterway"="riverbank"](area.d);
  way["man_made"~"^(dyke|embankment)$"](area.d);
  way["barrier"~"^(wall|retaining_wall)$"]["wall"="flood_wall"](area.d);
  way["barrier"="flood_wall"](area.d);
  way["railway"~"^(rail|platform)$"]["tunnel"!="yes"]["layer"!~"^-"](area.d);
);
out geom;
