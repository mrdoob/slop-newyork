// tools/data/q_hk_coast.overpassql — 維港海岸線與天橋（Phase 1）
// usage: bash tools/overpass.sh tools/data/hk/osm_coast.json tools/data/q_hk_coast.overpassql
//
// natural=coastline 決定填海輪廓；man_made=bridge / bridge=yes 是香港特有的行人天橋系統，
// 之後會用來做多層世界（見 README 15.5 的「天橋多層」風險）。
[out:json][timeout:240];
(
  way["natural"="coastline"](22.240,114.130,22.340,114.200);
  way["man_made"="bridge"](22.240,114.130,22.340,114.200);
  way["railway"="tram"](22.240,114.130,22.340,114.200);
);
out tags geom;
