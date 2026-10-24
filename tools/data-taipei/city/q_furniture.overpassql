[out:json][timeout:300];
// Xinyi (信義區, OSM relation 2881027) + Da'an (大安區, relation 2869465) districts; area id = 3600000000 + relation id
area(id:3602881027,3602869465)->.d;
(
  node["highway"~"^(street_lamp|bus_stop)$"](area.d);
  node["public_transport"="platform"](area.d);
  node["railway"="subway_entrance"](area.d);
  node["amenity"~"^(bench|bicycle_parking|motorcycle_parking|bicycle_rental|waste_basket|post_box|telephone|drinking_water|vending_machine|parking_entrance|charging_station|atm)$"](area.d);
  way["amenity"~"^(motorcycle_parking|bicycle_parking|bench)$"](area.d);
  node["emergency"="fire_hydrant"](area.d);
  node["man_made"~"^(street_cabinet|flagpole)$"](area.d);
  node["leisure"="picnic_table"](area.d);
  node["highway"="street_lamp"](area.d);
);
out geom;
