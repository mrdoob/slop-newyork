// js/sim/crime-rules.js
// The rules of the street, GTA-style: the wanted level (heat from crimes, one to five stars, lost by staying out of the
// police's sight), the gangs' turf across the town, and how many police each star sends. No three.js, so node --test
// imports it directly (tests/crime-rules.test.mjs). crime.js plays them out.

// Heat at which each star is reached (index = stars)
const STAR_HEAT = [0, 10, 60, 150, 320, 560];
const MAX_HEAT = 800;
// Heat each crime adds when it is reported. Running someone over always gets reported (someone calls it in): the
// first one is a star, the third two.
const CRIME_HEAT = {
  runOver: 22,
  punch: 12,
  shootPed: 35,
  shootCar: 5,
  gunfire: 3,
  carjack: 15,
  hitCop: 70,
  shootCop: 110,
  killCop: 170,
  explosion: 45,
  stealCop: 60
};

// The police each star sends after the player: officers on foot and patrol cars
const POLICE = {
  foot: [0, 2, 3, 4, 5, 6],
  cruisers: [0, 1, 2, 3, 4, 5],
  shoots: [false, false, true, true, true, true], // one star: they only come to arrest
  weapon: [null, null, 'pistol', 'pistol', 'smg', 'smg'],
  speed: [0, 15, 18, 21, 24, 27] // m/s the patrol cars drive at
};

// Seconds out of the police's sight it takes to lose a star
const evadeTime = (stars) => 10 + stars * 5;

const starsFor = (heat) => {
  let stars = 0;
  for (let i = 1; i < STAR_HEAT.length; i++) if (heat >= STAR_HEAT[i]) stars = i;
  return stars;
};

class Wanted {
  constructor() {
    this.clear();
  }

  clear() {
    this.heat = 0;
    this.stars = 0;
    this.unseen = 0; // s since the police last saw the player
  }

  // A crime of `kind` (CRIME_HEAT); unwitnessed crimes go unpunished. Returns the stars gained.
  report(kind, witnessed = true) {
    if (!witnessed || !Object.hasOwn(CRIME_HEAT, kind)) return 0;
    const before = this.stars;
    this.heat = Math.min(MAX_HEAT, this.heat + CRIME_HEAT[kind]);
    this.stars = Math.max(this.stars, starsFor(this.heat));
    this.unseen = 0;
    return this.stars - before;
  }

  // Stars stay while the police can see the player; out of sight long enough, they drop one at a time
  update(dt, seen) {
    if (this.stars === 0) {
      this.heat = Math.max(0, this.heat - dt * 2);
      return;
    }
    this.unseen = seen ? 0 : this.unseen + dt;
    if (this.unseen >= evadeTime(this.stars)) {
      this.stars--;
      this.heat = this.stars ? STAR_HEAT[this.stars] : 0;
      this.unseen = 0;
    }
  }

  // 0..1: how close the player is to losing the next star (for the HUD's flashing stars)
  get evading() {
    return this.stars ? Math.min(1, this.unseen / evadeTime(this.stars)) : 0;
  }
}

// Two gangs share the town's turf: Los Rojos shoot at whoever comes close, Los Verdes only at whoever starts it.
// outfit: the colours they wear (pedestrians.js OUTFIT)
const GANGS = [
  { id: 0, name: 'Los Rojos', outfit: 2, hostile: true, weapon: 'smg' },
  { id: 1, name: 'Los Verdes', outfit: 3, hostile: false, weapon: 'pistol' }
];
const TURF_CELL = 260; // m: the turf is cut in squares this big, each one a gang's or nobody's

function hash2(ix, iz) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// The gang whose turf (x, z) is in (an index into GANGS), or -1. The town centre (within 300 m of the origin, the
// plaza) belongs to nobody.
function gangTurf(x, z) {
  if (Math.hypot(x, z) < 300) return -1;
  const h = hash2(Math.floor(x / TURF_CELL), Math.floor(z / TURF_CELL));
  return h < 0.2 ? 0 : h < 0.4 ? 1 : -1;
}

export { STAR_HEAT, CRIME_HEAT, POLICE, GANGS, TURF_CELL, Wanted, starsFor, evadeTime, gangTurf };
