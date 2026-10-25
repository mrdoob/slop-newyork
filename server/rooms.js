// server/rooms.js
// Rooms are per region (a metro area or state that shares one map, e.g. "nayarit" or "valle-de-mexico"), capped at
// `capacity` players. When every room of a region is full the next player opens a mirror room ("nayarit#2"), and
// empty rooms are dropped, so busy regions split instead of overflowing while quiet ones stay together.

import { SpatialGrid } from './aoi.js';

class RoomManager {
  // cellSize is in the units of the positions the grid is fed (see server/aoi.js)
  constructor({ capacity = 200, cellSize = 250 } = {}) {
    this.capacity = capacity;
    this.cellSize = cellSize;
    this.rooms = new Map(); // room id → room
  }

  // Puts a player ({ id, ... }) in the fullest-first open room of its region; returns that room
  join(region, player) {
    let best = null;
    for (const room of this.rooms.values()) {
      if (room.region !== region || room.players.size >= this.capacity) continue;
      // Fill the busiest open mirror first so players meet instead of spreading thin
      if (!best || room.players.size > best.players.size || (room.players.size === best.players.size && room.index < best.index)) {
        best = room;
      }
    }
    if (!best) best = this.open(region);
    best.players.set(player.id, player);
    return best;
  }

  open(region) {
    let index = 1;
    while (this.rooms.has(`${region}#${index}`)) index++;
    const room = { id: `${region}#${index}`, region, index, players: new Map(), grid: new SpatialGrid(this.cellSize) };
    this.rooms.set(room.id, room);
    return room;
  }

  leave(room, playerId) {
    if (!room) return;
    room.players.delete(playerId);
    room.grid.remove(playerId);
    if (room.players.size === 0) this.rooms.delete(room.id);
  }

  stats() {
    const rooms = [...this.rooms.values()].map((r) => ({ id: r.id, region: r.region, players: r.players.size }));
    return { players: rooms.reduce((n, r) => n + r.players, 0), capacity: this.capacity, rooms };
  }
}

export { RoomManager };
