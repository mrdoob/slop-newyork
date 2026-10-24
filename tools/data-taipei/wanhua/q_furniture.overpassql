[out:json][timeout:120];
(
  node["highway"~"^(street_lamp|bus_stop)$"](25.0328,121.4949,25.0418,121.5048);
  node["public_transport"="platform"](25.0328,121.4949,25.0418,121.5048);
  node["railway"="subway_entrance"](25.0328,121.4949,25.0418,121.5048);
  node["amenity"~"^(bench|bicycle_parking|motorcycle_parking|bicycle_rental|waste_basket|post_box|telephone|drinking_water|vending_machine|parking_entrance|charging_station|atm)$"](25.0328,121.4949,25.0418,121.5048);
  way["amenity"~"^(motorcycle_parking|bicycle_parking|bench)$"](25.0328,121.4949,25.0418,121.5048);
  node["emergency"="fire_hydrant"](25.0328,121.4949,25.0418,121.5048);
  node["man_made"~"^(street_cabinet|flagpole)$"](25.0328,121.4949,25.0418,121.5048);
  node["leisure"="picnic_table"](25.0328,121.4949,25.0418,121.5048);
  node["highway"="street_lamp"](25.0328,121.4949,25.0418,121.5048);
);
out geom;
