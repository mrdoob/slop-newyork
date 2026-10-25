#!/bin/bash
# Tepic's public transport routes (camiones & combis), as the Secretaría de Movilidad del Estado de Nayarit publishes
# them on https://semovi.nayarit.gob.mx/muevete-transporte-publico/ : a MapHub map whose viewer loads one GeoJSON
# FeatureCollection (a LineString per route, grouped by zone). Writes semovi_routes.json.
cd "$(dirname "$0")"
set -euo pipefail
MAP=312580 # https://maphub.net/MovilidadNayarit/Transporte-Publico-Tepic
TMP=$(mktemp semovi_routes.json.tmp.XXXXXX)
trap 'rm -f -- "$TMP"' EXIT
curl -sS -m 120 -A "tepic-layout-research/1.0 (three.js city sim)" -X POST -H 'Content-Type: application/json' -d '{}' \
  -o "$TMP" "https://maphub.net/json/map_load/$MAP"
# Keep the GeoJSON and the map's name & version only (the rest is the viewer's settings)
node -e '
  const fs = require("node:fs");
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!d.success || !d.geojson || !Array.isArray(d.geojson.features)) { console.error("unexpected response"); process.exit(1); }
  const out = { name: d.name, url: d.url, version: d.latest_map_version, geojson: d.geojson };
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  console.log(`${d.geojson.features.length} routes in ${(d.geojson.groups || []).length} groups, version ${d.latest_map_version}`);
' "$TMP" semovi_routes.json
