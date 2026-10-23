// tools/geo-height.mjs
// Building heights from OpenStreetMap tags, for footprint-extruded cities (tools/build-taipei-geodata.mjs).
//
// buildingHeight(tags, area) returns { top, base, source } in metres above ground:
//   1. `height` tag                      -> top as tagged                          source 'height'
//   2. `building:levels`                 -> levels × LEVEL_M                       source 'levels'
//   3. neither                           -> estimateHeight(type, area)             source 'estimate'
// `min_height` / `building:min_level` lift the base (building:part tiers, canopies); roof-only structures
// (building=roof / building:part=roof) are thin slabs under their top.
//
// ESTIMATES ARE NOT DATA. Most footprints in OSM carry neither `height` nor `building:levels`; estimateHeight() is the
// one place a height is inferred for them, and every inferred height is marked source 'estimate' all the way to the
// renderer. Replace this function with a real height dataset when one is available.

export const LEVEL_M = 3.2; // storey height (floor to floor) used to turn level counts into metres

// Estimated storeys by OSM `building` type: [levels at footprint ≤ a0 m², levels at footprint ≥ a1 m², a0, a1].
// Storeys grow with the logarithm of the footprint area between the two ends (bigger plots carry taller buildings),
// so untagged buildings vary with their real footprints instead of sharing one default height.
// Calibrated on the tagged buildings of Taipei's Xinyi district (1 km box around Taipei 101, OSM 2026-10):
//   apartments  100–300 m²: median 22 m (7 storeys), 300–1000 m²: 42 m (13), 1000–3000 m²: 54 m (17)
//   commercial  300–1000 m²: 42 m, 1000–3000 m²: 99 m;   residential: 9–18 m;   yes < 100 m²: 3 m, 100–300 m²: 9 m
// Types without tagged examples (retail, school, office, hospital) follow typical building programmes. Office and
// hospital rise tallest, houses and retail stay low.
export const ESTIMATE_TIERS = {
  house: [1, 2, 60, 300], detached: [1, 2, 60, 300], semidetached_house: [2, 3, 60, 300], terrace: [2, 4, 60, 300],
  hut: [1, 1, 10, 100], shed: [1, 1, 10, 100], garage: [1, 1, 10, 100], garages: [1, 1, 10, 100], kiosk: [1, 1, 10, 100],
  toilets: [1, 1, 10, 100], outbuilding: [1, 1, 10, 100], service: [1, 1, 10, 100], construction: [1, 1, 10, 100],
  residential: [3, 6, 80, 1000],
  apartments: [5, 17, 100, 2000],
  retail: [1, 6, 100, 5000], supermarket: [1, 3, 300, 5000], department_store: [4, 10, 1000, 10000],
  commercial: [4, 25, 150, 3000], office: [6, 30, 300, 3000], hotel: [6, 25, 300, 3000],
  hospital: [6, 15, 500, 5000], school: [3, 5, 300, 5000], university: [3, 8, 300, 5000], college: [3, 6, 300, 5000],
  public: [2, 8, 100, 3000], civic: [2, 8, 100, 3000], government: [3, 10, 200, 3000],
  industrial: [1, 3, 200, 5000], warehouse: [1, 2, 200, 5000],
  yes: [1, 6, 50, 1500] // unspecified type: anything from a kiosk to a mid-rise
};
const DEFAULT_TIER = ESTIMATE_TIERS.yes;
const ROOF_M = 4; // canopy top when a roof-only structure has no height tags
const ROOF_SLAB_M = 0.6; // thickness of a roof-only structure's slab

// Estimated height (m) of an untagged building of OSM type `type` with footprint area `area` m².
export function estimateHeight(type, area) {
  if (type === 'roof') return ROOF_M;
  const [l0, l1, a0, a1] = ESTIMATE_TIERS[type] || DEFAULT_TIER;
  const t = Math.min(1, Math.max(0, Math.log(Math.max(area, 1) / a0) / Math.log(a1 / a0)));
  return Math.round(l0 + (l1 - l0) * t) * LEVEL_M;
}

// OSM length value in metres ("30", "93.2m", "93.2 m", "100'", "100 ft"); null when absent or unreadable
export function parseMetres(v) {
  if (v == null) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|ft|'|)\s*$/i.exec(String(v));
  if (!m) return null;
  const x = parseFloat(m[1]);
  return m[2] === 'ft' || m[2] === "'" ? x * 0.3048 : x;
}
const parseCount = (v) => {
  const x = v == null ? NaN : parseFloat(v);
  return Number.isFinite(x) && x >= 0 ? x : null;
};

// `type` is the building's kind: the `building:part` value for parts, else the `building` value
export function buildingHeight(tags, area, type = tags.building || tags['building:part'] || 'yes') {
  const roof = type === 'roof';
  let top = parseMetres(tags.height), source = 'height';
  if (top == null || top <= 0) {
    const levels = parseCount(tags['building:levels']);
    if (levels != null && levels > 0) { top = levels * LEVEL_M; source = 'levels'; }
    else { top = estimateHeight(type, area); source = 'estimate'; }
  }
  let base = parseMetres(tags.min_height);
  if (base == null) {
    const minLevel = parseCount(tags['building:min_level']);
    base = minLevel != null ? minLevel * LEVEL_M : roof ? Math.max(0, top - ROOF_SLAB_M) : 0;
  }
  if (!(base < top)) base = Math.max(0, top - ROOF_SLAB_M);
  return { top, base, source };
}
