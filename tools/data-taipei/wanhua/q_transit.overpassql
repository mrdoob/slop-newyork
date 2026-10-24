[out:json][timeout:120];
// MRT: track (elevated, at grade and in tunnels), stations, platforms and entrances in the Wanhua 1 km box
(
  way["railway"~"^(subway|light_rail|monorail|rail)$"](25.0328,121.4949,25.0418,121.5048);
  node["railway"~"^(station|halt|subway_entrance)$"](25.0328,121.4949,25.0418,121.5048);
  way["railway"~"^(station|platform)$"](25.0328,121.4949,25.0418,121.5048);
  way["public_transport"~"^(station|platform)$"](25.0328,121.4949,25.0418,121.5048);
  way["building"="train_station"](25.0328,121.4949,25.0418,121.5048);
);
out geom;
