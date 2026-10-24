# Progress and resume notes

Where the Taipei port stands, how to pick it up again, and what is still open. Last updated 2026-10-25. Design decisions and per-feature details live in `CLAUDE.md`; this file is the short version for resuming.

## Where things stand

Three areas build and run in the viewer (`index.html`, served over http):

| Area | URL | What it covers |
|---|---|---|
| `xinyi` (default) | `/` | the whole of Xinyi District, origin Taipei 101 |
| `city` | `/?area=city` | Xinyi + Da'an Districts in one world |
| `wanhua` | `/?area=wanhua` | 1 km box around Lungshan Temple (old district) |

New York still runs at `nyc.html`.

Done so far, by commit (newest first):

| Commit | What |
|---|---|
| (this commit) | Road widths carried along the same street (Songzhi / Songshou Rd by Taipei 101 no longer neck down), widening kept off mapped verges, signal poles kept out of carriageways |
| `138b369` | Taipei house-number points (門牌, OGDL): heights from floors named at doors; stand-ins only by doors, shown by default |
| `26e5475` | Elevated roads as viaducts (Civic Blvd, Jianguo, Keelung Rd); Keelung Road underpass ramps in a trench |
| `4139324` | MRT piers / stations fixed; curved-road shape bug; dual-carriageway widths kept off the median |
| `c4ea898` | Taiwan-style traffic signals (horizontal heads, countdowns, 小綠人); MRT track and stations |
| `f22b6fd` | Da'an District (`city` area); viewer memory halved |
| `55b97a2` | Hill terrain (SRTM); flat basin |
| `e95c880` | Whole Xinyi District; building-permit footprints |
| earlier | UFO / rocket, phones, walk / bike / car / plane, minimap, day / night, Wanhua box, stand-ins, overlay |

Data quality (local check against Taipei's 3D city model; that model is not open, so only these aggregate numbers are
kept, never its data):

| | Xinyi District | Xinyi + Da'an | Wanhua box |
|---|---|---|---|
| Heights still estimated | 16% (was 53%) | 11% (was 34%) | ~20% |
| Door-floor heights vs measured | 1.1 m median error, 1.0× | 1.1 m, 1.0× | 1.8 m, 1.0× |
| Remaining estimates vs measured | 6 m, 1.4× too tall | 6.6 m, 1.35× | 8.5 m, 1.5× |
| Missing buildings under a stand-in | 41% (54% within 4 m) | not computed | 59% |
| Stand-ins on open ground | 14% | 12% | 4% |

Performance (headless Chrome on the dev Mac; mean over 300 frames): Xinyi about 27 ms per frame, Xinyi + Da'an about
43 ms. JS heap after load: Xinyi about 140 MB, Xinyi + Da'an about 290 MB.

## How to resume

```
export PATH=~/.nvm/versions/node/v23.4.0/bin:$PATH
node --test tests/*.test.mjs tests/*.test.cjs        # 124 tests, all passing at 138b369
GEO_AREA=xinyi node tools/build-taipei-geodata.mjs   # also: city, wanhua (city takes ~30 s)
python3 -m http.server 8123 --bind 127.0.0.1         # then open http://127.0.0.1:8123/
```

Inputs are committed (OSM downloads, permits, door points, terrain tiles), so the build works offline. To refresh:

- OSM: `bash tools/overpass.sh tools/data-taipei/<area>/osm_<kind>.json tools/data-taipei/<area>/q_<kind>.overpassql`
- Permits: SHP from data.gov.tw 151936 into `tools/data-local/permits/`, then `node tools/extract-permits.mjs`
- Doors: the 125 MB CSV from data.gov.tw 155472 into `tools/data-local/addresses/taipei-addresses.csv` (don't put a
  time limit on the download: a 300 s curl limit once cut it in half), then `node tools/extract-addresses.mjs`

Local-only checks (git-ignored `tools/data-local/`, never committed): `node tools/validate-heights.mjs` (per area,
`GEO_AREA=...`) and `node tools/gap-tasks.mjs`.

## Rules to keep (from earlier decisions)

- Taipei UDD LOD1 / 3d.taipei data and NLSC aerial photos (PHOTO2) are not openly licensed: local checks or viewing
  only. Never commit them, write them into `js/*-geodata.js`, or trace from them. Before each commit:
  `git diff --cached --name-only | grep -c data-local` must print 0.
- Inferred things stay labelled: estimated heights, stand-ins (`GEO.infill`), viaduct and trench heights.
- `js/*-geodata.js` is build output: change the inputs or `tools/`, then rebuild.
- Commits happen only when the owner approves. At `138b369`, main matched origin/main (sc0Vu/slop-taipei on GitHub).

## Open questions and next steps

1. **NLSC per-building outlines (`BUILDX`, 臺灣通用電子地圖加值分棟建物框).** This would fill nearly every missing
   building with a real outline, but only the e-map's small-scale layers (EMAP5/6_OPENDATA) are labelled open data. The
   terms don't mention derived works. Treated as view only until NLSC confirms in writing that vectorising it is allowed.
2. **Retune the remaining estimates.** The buildings still estimated (those without doors) run 1.35–1.5× too tall.
   Rerun `validate-heights.mjs` and refit `ESTIMATE_TIERS` for that group.
3. **Frame rate in Xinyi + Da'an** (~43 ms): the GPU draws ~3.5 M triangles. Candidates: per-district mesh chunks with
   frustum culling, lower-detail far buildings.
4. **Traffic on the viaducts.** Elevated roads are drawn but not driven; cars stay on the street. Trains on the
   Wenhu line would also be new.
5. **Test on a real phone.** Only an emulated phone was tested.
6. **Next district:** the plan is to grow the city one district at a time, checking looks, data quality and frame
   rate each time.
