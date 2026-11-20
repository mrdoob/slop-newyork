[out:json][timeout:180];
// Subway tracks, stations & street entrances under the modelled island (Battery to 125th St), the route relations
// that name the services running over each track, and their stops (which services call at which station)
(
  way["railway"="subway"](40.695,-74.025,40.815,-73.925);
  node["railway"="station"]["station"="subway"](40.695,-74.025,40.815,-73.925);
  node["railway"="subway_entrance"](40.695,-74.025,40.815,-73.925);
);
out geom tags;
way["railway"="subway"](40.695,-74.025,40.815,-73.925)->.tracks;
rel(bw.tracks)["route"="subway"]->.routes;
.routes out body;
node(r.routes:"stop")(40.695,-74.025,40.815,-73.925);
out geom;
