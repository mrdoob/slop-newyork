// shared/protocol.js
// Multiplayer wire protocol, shared verbatim by the browser client (js/net/multiplayer.js) and the room server
// (server/index.js). Binary WebSocket frames in the spirit of RuneScape's: a 1-byte opcode, fixed-width little-endian
// integers (positions in centimetres, heading in 1/65536 turns), one TICK frame per client per server tick, and in it
// only the players whose pose changed since that client last heard about them; the client keeps the rest where they
// were (its "local player list", grown by INFO entries and shrunk by GONE ones).
//
// client → server
//   HELLO  u8 op, u8 version, str region, str name                         once, right after connecting
//   STATE  u8 op, i32 x, i32 y, i32 z (cm), u16 heading, u8 mode, i16 speed (dm/s)   SEND_HZ times a second
// server → client
//   WELCOME u8 op, u16 id, u16 capacity, u8 tickHz, str room
//   TICK    u8 op, u16 players in room,
//           u16 nGone,  nGone × u16 id                                    left the view or the room
//           u16 nInfo,  nInfo × (u16 id, str name)                        came into view
//           u16 nMoved, nMoved × (u16 id, i32 x, i32 y, i32 z, u16 heading, u8 mode, i16 speed)
//   ERROR   u8 op, str code                                                then the server closes the socket
// str = u8 byte length + UTF-8 bytes

const PROTOCOL_VERSION = 2;
const SEND_HZ = 10; // client pose updates per second
const TICK_HZ = 10; // server ticks per second (OSRS runs 600 ms ticks; driving needs 100 ms)
const MODES = ['person', 'car', 'cyclist', 'helicopter'];
const NAME_MAX = 24; // characters
const REGION_RE = /^[a-z0-9-]{1,32}$/;
const WORLD_LIMIT = 2e7; // |x|, |y|, |z| in metres, inside the i32-centimetre range (±21 474 km)
const MAX_FRAME = 4096; // bytes a client may send in one message

const OP = {
  // client → server
  HELLO: 1,
  STATE: 2,
  // server → client
  WELCOME: 101,
  TICK: 102,
  ERROR: 103
};

const STATE_BYTES = 1 + 12 + 2 + 1 + 2;
const ROW_BYTES = 2 + 12 + 2 + 1 + 2; // one moved player in a TICK
const TURN = 2 * Math.PI;

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

// Visible, single-line, length-capped player names; empty or unusable names get a numbered default
function sanitizeName(name, fallbackSeed = 0) {
  const clean = [...String(name ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ') // line breaks & tabs become spaces before the remaining control characters go
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .trim()]
    .slice(0, NAME_MAX)
    .join('')
    .trim();
  return clean || `Player-${String(Math.abs(Math.floor(fallbackSeed)) % 10000).padStart(4, '0')}`;
}

function isRegion(region) {
  return typeof region === 'string' && REGION_RE.test(region);
}

const toCm = (m) => Math.round(m * 100);
const toHeading = (rad) => Math.round((((rad % TURN) + TURN) % TURN) / TURN * 65536) & 0xffff;
const toSpeed = (ms) => Math.max(-32768, Math.min(32767, Math.round(ms * 10)));

// Growable little-endian byte writer
class Writer {
  constructor(size = 256) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.at = 0;
  }
  room(n) {
    if (this.at + n <= this.bytes.length) return;
    const bigger = new Uint8Array(Math.max(this.bytes.length * 2, this.at + n));
    bigger.set(this.bytes);
    this.bytes = bigger;
    this.view = new DataView(bigger.buffer);
  }
  u8(v) { this.room(1); this.view.setUint8(this.at, v); this.at += 1; }
  u16(v) { this.room(2); this.view.setUint16(this.at, v, true); this.at += 2; }
  i16(v) { this.room(2); this.view.setInt16(this.at, v, true); this.at += 2; }
  i32(v) { this.room(4); this.view.setInt32(this.at, v, true); this.at += 4; }
  str(s) {
    let b = utf8.encode(s);
    if (b.length > 255) b = b.subarray(0, 255);
    this.u8(b.length);
    this.room(b.length);
    this.bytes.set(b, this.at);
    this.at += b.length;
  }
  pose(st) {
    this.i32(st.x); this.i32(st.y); this.i32(st.z); this.u16(st.h); this.u8(st.m); this.i16(st.s);
  }
  done() {
    return this.bytes.slice(0, this.at);
  }
}

// Bounds-checked reader; any overrun throws RangeError, which decoders turn into "malformed"
class Reader {
  constructor(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  u8() { const v = this.view.getUint8(this.at); this.at += 1; return v; }
  u16() { const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  i16() { const v = this.view.getInt16(this.at, true); this.at += 2; return v; }
  i32() { const v = this.view.getInt32(this.at, true); this.at += 4; return v; }
  str() {
    const n = this.u8();
    if (this.at + n > this.bytes.length) throw new RangeError('string overruns frame');
    const s = utf8Decode.decode(this.bytes.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }
  pose() {
    return { x: this.i32(), y: this.i32(), z: this.i32(), h: this.u16(), m: this.u8(), s: this.i16() };
  }
}

// ---- client → server -------------------------------------------------------------------------------------------

function encodeHello(region, name) {
  const w = new Writer(64);
  w.u8(OP.HELLO);
  w.u8(PROTOCOL_VERSION);
  w.str(region);
  w.str([...String(name ?? '')].slice(0, NAME_MAX).join('')); // the server sanitizes it & numbers empty ones
  return w.done();
}

// A player entity ({ position, heading, speed }) in a MODES mode → STATE frame (18 bytes)
function encodeState(entity, mode) {
  const p = entity.position;
  const w = new Writer(STATE_BYTES);
  w.u8(OP.STATE);
  w.pose({ x: toCm(p.x), y: toCm(p.y), z: toCm(p.z), h: toHeading(entity.heading), m: Math.max(0, MODES.indexOf(mode)), s: toSpeed(entity.speed || 0) });
  return w.done();
}

// Server side: one client frame → { op, ... } or null when malformed / out of range
function decodeClient(data) {
  try {
    if (!data || data.byteLength < 1 || data.byteLength > MAX_FRAME) return null;
    const r = new Reader(data);
    const op = r.u8();
    if (op === OP.HELLO) return { op, version: r.u8(), region: r.str(), name: r.str() };
    if (op === OP.STATE) {
      const st = r.pose();
      const lim = WORLD_LIMIT * 100;
      if (Math.abs(st.x) > lim || Math.abs(st.y) > lim || Math.abs(st.z) > lim || st.m >= MODES.length) return null;
      return { op, state: st };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- server → client -------------------------------------------------------------------------------------------

function encodeWelcome(id, capacity, tickHz, room) {
  const w = new Writer(48);
  w.u8(OP.WELCOME);
  w.u16(id);
  w.u16(capacity);
  w.u8(tickHz);
  w.str(room);
  return w.done();
}

// gone: [id], info: [[id, name]], moved: [[id, state]] with states in wire units (cm, 1/65536 turn, dm/s)
function encodeTick(roomPlayers, gone, info, moved) {
  const w = new Writer(9 + gone.length * 2 + info.length * 20 + moved.length * ROW_BYTES);
  w.u8(OP.TICK);
  w.u16(Math.min(roomPlayers, 0xffff));
  w.u16(gone.length);
  for (const id of gone) w.u16(id);
  w.u16(info.length);
  for (const [id, name] of info) {
    w.u16(id);
    w.str(name);
  }
  w.u16(moved.length);
  for (const [id, st] of moved) {
    w.u16(id);
    w.pose(st);
  }
  return w.done();
}

function encodeError(code) {
  const w = new Writer(24);
  w.u8(OP.ERROR);
  w.str(code);
  return w.done();
}

// Client side: one server frame → { op, ... } in metres / radians / m/s, or null when malformed
function decodeServer(data) {
  try {
    const r = new Reader(data);
    const op = r.u8();
    if (op === OP.WELCOME) return { op, id: r.u16(), capacity: r.u16(), tickHz: r.u8(), room: r.str() };
    if (op === OP.ERROR) return { op, code: r.str() };
    if (op !== OP.TICK) return null;
    const roomPlayers = r.u16();
    const gone = [];
    for (let i = r.u16(); i > 0; i--) gone.push(r.u16());
    const info = [];
    for (let i = r.u16(); i > 0; i--) info.push({ id: r.u16(), name: r.str() });
    const moved = [];
    for (let i = r.u16(); i > 0; i--) {
      const id = r.u16();
      const st = r.pose();
      moved.push({ id, x: st.x / 100, y: st.y / 100, z: st.z / 100, heading: (st.h / 65536) * TURN, mode: MODES[st.m] || MODES[0], speed: st.s / 10 });
    }
    return { op, roomPlayers, gone, info, moved };
  } catch {
    return null;
  }
}

export {
  PROTOCOL_VERSION,
  SEND_HZ,
  TICK_HZ,
  MODES,
  NAME_MAX,
  OP,
  STATE_BYTES,
  ROW_BYTES,
  sanitizeName,
  isRegion,
  encodeHello,
  encodeState,
  decodeClient,
  encodeWelcome,
  encodeTick,
  encodeError,
  decodeServer
};
