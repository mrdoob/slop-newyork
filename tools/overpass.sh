#!/bin/bash
# usage: overpass.sh <out.json> <query-file> [tries]
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <out.json> <query-file> [tries]" >&2
  exit 1
fi
OUT=$1; Q=$2; TRIES=${3:-12}
if ! [[ "$TRIES" =~ ^[1-9][0-9]*$ ]] || [ ! -r "$Q" ]; then
  echo "query file must be readable and tries must be a positive integer" >&2
  exit 1
fi

# Keep the previous data intact until a complete response has been validated. An adjacent
# temporary file makes the final rename atomic, including when the output is on another disk.
TMP=$(mktemp "${OUT}.tmp.XXXXXX")
trap 'rm -f -- "$TMP"' EXIT
for ((i = 1; i <= TRIES; i++)); do
  for ep in https://overpass-api.de/api/interpreter https://lz4.overpass-api.de/api/interpreter https://z.overpass-api.de/api/interpreter; do
    if code=$(curl -sS -m 240 -A "tepic-layout-research/1.0 (three.js city sim)" -o "$TMP" -w "%{http_code}" --data-urlencode "data@$Q" "$ep"); then
      if [ "$code" = "200" ] && node -e '
        const fs = require("node:fs");
        try {
          const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          if (!Array.isArray(data.elements) || data.remark) process.exit(1);
        } catch { process.exit(1); }
      ' "$TMP"; then
        mv -- "$TMP" "$OUT"
        echo "ok $ep try $i size $(wc -c < "$OUT")"
        exit 0
      fi
    fi
    echo "try $i $ep -> $code"
    sleep $((i * 4))
  done
done
echo FAILED; exit 1
