// server/bench.js
// Load test: BOTS simulated players drive random routes inside a SPREAD-metre square of one region for SECONDS, against
// an in-process server; prints the server's tick cost and the bytes each client receives.
//
//   node server/bench.js        BOTS=500 SPREAD=2000 SECONDS=10

import WebSocket from 'ws';
import { createServer } from './index.js';
import { encodeHello, encodeState, SEND_HZ } from '../shared/protocol.js';

const BOTS = Number(process.env.BOTS) || 500;
const SPREAD = Number(process.env.SPREAD) || 2000;
const SECONDS = Number(process.env.SECONDS) || 10;

const server = await createServer({ port: 0, capacity: BOTS, maxPlayers: BOTS + 10, log: () => {} });
let received = 0;
const bots = [];
for (let i = 0; i < BOTS; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const bot = { ws, position: { x: (Math.random() - 0.5) * SPREAD, y: 0, z: (Math.random() - 0.5) * SPREAD }, heading: Math.random() * 6.28, speed: 8 + Math.random() * 10 };
  ws.on('open', () => ws.send(encodeHello('bench', `Bot ${i}`)));
  ws.on('error', () => {}); // a refused bot just doesn't count
  ws.on('message', (data) => {
    received += data.length;
  });
  bots.push(bot);
  // connect in batches: the OS drops bursts beyond its listen backlog (128 on macOS)
  if (i % 50 === 49) await new Promise((r) => setTimeout(r, 60));
}
await new Promise((r) => setTimeout(r, 1500));

const dt = 1 / SEND_HZ;
const drive = setInterval(() => {
  for (const b of bots) {
    if (b.ws.readyState !== WebSocket.OPEN) continue;
    b.heading += (Math.random() - 0.5) * 0.3;
    b.position.x += Math.sin(b.heading) * b.speed * dt;
    b.position.z += Math.cos(b.heading) * b.speed * dt;
    if (Math.abs(b.position.x) > SPREAD / 2 || Math.abs(b.position.z) > SPREAD / 2) b.heading += Math.PI;
    b.ws.send(encodeState(b, 'car'));
  }
}, 1000 / SEND_HZ);

received = 0;
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(drive);
const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
const perClientKBs = received / SECONDS / BOTS / 1024;
console.log(`${BOTS} bots in ${SPREAD} m: tick ${health.tickMs} ms (budget ${1000 / 10} ms), ` +
  `${(health.bytesPerTick / 1024).toFixed(1)} KB out per tick, ${perClientKBs.toFixed(1)} KB/s per client, rooms ${health.rooms.map((r) => `${r.id}:${r.players}`).join(' ')}`);
for (const b of bots) b.ws.terminate();
await server.close();
