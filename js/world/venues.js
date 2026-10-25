// js/world/venues.js
// Tepic's eating & drinking places, read off the shop signs the city data puts on the real buildings (city-geodata.js
// `houses` & `signs`, from Overture Maps' places): the taquerías and burger stands that open at dusk, the restaurants
// and marisquerías, the cantinas and bars, the antros. Plain data (no three.js): the street food stalls, the night
// life and the interiors (street-food.js, nightlife.js, interiors.js) all start from findVenues().
// Each venue: { kind, name, house (index into houses), x, z (its door on the street front, at the sidewalk), nx, nz
// (out of the door, towards the street), ax, az (along the front, to the right seen from the street), width (m of
// front), depth (m), heading (yaw facing out of the door) }.

// What each kind serves and when it is open (hours, local time; `close` past midnight wraps)
const VENUE_KINDS = {
  tacos: { label: 'Taquería', open: 19, close: 2, food: true, night: true },
  burger: { label: 'Hamburguesas', open: 18, close: 1, food: true, night: true },
  restaurant: { label: 'Restaurante', open: 8, close: 23, food: true, night: false },
  seafood: { label: 'Marisquería', open: 10, close: 19, food: true, night: false },
  bar: { label: 'Bar', open: 17, close: 3, food: false, night: true },
  disco: { label: 'Antro', open: 22, close: 4, food: false, night: true }
};

// The sign's text → its kind (generic trade signs and real names alike); first match wins
const KIND_RULES = [
  [/CLUB DE NUTRICI|GORRA|BARBER|BARAT|BARRA DE|BARRO|EQUIPOS|ABARROT|SALÓN DE BELLEZA|SALON DE BELLEZA|BOUTIQUE|SPA\b/, null],
  [/DISCO|ANTRO|NIGHT ?CLUB|\bCLUB\b|LOUNGE|TAPANKO|TAPANCO/, 'disco'],
  [/CANTINA|\bBAR\b|BAR\b|CERVECER|MICHELAD|BOTANER|PULQUER/, 'bar'],
  [/TACO|BIRRIA|POZOLE|TORTAS AHOGADAS|ELOTE|HOT ?DOG|CARNITAS|LONCHER/, 'tacos'],
  [/HAMBURGUES|BURGER|PIZZ/, 'burger'],
  [/MARISC|OSTION|JAIBA|PESCADO|CEVICHE|ZARANDEAD/, 'seafood'],
  [/RESTAURANT|COMEDOR|COCINA|FONDA|CAF[EÉ]|POLLOS ASADOS/, 'restaurant']
];

function venueKind(text) {
  const t = String(text || '').toUpperCase();
  for (const [re, kind] of KIND_RULES) if (re.test(t)) return kind;
  return null;
}

// Open at `hour` (0..24, fractional)? Hours past midnight belong to the night before
function isOpen(kind, hour) {
  const k = VENUE_KINDS[kind];
  if (!k) return false;
  const h = ((hour % 24) + 24) % 24;
  return k.open < k.close ? h >= k.open && h < k.close : h >= k.open || h < k.close;
}

// The place's name: its sign's, in title case (a trade's generic sign names its trade: Lonchería, Birria, Cantina),
// tacos & mariscos as the places that serve them
const GENERIC = new Set(['TACOS', 'BIRRIA', 'LONCHERÍA', 'HAMBURGUESAS', 'RESTAURANTE', 'MARISCOS', 'CANTINA', 'POLLOS ASADOS', 'CAFÉ', 'TORTAS AHOGADAS']);
const TRADE_NAMES = { TACOS: 'Taquería', MARISCOS: 'Marisquería' };
function venueName(text) {
  const t = String(text || '').trim();
  if (TRADE_NAMES[t]) return TRADE_NAMES[t];
  return t.toLowerCase().replace(/(^|[\s"(¡¿-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

/**
 * Places that are no shop sign in the city data, or whose sign names a neighbour: placed by hand on the nearest
 * building (within 15 m) to their spot. The Tapanko (TPK Tepic), an antro on the Periférico Libramiento in Los Sauces
 * (Reserva Territorial), by La Jaiba Loka and the motels Flamingos & Barcelona (its pin on Google Maps)
 */
const NAMED_VENUES = [
  { name: 'Tapanko TPK', kind: 'disco', x: 3959, z: 4007.5, tapanco: true }
];

// A house of city-geodata.js (stride integers) as numbers in metres & radians
function decodeHouse(houses, i) {
  return {
    cx: houses[i] / 10, cz: houses[i + 1] / 10, w: houses[i + 2] / 10, d: houses[i + 3] / 10,
    th: houses[i + 4] / 1000, floors: houses[i + 5], kindBits: houses[i + 6], front: houses[i + 6] & 3, sign: houses[i + 7] || 0
  };
}

/**
 * The door of a house on its street front (front side 0..3 = local -x, +x, -z, +z, buildings.js), stepped `out` m
 * out of the wall onto the sidewalk: { x, z, nx, nz, ax, az, width, depth, heading }
 */
function frontDoor(h, out = 0.6) {
  const ou = h.front === 0 ? -1 : h.front === 1 ? 1 : 0;
  const ov = h.front === 2 ? -1 : h.front === 3 ? 1 : 0;
  const cs = Math.cos(h.th), sn = Math.sin(h.th);
  // world = c + (u cs + v sn, -u sn + v cs)
  const toW = (u, v) => [u * cs + v * sn, -u * sn + v * cs];
  const half = ou ? h.w / 2 : h.d / 2;
  const [nx, nz] = toW(ou, ov);
  const [px, pz] = toW(ou * h.w / 2, ov * h.d / 2);
  // along the front, to the right of someone standing in the street looking at it (facing -n: right = (-n) × up)
  const ax = nz, az = -nx;
  return {
    x: h.cx + px + nx * out, z: h.cz + pz + nz * out, nx, nz, ax, az,
    width: ou ? h.d : h.w, depth: ou ? h.w : h.d, half, heading: Math.atan2(nx, nz)
  };
}

/**
 * Every venue of the city data: the houses whose sign reads as one of VENUE_KINDS, and the NAMED_VENUES. `stride`:
 * integers per house (city-geodata.js houseStride)
 */
function findVenues(houses, signs, stride = 8) {
  const out = [];
  const claimed = new Map();
  for (const nv of NAMED_VENUES) {
    let best = -1, bd = 15;
    for (let i = 0; i + 7 < houses.length; i += stride) {
      const d = Math.hypot(houses[i] / 10 - nv.x, houses[i + 1] / 10 - nv.z);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) claimed.set(best, nv);
  }
  for (let i = 0; i + 7 < houses.length; i += stride) {
    const named = claimed.get(i);
    const sign = houses[i + 7] ? signs[houses[i + 7] - 1] : null;
    if (!named && (!sign || sign.chain)) continue;
    const kind = named ? named.kind : venueKind(sign.text);
    if (!kind) continue;
    const h = decodeHouse(houses, i);
    if (h.kindBits & 8 && !named) continue; // (a hall's own name: a supermarket, a warehouse)
    const door = frontDoor(h);
    out.push({
      kind, name: named ? named.name : venueName(sign.text), house: i / stride, floors: h.floors,
      tapanco: !!(named && named.tapanco), generic: !named && GENERIC.has(sign.text), ...door
    });
  }
  return out;
}

export { VENUE_KINDS, NAMED_VENUES, venueKind, venueName, isOpen, decodeHouse, frontDoor, findVenues };
