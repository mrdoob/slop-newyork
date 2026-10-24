// Department stores, banks, beer & corner stores, fast food and gas stations: parody names in each chain's colours.
const store = (id, match, name, bg, fg, border, big = false, stripe = border) => ({
  id, match, name, sign: { bg, fg, border }, facade: { band: bg, stripe, glazing: true }, big
});
export default [
  store('chedrauy', /\bchedraui\b/i, 'CHEDRAUY', '#004b93', '#ffffff', '#f7941d', true),
  store('coppelito', /\bcoppel\b/i, 'COPPELITO', '#ffd100', '#003a70', '#003a70', true),
  store('elektron', /\belektra\b/i, 'ELEKTRÓN', '#ffd200', '#c8102e', '#c8102e', true),
  store('liverpul', /\bliverpool\b/i, 'LIVERPUL', '#e10098', '#ffffff', '#ffffff', true),
  store('suburbios', /\bsuburbia\b/i, 'SUBURBIOS', '#6d2077', '#ffffff', '#ffffff', true),
  store('casa-depot', /\bhome depot\b/i, 'CASA DEPOT', '#f96302', '#ffffff', '#ffffff', true),
  store('samys-club', /\bsam'?s club\b/i, "SAMY'S CLUB", '#0067a0', '#ffffff', '#ffffff', true),
  store('modelorrama', /\bmodelorama\b/i, 'MODELORRAMA', '#0a2a5e', '#ffd100', '#ffd100'),
  store('kioskito', /\bkiosko\b/i, 'KIOSKITO', '#e30613', '#ffe600', '#ffe600'),
  store('pemez', /\bpemex\b/i, 'PEMEZ', '#006847', '#ffffff', '#ce1126'),
  store('bbvah', /\bbbva\b/i, 'BBVAH', '#004481', '#ffffff', '#ffffff'),
  store('banorti', /\bbanorte\b/i, 'BANORTI', '#eb0029', '#ffffff', '#ffffff'),
  store('burguer-quing', /\bburger king\b/i, 'BURGUER QUING', '#d62300', '#f5ebdc', '#f5ebdc'),
  store('little-cesar', /\blittle caesars\b/i, 'LITTLE CÉSAR', '#ff6900', '#ffffff', '#ffffff'),
  store('subguey', /\bsubway\b/i, 'SUBGÜEY', '#008c15', '#ffc600', '#ffc600')
];
