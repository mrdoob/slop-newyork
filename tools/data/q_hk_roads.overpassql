// tools/data/q_hk_roads.overpassql — 香港走廊中心線（Phase 1：把 seed 換成真 OSM）
// usage: bash tools/overpass.sh tools/data/hk/osm_roads.json tools/data/q_hk_roads.overpassql
//
// 覆蓋維港兩岸的種子範圍：上環—銅鑼灣（港島北）與西九龍—旺角（九龍）。
// 真正落資料前，請把 bbox 換成你要的城市範圍（南緯/西經/北緯/東經 = 22.24,114.13,22.34,114.20）。
[out:json][timeout:240];
(
  way["highway"~"^(trunk|primary|secondary|tertiary|trunk_link|primary_link)$"](22.240,114.130,22.340,114.200);
);
out tags geom;
