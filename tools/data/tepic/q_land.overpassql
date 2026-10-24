[out:json][timeout:240];
(
  way["leisure"](21.395,-104.975,21.580,-104.790);
  relation["leisure"](21.395,-104.975,21.580,-104.790);
  way["landuse"](21.395,-104.975,21.580,-104.790);
  relation["landuse"](21.395,-104.975,21.580,-104.790);
  way["natural"](21.395,-104.975,21.580,-104.790);
  relation["natural"](21.395,-104.975,21.580,-104.790);
  way["waterway"](21.395,-104.975,21.580,-104.790);
  way["railway"](21.395,-104.975,21.580,-104.790);
  way["aeroway"](21.395,-104.975,21.580,-104.790);
  way["amenity"~"^(school|university|college|hospital|marketplace|bus_station|place_of_worship|parking)$"](21.395,-104.975,21.580,-104.790);
  relation["amenity"~"^(school|university|college|hospital|marketplace|bus_station|place_of_worship)$"](21.395,-104.975,21.580,-104.790);
  way["man_made"~"^(bridge|tower|water_tower)$"](21.395,-104.975,21.580,-104.790);
  way["barrier"="wall"](21.395,-104.975,21.580,-104.790);
);
out geom tags;
