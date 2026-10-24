#!/bin/bash
# Downloads the elevation around Tepic as Terrarium PNG tiles (zoom 12, ~38 m a pixel) from the public AWS Terrain
# Tiles (Mapzen; SRTM & other open sources, see https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
# elevation (m) = R * 256 + G + B / 256 - 32768
set -euo pipefail
cd "$(dirname "$0")/terrain"
Z=12
read X0 X1 Y0 Y1 < <(node -e '
const z = 12, lon2x = (l) => Math.floor((l + 180) / 360 * 2 ** z);
const lat2y = (a) => { const r = a * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
console.log(lon2x(-105.12), lon2x(-104.66), lat2y(21.72), lat2y(21.28));')
for ((x = X0; x <= X1; x++)); do
  for ((y = Y0; y <= Y1; y++)); do
    f="${Z}_${x}_${y}.png"
    [ -s "$f" ] || curl -sSf -m 60 -o "$f" "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png"
  done
done
ls | wc -l
