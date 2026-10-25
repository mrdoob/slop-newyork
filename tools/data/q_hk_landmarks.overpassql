// tools/data/q_hk_landmarks.overpassql — 香港地標 footprint 與高度（Phase 1）
// usage: bash tools/overpass.sh tools/data/hk/osm_landmarks.json tools/data/q_hk_landmarks.overpassql
//
// 保留 building / height / building:levels，讓 build-hk-geodata 可以沿用真實高度而不是 profile 猜測。
// 名單先用維港兩岸的地標；換城市時改 bbox 即可。
[out:json][timeout:240];
(
  way["building"]["name"](22.240,114.130,22.340,114.200);
  relation["building"]["name"](22.240,114.130,22.340,114.200);
);
out tags geom;
