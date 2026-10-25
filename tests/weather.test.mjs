import assert from 'node:assert/strict';
import test from 'node:test';
import { solarPosition, sunDirection, parseOpenMeteo, weatherLabel, LiveWeather, WEATHER_LOCATION } from '../js/world/weather.js';

const { latitude, longitude } = WEATHER_LOCATION;

test('the sun stands almost overhead at Tepic on the June solstice noon', () => {
  // Tepic (21.5° N) sits 1.9° south of the Tropic of Cancer; local solar noon is ~19:00 UTC at 104.9° W
  const noon = solarPosition(new Date('2026-06-21T19:01:00Z'), latitude, longitude);
  assert.ok(noon.elevationDeg > 87.5 && noon.elevationDeg < 88.5, `elevation ${noon.elevationDeg}`);
  const winter = solarPosition(new Date('2026-12-21T18:51:00Z'), latitude, longitude);
  assert.ok(Math.abs(winter.elevationDeg - (90 - latitude - 23.44)) < 0.6, `elevation ${winter.elevationDeg}`);
  assert.ok(Math.abs(winter.azimuthDeg - 180) < 3, 'the December noon sun is due south');
});

test('the sun rises in the east, sets in the west and is down at midnight', () => {
  const morning = solarPosition(new Date('2026-03-20T14:30:00Z'), latitude, longitude); // ~07:30 local
  assert.ok(morning.elevationDeg > 0 && morning.elevationDeg < 20, `elevation ${morning.elevationDeg}`);
  assert.ok(morning.azimuthDeg > 80 && morning.azimuthDeg < 110, `azimuth ${morning.azimuthDeg}`);
  const evening = solarPosition(new Date('2026-03-21T00:30:00Z'), latitude, longitude); // ~17:30 local
  assert.ok(evening.azimuthDeg > 250 && evening.azimuthDeg < 280, `azimuth ${evening.azimuthDeg}`);
  const midnight = solarPosition(new Date('2026-03-21T07:00:00Z'), latitude, longitude);
  assert.ok(midnight.elevationDeg < -60, `elevation ${midnight.elevationDeg}`);
});

test('sun directions are unit vectors in the rotated world grid', () => {
  const north = sunDirection(0, 29, 29);
  assert.ok(Math.abs(north.x) < 1e-9 && Math.abs(north.z + 1) < 1e-9, 'true bearing 29° is grid north (-z)');
  const east = sunDirection(0, 119, 29);
  assert.ok(Math.abs(east.x - 1) < 1e-9, 'a quarter turn clockwise is grid east (+x)');
  const up = sunDirection(90, 200, 29);
  assert.ok(Math.abs(up.y - 1) < 1e-9);
  const d = sunDirection(35, 250, 29);
  assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9);
});

const SAMPLE = {
  current: {
    interval: 900, temperature_2m: 22.4, weather_code: 63, cloud_cover: 100, cloud_cover_low: 92, cloud_cover_mid: 40,
    cloud_cover_high: 10, precipitation: 0.5, visibility: 6400, wind_speed_10m: 14.8, wind_direction_10m: 230, is_day: 1
  },
  hourly: { precipitation: [0.2, 1.1, 0.6, 0.4] }
};

test('Open-Meteo conditions are normalized to fractions, mm/h & metres', () => {
  const w = parseOpenMeteo(SAMPLE, 1234);
  assert.equal(w.cloudCover, 1);
  assert.equal(w.cloudLow, 0.92);
  assert.equal(w.rainRate, 2, '0.5 mm in a 15 min interval is 2 mm/h');
  assert.ok(Math.abs(w.recentRain - 2.3) < 1e-9);
  assert.equal(w.visibility, 6400);
  assert.equal(w.fetchedAt, 1234);
  assert.equal(weatherLabel(w), 'Rain');
  assert.throws(() => parseOpenMeteo({}), /no current block/);
});

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

test('live weather fetches once, caches, and backs off after a failure', async () => {
  let calls = 0;
  const storage = memoryStorage();
  const ok = async () => {
    calls++;
    return { ok: true, json: async () => SAMPLE };
  };
  const weather = new LiveWeather(WEATHER_LOCATION, { fetchImpl: ok, storage });
  assert.equal(weather.live, false);
  assert.equal(await weather.refresh(), true);
  assert.equal(weather.current.code, 63);
  assert.equal(await weather.refresh(), false, 'fresh conditions are not re-fetched');
  assert.equal(calls, 1);

  const restored = new LiveWeather(WEATHER_LOCATION, { fetchImpl: ok, storage });
  assert.equal(restored.live, true, 'a recent fetch is restored from storage');
  assert.equal(await restored.refresh(), false);
  assert.equal(calls, 1);

  let failures = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const offline = new LiveWeather(WEATHER_LOCATION, {
      fetchImpl: async () => {
        failures++;
        throw new Error('offline');
      },
      storage: memoryStorage()
    });
    assert.equal(await offline.refresh(), false);
    assert.equal(await offline.refresh(), false);
    assert.equal(failures, 1, 'a failed request waits before retrying');
    assert.equal(offline.live, false);
    assert.equal(offline.current.cloudCover, 0.1, 'offline keeps the clear placeholder');
  } finally {
    console.warn = warn;
  }
});

test('blocked site storage does not stop live weather from starting', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: access is denied for this document');
    }
  });
  try {
    const weather = new LiveWeather(WEATHER_LOCATION, { fetchImpl: null });
    assert.equal(weather.storage, null);
    assert.equal(weather.live, false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('rain wets the road within a couple of minutes and it dries over the next half hour', async () => {
  const { RoadWater, WEATHER_SAMPLES, CLEAR_WEATHER, rainIntensity, wetGrip } = await import('../js/world/weather.js');
  assert.equal(rainIntensity(CLEAR_WEATHER), 0);
  assert.ok(rainIntensity(WEATHER_SAMPLES.rain) > 0.4 && rainIntensity(WEATHER_SAMPLES.rain) < 0.8);
  assert.equal(rainIntensity(WEATHER_SAMPLES.storm), 1);
  assert.equal(wetGrip(0), 1);
  assert.ok(Math.abs(wetGrip(1) - 0.7) < 1e-9);
  const water = new RoadWater().update(0.1, CLEAR_WEATHER);
  assert.equal(water.wet, 0, 'a dry start with no recent rain');
  for (let t = 0; t < 120; t++) water.update(1, WEATHER_SAMPLES.rain);
  assert.ok(water.wet > 0.8, `after 2 min of rain: ${water.wet}`);
  assert.ok(water.rain > 0.4);
  for (let t = 0; t < 300; t++) water.update(1, CLEAR_WEATHER);
  assert.ok(water.wet > 0.3 && water.wet < 0.9, `5 min after: still wet (${water.wet})`);
  assert.ok(water.rain < 0.01, 'the drops stop');
  for (let t = 0; t < 1800; t++) water.update(1, CLEAR_WEATHER);
  assert.equal(water.wet, 0, 'dry half an hour later');
  assert.ok(new RoadWater().update(0.1, { ...CLEAR_WEATHER, recentRain: 6 }).wet > 0.5, 'wet from the start after a morning shower');
});
