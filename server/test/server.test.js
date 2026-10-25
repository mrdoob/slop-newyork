import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { createServer } from '../index.js';
import { OP, PROTOCOL_VERSION, encodeHello, encodeState, decodeServer } from '../../shared/protocol.js';

const quiet = () => {};

// A test client that records every decoded frame and lets a test wait for one matching a predicate
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = decodeServer(new Uint8Array(data));
    frames.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const next = (match, ms = 2000) =>
    new Promise((resolve, reject) => {
      const found = frames.find(match);
      if (found) return resolve(found);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timed out waiting for a frame')), ms);
    });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const opened = new Promise((resolve) => ws.on('open', resolve));
  return { ws, frames, next, closed, opened };
}

const pose = (x, z, mode = 'car') => encodeState({ position: { x, y: 0, z }, heading: 0, speed: 5 }, mode);

test('two players in one region see each other, deltas skip parked players, and leaving notifies', async () => {
  const server = await createServer({ port: 0, tickHz: 20, log: quiet });
  try {
    const a = connect(server.port);
    const b = connect(server.port);
    await Promise.all([a.opened, b.opened]);
    a.ws.send(encodeHello('nayarit', 'Ana'));
    b.ws.send(encodeHello('nayarit', 'Beto'));
    const wa = await a.next((m) => m.op === OP.WELCOME);
    const wb = await b.next((m) => m.op === OP.WELCOME);
    assert.equal(wa.room, 'nayarit#1');
    assert.equal(wb.room, 'nayarit#1');

    a.ws.send(pose(10, 20));
    b.ws.send(pose(15, 20, 'person'));
    const seen = await a.next((m) => m.op === OP.TICK && m.moved.some((p) => p.id === wb.id));
    assert.deepEqual(seen.info, [{ id: wb.id, name: 'Beto' }]);
    const beto = seen.moved.find((p) => p.id === wb.id);
    assert.deepEqual([beto.x, beto.z, beto.mode, beto.speed], [15, 20, 'person', 5]);
    assert.equal(seen.roomPlayers, 2);

    // Beto parks: resending the same pose must not produce more moved rows for Ana
    b.ws.send(pose(15, 20, 'person'));
    const before = a.frames.length;
    await new Promise((r) => setTimeout(r, 200));
    const later = a.frames.slice(before).filter((m) => m.op === OP.TICK);
    assert.ok(later.length >= 2, 'ticks keep coming');
    assert.ok(later.every((m) => m.moved.length === 0), 'an unchanged pose is not resent');

    b.ws.send(pose(16, 20, 'person'));
    await a.next((m, i) => m.op === OP.TICK && m.moved.some((p) => p.id === wb.id && p.x === 16));

    b.ws.close();
    await a.next((m) => m.op === OP.TICK && m.gone.includes(wb.id));
  } finally {
    await server.close();
  }
});

test('players far apart or in other regions are out of view', async () => {
  const server = await createServer({ port: 0, tickHz: 20, viewRadius: 500, log: quiet });
  try {
    const [a, far, other] = [connect(server.port), connect(server.port), connect(server.port)];
    await Promise.all([a.opened, far.opened, other.opened]);
    a.ws.send(encodeHello('nayarit', 'A'));
    far.ws.send(encodeHello('nayarit', 'Far'));
    other.ws.send(encodeHello('jalisco', 'Other'));
    await Promise.all([a, far, other].map((c) => c.next((m) => m.op === OP.WELCOME)));
    a.ws.send(pose(0, 0));
    far.ws.send(pose(0, 900));
    other.ws.send(pose(5, 5));
    await new Promise((r) => setTimeout(r, 250));
    const ticks = a.frames.filter((m) => m.op === OP.TICK);
    assert.ok(ticks.length > 0);
    assert.ok(ticks.every((m) => m.info.length === 0 && m.moved.length === 0), 'nobody is in view');
    assert.equal(ticks[ticks.length - 1].roomPlayers, 2, 'the jalisco player is in another room');

    far.ws.send(pose(0, 300)); // drives into view
    const t = await a.next((m) => m.op === OP.TICK && m.info.some((i) => i.name === 'Far'));
    assert.equal(t.moved[0].z, 300);
    for (const c of [a, far, other]) c.ws.close();
  } finally {
    await server.close();
  }
});

test('a full room opens a mirror; a wrong protocol version or region is refused', async () => {
  const server = await createServer({ port: 0, capacity: 1, log: quiet });
  try {
    const [a, b] = [connect(server.port), connect(server.port)];
    await Promise.all([a.opened, b.opened]);
    a.ws.send(encodeHello('nayarit', 'A'));
    assert.equal((await a.next((m) => m.op === OP.WELCOME)).room, 'nayarit#1');
    b.ws.send(encodeHello('nayarit', 'B'));
    assert.equal((await b.next((m) => m.op === OP.WELCOME)).room, 'nayarit#2');

    const old = connect(server.port);
    await old.opened;
    const hello = encodeHello('nayarit', 'Old');
    hello[1] = PROTOCOL_VERSION - 1;
    old.ws.send(hello);
    assert.equal((await old.next((m) => m.op === OP.ERROR)).code, 'version');
    assert.equal((await old.closed).code, 1008);

    const bad = connect(server.port);
    await bad.opened;
    bad.ws.send(encodeHello('../../etc', 'X'));
    assert.equal((await bad.next((m) => m.op === OP.ERROR)).code, 'region');

    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    const stats = await res.json();
    assert.equal(stats.players, 2);
    assert.deepEqual(stats.rooms.map((r) => r.id).sort(), ['nayarit#1', 'nayarit#2']);
    a.ws.close();
    b.ws.close();
  } finally {
    await server.close();
  }
});

test('a client flooding messages is disconnected', async () => {
  const server = await createServer({ port: 0, log: quiet });
  try {
    const c = connect(server.port);
    await c.opened;
    c.ws.send(encodeHello('nayarit', 'Spam'));
    await c.next((m) => m.op === OP.WELCOME);
    for (let i = 0; i < 200; i++) c.ws.send(pose(i, 0));
    assert.equal((await c.next((m) => m.op === OP.ERROR)).code, 'rate');
    await c.closed;
  } finally {
    await server.close();
  }
});
