#!/bin/bash
# Downloads Overture Maps building footprints & places for Tepic and Xalisco into tools/data/tepic/overture/
# (~120 MB, not committed). Needs the Overture CLI: pip install overturemaps
# Buildings: OpenStreetMap + Microsoft & Google ML footprints (ODbL); places: CDLA-Permissive-2.0.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p overture
BBOX=-104.985,21.390,-104.785,21.580
overturemaps download --bbox=$BBOX -f geojsonseq -t building -o overture/buildings.geojsonl
overturemaps download --bbox=$BBOX -f geojsonseq -t place -o overture/places.geojsonl
wc -l overture/*.geojsonl
