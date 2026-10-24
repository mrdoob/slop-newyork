#!/bin/bash
cd "$(dirname "$0")"
set -u
for q in roads land pois buildings; do
  echo "=== $q $(date +%T)"
  bash ../../overpass.sh osm_tepic_$q.json q_$q.overpassql 6
done
echo "=== done $(date +%T)"
