// Pharmacy chains, each under its parody name: glazed fronts under a band in the chain's colours.
export default [
  {
    id: 'farmacias-guanatos',
    match: /farmacias? guadalajara/i,
    name: 'FARMACIAS GUANATOS',
    sign: { bg: '#00529b', fg: '#ffffff', border: '#e2231a' },
    facade: { band: '#00529b', stripe: '#e2231a', glazing: true }
  },
  {
    id: 'farmacias-del-ahorrito',
    match: /farmacias? del ahorro/i,
    name: 'FARMACIAS DEL AHORRITO',
    sign: { bg: '#003b71', fg: '#ffffff', border: '#e30613' },
    facade: { band: '#003b71', stripe: '#e30613', glazing: true }
  },
  {
    id: 'farmacias-benavidos',
    match: /farmacias? benavides/i,
    name: 'FARMACIAS BENAVIDOS',
    sign: { bg: '#00539b', fg: '#ffffff', border: '#ffffff' },
    facade: { band: '#00539b', stripe: '#ffffff', glazing: true }
  },
  {
    id: 'farmacias-similarcitos',
    match: /farmacias? (de )?similares/i,
    name: 'FARMACIAS SIMILARCITOS',
    sign: { bg: '#0077c8', fg: '#ffffff', border: '#ffd100' },
    facade: { band: '#0077c8', stripe: '#ffd100', glazing: true }
  }
];
