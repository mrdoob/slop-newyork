import assert from 'node:assert/strict';
import test from 'node:test';
import { venueKind, venueName, isOpen, frontDoor, findVenues, NAMED_VENUES } from '../js/world/venues.js';

test('signs read as the places they are', () => {
  assert.equal(venueKind('TACOS'), 'tacos');
  assert.equal(venueKind('TACOS EL CAMPEON'), 'tacos');
  assert.equal(venueKind('MONSTER BURGER HAMBURGUESAS Y…'), 'burger');
  assert.equal(venueKind('MARISCOS FABIÁN'), 'seafood');
  assert.equal(venueKind('CANTINA'), 'bar');
  assert.equal(venueKind("CHENDO'S BAR"), 'bar');
  assert.equal(venueKind('QUEENS DISCO'), 'disco');
  assert.equal(venueKind('RESTAURANTE LA NORIA'), 'restaurant');
  // not food or drink, though the words look like it
  for (const t of ['CLUB DE NUTRICIÓN ALICIA', 'BARBERÍA LÍNEA DORADA', 'EL BARATERO', 'EL REY GORRAS CLUB', 'GOGO ABARROTERA', 'FERRETERÍA']) {
    assert.equal(venueKind(t), null, t);
  }
});

test('names: a trade sign shows its trade, a real one its own name', () => {
  assert.equal(venueName('TACOS'), 'Taquería');
  assert.equal(venueName('LONCHERÍA'), 'Lonchería');
  assert.equal(venueName("CHENDO'S BAR"), "Chendo's Bar");
});

test('opening hours wrap past midnight', () => {
  assert.ok(isOpen('tacos', 21));
  assert.ok(isOpen('tacos', 1.5));
  assert.ok(!isOpen('tacos', 12));
  assert.ok(isOpen('restaurant', 14));
  assert.ok(!isOpen('disco', 20));
  assert.ok(isOpen('disco', 3));
});

test('the door is on the street front, facing out', () => {
  // a 10 x 6 m house at the origin, unturned, its front on the +z side
  const d = frontDoor({ cx: 0, cz: 0, w: 10, d: 6, th: 0, front: 3 }, 0.5);
  assert.deepEqual([d.x, d.z, d.nx, d.nz, d.width], [0, 3.5, 0, 1, 10]);
  // seen from the street (looking -z), to the right is +x
  assert.deepEqual([d.ax, d.az + 0], [1, 0]);
  // turned a quarter: its local +z front faces world +x
  const t = frontDoor({ cx: 0, cz: 0, w: 10, d: 6, th: Math.PI / 2, front: 3 }, 0);
  assert.ok(Math.abs(t.x - 3) < 1e-9 && Math.abs(t.z) < 1e-9 && Math.abs(t.nx - 1) < 1e-9);
});

test('venues come from the signs, and the hand-placed ones from their spot', () => {
  const signs = [{ text: 'TACOS' }, { text: 'OKSO', chain: 1 }, { text: 'FERRETERÍA' }];
  const n = NAMED_VENUES[0];
  const houses = [
    0, 0, 100, 60, 0, 1, 3 | 4, 1, // tacos
    500, 0, 100, 60, 0, 1, 3 | 4, 2, // a chain store
    1000, 0, 100, 60, 0, 1, 3 | 4, 3, // a hardware store
    Math.round(n.x * 10), Math.round(n.z * 10), 100, 60, 0, 1, 3 | 4, 3 // the hand-placed one's building
  ];
  const v = findVenues(houses, signs, 8);
  assert.deepEqual(v.map((x) => [x.kind, x.name]), [['tacos', 'Taquería'], [n.kind, n.name]]);
});
