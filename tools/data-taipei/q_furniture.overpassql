[out:json][timeout:120];
(
  node["highway"~"^(street_lamp|bus_stop)$"](25.029,121.559,25.039,121.570);
  node["public_transport"="platform"](25.029,121.559,25.039,121.570);
  node["railway"="subway_entrance"](25.029,121.559,25.039,121.570);
  node["amenity"~"^(bench|bicycle_parking|motorcycle_parking|bicycle_rental|waste_basket|post_box|telephone|drinking_water|vending_machine|parking_entrance|charging_station|atm)$"](25.029,121.559,25.039,121.570);
  way["amenity"~"^(motorcycle_parking|bicycle_parking|bench)$"](25.029,121.559,25.039,121.570);
  node["emergency"="fire_hydrant"](25.029,121.559,25.039,121.570);
  node["man_made"~"^(street_cabinet|flagpole)$"](25.029,121.559,25.039,121.570);
  node["leisure"="picnic_table"](25.029,121.559,25.039,121.570);
  node["highway"="street_lamp"](25.029,121.559,25.039,121.570);
);
out geom;
