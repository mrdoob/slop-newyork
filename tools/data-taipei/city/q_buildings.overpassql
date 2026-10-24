[out:json][timeout:300];
// Xinyi (信義區, OSM relation 2881027) + Da'an (大安區, relation 2869465) districts; area id = 3600000000 + relation id
area(id:3602881027,3602869465)->.d;
(
  way["building"](area.d);
  relation["building"](area.d);
  way["building:part"](area.d);
  relation["building:part"](area.d);
);
out geom;
