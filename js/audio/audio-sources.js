import { signalPhase, walkSignal } from '../world/city-config.js';

const MOTOR_RANGE = 180;
const SIREN_RANGE = 220;
const PEOPLE_RANGE = 45;
const SIGNAL_RANGE = 35;
const unit = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const seedAt = (index) => ((Math.imul(index + 1, 2654435761) >>> 0) / 4294967296);

function driveLoad(keys, speed, cyclist) {
  // Match the controller's forward priority, and distinguish propulsion from braking.
  const throttle = unit(+keys.forward) || -unit(+keys.backward) * (cyclist ? 0.6 : 1);
  if ((cyclist && throttle <= 0) || speed * throttle < 0) return 0;
  return unit(Math.abs(throttle) * (cyclist || keys.boost ? 1 : 0.8));
}

// (floor: the town's floor under it, which the controller's altitude limits are reckoned from)
function helicopterVerticalSpeed(entity, floor = 0) {
  const speed = Number.isFinite(entity.verticalSpeed) ? entity.verticalSpeed : 0;
  // The controller clamps altitude without clearing its stored vertical velocity.
  const y = entity.position.y - floor;
  return (y <= 0.25 && speed < 0) || (y >= 380 && speed > 0) ? 0 : speed;
}

// (ground: the ground's height under it)
function helicopterLoad(entity, keys, verticalSpeed, ground = 0) {
  const forward = unit(+keys.forward) || -unit(+keys.backward);
  const collective = unit(+keys.up) || -unit(+keys.down);
  const grounded = entity.position.y - ground <= 0.35 && verticalSpeed <= 0.03;
  return unit((grounded ? 0.12 : 0.45)
    + 0.28 * Math.max(collective, 0) - 0.16 * Math.max(-collective, 0)
    + 0.15 * unit(verticalSpeed / 16) - 0.08 * unit(-verticalSpeed / 16)
    + 0.1 * Math.abs(forward) + 0.12 * unit(Math.abs(entity.speed) / 52));
}

function roadLoad(speed, acceleration, maxAcceleration) {
  // Constant speed still needs power against rolling resistance and air drag.
  return unit(acceleration / maxAcceleration + unit(speed / 2) * (0.12 + 0.28 * unit(speed / 30) ** 2));
}

function writeMotor(item, id, kind, x, y, z, speed, load, heading, police, player, seed, blocked, gain, range, verticalSpeed = 0, rpm = 0) {
  item.id = id;
  item.kind = kind;
  item.x = x;
  item.y = y;
  item.z = z;
  item.speed = Number.isFinite(speed) ? Math.abs(speed) : 0;
  item.load = unit(load);
  item.verticalSpeed = Number.isFinite(verticalSpeed) ? verticalSpeed : 0;
  item.rpm = Number.isFinite(rpm) ? rpm : 0; // (an engine whose revs are known: the player's car, drivetrain.js)
  item.heading = heading;
  item.police = police;
  item.player = player;
  item.seed = seed;
  item.blocked = blocked;
  item.gain = gain;
  item.range = range;
}

// Bounded insertion keeps only nearby candidates. Records and the public array are reused across collections.
class NearestSources {
  constructor(limit) {
    this.pool = Array.from({ length: limit }, () => ({}));
    this.items = [];
    this.scores = new Float64Array(limit);
  }

  take(score) {
    let i = this.items.length;
    let item;
    if (i < this.pool.length) item = this.pool[i];
    else {
      if (score >= this.scores[i - 1]) return null;
      item = this.items[--i];
    }
    while (i > 0 && score < this.scores[i - 1]) {
      this.items[i] = this.items[i - 1];
      this.scores[i] = this.scores[i - 1];
      i--;
    }
    this.items[i] = item;
    this.scores[i] = score;
    return item;
  }
}

// Read at audio's control rate (10 Hz), after simulation updates. Snapshots remain valid until the next collect().
// IDs are the simulation objects, independent of pooled record order, so voices survive ranking changes/recycling.
class CityAudioSources {
  constructor({ controllerManager, trafficSystem, highwayTraffic, streetDetails }) {
    this.controllers = controllerManager;
    this.players = Object.values(controllerManager.entities);
    this.cars = trafficSystem.cars;
    this.buses = trafficSystem.buses;
    this.motos = trafficSystem.motos || [];
    this.peds = trafficSystem.peds;
    this.highwayCars = highwayTraffic.cars;
    this.signalSites = streetDetails.audioSignals;
    this.motors = new NearestSources(10);
    this.sirens = new NearestSources(2);
    this.people = new NearestSources(6);
    this.signals = new NearestSources(2);
    this.snapshot = {
      motors: this.motors.items, sirens: this.sirens.items,
      people: this.people.items, signals: this.signals.items, traffic: 0, motion: 0
    };
  }

  distanceSq(x, y, z) {
    const dx = x - this.listener.x;
    const dy = y - this.listener.y;
    const dz = z - this.listener.z;
    return dx * dx + dy * dy + dz * dz;
  }

  motor(id, kind, x, y, z, speed, load, heading, police, player, seed, blocked, gain = 1, range = kind === 'helicopter' ? 500 : 160, verticalSpeed = 0, rpm = 0) {
    const d2 = this.distanceSq(x, y, z);
    if (!Number.isFinite(d2)) return;
    if (police && d2 <= SIREN_RANGE * SIREN_RANGE) {
      const siren = this.sirens.take(d2);
      if (siren) writeMotor(siren, id, 'siren', x, y, z, speed, load, heading, true, player, seed, blocked, 1, 200);
    }
    const reach = kind === 'helicopter' ? range : MOTOR_RANGE;
    if (d2 > reach * reach) return;
    const item = this.motors.take(player ? -1 : d2);
    if (!item) return;
    writeMotor(item, id, kind, x, y, z, speed, load, heading, police, player, seed, blocked, gain, range, verticalSpeed, rpm);
  }

  person(id, x, y, z, speed, grounded, rig, player = false, priority = player) {
    const d2 = this.distanceSq(x, y, z);
    if (!Number.isFinite(d2) || d2 > PEOPLE_RANGE * PEOPLE_RANGE) return;
    const item = this.people.take(priority ? -1 : d2);
    if (!item) return;
    item.id = id;
    item.x = x;
    item.y = y;
    item.z = z;
    item.speed = Number.isFinite(speed) ? Math.abs(speed) : 0;
    item.grounded = grounded;
    item.seed = rig.seed;
    item.phase = rig.phase;
    item.player = player;
    item.conversation = player ? null : id.conversation || null;
    const left = rig.feet[0], right = rig.feet[1];
    item.leftX = left.px; item.leftY = left.py; item.leftZ = left.pz;
    item.rightX = right.px; item.rightY = right.py; item.rightZ = right.pz;
  }

  streetVehicles(vehicles, elapsed, seedOffset) {
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.edge) continue;
      const y = (v.hy || 0) + 0.7; // (over the ground under it)
      const d2 = this.distanceSq(v.x, y, v.z);
      const range = v.isPolice ? SIREN_RANGE : MOTOR_RANGE;
      if (!Number.isFinite(d2) || d2 > range * range) continue;
      if (d2 <= MOTOR_RANGE * MOTOR_RANGE) {
        this.snapshot.traffic += (1 - d2 / (MOTOR_RANGE * MOTOR_RANGE)) * (0.2 + 0.8 * unit(v.speed / 12));
      }
      const green = !v.edge.to.signal || signalPhase(elapsed, v.edge.axisIndex === 0) === 'green';
      const blocked = v.wait > 2 && v.speed < 0.5 && v.gap < 8 && v.leaderSpeed < 0.5 && green && !v.conn && !v.yielding;
      this.motor(v, v.bus ? 'bus' : v.moto ? 'moto' : v.heavy ? 'suv' : 'sedan', v.x, y, v.z,
        v.speed, roadLoad(v.speed, v.acc, v.driver.a), v.yaw + v.yawOffset, !!v.isPolice, false, seedAt(seedOffset + i), blocked);
    }
  }

  // The town's floor under an entity (the helicopter's altitudes are reckoned from it)
  floorUnder(entity) {
    return this.controllers.floorHeight(entity.position.x, entity.position.z);
  }

  collect(listenerPosition, elapsed) {
    this.listener = listenerPosition;
    this.motors.items.length = this.sirens.items.length = this.people.items.length = this.signals.items.length = 0;
    this.snapshot.traffic = 0;
    const active = this.controllers.getActiveEntity();
    const keys = this.controllers.keys;
    this.snapshot.motion = active.type === 'person' ? active.rig.speed
      : Math.hypot(active.speed, active.type === 'helicopter' ? helicopterVerticalSpeed(active, this.floorUnder(active)) : 0);

    for (let i = 0; i < this.players.length; i++) {
      const entity = this.players[i];
      if (entity.mesh.visible === false || entity.position.y < -0.05) continue;
      const { x, y, z } = entity.position;
      const player = entity === active;
      if (entity.type === 'person') {
        const ground = this.controllers.getGroundHeight(x, z, 'person');
        const grounded = y <= ground + 0.03 && Math.abs(entity.verticalVel) < 0.1;
        this.person(entity, x, y, z, entity.rig.speed, grounded, entity.rig, true, player);
      } else {
        // Inactive bicycles stop updating and are silent, even if their stored speed is left over from riding.
        if (!player && (entity.type === 'cyclist' || entity.type === 'moto')) continue;
        const kind = entity.type === 'car' ? 'sedan' : entity.type; // (the moto: the traffic's single-cylinder voice)
        const helicopter = kind === 'helicopter';
        const verticalSpeed = player && helicopter ? helicopterVerticalSpeed(entity, this.floorUnder(entity)) : 0;
        // the player's car: its engine's own revs & throttle (drivetrain.js), gear changes and all; an electric car has
        // no engine to hear, only a faint drive and its tyres
        const electric = Boolean(entity.spec && entity.spec.electric);
        const engine = player && entity.drive && !electric ? entity.drive : null;
        const load = player ? helicopter ? helicopterLoad(entity, keys, verticalSpeed, this.controllers.getGroundHeight(x, z, 'helicopter'))
          : engine ? engine.load : driveLoad(keys, entity.speed, kind === 'cyclist') : 0;
        const gain = (player ? 1 : helicopter ? 0.22 : 0.5) * (electric ? 0.3 : 1);
        const range = helicopter ? (player ? 500 : 200) : 160;
        this.motor(entity, kind, x, y + (helicopter ? 2.66 : 0.7), z, player ? entity.speed : 0, load, entity.heading,
          false, player, seedAt(i), false, gain, range, verticalSpeed, engine ? engine.rpm : 0);
      }
    }

    this.streetVehicles(this.cars, elapsed, 100);
    this.streetVehicles(this.buses, elapsed, 1000);
    this.streetVehicles(this.motos, elapsed, 2000);
    for (let i = 0; i < this.highwayCars.length; i++) {
      const car = this.highwayCars[i];
      // Lane ends sink into the road and the Battery tunnel is underground; neither should sound above ground.
      if (!car.placed || car.y < -0.05) continue;
      const d2 = this.distanceSq(car.x, car.y + 0.7, car.z);
      if (!Number.isFinite(d2) || d2 > MOTOR_RANGE * MOTOR_RANGE) continue;
      this.snapshot.traffic += (1 - d2 / (MOTOR_RANGE * MOTOR_RANGE)) * (0.2 + 0.8 * unit(car.v / 12));
      this.motor(car, car.kind === 'suv' ? 'suv' : 'sedan', car.x, car.y + 0.7, car.z,
        car.v, roadLoad(car.v, car.acc, 1.6), car.yaw, false, false, seedAt(2000 + i), car.v < 0.5);
    }
    this.snapshot.traffic = unit(this.snapshot.traffic / 16);

    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];
      if (!ped.placed) continue;
      const t = (ped.x - ped.ax) * ped.ux + (ped.z - ped.az) * ped.uz;
      const y = (ped.node && t > 2 && t < ped.len - 2 ? 0.012 : 0.22) + this.controllers.getGroundHeight(ped.x, ped.z, 'car');
      this.person(ped, ped.x, y, ped.z, ped.v, true, ped.rig);
    }
    for (let i = 0; i < this.signalSites.length; i++) {
      const site = this.signalSites[i];
      const d2 = this.distanceSq(site.x, site.y, site.z);
      if (!Number.isFinite(d2) || d2 > SIGNAL_RANGE * SIGNAL_RANGE) continue;
      const item = this.signals.take(d2);
      if (!item) continue;
      item.id = site;
      item.x = site.x;
      item.y = site.y;
      item.z = site.z;
      item.walk = walkSignal(elapsed, site.isAvenue);
      item.seed = seedAt(10000 + i);
    }
    return this.snapshot;
  }
}

export { CityAudioSources };
