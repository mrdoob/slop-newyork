// tools/geo-building-style.mjs
// Roof form and facade style of an OSM building, for footprint-extruded cities (tools/build-taipei-geodata.mjs).
//
// roofOf(tags, area, top, base) -> { shape, height, colour }
//   shape: one of ROOF_SHAPES (OSM roof:shape; unsupported shapes draw flat). height (m) from roof:height, else
//   roof:levels × LEVEL_M, else a default from the footprint size (labelled in the code below: roof heights are
//   rarely tagged, so a tagged shape with no height gets a proportionate one). OSM `height` includes the roof, so the
//   walls stop at top - height.
// facadeOf(tags, kind, top, base) -> one of FACADES, from the building type, material and height. A style hint for
//   the renderer, inferred from tags: not a survey of the real facade.

import { LEVEL_M, parseMetres } from './geo-height.mjs';

export const ROOF_SHAPES = ['flat', 'pyramidal', 'hipped', 'dome', 'onion'];
export const FACADES = [
  'punched', // load-bearing walls with rows of windows & balcony slabs: apartments, houses, schools, default
  'curtain', // glass curtain wall: office / commercial towers, building:material glass or mirror
  'podium', // wide window bands: retail, malls, department stores, low commercial
  'plain', // few or no windows: industrial, warehouses, garages, service, construction
  'none' // no facade: roof-only structures (canopies)
];

const ROOF_ALIASES = { pyramid: 'pyramidal', hip: 'hipped', 'half-hipped': 'hipped', side_hipped: 'hipped', domed: 'dome' };

export function roofOf(tags, area, top, base) {
  const raw = (tags['roof:shape'] || 'flat').toLowerCase();
  const shape = ROOF_SHAPES.includes(ROOF_ALIASES[raw] || raw) ? ROOF_ALIASES[raw] || raw : 'flat';
  const colour = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/i.test(tags['roof:colour'] || '') ? tags['roof:colour'].toLowerCase() : 0;
  if (shape === 'flat') return { shape, height: 0, colour };
  let height = parseMetres(tags['roof:height']);
  if (height == null && parseFloat(tags['roof:levels']) > 0) height = parseFloat(tags['roof:levels']) * LEVEL_M;
  if (height == null) {
    // Untagged roof height (an estimate): domes rise by the radius of the footprint's equal-area circle, pitched roofs
    // by a third of it, never more than 6 m (pitched) and never more than 40% of the building
    const r = Math.sqrt(area / Math.PI);
    height = shape === 'dome' || shape === 'onion' ? r : Math.min(6, r / 3);
  }
  return { shape, height: Math.max(0, Math.min(height, (top - base) * 0.4)), colour };
}

const CURTAIN_KINDS = new Set(['office', 'commercial', 'hotel', 'government']);
const PODIUM_KINDS = new Set(['retail', 'department_store', 'supermarket', 'mall', 'civic', 'train_station', 'transportation']);
const PLAIN_KINDS = new Set(['industrial', 'warehouse', 'garage', 'garages', 'service', 'construction', 'shed', 'hut', 'parking', 'carport']);

export function facadeOf(tags, kind, top, base) {
  if (kind === 'roof' || kind === 'carport') return 'none';
  const material = (tags['building:material'] || tags['building:facade:material'] || '').toLowerCase();
  if (material === 'glass' || material === 'mirror') return 'curtain';
  if (PLAIN_KINDS.has(kind)) return 'plain';
  if (PODIUM_KINDS.has(kind)) return top - base > 40 ? 'curtain' : 'podium';
  if (CURTAIN_KINDS.has(kind)) return top - base > 30 ? 'curtain' : 'podium';
  // Unspecified type ('yes', building parts): towers read as curtain walls, low wide blocks as podiums
  if (kind === 'yes' && top - base > 60) return 'curtain';
  return 'punched';
}
