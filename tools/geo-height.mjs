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

// Estimated storeys by OSM `building` type, as a piecewise table [[footprint m², storeys], ...]: storeys are
// interpolated on the logarithm of the footprint area between the points (held flat beyond the first and last), so
// untagged buildings vary with their real footprints instead of sharing one default height.
//
// Calibration (2026-10): medians of measured heights for 2,234 OSM footprints in the 2 km box around Taipei 101,
// compared locally with the 智慧城市3D臺北 building models (tools/validate-heights.mjs; those heights are not
// redistributed). Points with enough measured buildings come from those medians, e.g.
//   apartments  ~170 m²: 6 storeys (769 buildings: the old 5–6 storey walk-ups), ~550 m²: 13, ~1,700 m²: 16
//   residential ~60 m²: 4, ~170 m²: 5, ~550 m²: 6;   house (mostly townhouses here) ~170 m²: 5
//   commercial  ~550 m²: 14, ~1,700 m²: 24, ~5,000 m²: 31;   yes ~60 m²: 3, ~170 m²: 5, ~550 m²: 8
// The first version, a log-linear curve per type fitted in the 1 km Xinyi core, overestimated the older districts
// (median estimate 1.29 × measured, 7.6 m off); the table brings the 2 km box to a 5.1 m median error with a median
// ratio of 1.07, close to heights from storey counts (4.0 m). Types with few measured examples keep typical building
// programmes. Other districts need their own check.
export const ESTIMATE_TIERS = {
  house: [[60, 4], [300, 5]], detached: [[60, 1], [300, 2]], semidetached_house: [[60, 2], [300, 3]], terrace: [[60, 2], [300, 4]],
  hut: [[10, 1]], shed: [[10, 1]], garage: [[10, 1]], garages: [[10, 1]], kiosk: [[10, 1]], toilets: [[10, 1]],
  outbuilding: [[10, 1]], service: [[10, 1]], construction: [[10, 1]],
  residential: [[60, 4], [173, 5], [548, 6]],
  apartments: [[60, 6], [173, 6], [548, 13], [1732, 16], [5000, 25]],
  retail: [[300, 2], [1000, 4], [5000, 17]], supermarket: [[300, 1], [5000, 3]], department_store: [[1000, 4], [10000, 12]],
  commercial: [[173, 10], [548, 14], [1732, 24], [5000, 31]], office: [[300, 8], [548, 10], [1732, 15], [5000, 19]],
  hotel: [[300, 8], [1000, 18], [3000, 25]], hospital: [[500, 6], [1732, 8], [5000, 18]],
  school: [[60, 1], [548, 5], [1732, 7]], university: [[300, 3], [1732, 8], [5000, 9]], college: [[300, 3], [5000, 6]],
  public: [[100, 1], [3000, 8]], civic: [[100, 2], [3000, 8]], government: [[200, 3], [3000, 12]],
  industrial: [[200, 1], [5000, 3]], warehouse: [[200, 1], [5000, 2]],
  yes: [[60, 3], [173, 5], [548, 8], [1732, 8], [5000, 19]] // unspecified type: anything from a kiosk to a tower podium
};
const DEFAULT_TIER = ESTIMATE_TIERS.yes;
const ROOF_M = 4; // canopy top when a roof-only structure has no height tags
const ROOF_SLAB_M = 0.6; // thickness of a roof-only structure's slab

// Estimated height (m) of an untagged building of OSM type `type` with footprint area `area` m².
export function estimateHeight(type, area) {
  if (type === 'roof') return ROOF_M;
  const pts = ESTIMATE_TIERS[type] || DEFAULT_TIER;
  const a = Math.max(area, 1);
  let storeys = pts[pts.length - 1][1];
  if (a <= pts[0][0]) storeys = pts[0][1];
  else {
    for (let i = 1; i < pts.length; i++) {
      const [a0, l0] = pts[i - 1], [a1, l1] = pts[i];
      if (a <= a1) { storeys = l0 + ((l1 - l0) * Math.log(a / a0)) / Math.log(a1 / a0); break; }
    }
  }
  return Math.max(1, Math.round(storeys)) * LEVEL_M;
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
