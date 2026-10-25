// js/models/cars/index.js
// Every car model, from the makes' files (README.md: how to add one): by id, by body shape, and the weighted draw the
// traffic uses so that best sellers fill the streets and supercars turn up once in a long while.
import { CARS as nissan } from './nissan.js';
import { CARS as chevrolet } from './chevrolet.js';
import { CARS as volkswagen } from './volkswagen.js';
import { CARS as toyota } from './toyota.js';
import { CARS as honda } from './honda.js';
import { CARS as mazda } from './mazda.js';
import { CARS as kiaHyundai } from './kia-hyundai.js';
import { CARS as ford } from './ford.js';
import { CARS as stellantis } from './stellantis.js';
import { CARS as electric } from './electric.js';
import { CARS as premium } from './premium.js';
import { CARS as exotic } from './exotic.js';

const CAR_MODELS = [
  ...nissan, ...chevrolet, ...volkswagen, ...toyota, ...honda, ...mazda, ...kiaHyundai, ...ford, ...stellantis,
  ...electric, ...premium, ...exotic
];
const CAR_MODEL_BY_ID = Object.fromEntries(CAR_MODELS.map((m) => [m.id, m]));
const TAXI_MODEL = CAR_MODEL_BY_ID['nissan-tsuru'];
const POLICE_MODEL = CAR_MODEL_BY_ID['dodge-charger-pursuit'];

// Body colours by class when a model has none of its own (white, silver & grey cars are most of Mexico's fleet)
const PAINTS = {
  economy: [0xf2f2ee, 0xf2f2ee, 0xcfd6de, 0xcfd6de, 0x52575e, 0x1c2026, 0x9e1b22, 0x1d3b6c, 0x6e1f24],
  family: [0xf2f2ee, 0xcfd6de, 0x52575e, 0x1c2026, 0x1d3b6c, 0x6e1f24, 0x3a434d],
  truck: [0xf2f2ee, 0xcfd6de, 0x1c2026, 0x52575e, 0x6e1f24, 0x28382e],
  premium: [0x1c2026, 0xf2f2ee, 0x52575e, 0x1d3b6c],
  sport: [0xb3121b, 0x1c2026, 0xf2f2ee, 0x2a5aa8],
  super: [0xc8102e, 0xe8a200, 0x1c2026, 0xf2f2ee]
};
const paintsOf = (m) => m.paints || PAINTS[m.class] || PAINTS.economy;

// The models that drive in traffic with each body shape, and each shape's share of the traffic (its models' rarity)
const TRAFFIC_MODELS = CAR_MODELS.filter((m) => m.traffic !== false && m.rarity > 0);
const BY_BODY = {};
for (const m of TRAFFIC_MODELS) (BY_BODY[m.body] ??= []).push(m);
const BODY_SHARE = Object.fromEntries(Object.entries(BY_BODY).map(([body, list]) => [body, list.reduce((s, m) => s + m.rarity, 0)]));

// A model with this body shape, drawn by rarity (rand: 0..1)
function pickModel(body, rand = Math.random()) {
  const list = BY_BODY[body];
  if (!list) return body === 'taxi' ? TAXI_MODEL : null;
  let r = rand * BODY_SHARE[body];
  for (const m of list) {
    r -= m.rarity;
    if (r < 0) return m;
  }
  return list[list.length - 1];
}

// A body shape for a traffic slot, drawn by the shapes' shares (rand: 0..1)
function pickBody(rand = Math.random()) {
  const total = Object.values(BODY_SHARE).reduce((s, w) => s + w, 0);
  let r = rand * total;
  for (const [body, w] of Object.entries(BODY_SHARE)) {
    r -= w;
    if (r < 0) return body;
  }
  return 'sedan';
}

export { CAR_MODELS, CAR_MODEL_BY_ID, TAXI_MODEL, POLICE_MODEL, BODY_SHARE, paintsOf, pickModel, pickBody };
