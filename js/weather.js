// js/weather.js
// Live weather & real sun for the "Live" time of day: the sun's true position over Tepic, Nayarit (computed locally
// from the clock, no network) and the current conditions there from Open-Meteo (free, keyless, CORS-enabled; weather
// data by Open-Meteo.com, CC BY 4.0). One point covers the whole map: the forecast models behind it resolve ~10 km
// cells, larger than the city. Kept free of three.js imports so it runs under node:test.

const WEATHER_LOCATION = { name: 'Tepic', latitude: 21.5042, longitude: -104.8946, timeZone: 'America/Mazatlan' };

const API_URL = 'https://api.open-meteo.com/v1/forecast';
const CURRENT_FIELDS = [
  'temperature_2m', 'weather_code', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'precipitation', 'visibility', 'wind_speed_10m', 'wind_direction_10m', 'is_day'
];
const CACHE_KEY = 'live-weather-v1';
const REFRESH_MS = 10 * 60 * 1000; // Open-Meteo's "current" block updates every 15 min

// WMO weather interpretation codes (the subset Open-Meteo reports) → short English labels for the HUD
const WMO_LABELS = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Heavy showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail'
};

// Clear, dry, unlimited visibility: what Live mode shows until (or unless) the first fetch lands
const CLEAR_WEATHER = Object.freeze({
  temperature: null, code: 0, cloudCover: 0.1, cloudLow: 0, cloudMid: 0.05, cloudHigh: 0.1,
  rainRate: 0, recentRain: 0, visibility: 24000, windSpeed: 8, windDirection: 0, fetchedAt: 0
});

// Fixed conditions for ?live-weather=<name> (previewing a look without waiting for it to happen in Tepic)
const WEATHER_SAMPLES = {
  clear: CLEAR_WEATHER,
  cloudy: { ...CLEAR_WEATHER, code: 2, cloudCover: 0.55, cloudLow: 0.3, cloudMid: 0.25, cloudHigh: 0.3 },
  overcast: { ...CLEAR_WEATHER, code: 3, cloudCover: 1, cloudLow: 0.9, cloudMid: 0.7, cloudHigh: 0.4, visibility: 12000 },
  rain: { ...CLEAR_WEATHER, code: 63, cloudCover: 1, cloudLow: 1, cloudMid: 0.8, cloudHigh: 0.5, rainRate: 3, recentRain: 6, visibility: 5000, windSpeed: 18 },
  storm: { ...CLEAR_WEATHER, code: 95, cloudCover: 1, cloudLow: 1, cloudMid: 1, cloudHigh: 0.9, rainRate: 12, recentRain: 20, visibility: 2500, windSpeed: 35 },
  fog: { ...CLEAR_WEATHER, code: 45, cloudCover: 0.9, cloudLow: 0.9, cloudMid: 0.1, cloudHigh: 0, visibility: 600, windSpeed: 3 }
};

const DEG = Math.PI / 180;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Low-precision solar ephemeris (Astronomical Almanac, ~0.01° over 1950–2050): apparent sun elevation & azimuth
// (degrees, azimuth clockwise from true north) at a UTC instant & a place
function solarPosition(date, latitude, longitude) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000.0
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmstHours = (18.697374558 + 24.06570982441908 * n) % 24;
  const H = (gmstHours * 15 + longitude) * DEG - ra; // local hour angle
  const lat = latitude * DEG;
  const elevation = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
  const azimuth = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(H));
  return { elevationDeg: elevation / DEG, azimuthDeg: ((azimuth / DEG) % 360 + 360) % 360 };
}

// Unit vector toward the sun in the world frame (x = grid east, y = up, z = grid south) whose grid north is turned
// gridBearingDeg clockwise from true north
function sunDirection(elevationDeg, azimuthDeg, gridBearingDeg = 0) {
  const a = (azimuthDeg - gridBearingDeg) * DEG;
  const e = elevationDeg * DEG;
  return { x: Math.sin(a) * Math.cos(e), y: Math.sin(e), z: -Math.cos(a) * Math.cos(e) };
}

// Open-Meteo response → normalized conditions (fractions 0..1, mm/h, m, km/h)
function parseOpenMeteo(json, now = Date.now()) {
  const c = json && json.current;
  if (!c) throw new Error('Open-Meteo response has no current block');
  const pct = (v) => (Number.isFinite(v) ? clamp01(v / 100) : 0);
  const intervalHours = (c.interval || 900) / 3600;
  const hourly = (json.hourly && json.hourly.precipitation) || [];
  return {
    temperature: Number.isFinite(c.temperature_2m) ? c.temperature_2m : null,
    code: Number.isFinite(c.weather_code) ? c.weather_code : 0,
    cloudCover: pct(c.cloud_cover),
    cloudLow: pct(c.cloud_cover_low),
    cloudMid: pct(c.cloud_cover_mid),
    cloudHigh: pct(c.cloud_cover_high),
    rainRate: Math.max(0, c.precipitation || 0) / intervalHours, // "current" precipitation is the interval's total
    recentRain: hourly.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0),
    visibility: Number.isFinite(c.visibility) && c.visibility > 0 ? c.visibility : 24000,
    windSpeed: Number.isFinite(c.wind_speed_10m) ? c.wind_speed_10m : 0,
    windDirection: Number.isFinite(c.wind_direction_10m) ? c.wind_direction_10m : 0,
    fetchedAt: now
  };
}

function weatherLabel(w) {
  return WMO_LABELS[w.code] || (w.cloudCover > 0.7 ? 'Overcast' : w.cloudCover > 0.3 ? 'Partly cloudy' : 'Clear');
}

class LiveWeather {
  constructor(location = WEATHER_LOCATION, { fetchImpl = globalThis.fetch && globalThis.fetch.bind(globalThis), storage } = {}) {
    this.location = location;
    this.fetchImpl = fetchImpl;
    if (storage === undefined) {
      try {
        storage = globalThis.localStorage; // reading it throws a SecurityError where site data is blocked
      } catch {
        storage = null;
      }
    }
    this.storage = storage;
    this.current = { ...CLEAR_WEATHER };
    this.live = false; // true once real conditions (fresh or cached) are in
    this.pending = null;
    this.nextAttempt = 0;
    this.restoreCache();
  }

  restoreCache() {
    try {
      const cached = JSON.parse(this.storage.getItem(CACHE_KEY));
      if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 3 * REFRESH_MS) {
        this.current = { ...CLEAR_WEATHER, ...cached };
        this.live = true;
        this.nextAttempt = cached.fetchedAt + REFRESH_MS;
      }
    } catch {
      // no storage (private mode / tests) or a stale shape: start clear
    }
  }

  // Fetches once the conditions are older than REFRESH_MS; resolves true when new ones arrived. Never rejects:
  // offline or a failed request keeps the last (or clear) weather
  refresh() {
    if (this.pending) return this.pending;
    if (!this.fetchImpl || Date.now() < this.nextAttempt) return Promise.resolve(false);
    const { latitude, longitude } = this.location;
    const url = `${API_URL}?latitude=${latitude}&longitude=${longitude}&current=${CURRENT_FIELDS.join(',')}` +
      '&hourly=precipitation&past_hours=3&forecast_hours=1&timezone=auto';
    this.pending = this.fetchImpl(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        this.current = parseOpenMeteo(json);
        this.live = true;
        this.nextAttempt = Date.now() + REFRESH_MS;
        try {
          this.storage.setItem(CACHE_KEY, JSON.stringify(this.current));
        } catch {
          // storage full or blocked: the in-memory copy still serves this session
        }
        return true;
      })
      .catch((err) => {
        console.warn('[weather] keeping previous conditions:', err.message);
        this.nextAttempt = Date.now() + 60000; // retry in a minute, not every tick
        return false;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  // Pins the conditions (no more fetching), e.g. to WEATHER_SAMPLES.storm
  hold(conditions) {
    this.fetchImpl = null;
    this.current = { ...CLEAR_WEATHER, ...conditions, fetchedAt: Date.now() };
    this.live = true;
  }

  sun(date = new Date()) {
    return solarPosition(date, this.location.latitude, this.location.longitude);
  }
}

export { WEATHER_LOCATION, CLEAR_WEATHER, WEATHER_SAMPLES, solarPosition, sunDirection, parseOpenMeteo, weatherLabel, LiveWeather };
