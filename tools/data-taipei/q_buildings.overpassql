[out:json][timeout:300];
// Xinyi District (信義區, OSM relation 2881027; area id = 3600000000 + relation id)
area(id:3602881027)->.d;
(
  way["building"](area.d);
  relation["building"](area.d);
  way["building:part"](area.d);
  relation["building:part"](area.d);
);
out geom;
