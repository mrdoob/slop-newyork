[out:json][timeout:120];
(
  node["highway"~"^(street_lamp|bus_stop)$"](25.0249,121.5546,25.0430,121.5744);
  node["public_transport"="platform"](25.0249,121.5546,25.0430,121.5744);
  node["railway"="subway_entrance"](25.0249,121.5546,25.0430,121.5744);
  node["amenity"~"^(bench|bicycle_parking|motorcycle_parking|bicycle_rental|waste_basket|post_box|telephone|drinking_water|vending_machine|parking_entrance|charging_station|atm)$"](25.0249,121.5546,25.0430,121.5744);
  way["amenity"~"^(motorcycle_parking|bicycle_parking|bench)$"](25.0249,121.5546,25.0430,121.5744);
  node["emergency"="fire_hydrant"](25.0249,121.5546,25.0430,121.5744);
  node["man_made"~"^(street_cabinet|flagpole)$"](25.0249,121.5546,25.0430,121.5744);
  node["leisure"="picnic_table"](25.0249,121.5546,25.0430,121.5744);
  node["highway"="street_lamp"](25.0249,121.5546,25.0430,121.5744);
);
out geom;
