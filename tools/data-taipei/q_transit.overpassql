[out:json][timeout:300];
// Xinyi District (信義區, OSM relation 2881027; area id = 3600000000 + relation id)
// MRT: track (elevated, at grade and in tunnels), stations, platforms and entrances
area(id:3602881027)->.d;
(
  way["railway"~"^(subway|light_rail|monorail|rail)$"](area.d);
  node["railway"~"^(station|halt|subway_entrance)$"](area.d);
  way["railway"~"^(station|platform)$"](area.d);
  way["public_transport"~"^(station|platform)$"](area.d);
  relation["public_transport"="station"](area.d);
  way["building"="train_station"](area.d);
);
out geom;
