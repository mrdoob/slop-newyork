// OKSO: the corner convenience store (OXXO in OpenStreetMap / Overture Maps). Glazed front between grey piers, a
// yellow-orange stripe over it and red panels above; a grey box carrying the red logo with yellow stripes; a tall red
// pole sign with the logo at the corner of the lot.
export default {
  id: 'okso',
  match: /\boxxo\b/i,
  name: 'OKSO',
  sign: { bg: '#d8232a', fg: '#ffffff', border: '#d8232a', stripe: '#f5a623' },
  facade: { band: '#d8232a', stripe: '#f5a623', glazing: true },
  pylon: { pole: '#d8232a', height: 6.5 },
  big: false
};
