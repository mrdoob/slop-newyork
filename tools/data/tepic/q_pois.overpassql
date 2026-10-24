[out:json][timeout:240];
(
  node["place"](21.395,-104.975,21.580,-104.790);
  node["tourism"]["name"](21.395,-104.975,21.580,-104.790);
  node["historic"]["name"](21.395,-104.975,21.580,-104.790);
  node["amenity"~"^(place_of_worship|marketplace|theatre|cinema|townhall|university|hospital|bus_station|fountain)$"]["name"](21.395,-104.975,21.580,-104.790);
  way["tourism"]["name"](21.395,-104.975,21.580,-104.790);
  way["historic"]["name"](21.395,-104.975,21.580,-104.790);
  node["natural"="peak"](21.38,-105.00,21.60,-104.76);
  way["leisure"="stadium"]["name"](21.395,-104.975,21.580,-104.790);
  node["highway"="street_lamp"](21.395,-104.975,21.580,-104.790);
  node["highway"="traffic_signals"](21.395,-104.975,21.580,-104.790);
  node["highway"="crossing"](21.395,-104.975,21.580,-104.790);
);
out center tags;
