// js/sim/traffic-demand.js
// How much traffic and how many people a street gets, by its class and the hour (traffic.js spawns by it). Tepic's
// traffic is on its avenues (Insurgentes, México, Allende, the Libramiento...): the colonias' streets, 85% of the
// road graph by length, see a car now and then. It has three rushes: 7-10 h (to school and work), 13-15 h (out of
// school, the midday meal at home) and 17-19 h (home from work), and the town is all but empty after midnight.
// (Nayarit had 578 284 motor vehicles registered in 2024, INEGI's VMRC; Tepic, with a third of the state's people,
// roughly 200 000 of them by that share.) No three.js, so node --test imports it directly (tests/traffic-demand.test.mjs).

// The road classes: 0 a colonia's street, 1 a collector (a wider street: OpenStreetMap's tertiary & secondary, 8-12 m
// curb to curb), 2 an avenue (road-network.js's 'ave': named, wide or with three lanes or more)
const LOCAL = 0;
const COLLECTOR = 1;
const AVENUE = 2;
// half width (both ways) from which a street counts as a collector: a residential street is 7.4 m across
const COLLECTOR_HALF = 4.25;

// At the busiest hour, vehicles per lane-km moving on each class (an avenue in the rush is about level of service D:
// a car every ~45 m of lane), and people per km of sidewalk
const CARS_PER_LANE_KM = [1.4, 8, 22];
const PEOPLE_PER_SIDEWALK_KM = [3, 12, 34];
// In the rush the avenues fill up more than the side streets (everyone is crossing town on them)
const RUSH_AVENUE_BOOST = 0.3;

// At a junction a driver turns onto a road by its class's pull over the one it is on: off an avenue into a colonia's
// street one time in six it would otherwise, from a side street onto an avenue six times as readily
const ROUTE_PULL = [1, 2.5, 6];

// The avenues busier than their width says, by name (OpenStreetMap's), × their class's density: Tepic's two spines,
// Insurgentes (east-west, the Centro to the Libramiento) and México (north-south through the Centro). A first guess,
// to tune by what one sees of them at rush hour (Google's traffic can be looked at, not copied into the game).
const BUSY_ROADS = [
  [/Insurgentes/i, 1.4],
  [/^(Avenida|Av\.?) M[eé]xico/i, 1.3]
];
function busyFactor(name) {
  if (!name) return 1;
  for (const [re, k] of BUSY_ROADS) if (re.test(name)) return k;
  return 1;
}

// Share of the busiest hour's traffic and crowds at each hour's start (local time, linear in between)
const CAR_HOURS = [
  0.10, 0.07, 0.05, 0.05, 0.06, 0.14, 0.40, 0.90, 1.00, 0.95, 0.72, 0.64,
  0.75, 0.95, 1.00, 0.90, 0.78, 0.95, 1.00, 0.92, 0.70, 0.50, 0.32, 0.18
];
const PEOPLE_HOURS = [
  0.06, 0.04, 0.03, 0.03, 0.04, 0.08, 0.30, 0.75, 0.80, 0.70, 0.70, 0.80,
  0.90, 1.00, 0.95, 0.80, 0.75, 0.85, 0.90, 0.85, 0.65, 0.45, 0.25, 0.12
];

function hourly(table, hour) {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const k = h - i;
  return table[i] * (1 - k) + table[(i + 1) % 24] * k;
}

// A directed road graph edge's class (road-network.js: axis, and half its curb-to-curb width)
function roadClass(e) {
  if (e.axis === 'ave') return AVENUE;
  return e.half >= COLLECTOR_HALF ? COLLECTOR : LOCAL;
}

const carDemand = (hour) => hourly(CAR_HOURS, hour);
const peopleDemand = (hour) => hourly(PEOPLE_HOURS, hour);

// How far into a rush hour it is: 0 off-peak (under 85% of the busiest), 1 at the busiest
const rushOf = (hour) => Math.max(0, Math.min(1, (carDemand(hour) - 0.85) / 0.15));

// Vehicles per lane-km on a road of class c at `hour`
function carDensity(c, hour) {
  return CARS_PER_LANE_KM[c] * carDemand(hour) * (c === AVENUE ? 1 + RUSH_AVENUE_BOOST * rushOf(hour) : 1);
}

// People per sidewalk-km along a road of class c at `hour`
function peopleDensity(c, hour) {
  return PEOPLE_PER_SIDEWALK_KM[c] * peopleDemand(hour);
}

/**
 * The hour (0-24, fractional) of a Date in a time zone, Tepic's by default (America/Mazatlan, UTC-7 all year since
 * Mexico dropped daylight saving time in 2022). Falls back to UTC-7 where the time zone isn't known.
 */
function localHour(date, timeZone = 'America/Mazatlan') {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const h = get('hour'), m = get('minute');
    if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) + m / 60;
  } catch {
    // (an unknown time zone)
  }
  return (((date.getTime() / 3600000 - 7) % 24) + 24) % 24;
}

export {
  LOCAL, COLLECTOR, AVENUE, CARS_PER_LANE_KM, PEOPLE_PER_SIDEWALK_KM, ROUTE_PULL, BUSY_ROADS,
  roadClass, busyFactor, carDemand, peopleDemand, rushOf, carDensity, peopleDensity, localHour
};
