import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL, COLLECTOR, AVENUE, ROUTE_PULL, roadClass, busyFactor, carDemand, peopleDemand, rushOf, carDensity, peopleDensity,
  localHour
} from '../js/sim/traffic-demand.js';

test("Tepic's three rushes are its busiest hours, and the small hours all but empty", () => {
  for (const h of [8, 14, 18]) assert.ok(carDemand(h) >= 0.95, `${h} h is a rush hour`);
  for (const h of [11, 16, 21]) assert.ok(carDemand(h) < 0.8, `${h} h is between the rushes`);
  assert.ok(carDemand(3) < 0.1);
  assert.ok(peopleDemand(3) < 0.05);
  assert.ok(rushOf(14) === 1 && rushOf(11) === 0);
  // linear within the hour, and round the clock
  assert.ok(Math.abs(carDemand(13.5) - (carDemand(13) + carDemand(14)) / 2) < 1e-9);
  assert.equal(carDemand(24), carDemand(0));
  assert.equal(carDemand(-1), carDemand(23));
});

test('the traffic is on the avenues: a lane of one carries many times a colonia street', () => {
  assert.equal(roadClass({ axis: 'ave', half: 3.7 }), AVENUE);
  assert.equal(roadClass({ axis: 'st', half: 5 }), COLLECTOR);
  assert.equal(roadClass({ axis: 'st', half: 3.7 }), LOCAL);
  for (const h of [3, 11, 14]) {
    assert.ok(carDensity(AVENUE, h) > 10 * carDensity(LOCAL, h));
    assert.ok(carDensity(COLLECTOR, h) > carDensity(LOCAL, h));
    assert.ok(peopleDensity(AVENUE, h) > peopleDensity(LOCAL, h));
  }
  // the rush crowds the avenues more than the side streets
  const rise = (c) => carDensity(c, 14) / carDensity(c, 11);
  assert.ok(rise(AVENUE) > rise(LOCAL));
  // and drivers keep to them
  assert.ok(ROUTE_PULL[AVENUE] > ROUTE_PULL[COLLECTOR] && ROUTE_PULL[COLLECTOR] > ROUTE_PULL[LOCAL]);
  assert.ok(busyFactor('Avenida Insurgentes') > 1);
  assert.equal(busyFactor('Calle Durango'), 1);
  assert.equal(busyFactor(''), 1);
});

test("the hour is Tepic's, UTC-7 all year", () => {
  assert.equal(localHour(new Date('2026-10-24T21:30:00Z')), 14.5);
  assert.equal(localHour(new Date('2026-01-15T07:00:00Z')), 0);
  assert.equal(localHour(new Date('2026-01-15T07:00:00Z'), 'Not/AZone'), 0, 'an unknown time zone falls back to UTC-7');
});
